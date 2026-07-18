"""
CRUD service for charts.
"""
import contextvars
from copy import deepcopy
import re
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func


# [pbi-filter] correlation: track which chart_id is being rendered so
# log lines emitted from deep inside the semantic engine (SQL emission,
# measure-filter wrap) can be tied back to a specific dashboard tile by
# DA. Set by ``get_chart_data`` / ``preview_chart_data``; defaults to
# None for non-chart callers (CSV export, MCP previews, etc.).
_pbi_chart_id_var: contextvars.ContextVar[int | None] = contextvars.ContextVar(
    "pbi_chart_id", default=None,
)

# Public per-link snapshot TTL (minutes) for the current request, threaded via a
# contextvar to avoid plumbing a param through the whole render call-stack.
# None → builder/authed (use current snapshot, never auto-rebuild); 0 → Realtime
# (live); >0 → serve-stale-then-async-rebuild past the TTL. Set by the public
# chart-data endpoint; default None everywhere else.
_snapshot_ttl_var: contextvars.ContextVar[int | None] = contextvars.ContextVar(
    "snapshot_ttl_minutes", default=None,
)


def _pbi_current_chart_id() -> int | None:
    """Return the chart_id currently being rendered, or None."""
    try:
        return _pbi_chart_id_var.get()
    except LookupError:
        return None

from app.models import Chart, ChartType, ChartMetadata, ChartParameter
from app.schemas import ChartCreate, ChartUpdate
from app.schemas import ChartMetadataUpsert, ChartParameterCreate, ChartParameterUpdate
from app.core.logging import get_logger
from app.services.execution_plan import plan_chart_execution
from app.services.chart_contracts import (
    _record_dropped_filter,
    enforce_no_hard_dropped_filters,
    get_chart_active_role_config,
    get_chart_custom_sql,
    merge_chart_query_filters,
    normalize_chart_filter_context,
    normalize_chart_role_config,
    normalize_filter_conditions,
    with_table_hyperlink_query_columns,
)
from app.services.chart_semantic_service import (
    resolve_chart_semantic_binding,
    with_chart_semantic_binding,
)
from app.services.dataset_calendar_service import (
    build_calendar_filter_expression,
    build_calendar_live_sql,
    get_calendar_settings,
    is_generated_calendar_table,
)
import app.services.dataset_table_sql_service as dataset_table_sql_service
from app.services.dataset_table_sql_service import (
    DatasetTableSqlError,
    build_live_proxy_table_for_dataset_table,
    is_derived_table,
)

logger = get_logger(__name__)


_SIMPLE_SQL_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_VALID_BUBBLE_AGG = {"sum", "avg", "count", "min", "max", "count_distinct"}


# ── Semantic chart routing ─────────────────────────────────────────────────
#
# Background:
#   The Explore chart builder lets the user pick dimensions / measures from
#   ANY semantic view that is reachable (via JOIN) from the chart's anchor
#   table. The user-facing field id is `view.field`. Legacy chart runtime
#   (`LiveQueryService.execute_chart_query`) only knows how to query a single
#   physical table — given dimension `"customers.name"` it would emit
#   `"customers"."name"` against the orders subquery and fail.
#
#   The dataset-execute endpoint already handles this by routing to
#   `SemanticQueryEngine`, which knows how to materialise the JOIN chain
#   from `SemanticExplore.joins`. We extend the same routing into the chart
#   runtime when a chart uses joined fields or declared semantic fields
#   (formulas, filtered measures, aliases). Pure physical-table charts
#   continue to flow through the existing path.


def _collect_role_config_field_refs(role_config: dict) -> list[str]:
    """Collect every user-bound field reference in a chart role_config.

    Returns the union of dimension-like roles, scatter axes, table pivot
    fields, selectedColumns, and every metric.field. Used to detect whether
    a chart query crosses semantic-view boundaries.
    """
    refs: list[str] = []

    def push_str(value: Any) -> None:
        if isinstance(value, str) and value.strip():
            refs.append(value.strip())

    def push_metric(metric: Any) -> None:
        if isinstance(metric, dict):
            push_str(metric.get("field"))

    for key in (
        "dimension", "breakdown", "timeField",
        "scatterX", "scatterY",
        "tableRowDimension", "tableColumnDimension",
    ):
        push_str(role_config.get(key))
    for col in role_config.get("selectedColumns") or []:
        push_str(col)
    # Phase-15.98 (Audit F + Cell D coverage) — TABLE / MATRIX role_config
    # also carries a plural ``dimensions: string[]`` slot (sibling of the
    # singular ``dimension``). Cell D of the filter audit demonstrated that
    # a qualified same-view dim like ``dataset_table_188.crm_name`` placed
    # in ``dimensions[]`` was invisible to the routing oracle because only
    # the singular form was scanned. Scan the list too so declared semantic
    # dims in TABLE-mode charts still force the semantic engine where
    # formulas / filters / aliases are honoured.
    for dim in role_config.get("dimensions") or []:
        push_str(dim)
    for metric in role_config.get("metrics") or []:
        push_metric(metric)
    for key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
        push_metric(role_config.get(key))
    return refs


def _apply_bubble_label_aggregation(
    *,
    chart_type: str,
    role_config: dict[str, Any],
    dimension_refs: list[str],
    measure_refs: list[str],
    agg_overrides: dict[str, str],
    qualify,
) -> tuple[list[str], list[str], dict[str, str]]:
    """Force Bubble/NINE_BOX to aggregate numeric marks at Label grain.

    Scatter-like role classification initially treats X/Y axes as dimensions so
    SCATTER can render one raw row per point. Bubble and 9-box use the optional
    `dimension` role as PowerBI "Details"/Label: when present, numeric X/Y/Size
    should collapse to one mark per label. A stale `timeField` from a prior
    chart type must not remain in GROUP BY, otherwise a >1 month date filter
    returns one row per (label, period) instead of one summed row per label.
    """
    normalized_chart_type = str(chart_type or "").upper()
    if normalized_chart_type not in ("BUBBLE", "NINE_BOX"):
        return dimension_refs, measure_refs, agg_overrides

    bubble_label = qualify(role_config.get("dimension"))
    axes = [
        (qualify(role_config.get("scatterX")), str(role_config.get("scatterXAgg") or "").strip().lower()),
        (qualify(role_config.get("scatterY")), str(role_config.get("scatterYAgg") or "").strip().lower()),
    ]
    if not bubble_label or not any(ref for ref, _ in axes):
        return dimension_refs, measure_refs, agg_overrides

    next_dimensions = list(dimension_refs)
    next_measures = list(measure_refs)
    next_aggs = dict(agg_overrides)

    for axis_ref, axis_agg in axes:
        if not axis_ref:
            continue
        was_dim = axis_ref in next_dimensions
        # NINE_BOX also accepts a categorical axis that must stay a GROUP BY
        # dimension. FE sets scatter*Agg only for numeric axes.
        if normalized_chart_type == "NINE_BOX" and was_dim and axis_agg not in _VALID_BUBBLE_AGG:
            continue
        if was_dim:
            next_dimensions.remove(axis_ref)
        if axis_ref not in next_measures:
            next_measures.append(axis_ref)
        if was_dim:
            next_aggs.setdefault(
                axis_ref,
                axis_agg if axis_agg in _VALID_BUBBLE_AGG else "sum",
            )

    # When a chart was switched from time-series/line into Bubble/9-box, the
    # saved role_config can still carry timeField/timeGrains. For these chart
    # types the date range is filter context, not output grain. Keep it only if
    # it is also the actual label or an explicit categorical 9-box axis.
    time_ref = qualify(role_config.get("timeField"))
    axis_refs = {ref for ref, _ in axes if ref}
    if time_ref and time_ref != bubble_label and time_ref not in axis_refs:
        while time_ref in next_dimensions:
            next_dimensions.remove(time_ref)

    return next_dimensions, next_measures, next_aggs


def _binding_semantic_fields(binding: dict[str, Any]) -> set[str]:
    fields = {
        str(value).strip()
        for value in [
            *(binding.get("dimensionFields") or []),
            *(binding.get("measureFields") or []),
            *(binding.get("reachableDimensionFields") or []),
            *(binding.get("reachableMeasureFields") or []),
            *(binding.get("reachableFields") or []),
            *((binding.get("fieldMap") or {}).values()),
            *[
                mapping.get("semanticField")
                for mapping in (binding.get("calendarFieldMappings") or [])
                if isinstance(mapping, dict)
            ],
        ]
        if str(value or "").strip()
    }
    return fields


def _binding_semantic_measure_fields(binding: dict[str, Any]) -> set[str]:
    return {
        str(value).strip()
        for value in [
            *(binding.get("measureFields") or []),
            *(binding.get("reachableMeasureFields") or []),
        ]
        if str(value or "").strip()
    }


def _role_config_needs_semantic_runtime(
    role_config: dict,
    binding: dict[str, Any],
    base_view_name: str,
    runtime_filters: list[dict] | None = None,
) -> bool:
    """Route to semantic runtime when role_config OR a runtime filter uses
    joined fields or any declared semantic field in qualified form.

    Cross-view fields require JOIN resolution. Same-view qualified semantic
    measures/dimensions also need the semantic engine because they may be
    formulas, filtered measures, or aliases rather than physical columns.

    Phase-15.25 — previously this returned False early when
    `base_view_name` was empty. That silently wiped out the dotted-ref
    detection below, so an MCP-created chart whose `semanticBinding`
    hadn't been hydrated (binding={}, baseViewName="") routed every
    qualified-ref query to the legacy live builder — which can't JOIN.
    DA's symptom: chart with a joined-view dim (e.g. calendar
    `year_quarter`) came back with 1 aggregated row because the SELECT
    silently dropped the joined column and every output cell collapsed
    to the same null bucket. Now: any dotted `view.field` ref ALWAYS
    routes semantic regardless of binding state, because the live
    builder cannot honour them either way.

    Phase-15.81 v15 — `runtime_filters` now also feeds the decision.
    Earlier routing only inspected metric/dim refs, so a chart whose
    metric is bare (e.g. `tong_lead_nhan`) but whose base filter
    references a joined view (e.g. `dataset_table_345.payment_date`)
    routed to the legacy live builder. The live builder cannot JOIN,
    so the joined-view filter got silently dropped on the second-pass
    `_normalize_runtime_filters_for_chart` re-normalisation and the
    Dashboard returned unfiltered rows that diverged from Explore.
    Detecting filter refs here pulls the query back to the semantic
    runtime which CAN materialise the JOIN.
    """
    base = (base_view_name or "").strip()

    semantic_fields = _binding_semantic_fields(binding)
    semantic_measures = _binding_semantic_measure_fields(binding)

    def _metric_needs_semantic(metric: Any) -> bool:
        """A metric forces semantic routing when its field is qualified
        (live builder can't resolve cross-view refs) OR when it maps to a
        DECLARED same-view semantic measure (which may be a formula /
        filtered measure / alias rather than a physical column).

        STRICT (PowerBI parity) — bare-metric matching has only TWO tiers:

          1. qualified ``view.field`` → semantic (live builder can't JOIN).

          2. bare ``{field}`` / ``{base}.{field}`` that maps to a declared
             same-view measure → semantic.

        Anything else returns False here. It does NOT mean "route to live":
        the strict force-gate in ``_execute_chart_runtime_for_table`` routes
        EVERY generated chart on a modeled dataset to the semantic engine
        regardless of this function's result. The engine then resolves a
        bare ref DETERMINISTICALLY (unique reachable view → qualify) or fails
        LOUD via ``_parse_field_ref`` (``AmbiguousFieldError`` when 2+ loaded
        views share the name → 400 with a "qualify it as view.field" hint;
        ValueError when the field exists on no reachable view).

        The previous tier-3 "cross-view trailing-segment scan" — which
        GUESSED a bare metric onto a same-named cross-view measure and, on
        miss/shadow/ambiguity, fell back to the live builder — is removed.
        That guess-then-fallback was the root of the recurring "wrong total
        / dropped filter / silent-wrong-table" class. No more guessing.
        """
        if not isinstance(metric, dict):
            return False
        field = str(metric.get("field") or "").strip()
        if not field:
            return False
        if "." in field:
            return True
        # Tier 1 — same-view declared measure lookup. Deterministic, no scan.
        if field in semantic_measures:
            return True
        if base and f"{base}.{field}" in semantic_measures:
            return True
        # STRICT — NO cross-view bare-ref GUESS. A bare metric that is not a
        # same-view declared measure is NOT heuristically promoted to a
        # cross-view measure here (the old "auto-guess then fall back to live"
        # pattern). The strict force-gate in `_execute_chart_runtime_for_table`
        # already routes every generated chart on a modeled dataset to the
        # semantic engine, which then resolves the bare ref DETERMINISTICALLY
        # (unique reachable view) or fails LOUD (ambiguous / unknown) via
        # `_parse_field_ref`. We never guess-then-fallback.
        return False

    # Metric with qualified field OR with a bare ref that resolves to a
    # declared semantic measure always needs the semantic engine — measure
    # formulas, filtered measures, dataset-scope, and context-modifier
    # measures all depend on it. Live builder has no idea what
    # ``view.metric_name`` means and silently drops any internal filter.
    cid = _pbi_current_chart_id()
    if role_config:
        for metric in role_config.get("metrics") or []:
            if _metric_needs_semantic(metric):
                # [pbi-filter] explain WHY we route semantic — the metric
                # is qualified or matches a declared measure that may
                # carry where_sql / filters. Temporary log; remove after
                # rollout validation.
                logger.info(
                    "[pbi-filter] routing=semantic chart_id=%s base=%s reason=metric metric=%r chart_type_hint=%s",
                    cid, base, (metric or {}).get("field"),
                    str(role_config.get("chartType") or role_config.get("chart_type") or "unknown"),
                )
                return True
        for key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
            if _metric_needs_semantic(role_config.get(key)):
                logger.info(
                    "[pbi-filter] routing=semantic chart_id=%s base=%s reason=%s metric=%r",
                    cid, base, key, (role_config.get(key) or {}).get("field"),
                )
                return True
    for ref in _collect_role_config_field_refs(role_config):
        if "." not in ref:
            continue
        view_part, _ = ref.split(".", 1)
        # When base is unknown OR the ref lives on a different view → the
        # live builder cannot serve this; only the semantic engine can.
        # Defensive: treat unknown-base as "definitely needs JOIN" so the
        # routing never silently drops to live_query for qualified refs.
        if not base or (view_part.strip() and view_part.strip() != base):
            return True
        # Same-view qualified ref → semantic anyway if it's a declared
        # measure/dim (formula, filter, alias rather than a raw column).
        if ref in semantic_fields or ref in semantic_measures:
            return True

    # Phase-15.81 v15 — scan filter refs the same way. A base filter on a
    # joined view forces semantic routing even when the role config is
    # bare-column only.
    for filt in runtime_filters or []:
        if not isinstance(filt, dict):
            continue
        for key in ("semanticField", "fieldKey", "field"):
            ref = str(filt.get(key) or "").strip()
            if not ref or "." not in ref:
                continue
            view_part, _ = ref.split(".", 1)
            if not base or (view_part.strip() and view_part.strip() != base):
                return True
            if ref in semantic_fields or ref in semantic_measures:
                return True
        # linkedFields can also point to joined views even when the
        # primary semanticField sits on the base view (DA-built Date
        # filter with fan-out across calendar + fact dim_date).
        for linked in filt.get("linkedFields") or []:
            ref = str(linked or "").strip()
            if not ref or "." not in ref:
                continue
            view_part, _ = ref.split(".", 1)
            if not base or (view_part.strip() and view_part.strip() != base):
                return True

    # [pbi-filter] log the live-route decision too so DA can spot charts
    # that are NOT going through semantic — these never see measure
    # where_sql/filters applied. Temporary instrumentation.
    logger.info(
        "[pbi-filter] routing=live chart_id=%s base=%s metrics=%s n_filters=%d",
        cid,
        base,
        [(m or {}).get("field") for m in (role_config.get("metrics") or [])] if role_config else [],
        len(runtime_filters or []),
    )
    return False


def _strip_nonsemantic_base_view_refs_from_role_config(
    role_config: dict,
    binding: dict[str, Any],
    base_view_name: str,
) -> dict:
    """Keep the live-query fallback compatible with old qualified field ids.

    Semantic fields are routed before this helper. If a non-semantic field is
    still stored as `base.field`, the legacy live builder must see `field`
    because it queries a single wrapped table and would otherwise quote
    `"base.field"` as a physical column name.
    """
    base = str(base_view_name or "").strip()
    if not base:
        return role_config

    semantic_fields = _binding_semantic_fields(binding)
    prefix = f"{base}."
    changed = False

    def strip_field(value: Any) -> Any:
        nonlocal changed
        if not isinstance(value, str):
            return value
        field = value.strip()
        if field.startswith(prefix) and field not in semantic_fields:
            changed = True
            return field[len(prefix):]
        return value

    def strip_metric(metric: Any) -> Any:
        if not isinstance(metric, dict):
            return metric
        field = metric.get("field")
        next_field = strip_field(field)
        if next_field == field:
            return metric
        return {**metric, "field": next_field}

    next_config = dict(role_config or {})
    for key in (
        "dimension", "breakdown", "timeField",
        "scatterX", "scatterY",
        "tableRowDimension", "tableColumnDimension",
    ):
        if key in next_config:
            next_config[key] = strip_field(next_config.get(key))

    if isinstance(next_config.get("selectedColumns"), list):
        next_config["selectedColumns"] = [
            strip_field(item)
            for item in next_config.get("selectedColumns") or []
        ]

    if isinstance(next_config.get("metrics"), list):
        next_config["metrics"] = [
            strip_metric(metric)
            for metric in next_config.get("metrics") or []
        ]

    for key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
        if key in next_config:
            next_config[key] = strip_metric(next_config.get(key))

    return next_config if changed else role_config


def _build_debug_response(runtime_result: dict) -> Optional[dict]:
    """Phase-15.9: shape the `_debug` payload from a chart runtime result
    into the public `ChartDebugInfo` schema. Folds in legacy top-level
    fields (`execution_time_ms`, `warnings`) so the inspector tab has
    everything in one object.

    Returns None when the result has no debug info (cache hit or older
    cached payload predating Phase-15.9). FE treats None as "inspector
    unavailable" rather than rendering an empty panel.
    """
    if not isinstance(runtime_result, dict):
        return None
    raw_debug = runtime_result.get("_debug")
    if not isinstance(raw_debug, dict):
        # Older cached results predate _debug. Surface what we can from
        # the legacy top-level keys so the inspector isn't totally blank
        # for cached hits.
        exec_ms = runtime_result.get("execution_time_ms")
        warnings = runtime_result.get("warnings") or []
        if exec_ms is None and not warnings:
            return None
        return {
            "execution_time_ms": exec_ms,
            "warnings": list(warnings),
        }
    return {
        "sql_emitted": raw_debug.get("sql_emitted"),
        "dialect": raw_debug.get("dialect"),
        "routing": raw_debug.get("routing"),
        "row_count": raw_debug.get("row_count"),
        # Promote top-level fields onto the same debug object — the FE
        # tab shouldn't have to walk multiple shapes.
        "execution_time_ms": runtime_result.get("execution_time_ms"),
        "warnings": list(runtime_result.get("warnings") or []),
        # Phase-15.78: forward structured drop log to the API response.
        "dropped_filters": list(raw_debug.get("dropped_filters") or []),
        # Dashboard perf #5 — snapshot freshness for the builder "as of" label.
        "data_source_mode": raw_debug.get("data_source_mode"),
        "snapshot_as_of": raw_debug.get("snapshot_as_of"),
        "snapshot_stale": raw_debug.get("snapshot_stale"),
        # Phase 8 (#47): planner decision surfaced end-to-end (state + why).
        "execution_state": raw_debug.get("execution_state"),
        "execution_reason": raw_debug.get("execution_reason"),
        "snapshot_generation": raw_debug.get("snapshot_generation"),
    }


def _build_semantic_alias_map(canonical_fields: list[str]) -> dict[str, str]:
    """Map engine SQL alias (`view_field`) → canonical caller ref (`view.field`).

    Mirrors `SemanticQueryEngine._safe_alias`. Used to rename keys in
    returned rows so the response contract matches the request (callers ask
    in `view.field` form, they get back `view.field` keyed rows)."""
    out: dict[str, str] = {}
    for raw in canonical_fields:
        canonical = str(raw or "").strip()
        if not canonical:
            continue
        # Must match SemanticQueryEngine._safe_alias: sanitize EVERY
        # non-identifier char (not just '.') so a space-containing column like
        # 'Activity Group' maps to the same alias the engine emitted.
        alias = re.sub(r"[^A-Za-z0-9_]", "_", canonical)
        # Two distinct refs cannot collide on the same alias because the
        # engine itself rejects that case; first-write-wins is safe.
        out.setdefault(alias, canonical)
    return out


def remap_semantic_engine_rows(
    rows: list[dict],
    alias_to_canonical: dict[str, str],
) -> list[dict]:
    """Rewrite each row's keys from engine aliases back to canonical refs.

    Unknown keys (e.g. window-function aliases, calculated fields) pass
    through unchanged. This keeps the row shape compatible with frontend
    chart adapters which lookup `row[roleConfig.dimension]`.
    """
    if not alias_to_canonical or not rows:
        return rows
    remapped: list[dict] = []
    for row in rows:
        new_row: dict[str, Any] = {}
        for key, value in row.items():
            new_row[alias_to_canonical.get(key, key)] = value
        remapped.append(new_row)
    return remapped


def _normalize_chart_name(name: str | None) -> str:
    return str(name or "").strip().lower()


def _find_chart_name_conflict(
    db: Session,
    name: str | None,
    *,
    owner_id=None,
    exclude_chart_id: int | None = None,
) -> Chart | None:
    normalized = _normalize_chart_name(name)
    if not normalized:
        return None

    query = db.query(Chart).filter(
        func.lower(func.trim(Chart.name)) == normalized,
    )
    if owner_id is None:
        query = query.filter(Chart.owner_id.is_(None))
    else:
        query = query.filter(Chart.owner_id == owner_id)
    if exclude_chart_id is not None:
        query = query.filter(Chart.id != exclude_chart_id)
    return query.first()


def _semantic_field_is_supported_by_binding(
    binding: dict[str, Any],
    semantic_field: str,
) -> bool:
    semantic_ref = str(semantic_field or "").strip()
    if not semantic_ref or "." not in semantic_ref:
        return True

    # Reachable set is computed via multi-hop BFS over the semantic model's
    # join graph (see semantic_join_resolver). A field is supported if it
    # belongs to a view reachable from this chart's base view via joins, OR
    # it appears in the explicit chart bindings (dimensionFields, fieldMap,
    # calendar mappings).
    reachable_fields = {
        str(value).strip()
        for value in (binding.get("reachableFields") or [])
        if str(value or "").strip()
    }
    reachable_views = {
        str(value).strip()
        for value in (binding.get("reachableViews") or [])
        if str(value or "").strip()
    }
    if semantic_ref in reachable_fields:
        return True
    semantic_view, _ = semantic_ref.split(".", 1)
    if semantic_view in reachable_views:
        return True

    supported_fields = {
        str(value).strip()
        for value in [
            *(binding.get("dimensionFields") or []),
            *(binding.get("measureFields") or []),
            *((binding.get("fieldMap") or {}).values()),
            *[
                mapping.get("semanticField")
                for mapping in (binding.get("calendarFieldMappings") or [])
                if isinstance(mapping, dict)
            ],
        ]
        if str(value or "").strip()
    }
    if semantic_ref in supported_fields:
        return True

    base_view_name = str(binding.get("baseViewName") or "").strip()
    return bool(base_view_name and semantic_ref.startswith(f"{base_view_name}."))


def _rewrite_calendar_filter_to_role(
    binding: dict[str, Any],
    semantic_field: str,
    raw_field: str | None,
) -> dict[str, Any] | None:
    """Phase-15.96 Bug B — translate a filter ref to the raw generated
    calendar view into the chart's role-played calendar alias. Returns
    the override dict or ``None``.

    Single-role rewrite path: when exactly ONE calendar role matches the
    filter's column, returns the override dict to merge into the filter.
    Multi-role cases are handled by :func:`_rewrite_calendar_filter_to_all_roles`
    which expands the filter into N AND'd filters (one per role).
    """
    rewrites = _rewrite_calendar_filter_to_all_roles(binding, semantic_field, raw_field)
    if rewrites is None or len(rewrites) != 1:
        return None
    return rewrites[0]


def _rewrite_calendar_filter_to_all_roles(
    binding: dict[str, Any],
    semantic_field: str,
    raw_field: str | None,
) -> list[dict[str, Any]] | None:
    """Calendar-filter rewrite — collapse role-played or raw-calendar
    references onto the underlying fact source column with calendar
    metadata. The engine WHERE-builder reads ``calendarField`` +
    ``calendarSourceField`` and emits a direct expression
    (``EXTRACT(YEAR FROM ...)`` etc.) on the source column — the SAME
    SQL shape Chart Explore's raw-column filter produces.

    Two convergence wins:

      1. **Identical SQL for the two UI paths.** Chart Explore filter
         on the raw fact column (Path A) and Dashboard FilterPane
         filter via the synthetic "Date" composite (Path B) now emit
         the same WHERE clause shape — fixes the long-standing
         "filter in chart works, filter in dashboard gives different
         result" complaint.

      2. **No role-played view dependency.** Earlier code emitted the
         role-played alias (``dataset_table_<id>__<col>__date_dim``)
         and trusted the engine to load it as a SemanticView. When
         calendar settings drift (table removed but auto_calendar
         joins persist), the engine crashed with
         ``View '<role>__date_dim' not found``. Now the engine never
         needs to load the role-played view for filter purposes; the
         expression is computed directly on the base fact column.

    Two input shapes are handled:

      • **Raw calendar** (``dataset_table_<calendar_id>.year``) — legacy
        FE codepath. Look up by ``calendarField`` in the binding's
        ``calendarFieldMappings``; each matching mapping yields ONE
        rewrite (so a chart with multiple calendar roles produces N
        AND'd filters — PBI intersection semantics preserved).
      • **Role-played alias** (``dataset_table_<id>__<col>__date_dim.year``)
        — current FE Dashboard composite. Look up by ``semanticField``;
        produces exactly one rewrite.

    Empty list / ``None`` means "no rewrite possible" — caller falls
    back to the original support check.
    """
    sem_ref = str(semantic_field or "").strip()
    if not sem_ref or "." not in sem_ref:
        return None
    sem_view, sem_field_name = sem_ref.split(".", 1)
    sem_view = sem_view.strip()
    sem_field_name = sem_field_name.strip()
    if not sem_view or not sem_field_name:
        return None

    all_mappings = [
        m for m in (binding.get("calendarFieldMappings") or [])
        if isinstance(m, dict)
    ]
    # The base view (fact table) the chart is anchored on. Role-played
    # date dims are always joined OFF this view, so it's the natural
    # target for the rewrite — and saves us from reverse-engineering the
    # base view name out of a slugified role-view alias (where the
    # column-name component was lowered + non-alnum normalized via
    # `_slugify` and no longer matches the raw `sourceField` byte-for-byte).
    base_view = str(binding.get("baseViewName") or "").strip()
    if not base_view:
        return None

    # Shape detection: does the incoming semanticField match a mapping
    # exactly (role-played input) or only by its calendar field name
    # (raw-calendar input)?
    direct_match = next(
        (m for m in all_mappings if str(m.get("semanticField") or "").strip() == sem_ref),
        None,
    )

    if direct_match is not None:
        # Role-played input — single rewrite targets one source column on
        # the chart's base view.
        source_field = str(direct_match.get("sourceField") or "").strip()
        calendar_field = str(direct_match.get("calendarField") or "").strip()
        if not source_field or not calendar_field:
            return None
        return [{
            "semanticField": f"{base_view}.{source_field}",
            "fieldKey": f"{base_view}.{source_field}",
            "field": source_field,
            "calendarField": calendar_field,
            "calendarSourceField": source_field,
        }]

    # Raw-calendar input — fan out to every fact role that exposes this
    # calendar field. PBI intersection semantics: filter applies if
    # EVERY role satisfies (multi-role facts get AND'd predicates).
    matching_by_field = [
        m for m in all_mappings
        if str(m.get("calendarField") or "").strip() == sem_field_name
    ]
    if not matching_by_field:
        return None

    # Deduplicate by source_field — multiple mappings of the same source
    # column to different calendar fields shouldn't happen but are
    # defensively coalesced here. All role-played dims hang off the same
    # base view, so we always emit on `binding.baseViewName`.
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for mapping in matching_by_field:
        source_field = str(mapping.get("sourceField") or "").strip()
        calendar_field = str(mapping.get("calendarField") or "").strip()
        role_ref = str(mapping.get("semanticField") or "").strip()
        if not source_field or not calendar_field or "." not in role_ref:
            continue
        role_view, _ = role_ref.split(".", 1)
        # Skip rewrite when input already targets the role view itself —
        # the direct-match branch above already handled that.
        if sem_view == role_view:
            continue
        if source_field in seen:
            continue
        seen.add(source_field)
        out.append({
            "semanticField": f"{base_view}.{source_field}",
            "fieldKey": f"{base_view}.{source_field}",
            "field": source_field,
            "calendarField": calendar_field,
            "calendarSourceField": source_field,
        })
    return out or None


def _log_calendar_rewrite(
    semantic_field: str,
    rewrites: list[dict[str, Any]] | None,
) -> None:
    """[pbi-filter] log calendar-filter rewrite events for prod debugging.

    Logs once per filter that was rewritten so DA can grep
    ``[pbi-filter] calendar-rewrite`` in docker logs and see exactly
    which dashboard slicer / chart filter got collapsed onto the source
    column. Temporary instrumentation; remove with the other entries
    after the rollout is validated.
    """
    if not rewrites:
        return
    cid = _pbi_current_chart_id()
    if len(rewrites) == 1:
        rw = rewrites[0]
        logger.info(
            "[pbi-filter] calendar-rewrite chart_id=%s single in=%s -> out=%s calendarField=%s sourceField=%s",
            cid,
            semantic_field,
            rw.get("semanticField"),
            rw.get("calendarField"),
            rw.get("calendarSourceField"),
        )
    else:
        logger.info(
            "[pbi-filter] calendar-rewrite chart_id=%s fanout in=%s -> %d roles: %s",
            cid,
            semantic_field,
            len(rewrites),
            [(r.get("semanticField"), r.get("calendarField")) for r in rewrites],
        )


def _resolve_legacy_calendar_filter_for_binding(
    binding: dict[str, Any],
    field_name: str,
) -> dict[str, str] | None:
    target = str(field_name or "").strip()
    if not target:
        return None

    source_fields = sorted(
        {
            str(mapping.get("sourceField") or "").strip()
            for mapping in (binding.get("calendarFieldMappings") or [])
            if isinstance(mapping, dict)
            and str(mapping.get("calendarField") or "").strip() == target
            and str(mapping.get("sourceField") or "").strip()
        }
    )
    if len(source_fields) != 1:
        return None

    source_field = source_fields[0]
    return {
        "field": source_field,
        "calendarField": target,
        "calendarSourceField": source_field,
    }


def _plain_field_is_supported_by_binding(
    binding: dict[str, Any],
    field_name: str,
) -> bool:
    target = str(field_name or "").strip()
    if not target:
        return False

    # Bug #1 fix (2026-05-26): when the caller passes a qualified field
    # like "dataset_table_145.metatype" but forgets the parallel
    # `semanticField` key, treat it as a semantic ref and defer to the
    # semantic-binding check instead of silently dropping it. This was
    # the source of "dashboard filter does nothing" — URL filters, AI
    # Bot calls, and any non-FE consumer were sending qualified refs
    # without the redundant semanticField pair, and the runtime tagged
    # every one as `binding_unsupported`.
    if "." in target:
        return _semantic_field_is_supported_by_binding(binding, target)

    base_view_name = str(binding.get("baseViewName") or "").strip()
    mapped_field_names = {
        str(key).strip()
        for key in (binding.get("fieldMap") or {}).keys()
        if str(key or "").strip()
    }
    calendar_source_fields = {
        str(mapping.get("sourceField") or "").strip()
        for mapping in (binding.get("calendarFieldMappings") or [])
        if isinstance(mapping, dict) and str(mapping.get("sourceField") or "").strip()
    }
    supported_semantic_fields = {
        str(value).strip()
        for value in [
            *(binding.get("dimensionFields") or []),
            *(binding.get("measureFields") or []),
            *((binding.get("fieldMap") or {}).values()),
            *[
                mapping.get("semanticField")
                for mapping in (binding.get("calendarFieldMappings") or [])
                if isinstance(mapping, dict)
            ],
        ]
        if str(value or "").strip()
    }

    if target in mapped_field_names or target in calendar_source_fields:
        return True
    if base_view_name and f"{base_view_name}.{target}" in supported_semantic_fields:
        return True

    has_binding_scope = bool(
        mapped_field_names
        or calendar_source_fields
        or supported_semantic_fields
    )
    return not has_binding_scope


def _normalize_runtime_filters_for_chart(
    chart_config: dict | None,
    filters: list | None,
    *,
    include_joined_semantic: bool = False,
    diagnostics: list[dict] | None = None,
    db=None,
) -> list[dict]:
    """Filter the incoming runtime filter list down to what's safely
    applicable to *this* chart's semantic binding.

    Phase-15.78 — every dropped filter is logged at WARNING and, when the
    caller provides a `diagnostics` list, appended as a structured entry
    `{field, semantic_field, operator, reason, detail}`. Chart-data
    endpoints forward this into `ChartDebugInfo.dropped_filters` so the
    user can see exactly which filters their tile ignored and why.
    Reasons: dataset_mismatch, binding_unsupported, unreachable_view,
    plus the Phase-2 propagation drops: wrong_direction, ambiguous_path,
    no_primary_key.

    Phase 2.3 — when ``db`` is supplied AND ``FEATURE_PROPAGATION_ENGINE_V2``
    is on, the joined-view support check is replaced by a call to
    :func:`resolve_filter_propagation`. The propagation engine considers
    cardinality + cross_filter direction (PBI parity) rather than the
    binding's flat ``reachableViews`` set. Callers that don't pass ``db``
    (legacy / non-DB contexts) keep the original behavior.
    """
    normalized_filters = normalize_filter_conditions(filters, diagnostics=diagnostics)
    if not normalized_filters:
        return []

    binding = (
        chart_config.get("semanticBinding")
        if isinstance(chart_config, dict) and isinstance(chart_config.get("semanticBinding"), dict)
        else {}
    )
    dataset_id = binding.get("datasetId")
    base_view_name = str(binding.get("baseViewName") or "").strip()

    # Phase 2.3 — lazy-bind a propagation resolver when DB + flag are present.
    # The resolver inspects cardinality/cross_filter edges in the semantic
    # model; when it can't be built (no model_id, model missing, exception),
    # propagation routing is skipped and we fall back to legacy binding-check.
    _prop_resolver = None
    _prop_helpers = None
    try:
        from app.core.config import settings as _prop_settings
        if (
            db is not None
            and bool(getattr(_prop_settings, "FEATURE_PROPAGATION_ENGINE_V2", False))
            and base_view_name
        ):
            model_id = binding.get("modelId") or binding.get("model_id")
            if model_id:
                from app.models.semantic import SemanticModel
                from app.services.semantic_join_resolver import SemanticJoinResolver
                from app.services.filter_propagation import (
                    resolve_filter_propagation,
                    PropagationMode,
                )
                _model = (
                    db.query(SemanticModel)
                    .filter(SemanticModel.id == model_id)
                    .first()
                )
                if _model is not None:
                    _prop_resolver = SemanticJoinResolver(
                        db, _model, base_view_name, bidirectional=False,
                    )
                    _prop_helpers = (resolve_filter_propagation, PropagationMode)
    except Exception:
        # Defensive: never let propagation wiring fail this normalizer; legacy
        # path is correct + reachable, just less precise. Log at debug level.
        logger.debug("Propagation resolver init failed in filter normalizer", exc_info=True)
        _prop_resolver = None
        _prop_helpers = None

    result: list[dict] = []
    for filt in normalized_filters:
        filter_dataset_id = filt.get("datasetId")
        if dataset_id is not None and filter_dataset_id is not None and filter_dataset_id != dataset_id:
            _record_dropped_filter(
                diagnostics,
                filt,
                "dataset_mismatch",
                f"filter targets dataset {filter_dataset_id} but chart binds to dataset {dataset_id}",
            )
            continue

        semantic_field = str(
            filt.get("semanticField")
            or filt.get("fieldKey")
            or ""
        ).strip()
        # Bug #1 fix (2026-05-26): infer semanticField from a qualified
        # `field` ref so external/URL/AI-Bot callers that omit the
        # parallel key go through the same join-graph routing as FE.
        if not semantic_field and isinstance(filt.get("field"), str) and "." in filt["field"]:
            semantic_field = filt["field"].strip()
            filt = {**filt, "semanticField": semantic_field}
        # Calendar-filter rewrite — runs unconditionally when the filter
        # ref looks like a calendar reference (raw calendar view OR
        # role-played alias). The rewrite lands the filter on the
        # underlying fact column with `calendarField` + `calendarSourceField`
        # metadata; the WHERE-builder emits a direct expression
        # (``EXTRACT(YEAR FROM …)``) on the source column, identical to
        # what Chart Explore's raw-column filter produces.
        #
        # Two reasons to ALWAYS try the rewrite (even when the binding
        # claims to support the ref):
        #   1. The role-played alias is in the binding's
        #      `calendarFieldMappings` — so the legacy support check
        #      returns True and the legacy code passed it through
        #      unchanged. The SQL engine then tried to load the
        #      role-played view as a SemanticView and crashed when
        #      calendar settings had drifted (no calendar table → no
        #      role-view rows). Bypassing the JOIN entirely removes
        #      that fragile dependency.
        #   2. The rewrite produces the SAME SQL shape as Chart Explore's
        #      raw-column filter, so Dashboard FilterPane (Path B) and
        #      Chart Explore (Path A) emit identical predicates — fixes
        #      "filter in chart works but dashboard filter gives different
        #      result" complaints.
        #
        # PBI intersection semantics preserved: a raw calendar ref on a
        # chart with multiple calendar roles fans out into N filters
        # (one per fact role), AND'd downstream.
        if semantic_field and "." in semantic_field:
            multi = _rewrite_calendar_filter_to_all_roles(
                binding, semantic_field, filt.get("field"),
            )
            _log_calendar_rewrite(semantic_field, multi)
            if multi and len(multi) > 1:
                # Expand: emit one filter per role with identical operator/value.
                # Skip the downstream single-filter append (`result.append(filt)`)
                # by recording each expansion directly and `continue`-ing.
                for rw in multi:
                    expanded = {**filt, **rw}
                    result.append(expanded)
                continue
            if multi and len(multi) == 1:
                filt = {**filt, **multi[0]}
                semantic_field = multi[0].get("semanticField") or semantic_field
        if semantic_field and "." in semantic_field and not _semantic_field_is_supported_by_binding(binding, semantic_field):
            # Phase 2.3 — when the propagation engine is wired, DEFER to it.
            # The binding's reachableViews set is a flat (no-cardinality, no-
            # direction) snapshot; the engine has richer knowledge. Skip this
            # legacy drop and let the engine decide downstream.
            if _prop_resolver is None or _prop_helpers is None:
                _record_dropped_filter(
                    diagnostics,
                    filt,
                    "binding_unsupported",
                    f"semantic field {semantic_field!r} is not exposed by this chart's binding",
                )
                continue

        if not semantic_field or "." not in semantic_field:
            legacy_calendar_filter = _resolve_legacy_calendar_filter_for_binding(binding, filt.get("field"))
            if legacy_calendar_filter is not None:
                result.append(
                    {
                        **filt,
                        **legacy_calendar_filter,
                    }
                )
                continue

            if not _plain_field_is_supported_by_binding(binding, filt.get("field")):
                _record_dropped_filter(
                    diagnostics,
                    filt,
                    "binding_unsupported",
                    f"plain field {filt.get('field')!r} is not in the chart's base view",
                )
                continue
            result.append(filt)
            continue

        semantic_view, _semantic_name = semantic_field.split(".", 1)
        if semantic_view == base_view_name:
            result.append(filt)
            continue

        # Phase 2.3 — when the propagation engine is wired, ask IT whether
        # the filter is applicable instead of trusting the binding's flat
        # ``reachableViews`` set. The engine encodes cardinality + direction
        # rules (PBI parity) so a filter rejected here for `wrong_direction`
        # would otherwise have silently propagated incorrectly through the
        # SELECT-side JOIN chain. Drop reasons surfaced to UI via diagnostics.
        if _prop_resolver is not None and _prop_helpers is not None:
            _resolve_prop, _Mode = _prop_helpers
            try:
                prop = _resolve_prop(
                    _prop_resolver,
                    base_view_name,
                    semantic_field,
                )
            except Exception:
                logger.debug(
                    "Propagation resolve failed for filter %r", semantic_field,
                    exc_info=True,
                )
                prop = None
            if prop is not None and prop.mode == _Mode.DROP:
                _record_dropped_filter(
                    diagnostics,
                    filt,
                    (prop.reason.value if prop.reason else "unreachable_view"),
                    prop.detail or (
                        f"propagation engine rejected {semantic_field!r}: no valid path"
                    ),
                )
                continue
            if prop is not None:
                # PLAIN / JOIN_CHAIN / EXISTS / SYMMETRIC all keep the filter;
                # downstream SQL engine handles emission shape per mode.
                result.append(filt)
                continue

        if include_joined_semantic:
            # Only forward joined-view filters when the target view is
            # actually reachable from this chart's base view via the
            # semantic model's join graph. The SQL adapter will resolve
            # the actual join chain.
            reachable_views = {
                str(v).strip()
                for v in (binding.get("reachableViews") or [])
                if str(v or "").strip()
            }
            if reachable_views and semantic_view not in reachable_views:
                _record_dropped_filter(
                    diagnostics,
                    filt,
                    "unreachable_view",
                    f"view {semantic_view!r} is not reachable from {base_view_name!r} via the semantic join graph",
                )
                continue
            result.append(filt)
        else:
            # include_joined_semantic=False: anything outside the base view
            # is not consumable in this call path.
            _record_dropped_filter(
                diagnostics,
                filt,
                "binding_unsupported",
                f"joined-view filter on {semantic_field!r} skipped — caller did not enable joined-semantic mode",
            )

    return result


def _semantic_view_has_field(semantic_view, field_name: str) -> bool:
    target = str(field_name or "").strip()
    if not target:
        return False
    return any(
        str(item.get("name") or "").strip() == target
        for item in [*(getattr(semantic_view, "dimensions", None) or []), *(getattr(semantic_view, "measures", None) or [])]
    )


def _render_live_semantic_field_sql(
    field_def: dict,
    field_name: str,
    table_alias: str,
) -> str | None:
    sql_template = str(field_def.get("sql") or field_name).strip()
    if not sql_template or sql_template == "*":
        return None
    if "${TABLE}" in sql_template:
        return sql_template.replace("${TABLE}", table_alias)
    if _SIMPLE_SQL_IDENTIFIER_RE.fullmatch(sql_template):
        return f"{table_alias}.{sql_template}"
    return None


def _build_live_relation_for_semantic_view(
    db: Session,
    datasource,
    semantic_view,
) -> str | None:
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource
    from app.services.live_query_service import build_live_base_query_plan

    dataset_table_id = getattr(semantic_view, "dataset_table_id", None)
    if dataset_table_id:
        joined_table = db.query(DatasetTable).filter(DatasetTable.id == dataset_table_id).first()
        if not joined_table:
            pass
        elif is_generated_calendar_table(joined_table) or is_derived_table(joined_table):
            from app.models.dataset import Dataset

            dataset_obj = db.query(Dataset).filter(Dataset.id == joined_table.dataset_id).first()
            if dataset_obj is None:
                return None
            try:
                _, live_proxy_table = build_live_proxy_table_for_dataset_table(
                    db,
                    dataset_obj,
                    joined_table,
                )
                return getattr(live_proxy_table, "source_query", None)
            except DatasetTableSqlError:
                pass
        else:
            joined_datasource = db.query(DataSource).filter(DataSource.id == joined_table.datasource_id).first()
            if joined_datasource and joined_datasource.id == datasource.id:
                try:
                    # Specialty: semantic view definition is shared across
                    # consumers, so it must NOT bake in this dataset's casts.
                    # Type overrides will be applied by the consumer's chart
                    # query when it wraps this view. Do NOT route through
                    # resolve_dataset_table_relation here.
                    return build_live_base_query_plan(
                        joined_datasource,
                        joined_table,
                        apply_type_overrides=False,
                    ).sql
                except Exception:
                    logger.debug(
                        "Falling back to semantic sql_table_name for live join view %s",
                        getattr(semantic_view, "name", None),
                        exc_info=True,
                    )

    sql_table_name = str(getattr(semantic_view, "sql_table_name", "") or "").strip()
    return sql_table_name or None


_LEADING_SQL_KW_RE = re.compile(r"^(?:select|with)\b", re.IGNORECASE)


def _wrap_live_sql_relation(relation: str) -> str:
    """Wrap a raw `SELECT ...` / `WITH ...` subquery in parens so it can sit
    after `FROM`/`JOIN`. The original check used ``startswith("select ")`` —
    a literal SPACE — which silently MISSED multi-line queries like the
    generated_calendar proxy (``SELECT\\n  d AS date, ...``). The unwrapped
    relation then landed in the distinct-values EXISTS as
    ``FROM SELECT d AS date, ...`` and BigQuery rejected the whole query
    with ``Unexpected keyword SELECT`` (production log 2026-05-28).
    Use a word-boundary regex so any whitespace (space, newline, tab) after
    the keyword counts.
    """
    text = str(relation or "").strip().rstrip(";")
    if not text:
        return text
    if text.startswith("("):
        return text
    if _LEADING_SQL_KW_RE.match(text):
        return f"({text})"
    return text


def _render_live_join_condition(
    join_def: dict[str, Any],
    join_alias: str,
    *,
    base_alias: str = "_appbi_base",
) -> str | None:
    sql_on = str(join_def.get("sql_on") or "").strip()
    join_view = str(join_def.get("view") or "").strip()
    if sql_on and join_view:
        return (
            sql_on
            .replace("${TABLE}", base_alias)
            .replace(f"${{{join_view}}}", join_alias)
        )

    join_from_column = str(join_def.get("from_column") or "").strip()
    join_to_column = str(join_def.get("to_column") or "").strip()
    if join_from_column and join_to_column:
        return f"{base_alias}.{join_from_column} = {join_alias}.{join_to_column}"
    return None


def _render_step_join_condition(
    edge,
    *,
    from_alias: str,
    to_alias: str,
) -> str | None:
    """Render a JOIN ON condition for a JoinEdge between two SQL aliases.

    Prefers the raw `sql_on` template when present (replacing ${TABLE} →
    from_alias and ${view} / ${alias} → to_alias). Falls back to
    from_column/to_column equality when the template is absent.

    NOTE (semantic-audit 2026-07 #1): the ENGINE's renderer
    (`SemanticQueryEngine._typed_join_condition`) additionally coerces
    mixed STRING/number join keys (Sheets/Airbyte keys stored as text →
    BigQuery 400 on `STRING = INT64`). This live-path helper renders the
    raw template untyped — if a mixed-type key join surfaces here (filter
    EXISTS on the live path / distinct cascade), port that coercion.
    """
    sql_on = str(edge.sql_on or "").strip()
    if sql_on:
        rendered = sql_on.replace("${TABLE}", from_alias)
        # Replace alias-keyed placeholder (preferred when role-played) and
        # the raw view-keyed placeholder (legacy joins).
        if edge.to_node and edge.to_node != edge.to_view:
            rendered = rendered.replace(f"${{{edge.to_node}}}", to_alias)
        rendered = rendered.replace(f"${{{edge.to_view}}}", to_alias)
        # Audit #4 — expand the calendar-timezone local-date macro. This
        # helper has no dialect context; the generic expansion falls back to
        # CAST(expr AS DATE) (pre-timezone behaviour) so a macro can never
        # leak raw into SQL on the live/distinct paths.
        if "APPBI_LOCAL_DATE" in rendered:
            from app.services.dataset_calendar_service import expand_local_date_macros

            rendered = expand_local_date_macros(rendered, None)
        return rendered

    if edge.from_column and edge.to_column:
        return f"{from_alias}.{edge.from_column} = {to_alias}.{edge.to_column}"
    return None


def _adapt_live_sql_for_semantic_filters(
    db: Session,
    datasource,
    db_table,
    chart_config: dict | None,
    filters: list | None,
) -> tuple[str | None, list[dict]]:
    """Wrap base SQL with multi-hop joins so dashboard filters that target
    fields on joined views can be applied.

    Strategy:
    1. For each filter referencing a joined view (`alias.field`), use the
       SemanticJoinResolver to compute a join path from base_view to the
       target node.
    2. Materialize each unique step in the chain as a LEFT JOIN with a
       deterministic SQL alias.
    3. Project the target field as `__sem_filter_N` on the wrapping SELECT
       and rewrite the filter to reference that projection alias.
    """
    normalized_filters = _normalize_runtime_filters_for_chart(
        chart_config,
        filters,
        include_joined_semantic=True,
        db=db,
    )
    if not normalized_filters:
        return None, []

    binding = (
        chart_config.get("semanticBinding")
        if isinstance(chart_config, dict) and isinstance(chart_config.get("semanticBinding"), dict)
        else {}
    )
    base_view_name = str(binding.get("baseViewName") or "").strip()
    model_id = binding.get("modelId")
    if not base_view_name:
        return None, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    from app.models.semantic import SemanticModel, SemanticView
    from app.services.dataset_relation_service import resolve_dataset_table_relation
    from app.services.semantic_join_resolver import SemanticJoinResolver

    model = (
        db.query(SemanticModel).filter(SemanticModel.id == model_id).first()
        if model_id
        else None
    )
    # bidirectional=True so snowflake schemas resolve correctly: when the
    # chart base is a dim (e.g. bc_owner) and the filter references another
    # dim (e.g. Date) that only connects through a shared fact (bc_deal /
    # bc_revenue), the resolver must be able to traverse the fact in the
    # *reverse* direction of the stored join. Without this, resolve_path()
    # returns None for the cross-dim target and the filter is silently
    # dropped — matching the user-reported "Date filter không ăn vào chart
    # bc_owner" symptom. The engine path (semantic_query_engine.py) already
    # uses bidirectional=True for the same reason.
    resolver = SemanticJoinResolver(db, model, base_view_name, bidirectional=True)

    try:
        base_sql = resolve_dataset_table_relation(datasource, db_table).sql
    except Exception:
        logger.debug("Failed to build base live SQL for semantic runtime filters", exc_info=True)
        return None, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    # Track materialized join steps. Key = (from_alias_sql, to_node) so that
    # a path of length N spawns N JOINs but two filters that share a prefix
    # reuse them (e.g. orders → customers → addresses, plus another filter
    # on customers.country reuses the customers join).
    materialized_steps: dict[tuple[str, str], str] = {}
    join_clauses: list[str] = []
    projected_fields: list[dict[str, str]] = []
    effective_filters: list[dict] = []
    next_join_index = 0
    next_projection_index = 0

    # cache SemanticView lookups
    view_cache: dict[str, SemanticView | None] = {}
    dataset_table_ids: set[int] = set()
    if getattr(model, "dataset_id", None) is not None:
        try:
            from app.models.dataset import DatasetTable

            dataset_table_ids = {
                int(row.id)
                for row in db.query(DatasetTable.id)
                .filter(DatasetTable.dataset_id == model.dataset_id)
                .all()
            }
        except Exception:
            dataset_table_ids = set()

    def _get_view(view_name: str) -> SemanticView | None:
        if view_name in view_cache:
            return view_cache[view_name]
        result = (
            db.query(SemanticView)
            .filter(
                SemanticView.name == view_name,
                SemanticView.dataset_table_id.in_(dataset_table_ids),
            )
            .first()
            if dataset_table_ids
            else None
        )
        if result is None:
            result = (
                db.query(SemanticView)
                .filter(
                    SemanticView.name == view_name,
                    SemanticView.dataset_table_id.is_(None),
                )
                .first()
            )
        view_cache[view_name] = result
        return result

    for filt in normalized_filters:
        semantic_field = str(
            filt.get("semanticField")
            or filt.get("fieldKey")
            or ""
        ).strip()
        if not semantic_field or "." not in semantic_field:
            effective_filters.append(filt)
            continue

        target_node, semantic_name = semantic_field.split(".", 1)
        if target_node == base_view_name:
            effective_filters.append(filt)
            continue

        path = resolver.resolve_path(target_node)
        if path is None:
            # not reachable — skip this filter for this chart
            continue

        # Materialize each step. Use stable alias based on path prefix so
        # shared prefixes reuse the same JOIN.
        prev_alias = "_appbi_base"
        last_alias = prev_alias
        path_failed = False
        for step in path.steps:
            cache_key = (prev_alias, step.edge.to_node)
            existing_alias = materialized_steps.get(cache_key)
            if existing_alias is not None:
                last_alias = existing_alias
                prev_alias = existing_alias
                continue

            joined_view = _get_view(step.edge.to_view)
            if joined_view is None:
                path_failed = True
                break
            relation = _build_live_relation_for_semantic_view(db, datasource, joined_view)
            if not relation:
                path_failed = True
                break

            new_alias = f"_appbi_sem_join_{next_join_index}"
            next_join_index += 1
            condition = _render_step_join_condition(
                step.edge,
                from_alias=prev_alias,
                to_alias=new_alias,
            )
            # Validate the to_column actually exists; rebuild if necessary.
            to_col = step.edge.to_column
            if condition and to_col and not _semantic_view_has_field(joined_view, to_col):
                # try fallback: maybe to_column is misnamed but from_column exists
                from_col = step.edge.from_column
                if from_col and _semantic_view_has_field(joined_view, from_col):
                    condition = f"{prev_alias}.{from_col} = {new_alias}.{from_col}"
                else:
                    condition = None
            if not condition:
                path_failed = True
                break

            join_kw = (step.edge.type or "left").upper()
            join_clauses.append(
                f"{join_kw} JOIN {_wrap_live_sql_relation(relation)} AS {new_alias} "
                f"ON {condition}"
            )
            materialized_steps[cache_key] = new_alias
            prev_alias = new_alias
            last_alias = new_alias

        if path_failed:
            continue

        # Resolve the field def on the target view
        target_view_name = resolver.view_for_node(target_node) or target_node
        target_view = _get_view(target_view_name)
        if target_view is None:
            continue
        field_def = next(
            (
                item
                for item in [
                    *(target_view.dimensions or []),
                    *(target_view.measures or []),
                ]
                if str(item.get("name") or "").strip() == semantic_name
            ),
            None,
        )
        if not field_def:
            continue

        rendered_expr = _render_live_semantic_field_sql(field_def, semantic_name, last_alias)
        if not rendered_expr:
            continue

        projection_alias = f"__sem_filter_{next_projection_index}"
        next_projection_index += 1
        projected_fields.append({"expr": rendered_expr, "alias": projection_alias})
        effective_filters.append({**filt, "field": projection_alias})

    if not join_clauses or not projected_fields:
        return None, _normalize_runtime_filters_for_chart(chart_config, normalized_filters)

    select_parts = ["_appbi_base.*"]
    select_parts.extend(
        f'{field["expr"]} AS {field["alias"]}'
        for field in projected_fields
    )
    enriched_sql = (
        f'SELECT {", ".join(select_parts)} '
        f'FROM ({base_sql}) AS _appbi_base '
        f'{" ".join(join_clauses)}'
    )
    logger.debug("Semantic enriched SQL: %s", enriched_sql)
    return enriched_sql, effective_filters


def _find_dataset_datasource(db: Session, dataset_obj) -> Optional[Any]:
    """Find any available datasource from the dataset's tables (for calendar table execution)."""
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource

    tables = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == dataset_obj.id,
            DatasetTable.datasource_id.isnot(None),
        )
        .limit(1)
        .all()
    )
    if not tables:
        return None
    return db.query(DataSource).filter(DataSource.id == tables[0].datasource_id).first()


def _semantic_binding_for_runtime_table(
    db: Session,
    table,
) -> dict[str, Any] | None:
    table_id = getattr(table, "id", None)
    if table_id is None:
        return None
    return resolve_chart_semantic_binding(
        db,
        int(table_id),
        {},
        auto_generate=True,
    )


def _build_row_filtered_live_relation_sql(
    db: Session,
    datasource,
    db_table,
    filters: list[dict] | None,
    *,
    semantic_binding: dict[str, Any] | None = None,
) -> str:
    from app.services.live_query_service import (
        _build_where_clause,
        _dialect_for_ds_type,
    )
    from app.services.dataset_relation_service import resolve_dataset_table_relation

    normalized_filters = normalize_filter_conditions(filters)
    base_plan = resolve_dataset_table_relation(datasource, db_table)
    base_sql = base_plan.sql
    available_fields = {
        str(name).strip()
        for name in (base_plan.output_columns or [])
        if str(name).strip()
    }
    applicable_filters: list[dict] = []
    for filt in normalized_filters:
        semantic_field = str(
            filt.get("semanticField")
            or filt.get("fieldKey")
            or ""
        ).strip()
        if semantic_field and "." in semantic_field:
            applicable_filters.append(filt)
            continue

        field_name = str(filt.get("field") or "").strip()
        if not available_fields or not field_name or field_name in available_fields:
            applicable_filters.append(filt)

    relation_sql = base_sql
    effective_filters = applicable_filters
    if semantic_binding:
        adapted_sql, adapted_filters = _adapt_live_sql_for_semantic_filters(
            db,
            datasource,
            db_table,
            {"semanticBinding": semantic_binding},
            applicable_filters,
        )
        if adapted_sql:
            relation_sql = adapted_sql
        effective_filters = adapted_filters

    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    dialect = _dialect_for_ds_type(ds_type)
    where_clause = _build_where_clause(effective_filters, dialect)
    if not where_clause:
        return relation_sql
    return f"SELECT * FROM ({relation_sql}) AS _appbi_runtime_filtered WHERE {where_clause}"


def _build_filtered_live_sql_for_dataset_table(
    db: Session,
    dataset_obj,
    table,
    filters: list[dict] | None,
    *,
    visited_table_ids: list[int] | None = None,
    required_datasource_id: int | None = None,
) -> tuple[Any, str]:
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource
    from app.services.live_query_service import (
        _dialect_for_ds_type,
        _quote_identifier,
    )

    normalized_filters = normalize_filter_conditions(filters)

    if is_generated_calendar_table(table):
        datasource, live_sql = dataset_table_sql_service.build_dataset_table_live_query(
            db,
            dataset_obj,
            table,
            required_datasource_id=required_datasource_id,
        )
        proxy_table = SimpleNamespace(
            id=getattr(table, "id", None),
            dataset_id=getattr(table, "dataset_id", getattr(dataset_obj, "id", None)),
            datasource_id=datasource.id,
            source_kind="sql_query",
            source_table_name=None,
            source_query=live_sql,
            display_name=getattr(table, "display_name", None),
            enabled=getattr(table, "enabled", True),
            transformations=[],
            type_overrides=getattr(table, "type_overrides", None),
            columns_cache=getattr(table, "columns_cache", None),
        )
        return datasource, _build_row_filtered_live_relation_sql(
            db,
            datasource,
            proxy_table,
            normalized_filters,
            semantic_binding=_semantic_binding_for_runtime_table(db, table),
        )

    if not is_derived_table(table):
        datasource_id = getattr(table, "datasource_id", None)
        datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first() if datasource_id else None
        if datasource is None:
            raise DatasetTableSqlError(
                f'Table "{getattr(table, "display_name", getattr(table, "source_table_name", "Unknown"))}" has no datasource.',
                code="DATASOURCE_NOT_FOUND",
            )
        if required_datasource_id is not None and int(datasource.id) != int(required_datasource_id):
            raise DatasetTableSqlError(
                "Live calculated tables can only reference tables from the same datasource.",
                code="NOT_SYNCED",
            )
        return datasource, _build_row_filtered_live_relation_sql(
            db,
            datasource,
            table,
            normalized_filters,
            semantic_binding=_semantic_binding_for_runtime_table(db, table),
        )

    current_table_id = getattr(table, "id", None)
    display_name = str(getattr(table, "display_name", "") or f"Table {current_table_id or ''}").strip()
    if current_table_id is not None and current_table_id in set(visited_table_ids or []):
        cycle_chain = " -> ".join(str(item) for item in [*(visited_table_ids or []), current_table_id])
        raise DatasetTableSqlError(
            f"Calculated table dependency cycle detected: {cycle_chain}",
            code="CIRCULAR_DEPENDENCY",
        )

    source_query = str(getattr(table, "source_query", "") or "").strip()
    cleaned_query = dataset_table_sql_service.validate_and_clean_derived_query(source_query)
    dependency_ids = dataset_table_sql_service.collect_derived_dependency_table_ids(
        db,
        dataset_obj.id,
        cleaned_query,
        exclude_table_id=current_table_id,
    )
    dependency_tables = {
        int(dep.id): dep
        for dep in (
            db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_obj.id)
            .filter(DatasetTable.id.in_(dependency_ids))
            .all()
        )
    }
    all_dataset_tables = db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_obj.id).all()
    dataset_alias_map = dataset_table_sql_service.build_dataset_table_reference_alias_map(
        all_dataset_tables
    )
    alias_to_technical = dataset_table_sql_service.build_dataset_table_alias_replacement_map(
        all_dataset_tables,
        table_ids=dependency_ids,
    )

    resolved_datasource = None
    ctes: list[str] = []
    next_visited = [*(visited_table_ids or [])]
    if current_table_id is not None:
        next_visited.append(int(current_table_id))

    ordered_dependency_ids = [
        *[
            dependency_id
            for dependency_id in dependency_ids
            if not is_generated_calendar_table(dependency_tables.get(int(dependency_id)))
        ],
        *[
            dependency_id
            for dependency_id in dependency_ids
            if is_generated_calendar_table(dependency_tables.get(int(dependency_id)))
        ],
    ]

    for dependency_id in ordered_dependency_ids:
        dependency_table = dependency_tables.get(int(dependency_id))
        if dependency_table is None:
            raise DatasetTableSqlError(
                f'Calculated table "{display_name}" references a missing table alias: {dataset_alias_map.get(int(dependency_id), dataset_table_sql_service.build_dataset_table_sql_alias(int(dependency_id)))}',
                code="INVALID_DATASET_SQL",
            )

        dependency_datasource, dependency_sql = _build_filtered_live_sql_for_dataset_table(
            db,
            dataset_obj,
            dependency_table,
            normalized_filters,
            visited_table_ids=next_visited,
            required_datasource_id=(
                int(resolved_datasource.id)
                if resolved_datasource is not None
                else required_datasource_id
            ),
        )
        if resolved_datasource is None:
            resolved_datasource = dependency_datasource
        elif int(dependency_datasource.id) != int(resolved_datasource.id):
            raise DatasetTableSqlError(
                "Live calculated tables can only reference tables from the same datasource.",
                code="NOT_SYNCED",
            )

        ds_type = dependency_datasource.type if isinstance(dependency_datasource.type, str) else dependency_datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        alias = dataset_table_sql_service.build_dataset_table_sql_alias(int(dependency_id))
        quoted_alias = _quote_identifier(alias, dialect)
        ctes.append(f"{quoted_alias} AS (\n{dataset_table_sql_service._indent_sql(dependency_sql)}\n)")

    if resolved_datasource is None:
        raise DatasetTableSqlError(
            f'Calculated table "{display_name}" could not resolve a live datasource.',
            code="NOT_SYNCED",
        )

    ds_type = resolved_datasource.type if isinstance(resolved_datasource.type, str) else resolved_datasource.type.value
    dialect = _dialect_for_ds_type(ds_type)
    if alias_to_technical:
        cleaned_query = dataset_table_sql_service.rewrite_dataset_table_aliases_in_sql(
            cleaned_query,
            alias_to_technical,
            output_dialect=dialect,
        )
    derived_alias = _quote_identifier("_derived_table", dialect)
    base_query = f"SELECT * FROM (\n{dataset_table_sql_service._indent_sql(cleaned_query)}\n) AS {derived_alias}"
    if ctes:
        base_query = "WITH " + ",\n".join(ctes) + "\n" + base_query
    base_query = dataset_table_sql_service._apply_table_transformations(
        base_query,
        table,
        dialect=dialect,
    )
    proxy_table = SimpleNamespace(
        id=getattr(table, "id", None),
        dataset_id=getattr(table, "dataset_id", getattr(dataset_obj, "id", None)),
        datasource_id=resolved_datasource.id,
        source_kind="sql_query",
        source_table_name=None,
        source_query=base_query,
        display_name=getattr(table, "display_name", None),
        enabled=getattr(table, "enabled", True),
        transformations=[],
        type_overrides=getattr(table, "type_overrides", None),
        columns_cache=getattr(table, "columns_cache", None),
    )
    return resolved_datasource, _build_row_filtered_live_relation_sql(
        db,
        resolved_datasource,
        proxy_table,
        normalized_filters,
        semantic_binding=_semantic_binding_for_runtime_table(db, table),
    )


def _is_missing_relation_error(exc: Exception) -> bool:
    """True when a query failed because a physical table/relation is missing —
    e.g. a snapshot table dropped by BigQuery table-expiration (or GC) while the
    registry still marks it current. Used to fall back to a LIVE query + trigger a
    rebuild instead of failing the whole chart.

    Phase 8 (#44): detection is CODE-FIRST — the provider's typed exception
    (google NotFound / psycopg2 UndefinedTable) is checked on the exception AND
    its cause chain before any string matching. The string fallback is kept for
    wrapped/re-raised errors but narrowed: the bare \"404\" token is gone (any
    error message containing an id like 404… used to trigger a spurious live
    retry)."""
    # 1) typed provider exceptions (walk the cause/context chain)
    seen = set()
    node: Optional[BaseException] = exc
    while node is not None and id(node) not in seen:
        seen.add(id(node))
        try:
            from google.api_core.exceptions import NotFound as _GNotFound
            if isinstance(node, _GNotFound):
                return True
        except Exception:  # noqa: BLE001 — google lib absent → skip
            pass
        try:
            from psycopg2 import errors as _pg_errors
            if isinstance(node, (_pg_errors.UndefinedTable,)):
                return True
        except Exception:  # noqa: BLE001 — psycopg2 absent → skip
            pass
        node = node.__cause__ or node.__context__
    # 2) narrowed string fallback (wrapped errors that lost their type)
    msg = str(exc).lower()
    return (
        "not found: table" in msg   # BigQuery message shape
        or "was not found" in msg
        or "does not exist" in msg  # Postgres-style relation errors
    )


def _detect_foreign_dialect_leak(sql: str, dialect: str) -> Optional[str]:
    """If a query GENERATED for `dialect` contains syntax only ANOTHER engine
    understands, return a short human reason; else None. The real-world trigger
    is a cross-source dataset: one table's native SQL (e.g. a BigQuery sql_query
    table with `project.dataset.table` backtick refs) inlined into a DuckDB
    (Google Sheets) query, which then dies with a cryptic parser error. DuckDB
    never emits backticks, so a backtick-quoted DOTTED identifier in a duckdb
    query is an unambiguous BigQuery leak. Matching the dotted form (not any
    lone backtick) keeps a stray backtick inside a filter VALUE from misfiring."""
    d = (dialect or "").lower()
    if d == "duckdb" and re.search(r"`[^`\n]*\.[^`\n]*`", sql or ""):
        return "tham chiếu bảng kiểu BigQuery (dấu backtick `project.dataset.table`)"
    return None


def _execute_semantic_chart_runtime(
    db: Session,
    datasource,
    chart_type,
    chart_config: dict,
    *,
    binding: dict,
    raw_extra_filters: list,
    filter_context: str | None,
    limit_override: int | None,
) -> Dict[str, Any]:
    """Execute a chart whose role_config needs semantic SQL rendering.

    Uses `SemanticQueryEngine` so the generated SQL contains the explore's
    join chain and measure formulas. Returned row keys are remapped to match
    the requested `view.field` refs (rather than the engine's `view_field`
    SQL aliases) — preserves the chart-runtime contract."""
    import hashlib
    import time

    from app.models.semantic import SemanticExplore
    from app.services.semantic_query_engine import SemanticQueryEngine
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.live_query_service import (
        _dialect_for_ds_type,
        _estimate_bigquery_bytes,
        _should_cache_live_query,
    )
    from app.services import query_cache
    from app.core.crypto import decrypt_config
    from app.core.config import settings

    base_view_name = str(binding.get("baseViewName") or "").strip()
    explore_name = str(binding.get("exploreName") or base_view_name).strip()
    model_id = binding.get("modelId") or None
    explore_id = binding.get("exploreId") or None
    if not base_view_name:
        raise ValueError("Semantic chart requires a resolved semantic binding")

    # Sanity-check the explore exists; without it the engine cannot resolve
    # joins and the caller would get a confusing engine-level error.
    explore_query = db.query(SemanticExplore)
    if explore_id:
        explore_query = explore_query.filter(SemanticExplore.id == explore_id)
    else:
        explore_query = explore_query.filter(SemanticExplore.name == explore_name)
    if model_id:
        explore_query = explore_query.filter(SemanticExplore.model_id == model_id)
    if not explore_query.first():
        raise ValueError(
            f"Semantic chart needs an Explore '{explore_name}'"
        )

    # Cross-source safety now lives in the EXECUTION PLANNER (execution_plan.py),
    # which runs AFTER snapshot resolution below — so a mixed-source dataset that
    # is fully materialized into the host BigQuery runs normally, and only a
    # mixed dataset forced to run LIVE gets a clear blocked message (issue #5).
    role_config = normalize_chart_role_config(
        chart_type,
        with_table_hyperlink_query_columns(
            chart_type,
            get_chart_active_role_config(chart_config),
            chart_config,
        ),
    )

    semantic_measure_fields = _binding_semantic_measure_fields(binding)
    semantic_fields_all = _binding_semantic_fields(binding)
    # Bare-name view of declared measures → lets the shared classifier reclassify
    # a BARE measure ref (e.g. an old / MCP / API chart that stored
    # `scatterX: "total_revenue"` without a view prefix) into the measure tier
    # WITHOUT guessing the view (the engine resolves it). Passed to
    # `classify_semantic_roles` below — the role classification + the
    # qualified/bare measure test now live ONCE in semantic_query_compiler,
    # shared with the preview + direct-API paths (no per-path drift).
    semantic_measure_bare_names = {f.rpartition(".")[2] for f in semantic_measure_fields if f}

    def qualify(field: str | None) -> str:
        """STRICT contract — return the dimension ref UNCHANGED.

        The semantic engine's ``_parse_field_ref`` is the SINGLE resolver: a
        qualified ``view.field`` passes through; a BARE dim is resolved
        deterministically by the engine (unique reachable view) or fails LOUD
        (ambiguous / unknown). chart_service no longer pre-qualifies bare dims
        to the base view — that masked genuinely cross-view dims and the
        engine's own ambiguity/missing fail-loud (and was a second resolution
        path that could drift from the engine).
        """
        return str(field or "").strip()

    # ── Role classification via the SINGLE shared classifier ─────────────────
    # `semantic_query_compiler.classify_semantic_roles` is the ONE rule the
    # preview (dataset-execute) and direct-API paths share too, so they cannot
    # drift — the structural cure for "Explore preview ≠ Dashboard tile".
    # `qualify` is pass-through (the engine is the sole resolver), so refs are
    # just the stripped role_config values; the
    # classifier dedups + splits dim/measure: STRICT dim slots
    # (dimension/breakdown/timeField/table) never reclassify (a measure there
    # fails loud); scatter axes + selectedColumns reclassify a declared measure
    # (qualified OR bare); explicit metrics come first, then reclassified.
    from app.services.semantic_query_compiler import classify_semantic_roles
    _selected_metric_fields = {
        str(m.get("field") or "").strip()
        for m in (role_config.get("metrics") or [])
        if isinstance(m, dict) and str(m.get("field") or "").strip()
    }
    _strict_dim_refs = [
        role_config.get(k) for k in (
            "dimension", "breakdown", "timeField",
            "tableRowDimension", "tableColumnDimension",
        )
    ]
    # `selectedColumns` is a STANDARD-TABLE "show these columns" list — only in
    # that mode are its non-measure entries legitimately GROUP BY dimensions
    # (a table shows one row per displayed-column combination). For EVERY
    # aggregating viz (bar / line / pie / KPI / gauge / scatter / …) and for
    # MATRIX (pivot), selectedColumns must NOT enter GROUP BY: otherwise the
    # chart groups by every column the default Table happened to select and the
    # grain explodes. DA-Test smoking gun: Bar "Revenue by Product" (bound only
    # dimension=product_name) emitted GROUP BY product×quantity×total_price×
    # transaction_date×year_month×employee_name×email → 249 rows + meaningless
    # SUM; a KPI carried _airbyte_meta (JSON) into GROUP BY → BigQuery 400
    # "Grouping by JSON not allowed". The gate mirrors chart_contracts (line
    # ~610): selectedColumns apply only when ctype == "TABLE" and tableMode is
    # not pivot. Scatter axes still reclassify (they ARE the scatter's roles).
    _chart_type_str = str(getattr(chart_type, "value", chart_type) or "").upper()
    _is_standard_table = (
        _chart_type_str == "TABLE"
        and str(role_config.get("tableMode") or "").lower() != "pivot"
    )
    _selected_dim_refs = (
        [
            c for c in (role_config.get("selectedColumns") or [])
            if str(c or "").strip() and str(c or "").strip() not in _selected_metric_fields
        ]
        if _is_standard_table
        else []
    )
    _reclassifiable_refs = _selected_dim_refs + [role_config.get("scatterX"), role_config.get("scatterY")]
    _metric_dicts = [m for m in (role_config.get("metrics") or []) if isinstance(m, dict)]
    for _mk in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
        _mv = role_config.get(_mk)
        if isinstance(_mv, dict):
            _metric_dicts.append(_mv)
    dimension_refs, measure_refs, agg_overrides = classify_semantic_roles(
        strict_dims=[d for d in _strict_dim_refs if isinstance(d, str)],
        reclassifiable_dims=[r for r in _reclassifiable_refs if isinstance(r, str)],
        metrics=[(m.get("field"), m.get("agg")) for m in _metric_dicts],
        measure_fields=semantic_measure_fields,
        measure_bare_names=semantic_measure_bare_names,
    )

    # Build filters: combine base + dashboard runtime; only forward filters
    # whose target is supported by the binding (base or reachable view) and
    # which the engine can understand. Bare-field filters get qualified to
    # the base view; semantic refs pass through.
    #
    # Phase-15.78: collect a structured drop log so the chart-data response
    # can tell the UI which filters were ignored and why (forwarded into
    # _debug.dropped_filters below). Tester reported "filter applied but
    # chart not filtered" was silent — this surfaces it.
    filter_diagnostics: list[dict] = []
    runtime_filters = _normalize_runtime_filters_for_chart(
        chart_config,
        merge_chart_query_filters(
            chart_config,
            extra_filters=raw_extra_filters,
            context=filter_context,
        ),
        include_joined_semantic=True,
        diagnostics=filter_diagnostics,
        db=db,
    )
    # STRICT (#4) — a complete filter the semantic engine could not apply
    # (unknown field / unreachable view / unsupported operator) must FAIL
    # LOUD here, not silently produce a result computed without it. Soft
    # drops (incomplete input, public-link policy) pass through untouched.
    enforce_no_hard_dropped_filters(filter_diagnostics)

    _OP_ALIAS = {"neq": "ne", "startswith": "starts_with"}
    engine_filters: dict[str, list] = {}
    for filt in runtime_filters:
        target_field = str(
            filt.get("semanticField")
            or filt.get("fieldKey")
            or filt.get("field")
            or ""
        ).strip()
        if not target_field:
            continue
        qualified = qualify(target_field)
        if not qualified:
            continue
        operator = str(filt.get("operator") or "eq").strip().lower()
        operator = _OP_ALIAS.get(operator, operator)
        # PBI-parity (2026-05-31): a field may carry MULTIPLE predicates
        # (chart_base AND runtime on the SAME field). engine_filters maps
        # field -> LIST of predicates; the engine's WHERE/HAVING builders
        # expand the list and AND each. Single-predicate fields (the common
        # case) render identically to before.
        engine_filt: dict[str, Any] = {
            "operator": operator,
            "value": filt.get("value"),
        }
        # Forward calendar-rewrite metadata so the engine's WHERE-builder
        # can emit a direct expression (``EXTRACT(YEAR FROM source)``
        # etc.) on the base fact column instead of trying to load the
        # role-played calendar SemanticView. See
        # `_rewrite_calendar_filter_to_all_roles` for the producer side.
        calendar_field = filt.get("calendarField") or filt.get("calendar_field")
        if calendar_field:
            engine_filt["calendarField"] = calendar_field
            cal_source = filt.get("calendarSourceField") or filt.get("calendar_source_field")
            if cal_source:
                engine_filt["calendarSourceField"] = cal_source
        engine_filters.setdefault(qualified, [])
        if engine_filt not in engine_filters[qualified]:
            engine_filters[qualified].append(engine_filt)

    # Phase-15.83 — DA decision: render every row. The previous code
    # capped chart queries at 1000 (default) / 5000 (with limit_override).
    # Both are gone; the LIMIT clause is now constructed only when an
    # explicit override is passed. If the override is missing or invalid
    # we fall back to a very high sentinel that effectively disables the
    # LIMIT (the SQL builder always emits "LIMIT N" so we can't drop it
    # entirely without rewriting every dialect path — 10M is well above
    # any single-chart workload we expect, and DBs short-circuit when
    # the actual row count is smaller).
    effective_limit: int = 10_000_000
    if limit_override is not None:
        try:
            effective_limit = max(1, int(limit_override))
        except (TypeError, ValueError):
            pass

    # RAW-distribution charts (BOXPLOT) need the per-ROW value spread, not an
    # aggregate. The semantic engine always GROUP-BYs its dimensions, so a
    # SUM(value) collapses each category to one point and the box degenerates
    # to a flat line (no quartiles). Reclassify the value metric(s) as raw
    # dimensions → the engine emits `SELECT dim, value ... GROUP BY dim, value`,
    # i.e. the distinct (category, value) pairs that give the box its spread.
    # Cap the row count so a high-cardinality value column can't scan the
    # whole table. The FE BoxplotChart reads the raw value via row[field].
    _raw_distribution_types = {"BOXPLOT"}
    _normalized_ct = str(getattr(chart_type, "value", chart_type) or "").upper()
    if _normalized_ct in _raw_distribution_types and measure_refs:
        for ref in measure_refs:
            if ref not in dimension_refs:
                dimension_refs.append(ref)
        measure_refs = []
        agg_overrides = {}
        effective_limit = min(effective_limit, 5000)

    # BUBBLE / NINE_BOX — aggregate X / Y / Size by the Label dimension (PowerBI
    # parity). The shared classifier leaves the scatter axes as raw GROUP BY
    # dims, which is correct for SCATTER (every row is a point) but wrong for
    # BUBBLE and the 9-box grid: the user binds a Label (≈ PowerBI "Details")
    # and expects ONE aggregated mark per label, with X / Y / Size summed (or
    # averaged). Left as dims, the axes enter GROUP BY and each distinct (x, y)
    # row becomes its own mark — DA report (BUG-016): "Bubble không tự SUM theo
    # Label khi chọn khoảng thời gian dài"; the SAME defect surfaced on NINE_BOX
    # (raw price/freight axes produced N rows per category instead of one
    # binned point). Move the axes out of dimension_refs into measure_refs so
    # only the Label stays in GROUP BY. A declared-measure axis keeps its own
    # aggregation; a raw numeric axis defaults to SUM, overridable per-axis via
    # scatterXAgg / scatterYAgg. A stale timeField from a previous time-based
    # chart is also removed from GROUP BY so long date filters do not split the
    # Label into per-month/per-day rows. Gated on a bound Label — without one the
    # chart keeps the raw SCATTER behaviour. SCATTER / MAP_POINT are never touched.
    dimension_refs, measure_refs, agg_overrides = _apply_bubble_label_aggregation(
        chart_type=_normalized_ct,
        role_config=role_config,
        dimension_refs=dimension_refs,
        measure_refs=measure_refs,
        agg_overrides=agg_overrides,
        qualify=qualify,
    )

    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    dialect = _dialect_for_ds_type(ds_type)

    # Phase-15.12: forward time grains from the saved role_config.
    # When DA picks a grain in the Explore editor, FE forwards it through
    # the preview path so the live chart renders bucketed. But the saved
    # chart path (/charts/{id}/data → here) was silently dropping the
    # grain — engine called without `time_grains`, so dashboards and
    # reloaded charts ignored the bucketing the user had configured.
    # Keys may be bare or already qualified — `qualify()` handles both.
    # We only keep grains whose target is an active dimension; stale
    # entries (field the user removed) would just spam the engine.
    raw_time_grains = role_config.get("timeGrains") or {}
    time_grains: dict[str, str] = {}
    if isinstance(raw_time_grains, dict):
        active_dim_set = set(dimension_refs)
        for field, grain in raw_time_grains.items():
            if not isinstance(field, str) or not isinstance(grain, str):
                continue
            qualified = qualify(field)
            if qualified in active_dim_set:
                time_grains[qualified] = grain

    # ── Top-N / Bottom-N (per-tile) ─────────────────────────────────────
    # FE (ChartTile Phase-15.78) persists styleConfig.dataLimit +
    # dataLimitDirection, but the render path historically IGNORED it
    # (Phase-15.83 no-op) so a DA's "Top 10" silently showed every row.
    # Wire it: ORDER BY the primary measure (DESC for top, ASC for bottom)
    # and LIMIT N. We rank by the engine-known measure ref (not the FE
    # chartSortRules field-key, which can diverge) so the ORDER BY alias
    # always resolves via _safe_alias.
    chart_sorts: list[dict] = []
    _style_cfg = chart_config.get("styleConfig") if isinstance(chart_config, dict) else None
    _style_cfg = _style_cfg if isinstance(_style_cfg, dict) else {}
    _data_limit_raw = _style_cfg.get("dataLimit")
    try:
        _data_limit_n = int(_data_limit_raw) if _data_limit_raw not in (None, "") else 0
    except (TypeError, ValueError):
        _data_limit_n = 0
    if _data_limit_n > 0:
        _rank_ref = (
            measure_refs[0] if measure_refs
            else (dimension_refs[0] if dimension_refs else None)
        )
        if _rank_ref:
            _dir = "asc" if str(_style_cfg.get("dataLimitDirection") or "top").lower() == "bottom" else "desc"
            chart_sorts = [{"field": _rank_ref, "direction": _dir}]
        effective_limit = max(1, _data_limit_n)

    # ── Window functions (running total / cumulative / YTD) ─────────────
    # The engine renders running_sum/running_avg/rank/... but the chart
    # runtime never forwarded them, so a DA could not build a YTD/running
    # total. Pass through whatever the config carries (snake_case spec key
    # or a roleConfig camelCase alias) so the feature works end-to-end.
    _window_fns = (
        (chart_config.get("window_functions") if isinstance(chart_config, dict) else None)
        or role_config.get("windowFunctions")
        or []
    )
    chart_window_functions = list(_window_fns) if isinstance(_window_fns, list) else []

    # ── Perf (BQ/Sheets dashboard latency) — CACHE LOOKUP BEFORE SQL-GEN ──
    # The cache key is fully determined by the classified refs computed above
    # (dims/measures/agg/limit/grains/sorts/windows/filters + explore identity),
    # NONE of which depend on the emitted SQL. Building the SQL first meant a
    # dashboard tile paid the full semantic model rebuild (load explore/model/
    # views, resolver, isolation analysis) AND — on BigQuery — a dry-run
    # round-trip on EVERY request, even a cache HIT. A dashboard with N tiles
    # re-running the same bounded query therefore burned N model rebuilds +
    # N dry-runs for results already in cache. Compute the key + probe the
    # cache up front so a HIT returns before any of that work runs. (User
    # decision 2026-06-10: "skip dry-run on cache-hit + dashboard".)
    # Dashboard perf #5 — resolve (and lazily build) snapshot tables BEFORE the
    # cache probe, so the snapshot version is part of the cache key (a Refresh /
    # Builder/authed pass ttl=None (use current snapshot, no auto-rebuild —
    # freshness is the explicit Refresh button). The public endpoint sets the
    # per-link TTL via the contextvar → serve-stale-then-async past the TTL.
    try:
        _snap_ttl = _snapshot_ttl_var.get()
    except LookupError:
        _snap_ttl = None
    # ── EXECUTION PLANNER (refactor Phase 2) ─────────────────────────────────
    # ONE typed decision replaces the scattered snapshot-resolve + dialect/
    # credential forcing + cross-source guard. See execution_plan.py. The live
    # path deliberately keeps this function's own `dialect`/`ds_type` locals so
    # its SQL stays byte-identical; only a snapshot-backed plan overrides them
    # (snapshot refs render as BigQuery tables in the host → the WHOLE statement
    # must be BigQuery, whatever the base datasource is).
    plan = plan_chart_execution(
        db, datasource, binding, base_view_name, ttl_minutes=_snap_ttl,
        # chart_id == -1 marks the Explore/preview (design-time) path, which may
        # run live on an un-published dataset; a saved chart (Dashboard) may not.
        is_preview=(_pbi_current_chart_id() == -1),
    )
    _snap_overrides = dict(plan.overrides)
    _snap_as_of = plan.as_of
    _snap_mode = plan.mode
    _snap_stale = plan.stale
    # Federated = the DATASET spans >1 engine (engine-span, not "base isn't BQ"):
    # a snapshot-backed query on such a dataset has NO live fallback — live SQL
    # would join across engines (used by the missing-snapshot branch below).
    _snap_federated = plan.mode == "snapshot" and plan.federated
    # Published (Phase 1): pinned to a published generation — NO live/prev-gen
    # fallback on a missing snapshot (block + ask to re-Sync instead).
    _snap_published = bool(plan.published)
    _plan_dataset_id = plan.dataset_id
    # Issues #3/#4 — ACTUAL execution facts, mutated if a fallback happens below,
    # so the cache key, _debug state and generation reflect what REALLY ran (not
    # the original plan). `_fell_back` ⇒ do NOT cache under the original key.
    _exec_state = plan.snapshot_state.value
    _exec_reason = plan.reason
    _exec_generation = plan.generation
    _fell_back = False
    if plan.trigger_dataset_id:
        # Stale (or eligible-but-unbuilt) → warm in the background; this request
        # still serves the stale/live result instantly (or, for a not-yet-built
        # mixed-engine dataset, surfaces the clear blocked message meanwhile).
        from app.services import snapshot_service as _ss
        _ss.trigger_async_refresh(plan.trigger_dataset_id)
    if plan.exec_config is not None:  # snapshot mode → host SA credential + BQ
        _snap_exec_config = plan.exec_config
        dialect = plan.dialect
        ds_type = plan.ds_type
    else:
        _snap_exec_config = None

    # [exec-decision] observability: one grep-able line with the full physical
    # execution decision. Grep ``[exec-decision]`` to trace why a chart ran the
    # way it did. `cred`: which credential identity executes (source datasource
    # vs the materialization host service-account).
    try:
        logger.info(
            "[exec-decision] chart_id=%s dataset=%s base_ds=%s base_ds_type=%s "
            "mode=%s dialect=%s exec_host_ds=%s cred=%s snapshot_asof=%s stale=%s "
            "federated=%s n_overrides=%d state=%s blocked=%s generation=%s reason=%r",
            _pbi_current_chart_id(),
            _plan_dataset_id,
            getattr(datasource, "id", None),
            str(getattr(datasource.type, "value", datasource.type)),
            plan.mode,
            dialect,
            plan.host_id,
            plan.cred,
            (_snap_as_of.isoformat() if _snap_as_of else None),
            bool(_snap_stale),
            plan.federated,
            len(_snap_overrides or {}),
            plan.snapshot_state.value,
            bool(plan.blocked),
            plan.generation,
            plan.reason,
        )
    except Exception:  # noqa: BLE001 — logging must never break a chart
        logger.debug("[exec-decision] log emit failed", exc_info=True)

    # A blocked plan = this request cannot run in the current state (mixed-engine
    # dataset forced to live). Raise AFTER the warm-trigger + decision log so the
    # background repair is already underway and the decision is visible.
    if plan.blocked:
        raise ValueError(plan.blocked)

    cache_enabled = _should_cache_live_query(ds_type)
    cache_role_config = {
        "_semantic_chart_runtime": True,
        "_dimensions": dimension_refs,
        "_measures": measure_refs,
        "_agg_overrides": agg_overrides,
        "_limit": effective_limit,
        # #5 — snapshot identity in the cache key so a refresh invalidates
        # cleanly. Phase 4: the GENERATION id (one refresh batch = one id) is
        # the true identity — two different snapshot sets can share the same
        # oldest-built_at timestamp; legacy (no generation) keeps the as_of.
        "_snapshot_asof": (
            f"gen:{plan.generation}" if plan.generation
            else (_snap_as_of.isoformat() if _snap_as_of else None)
        ),
        # Phase 7 (#31): the EXECUTION host is part of the cache identity — a
        # snapshot-backed result executed on the host SA must never be served
        # for (or collide with) a live run on the source credential.
        "_exec_host": (plan.host_id if plan.exec_config is not None else None),
        # Phase 1: security scope in the cache identity — a result computed for
        # one security principal (tenant/RLS scope) must never be served to
        # another. Currently "shared" (all authorized viewers see the same rows);
        # becomes per-principal once row-level security lands.
        "_security_scope": plan.security_scope,
        # Phase-15.xx — time_grains MUST be part of the cache key. Two
        # requests with identical dimensions/measures but different date
        # grains (raw daily vs month bucketing) otherwise collapse onto the
        # same slot: the first (e.g. daily) result is re-served for the
        # second (month) request, so changing the date-hierarchy drill in
        # Explore/Dashboard silently returns the prior grain's data.
        # Same collision class the cache_filters comment below documents.
        "_time_grains": {k: time_grains[k] for k in sorted(time_grains)} if time_grains else None,
        # Top-N direction + window functions change the emitted SQL but not the
        # dims/measures/filters, so they MUST be in the cache key — otherwise a
        # "Top 1" and "Bottom 1" (same N, same dims) collide and the first
        # result is re-served for the second (same class as _time_grains /
        # cache_filters collisions documented above).
        "_sorts": chart_sorts or None,
        "_window_functions": chart_window_functions or None,
    }
    cache_identifier = f"semantic_chart::{model_id or 'model'}::{explore_id or explore_name}"
    # Phase-15.81 v10 — query_cache._canonicalize_filters expects a list
    # of {field, operator, value} dicts and silently skips anything else.
    # The semantic-runtime path previously passed
    # `sorted(engine_filters.items())` which is a list of tuples, so
    # every request canonicalised down to an empty filter list. That
    # collapsed the cache key across "no filter", "metatype=task" and
    # "date BETWEEN ..." into one bucket — the first response served
    # every subsequent call, including Dashboard requests that the user
    # saw as "no data". Project the dict back into the wire-format
    # dicts the cache layer understands.
    #
    # PBI-parity (2026-05-31) REGRESSION FIX: `engine_filters` now maps
    # `field -> LIST[predicate]` (a field can carry chart_base AND a
    # runtime predicate). The old projection had `if isinstance(cond, dict)`
    # which is FALSE for the list value → cache_filters collapsed to `[]`
    # for EVERY filtered query, re-collapsing the exact cache-key bucket
    # this block was written to prevent: the first (no-filter) result was
    # served for all filtered requests → "filter applied but chart shows
    # unfiltered total". Flatten each field's predicate list so the cache
    # key is distinct per filter set again.
    cache_filters = [
        {"field": field, "operator": cond.get("operator"), "value": cond.get("value")}
        for field, conds in sorted(engine_filters.items())
        for cond in (conds if isinstance(conds, list) else [conds])
        if isinstance(cond, dict)
    ]

    coalesce_leader = False
    if cache_enabled:
        cached = query_cache.get_cached(
            datasource.id, cache_identifier, chart_type, cache_role_config, cache_filters
        )
        if cached is None:
            # Cross-process request coalescing: on a multi-worker deployment N
            # viewers of the SAME report each fire this identical query. Elect ONE
            # leader across all workers to run it; everyone else waits for the
            # leader's cached result instead of duplicating the warehouse scan
            # (fixes cost scaling linearly with concurrent viewers). Returns a
            # coalesced result (waiter) or flags us as the leader (must run + then
            # end_coalesced_compute). Falls back to "compute" on any error.
            cached, coalesce_leader = query_cache.begin_coalesced_compute(
                datasource.id, cache_identifier, chart_type, cache_role_config, cache_filters
            )
        if cached is not None:
            # Phase-15.96 — `cache_filters` only contains filters that
            # made it past `_normalize_runtime_filters_for_chart`. Two
            # requests whose only difference is the dropped filter (e.g.
            # one sends a calendar Date ref, another sends a CTE-view
            # ref — both get binding_unsupported and stripped) collapse
            # onto the same cache slot. Without overriding
            # `_debug.dropped_filters` here, the cached response carries
            # the dropped log of the FIRST request and re-serves it for
            # the SECOND, lying about which filter was actually dropped.
            # Fix: rebuild the dropped log from this request's
            # `filter_diagnostics` before returning.
            try:
                cached_debug = dict(cached.get("_debug") or {})
                cached_debug["dropped_filters"] = list(filter_diagnostics)
                # snapshot_stale is time-dependent (age vs the per-request TTL),
                # so it must reflect THIS request, not the value baked in when the
                # slot was cached — else the "refreshing…" hint is wrong on a hit.
                cached_debug["snapshot_stale"] = bool(_snap_stale)
                cached = {**cached, "_debug": cached_debug}
            except Exception:
                logger.debug("Failed to overlay dropped_filters onto cached chart response", exc_info=True)
            # [perf] cache HIT on the semantic chart path. This request skipped
            # BOTH the semantic model rebuild AND (on BigQuery) the dry-run +
            # real query — the whole point of Fix #2 (cache-before-SQL-gen).
            logger.info(
                "[perf] semantic chart cache=HIT chart_id=%s ds=%s ds_type=%s explore=%s "
                "dims=%d measures=%d rows=%d (skipped: model-rebuild, sql-gen%s)",
                _pbi_current_chart_id(), datasource.id, ds_type, explore_name,
                len(dimension_refs), len(measure_refs),
                len((cached.get("data") if isinstance(cached, dict) else None) or []),
                ", bq-dry-run+query" if ds_type == "bigquery" else "",
            )
            return cached

    # Phase 7 (#32) — coalescing-leader safety: everything from here to the
    # cache write runs under a guard that RELEASES the cross-worker in-flight
    # marker if this request fails. Without it, a failed leader left waiters
    # in other workers polling until the lease expired.
    try:
        # [perf] cache MISS — this request WILL rebuild the model + generate SQL +
        # (BigQuery) dry-run + query the source. These are the slow tiles a DA
        # feels on a cold dashboard; grep ``[perf] semantic chart cache=MISS`` to
        # see how many tiles actually hit the source per page load.
        logger.info(
            "[perf] semantic chart cache=MISS chart_id=%s ds=%s ds_type=%s explore=%s "
            "dims=%d measures=%d filters=%d (will: rebuild-model, sql-gen%s)",
            _pbi_current_chart_id(), datasource.id, ds_type, explore_name,
            len(dimension_refs), len(measure_refs), len(cache_filters),
            ", bq-dry-run+query" if ds_type == "bigquery" else "",
        )

        # Phase-12.7: explicit try around generate_sql so the caller and API
        # endpoint see a ValueError with the engine's Vietnamese message
        # (Phase-11), not an opaque internal exception. ValueError bubbles up
        # — the chart API layer maps it to 400.
        engine = SemanticQueryEngine(db, database_type=dialect)
        # Unified engine entry — the chart now builds a SemanticQuerySpec (the SAME
        # contract the preview + direct-API paths use) and runs it; no path bypasses
        # the spec/compiler any more. dimension_refs / measure_refs / agg_overrides
        # came from the shared classify_semantic_roles above.
        from app.services.semantic_query_compiler import SemanticQuerySpec
        _spec = SemanticQuerySpec(
            explore_name=explore_name,
            dimensions=dimension_refs,
            measures=measure_refs,
            measure_agg_overrides=agg_overrides or {},
            filters=engine_filters,
            time_grains=time_grains or {},
            sorts=chart_sorts,
            window_functions=chart_window_functions,
            limit=effective_limit,
            model_id=model_id,
            explore_id=explore_id,
            response_aliases=_build_semantic_alias_map(dimension_refs + measure_refs),
            diagnostics=filter_diagnostics,
            snapshot_overrides=_snap_overrides,
        )
        try:
            sql, _engine_columns, _pivot_metadata = engine.run(_spec)
            # [pbi-filter] full SQL dump correlated to chart_id. DA can grep
            # ``[pbi-filter] sql chart_id=<N>`` to see exactly what hit
            # BigQuery for one specific tile (especially useful for KPI /
            # Table charts where measure-filter behaviour was reported as
            # inconsistent).  Truncated at 4000 chars to keep log lines
            # readable; semantic_emit log still carries the truncated 1500-
            # char preview as a fallback. Temporary instrumentation.
            logger.info(
                "[pbi-filter] sql chart_id=%s dialect=%s chart_type=%s n_dims=%d n_measures=%d sql=%s",
                _pbi_current_chart_id(),
                dialect,
                str(getattr(chart_type, "value", chart_type) or "?"),
                len(dimension_refs),
                len(measure_refs),
                sql.replace("\n", " ")[:4000],
            )
        except ValueError:
            # Already carries a friendly VN message; let it propagate so the
            # API layer can turn it into a 400 with that text intact.
            raise
        except Exception as exc:
            logger.exception(
                "Semantic chart SQL generation failed: explore=%s dialect=%s",
                explore_name, dialect,
            )
            raise ValueError(
                f"Lỗi sinh SQL semantic ({dialect}): {exc}. "
                "Báo dev kiểm tra explore + measure config."
            ) from exc

        # Cross-engine leak guard (deterministic): a cross-source dataset can inline
        # one table's NATIVE SQL into another engine's query — e.g. a BigQuery
        # sql_query table (`project.dataset.table` backtick refs + SELECT * EXCEPT)
        # joined under a Google Sheets base that runs on DuckDB. DuckDB then rejects
        # the BigQuery syntax with an opaque "syntax error at or near \`". Detect the
        # foreign syntax in the GENERATED SQL (independent of how the dataset's
        # datasources resolve) and fail with a clear, actionable message instead.
        _leak = _detect_foreign_dialect_leak(sql, dialect)
        if _leak:
            raise ValueError(
                "Biểu đồ này không chạy được vì dataset đang trộn nhiều nguồn khác "
                f"engine nhau (phát hiện {_leak} trong truy vấn chạy trên '{dialect}'). "
                "Một biểu đồ chỉ chạy trên MỘT engine — không thể JOIN bảng Google "
                "Sheets với bảng BigQuery trong cùng một truy vấn. Hãy đưa tất cả bảng "
                "về CÙNG một nguồn (khuyến nghị: cùng trên BigQuery) hoặc tách thành "
                "các dataset riêng theo nguồn."
            )

        # Cache key + lookup already ran BEFORE engine.run() above (perf: a
        # cache HIT must not pay the semantic model rebuild or a BQ dry-run).
        # Reaching here means a cache MISS, so we generated SQL and now execute.

        # Execution credential: snapshot-backed queries read the SA-only snapshot
        # dataset → run on the service-account config; else the datasource's own cred.
        _exec_config = _snap_exec_config if _snap_exec_config is not None else datasource.config

        # ── DB connection release (QueuePool exhaustion fix) ─────────────────────
        # The warehouse query below can run up to 60s. The request's ORM Session has
        # an open (read-only) transaction from loading the chart/model, which pins a
        # pooled DB connection for that whole 60s. N concurrent tiles (a dashboard
        # open, or a post-Refresh re-fetch) then pin N connections → QueuePool
        # (pool_size + max_overflow) is exhausted and EVERY later request — including
        # /health — blocks on pool_timeout. Everything needed for execution is
        # already captured in plain locals (`_exec_config`, `sql`, `ds_type`); commit
        # ends the txn so the connection returns to the pool for the BQ wait.
        # Post-query code only touches `datasource.id` (PK — no reload) + plain
        # locals; any other ORM access re-acquires a connection lazily.
        try:
            db.commit()
        except Exception:  # noqa: BLE001 — read path: nothing critical pending
            db.rollback()

        # BigQuery cost guard (mirrors LiveQueryService behavior).
        if ds_type == "bigquery":
            config = decrypt_config(_exec_config)
            estimated_bytes = _estimate_bigquery_bytes(config, sql)
            max_bytes = settings.BQ_MAX_BYTES_SCANNED
            if estimated_bytes > max_bytes:
                gb_est = estimated_bytes / (1024**3)
                gb_max = max_bytes / (1024**3)
                raise ValueError(
                    f"Query would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                    f"Add filters (e.g. date range) to reduce the data scanned."
                )

        timeout = 60 if ds_type == "bigquery" else 30
        start = time.time()
        # Phase-12.7: wrap execute so connection errors / dialect mismatch /
        # missing physical column at the datasource surface as a ValueError
        # with debugging context, not a generic 500. ValueError because the
        # chart API endpoint maps ValueError → 4xx with the message intact.
        try:
            _cols, rows, _exec_ms = DataSourceConnectionService.execute_query(
                ds_type,
                _exec_config,
                sql,
                timeout_seconds=timeout,
                skip_bigquery_cost_check=True,
            )
        except Exception as exc:
            # ── Phase 1: PUBLISHED datasets NEVER fall back ──────────────────
            # A published Dashboard is pinned to a published generation. If that
            # snapshot is missing at execute time we must NOT run live or serve a
            # different generation (that would show data the DA never published /
            # inconsistent numbers). Fail loud with a re-sync instruction.
            if _snap_published and _is_missing_relation_error(exc):
                logger.warning(
                    "[snapshot] PUBLISHED snapshot missing at execute (chart_id=%s ds=%s gen=%s): %s",
                    _pbi_current_chart_id(), datasource.id, plan.generation, str(exc)[:300],
                )
                raise ValueError(
                    "Snapshot đã publish của Dataset không còn đầy đủ (có thể đã bị xoá/hết hạn). "
                    "Vào Dataset bấm “Sync & Publish” để dựng lại — Dashboard không tự chạy live "
                    "để tránh hiển thị số liệu chưa được phát hành."
                ) from exc
            # ── Self-heal (LEGACY datasets only): snapshot missing → LIVE + rebuild ──
            # A snapshot-backed query can fail because the physical snapshot table
            # was dropped (BigQuery table-expiration / GC) while the registry still
            # marks it current. For a LEGACY (non-published) dataset, fall back to a
            # LIVE query — FULL data, no cap — on the datasource's OWN credential,
            # and trigger a background rebuild. snapshots are BigQuery-only, so a
            # genuine live query is never silently retried.
            if _snap_overrides and _is_missing_relation_error(exc) and not _snap_federated:
                logger.warning(
                    "[snapshot] snapshot table missing at execute (chart_id=%s ds=%s) — "
                    "falling back to LIVE + triggering rebuild: %s",
                    _pbi_current_chart_id(), datasource.id, str(exc)[:300],
                )
                try:
                    # Planner-resolved dataset id (works even when the binding lacks
                    # datasetId, e.g. the preview path — resolved via the base view).
                    _ds_id_for_rebuild = _plan_dataset_id or binding.get("datasetId")
                    if _ds_id_for_rebuild:
                        from app.services import snapshot_service as _ss
                        _ss.trigger_async_refresh(int(_ds_id_for_rebuild))
                except Exception:  # noqa: BLE001 — rebuild is best-effort
                    logger.debug("[snapshot] rebuild trigger after missing table failed", exc_info=True)
                # Regenerate the query WITHOUT snapshot overrides → live SQL on source.
                import dataclasses as _dc
                _live_spec = _dc.replace(_spec, snapshot_overrides={})
                try:
                    sql, _engine_columns, _pivot_metadata = engine.run(_live_spec)
                except Exception:
                    logger.exception("Semantic chart LIVE regen failed after missing snapshot")
                    raise ValueError(
                        f"Lỗi chạy chart query trên {ds_type} (dialect {dialect}): {exc}. "
                        "Snapshot đã hết hạn và không dựng lại được SQL trực tiếp — "
                        "thử bấm Refresh trên Dataset."
                    ) from exc
                _exec_config = datasource.config
                _snap_overrides = {}
                _snap_mode = "live"
                _snap_stale = False
                _snap_as_of = None
                # Issues #3/#4 — record the ACTUAL execution so cache + debug tell
                # the truth (served LIVE, not the planned snapshot generation).
                _fell_back = True
                _exec_state = "live_fallback"
                _exec_reason = "snapshot table missing → served LIVE + rebuild triggered"
                _exec_generation = None
                # Regen re-opened a read txn (engine loads the model) → release the
                # pooled DB connection before the up-to-60s live BQ wait (same
                # QueuePool-exhaustion guard as the primary path above).
                try:
                    db.commit()
                except Exception:  # noqa: BLE001
                    db.rollback()
                # Live BigQuery can scan far more than a flat snapshot table → re-run
                # the byte-cost guard on the regenerated SQL.
                if ds_type == "bigquery":
                    _live_cfg = decrypt_config(_exec_config)
                    _live_bytes = _estimate_bigquery_bytes(_live_cfg, sql)
                    if _live_bytes > settings.BQ_MAX_BYTES_SCANNED:
                        gb_est = _live_bytes / (1024**3)
                        gb_max = settings.BQ_MAX_BYTES_SCANNED / (1024**3)
                        raise ValueError(
                            f"Query would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                            f"Add filters (e.g. date range) to reduce the data scanned."
                        )
                _cols, rows, _exec_ms = DataSourceConnectionService.execute_query(
                    ds_type,
                    _exec_config,
                    sql,
                    timeout_seconds=timeout,
                    skip_bigquery_cost_check=True,
                )
            elif _snap_overrides and _is_missing_relation_error(exc) and _snap_federated:
                # Federated dataset (mixed sources materialized into the host BQ): a
                # LIVE query CANNOT run (it would join across engines). Phase 7 (#16):
                # before giving up, fall back to the PREVIOUS complete snapshot
                # generation — its physical tables are retained by the delayed GC —
                # and trigger a rebuild of the broken one in the background.
                logger.warning(
                    "[snapshot] federated snapshot table missing (chart_id=%s ds=%s) — "
                    "trying previous generation + triggering rebuild: %s",
                    _pbi_current_chart_id(), datasource.id, str(exc)[:300],
                )
                try:
                    # Planner-resolved dataset id (works even when the binding lacks
                    # datasetId, e.g. the preview path — resolved via the base view).
                    _ds_id_for_rebuild = _plan_dataset_id or binding.get("datasetId")
                    if _ds_id_for_rebuild:
                        from app.services import snapshot_service as _ss
                        _ss.trigger_async_refresh(int(_ds_id_for_rebuild))
                except Exception:  # noqa: BLE001 — rebuild is best-effort
                    logger.debug("[snapshot] federated rebuild trigger failed", exc_info=True)
                _prev_refs: Dict[int, str] = {}
                try:
                    from app.services import snapshot_service as _ss
                    _prev_refs, _pfps, _prev_gen, _prev_asof = _ss.resolve_generation_refs(
                        db, list(_snap_overrides.keys()),
                        before_generation=plan.generation,
                    )
                except Exception:  # noqa: BLE001 — fallback resolve is best-effort
                    logger.debug("[snapshot] previous-generation resolve failed", exc_info=True)
                if _prev_refs:
                    logger.warning(
                        "[snapshot] serving PREVIOUS generation %s for chart_id=%s while rebuild runs",
                        _prev_gen, _pbi_current_chart_id(),
                    )
                    # Issue #2 — the previous generation may have been built on a
                    # DIFFERENT host; execute with THAT generation's host cred, not
                    # the failed plan's. Falls back to the plan's exec_config only
                    # if the prev-gen host can't be resolved.
                    try:
                        from app.services import snapshot_service as _ss2
                        _prev_host = _ss2.host_for_generation(db, _plan_dataset_id, _prev_gen)
                        if _prev_host is not None:
                            _exec_config = DataSourceConnectionService.snapshot_query_config(_prev_host.config)
                    except Exception:  # noqa: BLE001
                        logger.debug("[snapshot] prev-gen host resolve failed; using plan cred", exc_info=True)
                    import dataclasses as _dc
                    _prev_spec = _dc.replace(_spec, snapshot_overrides=_prev_refs)
                    sql, _engine_columns, _pivot_metadata = engine.run(_prev_spec)
                    _snap_overrides = dict(_prev_refs)
                    _snap_as_of = _prev_asof
                    _snap_stale = True  # older than intended — surface as stale
                    # Issues #3/#4 — record actual execution (previous generation).
                    _fell_back = True
                    _exec_state = "prev_generation"
                    _exec_reason = f"current generation broken → served previous generation {_prev_gen}"
                    _exec_generation = _prev_gen
                    try:
                        db.commit()  # pool-release before the BQ wait (same guard as above)
                    except Exception:  # noqa: BLE001
                        db.rollback()
                    _cols, rows, _exec_ms = DataSourceConnectionService.execute_query(
                        ds_type,
                        _exec_config,
                        sql,
                        timeout_seconds=timeout,
                        skip_bigquery_cost_check=True,
                    )
                else:
                    raise ValueError(
                        "Snapshot của dataset (nguồn trộn nhiều engine) đang được dựng lại "
                        "— vui lòng thử lại sau giây lát. Nếu lặp lại, bấm Refresh trên Dataset."
                    ) from exc
            else:
                logger.exception(
                    "Semantic chart execute failed: ds_type=%s dialect=%s sql=%s",
                    ds_type, dialect, sql[:500],
                )
                # STRICT (PowerBI fail-loud): a generated chart on a modeled dataset
                # has NO fallback for a genuine SQL/relationship error. If the semantic
                # SQL errors on the datasource we surface it as a 400 with the engine's
                # Vietnamese message — we do NOT silently degrade to a base-scoped
                # legacy result. (The snapshot-missing case above is the ONE exception,
                # because it's a serving artefact, not a modelling error.)
                raise ValueError(
                    f"Lỗi chạy chart query trên {ds_type} (dialect {dialect}): {exc}. "
                    "Thường do cardinality relationship sai, cột không tồn tại trên datasource, "
                    "hoặc cú pháp dialect khác. Kiểm tra Data Model tab."
                ) from exc
        elapsed_ms = (time.time() - start) * 1000

        alias_map = _spec.response_aliases  # computed once on the spec above
        rows = remap_semantic_engine_rows(rows, alias_map)

        # PBI parity (2026-06) — harvest the engine's OWN structured filter drops.
        # `_build_where_clause` records two kinds of drop on the engine instance via
        # `self._propagation_drops`: the single-direction reachability gate
        # (`unreachable_view` — a filter on a dim related to a SIBLING fact, which
        # PowerBI ignores) and the EXISTS-build bail (`no_join_path` — a malformed /
        # nested-CTE join). These never went through `_normalize_runtime_filters_for_chart`
        # so they're absent from `filter_diagnostics`; previously they survived ONLY as
        # `engine.warnings` strings, which the dashboard tile does not render — so the
        # ignored filter was invisible to the viewer (the DA's "mông lung" report).
        # Merge them into `filter_diagnostics` so they reach `_debug.dropped_filters`
        # and the FE skip-badge, exactly like the pre-engine drops. Dedupe on
        # (field, reason) so a filter dropped at both layers shows once.
        _engine_drops = list(getattr(engine, "_propagation_drops", []) or [])
        if _engine_drops:
            _seen_drop_keys = {
                (str(d.get("field") or d.get("semantic_field") or ""), str(d.get("reason") or ""))
                for d in filter_diagnostics
                if isinstance(d, dict)
            }
            for _d in _engine_drops:
                if not isinstance(_d, dict):
                    continue
                _key = (str(_d.get("field") or _d.get("semantic_field") or ""), str(_d.get("reason") or ""))
                if _key in _seen_drop_keys:
                    continue
                _seen_drop_keys.add(_key)
                filter_diagnostics.append(_d)

        result: Dict[str, Any] = {
            "data": rows,
            # The engine always emits SELECT … GROUP BY for measure'd queries, and
            # raw distinct rows otherwise; both are already at the granularity the
            # chart wants. Mark pre-aggregated so frontend skips client-side agg.
            "pre_aggregated": True,
            "execution_time_ms": round(elapsed_ms, 1),
            # Phase-3b: surface engine warnings (ambiguous join paths, etc.) so the
            # chart UI can banner them. List is empty in the happy path.
            "warnings": list(getattr(engine, "warnings", []) or []),
            # Phase-15.9: debug payload for the Explore "Query" tab. The FE
            # inspector shows DA exactly what BE ran — picks up renamed
            # views, ambiguous joins, etc. without needing server logs.
            # `sql` is the post-templating SemanticQueryEngine output (after
            # macro resolution + JOIN rendering); pasting it into a DB
            # console reproduces the chart's data 1:1.
            "_debug": {
                "sql_emitted": sql,
                "dialect": dialect,
                "routing": "semantic_engine",
                "row_count": len(rows),
                # Dashboard perf #5 — snapshot freshness for the builder "as of HH:MM"
                # label + a live/snapshot badge. Oldest built_at wins (never over-
                # claims freshness); "live" when no snapshot was used.
                "data_source_mode": _snap_mode,
                "snapshot_as_of": (_snap_as_of.isoformat() if _snap_as_of else None),
                # Public per-link TTL: the served snapshot is older than the TTL and
                # a background rebuild was kicked off; the FE shows "đang làm mới…".
                "snapshot_stale": bool(_snap_stale),
                # Phase 8 (#47) + issue #4: the ACTUAL execution decision, updated
                # on fallback (live_fallback / prev_generation), not the original
                # plan — so log/Query tab never claims "fresh" while serving live
                # or an older generation.
                "execution_state": _exec_state,
                "execution_reason": _exec_reason,
                "snapshot_generation": _exec_generation,
                # Phase-15.78: structured record of every filter the BE dropped
                # before generating SQL. Empty list = nothing dropped. FE can
                # banner this so users discover when a slicer they applied
                # didn't reach this chart.
                "dropped_filters": list(filter_diagnostics),
            },
        }

        # Issue #3 — do NOT cache a FALLBACK result under the original plan's
        # cache key: the key encodes the intended snapshot generation, but the
        # result actually came from LIVE or a PREVIOUS generation. Caching it
        # would serve stale/mislabeled data for that key until it rotates. Skip
        # the write on fallback (next request recomputes — and by then the
        # rebuild has usually produced a fresh generation with its own key).
        if cache_enabled and not _fell_back:
            query_cache.set_cached(
                datasource.id, cache_identifier, chart_type, cache_role_config, cache_filters, result
            )
        # Always release the coalescing marker (even on fallback) so cross-worker
        # waiters stop polling; they recompute (and hit the same fallback).
        if cache_enabled and coalesce_leader:
            query_cache.end_coalesced_compute(
                datasource.id, cache_identifier, chart_type, cache_role_config, cache_filters
            )

    except BaseException:
        if cache_enabled and coalesce_leader:
            try:
                query_cache.end_coalesced_compute(
                    datasource.id, cache_identifier, chart_type, cache_role_config, cache_filters
                )
            except Exception:  # noqa: BLE001 — release is best-effort
                pass
        raise

    logger.info(
        "[perf] semantic chart EXECUTED (cache=MISS) chart_id=%s ds=%d ds_type=%s explore=%s "
        "dims=%d measures=%d rows=%d source_query_ms=%.0f",
        _pbi_current_chart_id(),
        datasource.id,
        ds_type,
        explore_name,
        len(dimension_refs),
        len(measure_refs),
        len(rows),
        elapsed_ms,
    )

    return result


def _dispatch_per_measure_isolation(
    db: Session,
    datasource,
    db_table,
    chart_type,
    base_chart_config: dict,
    *,
    plan,                           # PerMeasurePlan — typed lazily to avoid cycle
    extra_filters: list | None,
    filter_context: str | None,
    limit_override: int | None,
) -> Dict[str, Any]:
    """Run a multi-fact chart as N parallel single-fact queries + Python merge.

    Phase-3 entry point. The plan has already been validated by
    :func:`per_measure_planner.plan_per_measure_execution`. Each group's
    chart_config is built by :func:`per_measure_executor.build_group_chart_config`
    and executed via a fresh recursive call to :func:`_execute_chart_runtime_for_table`
    — this guarantees the legacy single-query path runs for each group
    (i.e., this dispatch only recurses ONCE: the inner call sees a
    single-fact config so the planner returns ``enabled=False``).

    Each thread opens its own ``SessionLocal()`` because SQLAlchemy Session
    instances are not thread-safe. The outer ``db`` session stays bound to
    the request and is left untouched.
    """
    from app.core.database import SessionLocal
    from app.services.per_measure_executor import (
        execute_groups_parallel,
        merge_group_results,
    )

    def _runner(group_cfg: dict) -> Dict[str, Any]:
        # Fresh session per thread — SQLAlchemy session is not thread-safe.
        local_db = SessionLocal()
        try:
            return _execute_chart_runtime_for_table(
                local_db, datasource, db_table, chart_type, group_cfg,
                extra_filters=extra_filters,
                filter_context=filter_context,
                limit_override=limit_override,
            )
        finally:
            local_db.close()

    group_results = execute_groups_parallel(plan, base_chart_config, runner=_runner)
    merged_data = merge_group_results(plan, group_results)

    # Compose debug payload. `sql_emitted` keeps the str shape (first group's
    # SQL) for back-compat with FE Query tab; `sql_emitted_per_group` is the
    # new list of per-group SQL with fact_view labels. Dropped filters from
    # every group are concatenated with a `group_fact_view` annotation.
    sql_per_group = [
        {"fact_view": g["fact_view"], "sql": g.get("sql") or ""}
        for g in group_results
    ]
    primary_sql = sql_per_group[0]["sql"] if sql_per_group else ""
    all_dropped: list[dict] = []
    all_warnings: list[str] = []
    for g in group_results:
        for d in g.get("dropped_filters") or []:
            if isinstance(d, dict):
                all_dropped.append({**d, "group_fact_view": g["fact_view"]})
        for w in g.get("warnings") or []:
            all_warnings.append(f"[{g['fact_view']}] {w}")

    debug_payload = {
        "routing": "per_measure_isolation",
        "sql_emitted": primary_sql,
        "sql_emitted_per_group": sql_per_group,
        "queries_count": len(group_results),
        "dropped_filters": all_dropped,
        "warnings": all_warnings,
        "merge_dimension": plan.shared_dimensions[0] if plan.shared_dimensions else None,
    }
    return {
        "data": merged_data,
        "pre_aggregated": False,
        "_debug": debug_payload,
    }


def _apply_viewer_granularity(config: dict, grain: str | None) -> None:
    """#2 — apply an end-user's runtime date-grain choice (Dashboard / Public
    viewer date-hierarchy drill) onto the chart's ACTIVE role config so the
    pipeline re-queries the source at that grain. This makes the drill work
    even when the default render is pre-aggregated (client-side can't add finer
    buckets). Mutates ``config`` in place — callers MUST pass a deep copy so the
    saved chart contract is never touched. ``grain`` None/"" ⇒ no-op; "raw" ⇒
    strip bucketing (raw timestamps)."""
    if not isinstance(config, dict) or not grain:
        return
    role_config = get_chart_active_role_config(config)
    if not isinstance(role_config, dict):
        return
    # The date field the chart buckets on: timeField (TIME_SERIES) or the
    # plain dimension (a date column on a bar/line/combo X axis).
    fields = [f for f in (role_config.get("timeField"), role_config.get("dimension"))
              if isinstance(f, str) and f]
    if not fields:
        return
    grains = dict(role_config.get("timeGrains") or {})
    for field in fields:
        if grain == "raw":
            grains.pop(field, None)
        else:
            grains[field] = grain
    role_config["timeGrains"] = grains


def _execute_chart_runtime_for_table(
    db: Session,
    datasource,
    db_table,
    chart_type,
    chart_config: dict | None = None,
    *,
    extra_filters: list | None = None,
    filter_context: str | None = None,
    limit_override: int | None = None,
) -> Dict[str, Any]:
    """Execute chart runtime against a dataset table.

    All queries are routed through LiveQueryService to execute directly
    on the source database (BigQuery / PostgreSQL / MySQL).

    Phase 3 (PBI-parity, feature-flagged) — if the chart's measures span
    MULTIPLE fact views and FEATURE_PER_MEASURE_ISOLATION is on, dispatch
    the workload as one parallel query per fact view, then merge results
    in Python. Mirrors PowerBI / Tableau "context isolation per measure".
    Falls back to the single-query path when the planner declines (single
    fact, calc dependency across facts, pivot chart, flag off, …).
    """
    from app.services.live_query_service import LiveQueryService, _dialect_for_ds_type
    from app.models.dataset import Dataset
    from app.services.per_measure_planner import plan_per_measure_execution
    from app.core.config import settings

    filter_context = normalize_chart_filter_context(filter_context)
    # Runtime filters are an overlay, not part of the saved chart contract.
    # Work on an execution-local copy so downstream normalizers/planners can
    # enrich or reshape config without leaking changes back to Chart.config.
    chart_config = deepcopy(chart_config or {})

    # ── Phase 3 — try per-measure isolation BEFORE legacy path. ────────
    # Planner is a pure decision function; failures bail to the legacy path.
    try:
        _per_measure_plan = plan_per_measure_execution(
            chart_config,
            feature_enabled=bool(getattr(settings, "FEATURE_PER_MEASURE_ISOLATION", False)),
        )
    except Exception as _pm_exc:
        logger.warning("[per_measure] planner failed; falling back to legacy: %s", _pm_exc)
        _per_measure_plan = None
    if _per_measure_plan is not None and _per_measure_plan.enabled:
        return _dispatch_per_measure_isolation(
            db, datasource, db_table, chart_type, chart_config,
            plan=_per_measure_plan,
            extra_filters=extra_filters,
            filter_context=filter_context,
            limit_override=limit_override,
        )
    role_config = with_table_hyperlink_query_columns(
        chart_type,
        get_chart_active_role_config(chart_config),
        chart_config,
    )
    # Base filters are folded with the runtime overlay per call site via
    # `merge_chart_query_filters(chart_config, extra_filters=…)` (single fold,
    # runtime-wins), so there is no standalone base-only `filters` variable.
    custom_sql = get_chart_custom_sql(chart_config)
    raw_extra_filters = list(extra_filters or [])

    binding = (
        chart_config.get("semanticBinding")
        if isinstance(chart_config, dict) and isinstance(chart_config.get("semanticBinding"), dict)
        else {}
    )
    base_view_name_for_routing = str(binding.get("baseViewName") or "").strip()
    # Phase-15.81 v15 — give the routing helper visibility into both
    # base filters (saved on chart_config) and the runtime overrides
    # (dashboard slicers, public link constraints) so a joined-view
    # filter pulls the query to the semantic runtime regardless of
    # how the metric is shaped.
    routing_filters = merge_chart_query_filters(
        chart_config,
        extra_filters=raw_extra_filters,
        context=filter_context,
    )
    needs_semantic_runtime = _role_config_needs_semantic_runtime(
        role_config,
        binding,
        base_view_name_for_routing,
        runtime_filters=routing_filters,
    )

    # ── STRICT semantic single-path (PowerBI parity) ──
    # A GENERATED chart on a dataset that HAS a semantic model ALWAYS goes
    # through the semantic engine — never the single-table live builder, which
    # cannot JOIN, cannot honour declared/filtered/cross-table measures, and
    # silently drops joined-view filters (the recurring "wrong total / dropped
    # filter" class). The ONLY non-semantic escape hatch is an explicit
    # custom-SQL chart, handled by its own `if custom_sql:` branch below. A
    # resolved `baseViewName` on the binding is the signal that this chart's
    # table is backed by a semantic model. When forced, the engine fails LOUD
    # (missing relationship / ambiguous path / unknown measure) rather than
    # degrading to a heuristic live result.
    #
    # "Model-backed" = a resolved baseViewName OR ANY declared semantic
    # field/measure on the binding. The second clause matters now that the
    # cross-view bare-ref PROMOTE heuristic is gone (`_metric_needs_semantic`
    # tier-2 removed): a chart whose binding carries semantic measures but whose
    # baseViewName failed to hydrate must STILL go semantic, not silently fall
    # to the single-table live builder. No more guess-then-fallback.
    _model_backed = bool(
        base_view_name_for_routing
        or _binding_semantic_fields(binding)
        or _binding_semantic_measure_fields(binding)
    )
    if not custom_sql and _model_backed and not needs_semantic_runtime:
        logger.info(
            "[strict-semantic] forcing semantic runtime chart_id=%s base=%s "
            "(generated chart on modeled dataset; live-builder path disabled)",
            _pbi_current_chart_id(), base_view_name_for_routing or "<unresolved>",
        )
        needs_semantic_runtime = True

    # Phase-15.98 (S6B asymmetry guard) — preview and dashboard tile both
    # reach this function with binding hydrated upstream (preview via
    # explicit ``with_chart_semantic_binding``; dashboard via
    # ``hydrate_runtime_config`` inside ``get_by_id``). Symmetry is
    # therefore structural. The one remaining trap is silent hydration
    # failure: when ``binding.status`` ≠ "resolved", the bare-metric
    # registry lookups above run against an incomplete ``measureFields``
    # set, which under-matches the cross-view trailing-segment scan and
    # silently keeps the chart on the live path — DA sees a wrong total
    # with no observable reason. Emit a single WARNING so the failure mode
    # is greppable in production logs without changing routing behaviour.
    if not needs_semantic_runtime and isinstance(binding, dict):
        _binding_status = str(binding.get("status") or "").strip().lower()
        if _binding_status and _binding_status != "resolved":
            logger.warning(
                "[pbi-filter] route=live with non-resolved binding chart_id=%s base=%s "
                "binding_status=%s — bare-metric registry lookup may have been incomplete; "
                "measure where_sql/filters silently dropped if this chart references a "
                "declared cross-view measure",
                _pbi_current_chart_id(), base_view_name_for_routing, _binding_status,
            )

    # Phase-15.78 + Phase-7.3 — normalise extra_filters ONLY for the live
    # path. Previously this ran unconditionally before the routing decision,
    # which dropped every joined-view filter as `binding_unsupported` (the
    # live path can't honour them) and emitted spurious warning logs for
    # charts that would actually go through `_execute_semantic_chart_runtime`
    # which re-normalises with `include_joined_semantic=True` and applies
    # them correctly. Charts routed to semantic get the raw filter list now.
    live_filter_diagnostics: list[dict] = []
    if needs_semantic_runtime:
        # Semantic runtime owns its own normalize + diagnostics.
        normalized_extra_filters = list(extra_filters or [])
    else:
        normalized_extra_filters = _normalize_runtime_filters_for_chart(
            chart_config,
            extra_filters,
            diagnostics=live_filter_diagnostics,
            db=db,
        )
        # STRICT (#4) — same fail-loud policy on the live path: a complete
        # filter dropped as unknown_field / unreachable_view /
        # binding_unsupported / dataset_mismatch / unsupported_operator
        # means silently-wrong data, so refuse to run. (Soft drops —
        # incomplete input, public-link policy — are tolerated.)
        enforce_no_hard_dropped_filters(live_filter_diagnostics)
    live_role_config = _strip_nonsemantic_base_view_refs_from_role_config(
        role_config,
        binding,
        base_view_name_for_routing,
    )

    # ── Calendar table: generate SQL in source dialect, execute on dataset's datasource ──
    if is_generated_calendar_table(db_table):
        dataset_obj = db.query(Dataset).filter(Dataset.id == db_table.dataset_id).first()
        if dataset_obj is None:
            raise ValueError("Dataset not found")
        cal_datasource = datasource or _find_dataset_datasource(db, dataset_obj)
        if cal_datasource is None:
            raise ValueError("No datasource available for calendar table execution")
        if needs_semantic_runtime:
            return _execute_semantic_chart_runtime(
                db,
                cal_datasource,
                chart_type,
                chart_config,
                binding=binding,
                raw_extra_filters=raw_extra_filters,
                filter_context=filter_context,
                limit_override=limit_override,
            )
        ds_type = cal_datasource.type if isinstance(cal_datasource.type, str) else cal_datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        cal_sql = build_calendar_live_sql(
            get_calendar_settings(dataset_obj, enabled_default=False),
            dialect,
        )
        all_filters = merge_chart_query_filters(
            chart_config,
            extra_filters=normalized_extra_filters,
            context=filter_context,
        )
        return LiveQueryService.execute_chart_query_from_sql(
            cal_datasource,
            chart_type,
            live_role_config,
            all_filters,
            cal_sql,
            extra_filters=[],
            limit_override=limit_override,
            dropped_filters_log=live_filter_diagnostics,
        )

    # ── Derived / calculated table: build live SQL from definition ──
    if is_derived_table(db_table):
        dataset_obj = db.query(Dataset).filter(Dataset.id == db_table.dataset_id).first()
        if dataset_obj is None:
            raise ValueError("Dataset not found")
        try:
            if needs_semantic_runtime:
                live_datasource, _live_proxy_table = build_live_proxy_table_for_dataset_table(
                    db, dataset_obj, db_table,
                )
                return _execute_semantic_chart_runtime(
                    db,
                    live_datasource,
                    chart_type,
                    chart_config,
                    binding=binding,
                    raw_extra_filters=raw_extra_filters,
                    filter_context=filter_context,
                    limit_override=limit_override,
                )

            combined_runtime_filters = merge_chart_query_filters(
                chart_config,
                extra_filters=raw_extra_filters,
                context=filter_context,
            )
            if combined_runtime_filters:
                live_datasource, filtered_live_sql = _build_filtered_live_sql_for_dataset_table(
                    db,
                    dataset_obj,
                    db_table,
                    combined_runtime_filters,
                )
                return LiveQueryService.execute_chart_query_from_sql(
                    live_datasource,
                    chart_type,
                    live_role_config,
                    [],
                    filtered_live_sql,
                    extra_filters=[],
                    limit_override=limit_override,
                    dropped_filters_log=live_filter_diagnostics,
                )

            live_datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                db, dataset_obj, db_table,
            )
            live_sql, live_filters = _adapt_live_sql_for_semantic_filters(
                db, live_datasource, live_proxy_table, chart_config, raw_extra_filters,
            )
            if live_sql:
                return LiveQueryService.execute_chart_query_from_sql(
                    live_datasource, chart_type, live_role_config,
                    merge_chart_query_filters(chart_config, extra_filters=live_filters, context=filter_context),
                    live_sql,
                    extra_filters=[],
                    limit_override=limit_override,
                    dropped_filters_log=live_filter_diagnostics,
                )
            return LiveQueryService.execute_chart_query(
                live_datasource, live_proxy_table, chart_type, live_role_config,
                merge_chart_query_filters(chart_config, extra_filters=normalized_extra_filters, context=filter_context),
                extra_filters=[],
                limit_override=limit_override,
                dropped_filters_log=live_filter_diagnostics,
            )
        except DatasetTableSqlError as exc:
            raise ValueError(str(exc)) from exc

    # ── Custom SQL: send directly to source ──
    if custom_sql:
        if datasource is None:
            raise ValueError("Custom SQL charts require a datasource-backed table")
        return LiveQueryService.execute_chart_query_from_sql(
            datasource,
            chart_type,
            role_config,
            merge_chart_query_filters(chart_config, extra_filters=normalized_extra_filters, context=filter_context),
            custom_sql,
            extra_filters=[],
            limit_override=limit_override,
            dropped_filters_log=live_filter_diagnostics,
        )

    if datasource is None:
        # Dataset-on-Dataset composition: the base is a parent-ref table with no
        # datasource of its own. Its data lives in the child's BigQuery snapshot
        # host (same host as its parents — enforced at publish), and the planner
        # supplies the published overrides. Resolve the host so the semantic
        # runtime has a dialect/exec datasource; the calculation is unchanged.
        if getattr(db_table, "source_kind", None) == "dataset":
            from app.services import snapshot_service as _ss
            datasource = _ss.resolve_host(db, db_table.dataset_id)
        if datasource is None:
            raise ValueError("Chart requires a datasource-backed table")

    # Semantic chart: joined refs or declared semantic fields.
    # The chart anchor table still owns the binding (`baseViewName`); the
    # engine resolves joins and renders formulas / filtered measures.
    if needs_semantic_runtime:
        return _execute_semantic_chart_runtime(
            db,
            datasource,
            chart_type,
            chart_config,
            binding=binding,
            raw_extra_filters=raw_extra_filters,
            filter_context=filter_context,
            limit_override=limit_override,
        )

    # ── Physical table / SQL query: live query with semantic filter adaptation ──
    live_sql, live_filters = _adapt_live_sql_for_semantic_filters(
        db, datasource, db_table, chart_config, raw_extra_filters,
    )
    if live_sql:
        # Merge chart_base ⊕ runtime through the single fold so a dashboard
        # filter OVERRIDES a chart base filter on the same semantic scope
        # ("runtime value wins"), matching the calendar/derived/public paths.
        # Previously base (`filters`) and `extra_filters` were passed
        # separately and AND-ed by LiveQueryService → two predicates on the
        # same field → empty result instead of the override the design intends.
        return LiveQueryService.execute_chart_query_from_sql(
            datasource, chart_type, live_role_config,
            merge_chart_query_filters(chart_config, extra_filters=live_filters, context=filter_context),
            live_sql,
            extra_filters=[],
            limit_override=limit_override,
            dropped_filters_log=live_filter_diagnostics,
        )
    return LiveQueryService.execute_chart_query(
        datasource, db_table, chart_type, live_role_config,
        merge_chart_query_filters(chart_config, extra_filters=normalized_extra_filters, context=filter_context),
        extra_filters=[],
        limit_override=limit_override,
        dropped_filters_log=live_filter_diagnostics,
    )


class ChartService:
    """Service for chart operations."""

    @staticmethod
    def hydrate_runtime_config(
        db: Session,
        chart: Chart | None,
        auto_generate: bool = True,
    ) -> Chart | None:
        """Attach derived semantic binding for response-time consumers."""
        if not chart:
            return chart
        next_config = with_chart_semantic_binding(
            db,
            chart.dataset_table_id,
            chart.config,
            auto_generate=auto_generate,
        )
        if next_config != (chart.config or {}):
            # Surface the derived semanticBinding to response-time consumers
            # (FE reads config.semanticBinding) WITHOUT marking the column
            # dirty: set_committed_value writes the in-memory value as if it
            # were loaded from the DB, so a later session flush never
            # persists the derived binding into the stored config. Persisting
            # it would (a) go stale when the dataset model changes and
            # (b) silently overwrite the author's saved config — exactly the
            # "đè trực tiếp vào config chart" failure mode. The binding is
            # derived, so it is recomputed on every read regardless.
            set_committed_value(chart, "config", next_config)
        return chart
    
    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[Chart]:
        """Get all charts with pagination."""
        from sqlalchemy.orm import joinedload, selectinload
        from app.models.dataset import DatasetTable

        charts = (
            db.query(Chart)
            .options(
                joinedload(Chart.chart_meta),
                selectinload(Chart.parameters),
                joinedload(Chart.dataset_table).joinedload(DatasetTable.dataset),
            )
            .offset(skip)
            .limit(limit)
            .all()
        )
        for chart in charts:
            ChartService.hydrate_runtime_config(db, chart)
        return charts
    
    @staticmethod
    def get_by_id(db: Session, chart_id: int) -> Optional[Chart]:
        """Get a chart by ID."""
        from sqlalchemy.orm import joinedload, selectinload
        from app.models.dataset import DatasetTable

        chart = (
            db.query(Chart)
            .options(
                joinedload(Chart.chart_meta),
                selectinload(Chart.parameters),
                joinedload(Chart.dataset_table).joinedload(DatasetTable.dataset),
            )
            .filter(Chart.id == chart_id)
            .first()
        )
        return ChartService.hydrate_runtime_config(db, chart)
    
    @staticmethod
    def get_by_name(db: Session, name: str) -> Optional[Chart]:
        """Get a chart by name."""
        return db.query(Chart).filter(Chart.name == name).first()
    
    @staticmethod
    def create(db: Session, chart: ChartCreate, owner_id=None) -> Chart:
        """Create a new chart."""
        chart_name = chart.name.strip()
        if not chart_name:
            raise ValueError("Chart name cannot be empty")

        if chart.dataset_table_id is not None:
            # Verify dataset table exists
            from app.services.dataset_crud import DatasetCRUDService
            table = DatasetCRUDService.get_table_by_id(db, chart.dataset_table_id)
            if not table:
                raise ValueError(f"Dataset table with ID {chart.dataset_table_id} not found")

        if _find_chart_name_conflict(db, chart_name, owner_id=owner_id):
            raise ValueError(f"You already have a chart named '{chart_name}'")

        try:
            # Hydrate the semantic binding before persisting so response-time
            # consumers have it. Metric/dimension refs are stored AS SENT
            # (canonical ``view.field`` from the FE picker); the semantic
            # engine is the SINGLE resolver at render time — no save-time
            # bare-ref pre-qualify (that second resolution path was removed so
            # resolution can't drift from the engine).
            hydrated_config = with_chart_semantic_binding(
                db,
                chart.dataset_table_id,
                chart.config,
                auto_generate=True,
            )
            db_chart = Chart(
                name=chart_name,
                description=chart.description,
                dataset_table_id=chart.dataset_table_id,
                chart_type=ChartType(chart.chart_type.value),
                config=hydrated_config,
                owner_id=owner_id,
            )
            db.add(db_chart)
            db.commit()
            db.refresh(db_chart)
            logger.info(f"Created chart: {chart_name}")
            return db_chart
        except IntegrityError:
            db.rollback()
            raise ValueError(f"You already have a chart named '{chart_name}'")
    
    @staticmethod
    def update(
        db: Session,
        chart_id: int,
        chart_update: ChartUpdate
    ) -> Optional[Chart]:
        """Update a chart."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            return None

        if chart_update.name is not None:
            next_name = chart_update.name.strip()
            if not next_name:
                raise ValueError("Chart name cannot be empty")
            if _find_chart_name_conflict(
                db,
                next_name,
                owner_id=db_chart.owner_id,
                exclude_chart_id=chart_id,
            ):
                raise ValueError(f"You already have a chart named '{next_name}'")
        
        try:
            update_data = chart_update.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                if field == "chart_type" and value:
                    setattr(db_chart, field, ChartType(value.value))
                elif field == "name":
                    if value is None:
                        continue
                    setattr(db_chart, field, value.strip())
                else:
                    setattr(db_chart, field, value)

            if "config" in update_data or "dataset_table_id" in update_data:
                # Re-hydrate the semantic binding on config/table change.
                # Refs are stored as sent; the engine resolves at render
                # (single resolver — no save-time bare-ref pre-qualify).
                hydrated = with_chart_semantic_binding(
                    db,
                    db_chart.dataset_table_id,
                    db_chart.config,
                    auto_generate=True,
                )
                db_chart.config = hydrated
            
            db.commit()
            db.refresh(db_chart)
            logger.info(f"Updated chart: {db_chart.name}")
            return ChartService.hydrate_runtime_config(db, db_chart)
        except IntegrityError:
            db.rollback()
            conflict_name = (chart_update.name or db_chart.name or "").strip()
            raise ValueError(f"You already have a chart named '{conflict_name}'")
    
    @staticmethod
    def delete(db: Session, chart_id: int) -> bool:
        """Delete a chart."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            return False
        
        db.delete(db_chart)
        db.commit()
        logger.info(f"Deleted chart: {db_chart.name}")
        return True
    
    @staticmethod
    def get_chart_data(
        db: Session,
        chart_id: int,
        extra_filters: list | None = None,
        filter_context: str | None = None,
        granularity_override: str | None = None,
        snapshot_ttl_minutes: int | None = None,
    ):
        """Get chart configuration with data.

        ``granularity_override`` (#2 viewer date-hierarchy) re-buckets the time
        axis at a grain the end-user picked in the Dashboard/Public viewer.
        None ⇒ exact previous behaviour.

        ``snapshot_ttl_minutes`` (public per-link TTL): None → builder/authed
        (current snapshot, no auto-rebuild); 0 → Realtime (live); >0 →
        serve-stale-then-async past the TTL. Threaded to the snapshot resolver
        via a contextvar so the deep render call-stack needs no new param."""
        # [pbi-filter] entry log + chart_id context propagation — downstream
        # logs in semantic engine (SQL emit, measure-filter wrap) read this
        # contextvar so DA can grep ``chart_id=<N>`` and see EVERY log line
        # produced by that one tile. Temporary debug instrumentation.
        _pbi_token = _pbi_chart_id_var.set(chart_id)
        _snap_ttl_token = _snapshot_ttl_var.set(snapshot_ttl_minutes)
        logger.info(
            "[pbi-filter] entry get_chart_data chart_id=%s extra_filters=%d context=%r",
            chart_id, len(extra_filters or []), filter_context,
        )
        try:
            # ── Single-flight (Fix #9, 2026-06-10) ───────────────────────────
            # Prod logs showed the SAME tile going cache=MISS 2-3x within a few
            # seconds (rapid re-render / a filter toggled twice / StrictMode
            # double-invoke) — each MISS = a separate 8-17s BigQuery query for
            # ONE chart. Serialise identical concurrent requests on a per-(chart,
            # filters, context) lock: the leader runs the full pipeline (which
            # writes the result cache via Fix #2), and every waiter — once it
            # acquires the lock — re-enters _get_chart_data_inner and hits that
            # warm cache instead of issuing its own source query. The wrapper is
            # the safe place to do this: _get_chart_data_inner is the single
            # entry for the whole pipeline, so no correctness-sensitive internal
            # code is restructured. Keyed by the request inputs (NOT the internal
            # semantic cache key, which isn't known until mid-pipeline) — same
            # inputs ⇒ same result, so collapsing them is sound.
            import hashlib as _hashlib
            import json as _json
            from app.services import query_cache as _qc
            try:
                _sf_key = "gcd::" + _hashlib.sha256(
                    _json.dumps(
                        [int(chart_id), str(filter_context or ""), extra_filters or [],
                         str(granularity_override or ""),
                         # Phase 7 (#30): freshness mode is part of the request
                         # identity — ttl=0 (realtime) vs ttl>0 (snapshot ok) must
                         # never collapse into one flight.
                         str(snapshot_ttl_minutes if snapshot_ttl_minutes is not None else "")],
                        sort_keys=True, separators=(",", ":"), default=str,
                    ).encode("utf-8")
                ).hexdigest()
            except Exception:
                _sf_key = ""  # un-keyable input → no dedup, just run normally
            return _qc.single_flight(
                _sf_key,
                lambda: ChartService._get_chart_data_inner(
                    db, chart_id, extra_filters=extra_filters, filter_context=filter_context,
                    granularity_override=granularity_override,
                ),
            )
        finally:
            _pbi_chart_id_var.reset(_pbi_token)
            _snapshot_ttl_var.reset(_snap_ttl_token)

    @staticmethod
    def get_charts_data_batch(
        items: list[dict],
        *,
        serialize=None,
        max_workers: int = 8,
    ) -> list[dict]:
        """Fetch data for MANY charts in ONE call — the server-side fan-out behind
        the per-page "1 request = 1 page" endpoint (perf: kill N HTTP round-trips
        + FE socket queueing, and share the dashboard/link resolve done ONCE by
        the caller).

        Each ``item`` is ``{chart_id, extra_filters?, filter_context?,
        granularity_override?, snapshot_ttl_minutes?}`` and runs through the SAME
        ``get_chart_data`` the single-chart endpoints use — so a batch result is
        byte-identical to N individual calls (this is a transport + concurrency
        layer, NOT a new query path; the result cache / single-flight still apply
        per chart).

        Concurrency: each chart runs in its OWN thread with its OWN
        ``SessionLocal()`` (SQLAlchemy Session is not thread-safe; the caller's
        request session is never touched — same pattern as
        ``_dispatch_per_measure_isolation``). Failures are ISOLATED per chart: a
        bad tile yields ``{"ok": False, "error": ...}`` instead of failing the
        whole page. Result order matches ``items``.

        ``serialize`` (optional) is run INSIDE the worker thread while its
        session is still open, on the raw ``get_chart_data`` result, and its
        return value becomes ``data``. This is REQUIRED when the caller will
        serialize an API model built from the result: ``get_chart_data`` returns
        a dict holding the Chart ORM instance, so it must be converted to a
        detached-safe form (e.g. ``ChartDataResponse(**d)``, which copies via
        ``from_attributes``) BEFORE the thread closes its session — otherwise the
        request thread hits ``DetachedInstanceError`` on lazy attributes.
        """
        if not items:
            return []
        from concurrent.futures import ThreadPoolExecutor
        from app.core.database import SessionLocal

        def _one(item: dict) -> dict:
            cid = int(item["chart_id"])
            local_db = SessionLocal()
            try:
                data = ChartService.get_chart_data(
                    local_db,
                    cid,
                    extra_filters=item.get("extra_filters"),
                    filter_context=item.get("filter_context"),
                    granularity_override=item.get("granularity_override"),
                    snapshot_ttl_minutes=item.get("snapshot_ttl_minutes"),
                )
                if serialize is not None:
                    data = serialize(data)
                return {"chart_id": cid, "ok": True, "data": data}
            except ValueError as exc:
                # Invalid chart config for the current dataset state — the same
                # case the single endpoint maps to 400 (Vietnamese-friendly msg).
                return {"chart_id": cid, "ok": False, "status": 400, "error": str(exc)}
            except Exception as exc:  # noqa: BLE001 — one tile must not sink the page
                logger.exception("Batch chart-data failed for chart_id=%s", cid)
                return {
                    "chart_id": cid, "ok": False, "status": 500,
                    "error": f"Failed to retrieve chart data: {exc}",
                }
            finally:
                local_db.close()

        # Bound concurrency: a big page must not open dozens of warehouse
        # connections at once (the DB pool is shared with foreground requests).
        workers = max(1, min(max_workers, len(items)))
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="chartbatch") as ex:
            return list(ex.map(_one, items))

    @staticmethod
    def _get_chart_data_inner(
        db: Session,
        chart_id: int,
        extra_filters: list | None = None,
        filter_context: str | None = None,
        granularity_override: str | None = None,
    ):
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            raise ValueError(f"Chart with ID {chart_id} not found")

        # #2 — viewer date-hierarchy: re-bucket at a runtime grain the end-user
        # picked in the Dashboard/Public viewer. Apply onto a COPY so the saved
        # chart contract is untouched; the pipeline then re-queries at that
        # grain. None ⇒ exact previous behaviour (no copy, no change).
        effective_config = db_chart.config or {}
        if granularity_override:
            effective_config = deepcopy(effective_config)
            _apply_viewer_granularity(effective_config, granularity_override)

        # Prefer direct dataset_table_id FK over config-embedded source
        if db_chart.dataset_table_id is not None:
            from app.services.dataset_crud import DatasetCRUDService
            from app.models.models import DataSource

            db_table = DatasetCRUDService.get_table_by_id(db, db_chart.dataset_table_id)
            if not db_table:
                raise ValueError("Dataset table not found")

            datasource = None
            if not is_generated_calendar_table(db_table) and not is_derived_table(db_table) and getattr(db_table, "source_kind", None) != "dataset":
                datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if not datasource:
                    raise ValueError("Data source not found")

            result = _execute_chart_runtime_for_table(
                db,
                datasource,
                db_table,
                db_chart.chart_type,
                effective_config,
                extra_filters=extra_filters,
                filter_context=filter_context,
            )

            # Phase-15.9: forward _debug payload (sql_emitted + dialect +
            # routing + row_count + warnings) so the Explore "Query" tab
            # can show DA the BE-side pipeline. Strip leading underscore
            # before serialising — schema field is `debug`. Legacy keys
            # `execution_time_ms` + `warnings` are folded in here too.
            return {
                "chart": db_chart,
                "data": result["data"],
                "pre_aggregated": result["pre_aggregated"],
                "debug": _build_debug_response(result),
            }

        # Fallback: check config for legacy dataset_table source
        config = effective_config
        if isinstance(config, dict) and config.get('source', {}).get('kind') == 'dataset_table':
            from app.services.dataset_crud import DatasetCRUDService
            from app.models.models import DataSource

            dataset_id = config['source'].get('datasetId')
            table_id = config['source'].get('tableId')

            if not dataset_id or not table_id:
                raise ValueError("Invalid dataset table source in chart config")

            db_table = DatasetCRUDService.get_table_by_id(db, table_id)
            if not db_table or db_table.dataset_id != dataset_id:
                raise ValueError("Table not found in dataset")

            datasource = None
            if not is_generated_calendar_table(db_table) and not is_derived_table(db_table) and getattr(db_table, "source_kind", None) != "dataset":
                datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if not datasource:
                    raise ValueError("Data source not found")

            result = _execute_chart_runtime_for_table(
                db,
                datasource,
                db_table,
                db_chart.chart_type,
                effective_config,
                extra_filters=extra_filters,
                filter_context=filter_context,
            )

            # Phase-15.9: forward _debug payload (sql_emitted + dialect +
            # routing + row_count + warnings) so the Explore "Query" tab
            # can show DA the BE-side pipeline. Strip leading underscore
            # before serialising — schema field is `debug`. Legacy keys
            # `execution_time_ms` + `warnings` are folded in here too.
            return {
                "chart": db_chart,
                "data": result["data"],
                "pre_aggregated": result["pre_aggregated"],
                "debug": _build_debug_response(result),
            }

        raise ValueError("Chart has no data source configured")

    @staticmethod
    def preview_chart_data(
        db: Session,
        dataset_table_id: int,
        chart_type,
        chart_config: dict | None = None,
        *,
        extra_filters: list | None = None,
        filter_context: str | None = None,
        include_source_sample: bool = False,
        source_sample_limit: int = 100,
    ) -> Dict[str, Any]:
        """Preview chart runtime for Explore using the same execution path as saved charts."""
        # [pbi-filter] mark this as a preview render (no saved chart_id);
        # downstream logs will show ``chart_id=preview`` so DA can tell
        # Editor previews apart from Dashboard tile renders when grepping.
        _pbi_token = _pbi_chart_id_var.set(-1)
        logger.info(
            "[pbi-filter] entry preview_chart_data dataset_table_id=%s extra_filters=%d context=%r",
            dataset_table_id, len(extra_filters or []), filter_context,
        )
        try:
            return ChartService._preview_chart_data_inner(
                db, dataset_table_id, chart_type, chart_config,
                extra_filters=extra_filters, filter_context=filter_context,
                include_source_sample=include_source_sample,
                source_sample_limit=source_sample_limit,
            )
        finally:
            _pbi_chart_id_var.reset(_pbi_token)

    @staticmethod
    def _preview_chart_data_inner(
        db: Session,
        dataset_table_id: int,
        chart_type,
        chart_config: dict | None = None,
        *,
        extra_filters: list | None = None,
        filter_context: str | None = None,
        include_source_sample: bool = False,
        source_sample_limit: int = 100,
    ) -> Dict[str, Any]:
        from app.models.models import DataSource
        from app.services.dataset_crud import DatasetCRUDService

        db_table = DatasetCRUDService.get_table_by_id(db, dataset_table_id)
        if not db_table:
            raise ValueError(f"Dataset table with ID {dataset_table_id} not found")

        datasource = None
        if not is_generated_calendar_table(db_table) and not is_derived_table(db_table) and getattr(db_table, "source_kind", None) != "dataset":
            datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
            if not datasource:
                raise ValueError("Data source not found")

        # Hydrate semanticBinding so preview takes the same routing path as
        # `GET /charts/{id}/data` (which goes through `hydrate_runtime_config`).
        # Without this, an MCP-saved or freshly-typed config carrying only the
        # minimal binding (baseViewName, exploreName, modelId, exploreId)
        # would skip the semantic engine for non-aggregating charts
        # (SCATTER / MAP_POINT) and the row keys come back bare instead of
        # `view.field`-qualified — breaking the FE axis lookup.
        config = with_chart_semantic_binding(
            db,
            dataset_table_id,
            chart_config,
            auto_generate=True,
        )
        custom_sql = get_chart_custom_sql(config)
        limit_override = None
        raw_limit_override = config.get("limit")
        if raw_limit_override is not None:
            try:
                # Phase-15.83 — per-chart row caps were dropped. Clamp to the
                # 10M sentinel, NOT 5000, so the FE's NO_LIMIT_SENTINEL passes
                # through and the preview isn't silently capped at 5000 rows
                # (BigQuery short-circuits on the real row count). The sibling
                # source-sample cap below was raised then; this one was missed.
                limit_override = max(1, min(int(raw_limit_override), 10_000_000))
            except (TypeError, ValueError):
                limit_override = None
        normalized_role_config = normalize_chart_role_config(
            chart_type,
            get_chart_active_role_config(config),
        )
        normalized_chart_type = str(getattr(chart_type, "value", chart_type) or "").upper()
        preview: Dict[str, Any] = {
            "data": [],
            "pre_aggregated": False,
        }

        if include_source_sample and custom_sql:
            from app.services.datasource_service import DataSourceConnectionService

            ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
            timeout = 60 if ds_type == "bigquery" else 30
            # Phase-15.83 — cap raised from 5000 → 10M sentinel; DB
            # short-circuits on the real row count.
            source_sample_limit = max(1, min(int(source_sample_limit), 10_000_000))
            # Release the pooled DB connection for the ≤60s warehouse query (see
            # the QueuePool-exhaustion note in _execute_semantic_chart_runtime).
            # Capture config first so the commit's attribute-expiry can't force a
            # reload mid-flight; the ORM Session re-acquires lazily afterwards.
            _src_exec_config = datasource.config
            try:
                db.commit()
            except Exception:  # noqa: BLE001 — read path: nothing critical pending
                db.rollback()
            source_columns, source_rows, source_execution_time_ms = DataSourceConnectionService.execute_query(
                ds_type,
                _src_exec_config,
                custom_sql,
                limit=source_sample_limit,
                timeout_seconds=timeout,
                skip_bigquery_cost_check=True,
            )
            preview["source_columns"] = source_columns
            preview["source_rows"] = source_rows
            if source_execution_time_ms is not None:
                preview["execution_time_ms"] = source_execution_time_ms

            # In Custom SQL mode, the first Run should always be able to return
            # the SQL output sample even before the user picks a chart value column.
            metric_optional_chart_types = {"TABLE", "MATRIX", "SCATTER", "MAP_POINT", "TIMELINE", "NINE_BOX"}
            if normalized_chart_type not in metric_optional_chart_types and not (normalized_role_config.get("metrics") or []):
                return preview

        result = _execute_chart_runtime_for_table(
            db,
            datasource,
            db_table,
            chart_type,
            config,
            extra_filters=extra_filters,
            filter_context=filter_context,
            limit_override=limit_override,
        )

        preview["data"] = result["data"]
        preview["pre_aggregated"] = result["pre_aggregated"]
        preview["warnings"] = list(result.get("warnings") or [])
        preview["debug"] = _build_debug_response(result)
        if result.get("execution_time_ms") is not None:
            preview["execution_time_ms"] = result["execution_time_ms"]

        return preview

    # -----------------------------------------------------------------------
    # Metadata CRUD
    # -----------------------------------------------------------------------

    @staticmethod
    def upsert_metadata(db: Session, chart_id: int, data: ChartMetadataUpsert) -> ChartMetadata:
        """Create or replace semantic metadata for a chart."""
        existing = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
        if existing:
            for field, value in data.model_dump(exclude_unset=False).items():
                setattr(existing, field, value)
            db.commit()
            db.refresh(existing)
            return existing
        new_meta = ChartMetadata(
            chart_id=chart_id,
            domain=data.domain,
            intent=data.intent,
            metrics=data.metrics or [],
            dimensions=data.dimensions or [],
            tags=data.tags or [],
        )
        db.add(new_meta)
        db.commit()
        db.refresh(new_meta)
        return new_meta

    @staticmethod
    def get_metadata(db: Session, chart_id: int) -> Optional[ChartMetadata]:
        """Get metadata for a chart."""
        return db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()

    @staticmethod
    def delete_metadata(db: Session, chart_id: int) -> bool:
        """Delete metadata for a chart."""
        existing = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
        if not existing:
            return False
        db.delete(existing)
        db.commit()
        return True

    # -----------------------------------------------------------------------
    # Parameter CRUD
    # -----------------------------------------------------------------------

    @staticmethod
    def get_parameters(db: Session, chart_id: int) -> List[ChartParameter]:
        """Get all parameter definitions for a chart."""
        return db.query(ChartParameter).filter(ChartParameter.chart_id == chart_id).all()

    @staticmethod
    def replace_parameters(db: Session, chart_id: int, params: List[ChartParameterCreate]) -> List[ChartParameter]:
        """Replace all parameter definitions for a chart (bulk upsert)."""
        db.query(ChartParameter).filter(ChartParameter.chart_id == chart_id).delete()
        new_params = [
            ChartParameter(
                chart_id=chart_id,
                parameter_name=p.parameter_name,
                parameter_type=p.parameter_type,
                column_mapping=p.column_mapping,
                default_value=p.default_value,
                description=p.description,
            )
            for p in params
        ]
        db.add_all(new_params)
        db.commit()
        for p in new_params:
            db.refresh(p)
        return new_params

    @staticmethod
    def add_parameter(db: Session, chart_id: int, data: ChartParameterCreate) -> ChartParameter:
        """Add a single parameter definition to a chart."""
        param = ChartParameter(
            chart_id=chart_id,
            parameter_name=data.parameter_name,
            parameter_type=data.parameter_type,
            column_mapping=data.column_mapping,
            default_value=data.default_value,
            description=data.description,
        )
        db.add(param)
        db.commit()
        db.refresh(param)
        return param

    @staticmethod
    def update_parameter(
        db: Session, chart_id: int, param_id: int, data: ChartParameterUpdate
    ) -> Optional[ChartParameter]:
        """Update a parameter definition."""
        param = db.query(ChartParameter).filter(
            ChartParameter.id == param_id,
            ChartParameter.chart_id == chart_id,
        ).first()
        if not param:
            return None
        for field, value in data.model_dump(exclude_unset=True).items():
            setattr(param, field, value)
        db.commit()
        db.refresh(param)
        return param

    @staticmethod
    def delete_parameter(db: Session, chart_id: int, param_id: int) -> bool:
        """Delete a parameter definition."""
        param = db.query(ChartParameter).filter(
            ChartParameter.id == param_id,
            ChartParameter.chart_id == chart_id,
        ).first()
        if not param:
            return False
        db.delete(param)
        db.commit()
        return True
