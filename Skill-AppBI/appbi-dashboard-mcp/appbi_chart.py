"""Stage 4 — Charts.

Tools for creating and editing charts. Charts target a `dataset_table_id`
and pass a `config` blob whose shape depends on `chart_type`.

Removed vs the legacy MCP:
  - `ai_chart_preview` — delegated to backend LLM. Claude proposes the
    config directly and uses `preview_chart_data` to verify.
  - `regenerate_chart_description` — backend LLM. Claude writes the
    description; `update_chart_description` saves it as plain text.

Phase-11 error-message contract:
  When a chart references a field on a view that is NOT reachable from
  the chart's base view via the dataset join graph, the BE semantic
  engine raises a Vietnamese message:

      "Bảng \"<X>\" chưa có relationship tới base view \"<Y>\".
       Mở tab Data Model để định nghĩa join trước khi dùng field từ
       bảng này."

  This surfaces in `preview_chart_data` / `create_chart` responses as
  `detail` on a 4xx. Forward the message verbatim — DA understands VN
  better than the old English engine identifier. To fix, the user must
  either (a) remove the cross-table field, or (b) add a relationship
  via `set_view_relationship`.

Phase-12 dataset-scope measure note:
  When chart `metric.field` references a measure with `scope='dataset'`
  (Phase-12), the engine auto-pulls every view in `source_columns` into
  the join graph. If any of those views is not reachable from the
  chart's base view, the engine raises the same VN message above. Tell
  the user to add a relationship between the base view and the missing
  source view.
"""
from __future__ import annotations

from typing import Any

from appbi_core import (
    APPBI_LONG_TIMEOUT_SECONDS,
    Context,
    _clamp_int,
    _confirmation_required_for_destructive,
    _drop_none,
    _query_path,
    _request,
    _requires_confirmation,
    tool,
)

SUPPORTED_CHART_TYPE_GROUPS: dict[str, tuple[str, ...]] = {
    "essentials": ("TABLE", "MATRIX", "KPI", "GAUGE", "BULLET", "PODIUM"),
    "comparison": (
        "BAR",
        "HORIZONTAL_BAR",
        "GROUPED_BAR",
        "STACKED_BAR",
        "BAR_LINE",
        "WATERFALL",
    ),
    "trend": ("LINE", "AREA", "TIME_SERIES", "RIBBON", "TIMELINE"),
    "composition": ("PIE", "DONUT", "POLAR_AREA", "TREEMAP", "FUNNEL", "WORD_CLOUD"),
    "relationship": ("SCATTER", "BUBBLE", "HEATMAP", "BOXPLOT", "RADAR", "SANKEY", "SUNBURST"),
    "geo": ("MAP_POINT", "MAP_REGION"),
}
SUPPORTED_CHART_TYPES: tuple[str, ...] = tuple(
    chart_type
    for group_types in SUPPORTED_CHART_TYPE_GROUPS.values()
    for chart_type in group_types
)

CHART_ROLE_REQUIREMENTS: dict[str, dict[str, Any]] = {
    "TABLE": {
        "required": [],
        "optional": ["selectedColumns"],
        "notes": "Raw table. Use selectedColumns to limit visible columns.",
    },
    "MATRIX": {
        "required": ["tableMode=pivot", "tableRowDimension", "tableColumnDimension", "tablePivotMetric"],
        "notes": "Pivot-style matrix table.",
    },
    "KPI": {"required": ["metrics[0]"], "optional": ["benchmarkMetric"]},
    "GAUGE": {"required": ["metrics[0]"], "optional": ["benchmarkMetric"]},
    "BULLET": {"required": ["metrics[0]"], "optional": ["benchmarkMetric"]},
    "PODIUM": {"required": ["dimension", "metrics[0]"], "notes": "Top-N ranking visual."},
    "BAR": {"required": ["dimension", "metrics"]},
    "HORIZONTAL_BAR": {"required": ["dimension", "metrics"]},
    "GROUPED_BAR": {"required": ["dimension", "breakdown", "metrics[0]"]},
    "STACKED_BAR": {"required": ["dimension", "breakdown", "metrics[0]"]},
    "BAR_LINE": {"required": ["dimension", "metrics", "lineMetric"]},
    "WATERFALL": {"required": ["dimension", "metrics[0]"]},
    "LINE": {"required": ["dimension", "metrics"], "optional": ["breakdown"]},
    "AREA": {"required": ["dimension", "metrics"], "optional": ["breakdown"]},
    "TIME_SERIES": {"required": ["timeField", "metrics"], "optional": ["breakdown"]},
    "RIBBON": {"required": ["timeField", "breakdown", "metrics[0]"]},
    "TIMELINE": {"required": ["timeField", "dimension"], "optional": ["metrics[0]"]},
    "PIE": {"required": ["dimension", "metrics[0]"]},
    "DONUT": {"required": ["dimension", "metrics[0]"]},
    "POLAR_AREA": {"required": ["dimension", "metrics[0]"]},
    "RADAR": {"required": ["dimension", "metrics"], "notes": "Use multiple metrics for multiple radar series."},
    "TREEMAP": {"required": ["dimension", "metrics[0]"]},
    "FUNNEL": {"required": ["dimension", "metrics[0]"]},
    "WORD_CLOUD": {"required": ["dimension", "metrics[0]"]},
    "SCATTER": {"required": ["scatterX", "scatterY"], "optional": ["dimension"]},
    "BUBBLE": {"required": ["scatterX", "scatterY", "metrics[0]"], "optional": ["dimension"]},
    "MAP_POINT": {"required": ["scatterX", "scatterY"], "optional": ["dimension", "metrics[0]"]},
    "MAP_REGION": {"required": ["dimension", "metrics[0]"]},
    "HEATMAP": {"required": ["dimension", "breakdown", "metrics[0]"]},
    "BOXPLOT": {"required": ["dimension", "metrics[0]"], "notes": "Uses raw distribution rows."},
    "SANKEY": {"required": ["dimension", "breakdown", "metrics[0]"]},
    "SUNBURST": {"required": ["dimension", "breakdown", "metrics[0]"]},
}

BREAKDOWN_SUPPORTED_CHART_TYPES = {
    "GROUPED_BAR",
    "STACKED_BAR",
    "HEATMAP",
    "SANKEY",
    "SUNBURST",
    "RIBBON",
    "LINE",
    "AREA",
    "TIME_SERIES",
}
SINGLE_METRIC_CHART_TYPES = {
    "GROUPED_BAR",
    "STACKED_BAR",
    "PIE",
    "DONUT",
    "POLAR_AREA",
    "FUNNEL",
    "TREEMAP",
    "WATERFALL",
    "MAP_REGION",
    "BOXPLOT",
    "HEATMAP",
    "SANKEY",
    "SUNBURST",
    "RIBBON",
    "TIMELINE",
    "WORD_CLOUD",
    "KPI",
    "GAUGE",
    "BULLET",
    "PODIUM",
}
NO_DIMENSION_METRIC_CHART_TYPES = {"KPI", "GAUGE", "BULLET"}
SCATTER_LIKE_CHART_TYPES = {"SCATTER", "BUBBLE", "MAP_POINT"}
TWO_DIMENSION_CHART_TYPES = {"HEATMAP", "SANKEY", "SUNBURST"}
PIE_LIKE_CHART_TYPES = {"PIE", "DONUT", "POLAR_AREA"}
CATEGORY_VALUE_CHART_TYPES = {
    "FUNNEL",
    "TREEMAP",
    "WATERFALL",
    "MAP_REGION",
    "WORD_CLOUD",
    "BOXPLOT",
}


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


@tool("report")
async def list_charts(
    q: str | None = None,
    chart_type: str | None = None,
    scope: str = "all",
    sort: str = "updated_desc",
    skip: int = 0,
    limit: int = 100,
    dataset_id: int | None = None,
    dataset_table_id: int | None = None,
    summary: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """List charts. Default returns FULL records (>500KB at 40 charts).

    Always pass `summary=True` unless inspecting a specific chart's config.
    `q`: substring search. `chart_type`: enum filter (uppercase).
    `scope`: all|mine|shared. `sort`: updated_desc|created_desc|name_asc|
    name_desc|relevance. `skip`/`limit` paginate (max 500).
    `dataset_id`/`dataset_table_id`: client-side post-filter (BE doesn't support).
    """
    items = await _request(
        "GET",
        _query_path(
            "/charts/",
            {
                "q": q,
                "chart_type": chart_type,
                "scope": scope,
                "sort": sort,
                "skip": skip,
                "limit": limit,
            },
        ),
    )
    if isinstance(items, list):
        if dataset_id is not None:
            items = [
                item for item in items
                if isinstance(item, dict)
                and (item.get("dataset_id") == int(dataset_id))
            ]
        if dataset_table_id is not None:
            items = [
                item for item in items
                if isinstance(item, dict)
                and (item.get("dataset_table_id") == int(dataset_table_id))
            ]
    if summary and isinstance(items, list):
        return {"items": [_summarize_chart_item(item) for item in items]}
    return {"items": items}


def _summarize_chart_item(chart: Any) -> dict[str, Any]:
    if not isinstance(chart, dict):
        return {"raw_type": type(chart).__name__}
    config = chart.get("config") or {}
    role = (
        config.get("customRoleConfig")
        if str(config.get("queryMode") or "").lower() == "custom"
        else config.get("generatedRoleConfig") or config.get("roleConfig")
    ) or {}
    return {
        "id": chart.get("id"),
        "name": chart.get("name"),
        "chart_type": chart.get("chart_type"),
        "dataset_table_id": chart.get("dataset_table_id"),
        "owner": chart.get("owner") or chart.get("user_id"),
        "role_summary": {
            "dimension": role.get("dimension") or role.get("timeField"),
            "breakdown": role.get("breakdown"),
            "metric_fields": [
                m.get("field")
                for m in (role.get("metrics") or [])
                if isinstance(m, dict)
            ],
        },
    }


@tool("report")
async def get_chart(chart_id: int, ctx: Context | None = None) -> dict[str, Any]:
    """Fetch one chart's full record (config, dataset_table_id, owner)."""
    return await _request("GET", f"/charts/{int(chart_id)}")


@tool("all")
async def get_chart_data(
    chart_id: int,
    filters_json: str | None = None,
    context: str | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Run a saved chart's query — data + columns. Honors chart's saved limit.

    `filters_json`: JSON array of [{field, operator, value}] applied on top
    of chart's filters. `context`: filter scope label (e.g. "dashboard").
    """
    return await _request(
        "GET",
        _query_path(
            f"/charts/{int(chart_id)}/data",
            {"filters": filters_json, "context": context},
        ),
    )


@tool("report")
async def preview_chart_data(
    dataset_table_id: int,
    chart_type: str,
    config: dict[str, Any],
    context: str | None = None,
    include_source_sample: bool = False,
    source_sample_limit: int = 50,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Run a chart query WITHOUT saving. Verify before create_chart.

    `chart_type`: uppercase enum (BAR, LINE, KPI, ...).
    `config`: Explore shape — chartType, queryMode, roleConfig,
    generatedRoleConfig|customRoleConfig, styleConfig, filters, baseFilters.
    `context`: filter scope label ("dashboard" typical) for scope-keyed overrides.
    """
    body = _drop_none(
        {
            "dataset_table_id": int(dataset_table_id),
            "chart_type": chart_type,
            "config": config,
            "context": context,
            "include_source_sample": bool(include_source_sample),
            "source_sample_limit": _clamp_int(
                source_sample_limit, default=50, minimum=1, maximum=200
            ),
        }
    )
    return await _request("POST", "/charts/preview-data", json_body=body)


@tool("all")
async def get_chart_description(
    chart_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Read the saved description payload for a chart."""
    return await _request("GET", f"/charts/{int(chart_id)}/description")


@tool("all")
async def list_chart_parameters(
    chart_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """List runtime parameters defined on a chart (date_range, dimension, etc.)."""
    items = await _request("GET", f"/charts/{int(chart_id)}/parameters")
    return {"items": items}


@tool("all")
async def search_charts(
    query: str, limit: int = 10, ctx: Context | None = None
) -> dict[str, Any]:
    """Vector-similarity search across charts by description / metadata."""
    return await _request(
        "GET", _query_path("/charts/search", {"q": query, "limit": int(limit)})
    )


# ---------------------------------------------------------------------------
# Chart contract helpers
# ---------------------------------------------------------------------------
#
# The previously exposed `get_supported_chart_types`, `build_chart_config`,
# and `validate_chart_config` tools have been removed. Their logic lives on
# in this module as private helpers used by the blueprint flow and
# `create_chart`'s pre-flight check. Claude no longer needs round-trip MCP
# calls to inspect chart metadata — the blueprint flow surfaces the same
# information in `propose_dashboard_blueprint` (available_measures /
# available_dimensions / explores), and `create_chart` validates the
# config server-side before writing.
#
# If you need the chart type catalogue at runtime, import
# `SUPPORTED_CHART_TYPES` and `CHART_ROLE_REQUIREMENTS` directly.


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


@tool("report")
async def create_chart(
    name: str,
    chart_type: str,
    dataset_table_id: int,
    config: dict[str, Any],
    description: str | None = None,
    bypass_semantic_check: bool = False,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create one chart. Prefer commit_dashboard_blueprint for dashboards.

    Every semantic field must resolve in the SemanticView. Qualified refs
    like `orders.customer_name` are preserved (the runtime decides legacy
    vs semantic-JOIN path). `bypass_semantic_check=True` skips that gate —
    explain to the user first. Workflow: get_table_profile → ensure
    SemanticView → preview_chart_data → user_confirmed=True.
    """
    # Phase-12 single-source-of-truth contract:
    # Instead of mirroring normalization / Pydantic validation / runtime
    # preview locally (which historically drifted from BE rules every time
    # the contract evolved — Phase-3 `agg='auto'`, Phase-9 validator,
    # Phase-10 hydration), we delegate the entire pre-flight to the BE's
    # `/charts/dry-run-create` endpoint. The BE is the single gatekeeper.
    dry_run = await _request(
        "POST",
        "/charts/dry-run-create",
        json_body={
            "name": name,
            "chart_type": chart_type,
            "dataset_table_id": int(dataset_table_id),
            "config": config,
            "description": description,
        },
    )

    if not isinstance(dry_run, dict):
        return {"status": "error", "error": "Unexpected dry-run response from backend."}

    normalized_config = dry_run.get("normalized_config") or config
    changes = dry_run.get("changes") or []
    validation_errors = dry_run.get("validation_errors") or []
    runtime_errors = dry_run.get("runtime_errors") or []

    if validation_errors:
        return {
            "status": "blocked_by_validation",
            "validation_errors": validation_errors,
            "normalized_config": normalized_config,
            "fix": (
                "Fix the validation errors above and retry. The chart config "
                "did not pass the Pydantic/role-config gate the BE enforces."
            ),
        }

    if runtime_errors and not bypass_semantic_check:
        return {
            "status": "blocked_by_runtime_preview",
            "runtime_errors": runtime_errors,
            "root_cause": dry_run.get("runtime_root_cause"),
            "normalized_config": normalized_config,
            "fix": (
                "Adjust the chart config until dry-run-create returns ok=true, "
                "then retry. This guardrail prevents saving charts that later "
                "fail in Explore/runtime. Set bypass_semantic_check=true only "
                "after explaining to the user that the chart will likely be "
                "broken at view time."
            ),
        }

    body = _drop_none(
        {
            "name": name,
            "chart_type": chart_type,
            "dataset_table_id": int(dataset_table_id),
            "config": normalized_config,
            "description": description,
        }
    )

    if not user_confirmed:
        fe_unrecognised = dry_run.get("fe_unrecognised_keys") or []
        plan: dict[str, Any] = {
            "name": name,
            "chart_type": chart_type,
            "dataset_table_id": int(dataset_table_id),
            "config_summary": _summarize_chart_config(normalized_config),
            "description_preview": (description or "")[:200],
            "normalized_changes": changes,
            "runtime_preview_sample": dry_run.get("runtime_preview_sample") or [],
            "runtime_check": "passed" if not runtime_errors else "bypassed",
        }
        if fe_unrecognised:
            plan["fe_will_ignore"] = {
                "keys": fe_unrecognised[:20],
                "note": (
                    "These config keys will be saved by the BE but the Explore "
                    "renderer does NOT consume them — the chart will look "
                    "different from what was requested. Drop or rename these "
                    "keys (or accept that they have no visible effect)."
                ),
            }
        return _requires_confirmation("create_chart", plan)
    return await _request("POST", "/charts/", json_body=body)


async def _semantic_preflight(
    *,
    dataset_table_id: int,
    config: dict[str, Any],
    chart_type: str,
) -> list[str]:
    """Validate the chart's metrics AND dimension fields against the live semantic model.

    Returns a list of human-readable issues; an empty list means the
    chart is safe to create. Reads `/semantic/views` once (cheap, no
    per-dataset scan) and uses the view whose `dataset_table_id`
    matches.

    This pre-flight is intentionally lighter than backend runtime:
    - unqualified refs must exist on the bound/base view
    - qualified refs may target any real semantic view
    - actual join-path / semantic-runtime compatibility is enforced by
      `preview_chart_data`, which is the canonical backend authority
    """
    try:
        views = await _request("GET", "/semantic/views")
    except RuntimeError as exc:
        return [
            f"Could not load /semantic/views to validate metrics: {exc}. "
            "Pass bypass_semantic_check=True if this is intentional."
        ]
    if not isinstance(views, list):
        return [f"Unexpected /semantic/views response type: {type(views).__name__}."]

    bound_view = next(
        (
            v
            for v in views
            if isinstance(v, dict)
            and v.get("dataset_table_id") == int(dataset_table_id)
        ),
        None,
    )
    if bound_view is None:
        return [
            f"No SemanticView is bound to dataset_table_id={dataset_table_id}. "
            "The chart would render in the dashboard but disappear from "
            "Explore and the dataset model UI. Run propose_semantic_model "
            "for this dataset first."
        ]

    measure_index: dict[str, set[str]] = {}
    dimension_index: dict[str, set[str]] = {}
    for v in views:
        if not isinstance(v, dict):
            continue
        vn = str(v.get("name") or "")
        measure_index[vn] = {
            str(m.get("name")) for m in (v.get("measures") or []) if m.get("name")
        }
        dimension_index[vn] = {
            str(d.get("name")) for d in (v.get("dimensions") or []) if d.get("name")
        }

    ctype = _normalize_chart_type(chart_type)
    role_config = _get_active_role_config(config)
    issues: list[str] = []

    # ── Role shape validation ──
    role_result = _validate_chart_role_config(ctype, role_config)
    for err in role_result.get("errors") or []:
        issues.append(f"role_config shape: {err}")

    # ── Metric field resolution ──
    metrics = role_config.get("metrics") or []
    bound_view_name = str(bound_view.get("name") or "")
    for index, metric in enumerate(metrics):
        if not isinstance(metric, dict):
            issues.append(f"metrics[{index}] is not an object.")
            continue
        field = str(metric.get("field") or "").strip()
        if not field:
            issues.append(f"metrics[{index}].field is empty.")
            continue
        if "." in field:
            view_part, _, name_part = field.partition(".")
            if view_part not in measure_index:
                issues.append(
                    f"metrics[{index}].field='{field}' references view "
                    f"'{view_part}' which has no SemanticView."
                )
            elif name_part not in measure_index[view_part]:
                available = sorted(measure_index[view_part])
                issues.append(
                    f"metrics[{index}].field='{field}' is not a measure on "
                    f"'{view_part}'. Available on that view: {available}."
                )
        else:
            if field not in measure_index.get(bound_view_name, set()):
                available = sorted(measure_index.get(bound_view_name, set()))
                issues.append(
                    f"metrics[{index}].field='{field}' is not a measure on "
                    f"the bound view '{bound_view_name}'. Available: {available}."
                )

    # ── Dimension-like field resolution (present, non-empty keys) ──
    _DIM_KEYS = {
        "dimension", "breakdown", "timeField", "scatterX", "scatterY",
        "tableRowDimension", "tableColumnDimension",
    }
    for dim_key in _DIM_KEYS:
        val = str(role_config.get(dim_key) or "").strip()
        if not val:
            continue
        if "." in val:
            view_part, _, field_part = val.partition(".")
            if view_part not in dimension_index:
                issues.append(
                    f"role_config.{dim_key}='{val}' references view "
                    f"'{view_part}' which has no SemanticView."
                )
            elif field_part not in dimension_index[view_part]:
                available = sorted(dimension_index[view_part])
                issues.append(
                    f"role_config.{dim_key}='{val}' is not a dimension on "
                    f"'{view_part}'. Available: {available}."
                )
        else:
            if val not in dimension_index.get(bound_view_name, set()):
                available = sorted(dimension_index.get(bound_view_name, set()))
                issues.append(
                    f"role_config.{dim_key}='{val}' is not a dimension on "
                    f"the bound view '{bound_view_name}'. Available: {available}."
                )

    for metric_key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
        metric = role_config.get(metric_key)
        if not isinstance(metric, dict):
            continue
        field = str(metric.get("field") or "").strip()
        if not field:
            continue
        if "." in field:
            view_part, _, name_part = field.partition(".")
            if view_part not in measure_index:
                issues.append(
                    f"role_config.{metric_key}.field='{field}' references view "
                    f"'{view_part}' which has no SemanticView."
                )
            elif name_part not in measure_index[view_part]:
                available = sorted(measure_index[view_part])
                issues.append(
                    f"role_config.{metric_key}.field='{field}' is not a measure on "
                    f"'{view_part}'. Available on that view: {available}."
                )
        else:
            if field not in measure_index.get(bound_view_name, set()):
                available = sorted(measure_index.get(bound_view_name, set()))
                issues.append(
                    f"role_config.{metric_key}.field='{field}' is not a measure on "
                    f"the bound view '{bound_view_name}'. Available: {available}."
                )

    selected_columns = role_config.get("selectedColumns") or []
    for index, column in enumerate(selected_columns):
        if not isinstance(column, str):
            continue
        field = column.strip()
        if not field:
            continue
        if "." in field:
            view_part, _, name_part = field.partition(".")
            if view_part not in dimension_index:
                issues.append(
                    f"role_config.selectedColumns[{index}]='{field}' references view "
                    f"'{view_part}' which has no SemanticView."
                )
            elif (
                name_part not in dimension_index.get(view_part, set())
                and name_part not in measure_index.get(view_part, set())
            ):
                issues.append(
                    f"role_config.selectedColumns[{index}]='{field}' is neither a "
                    f"dimension nor a measure on '{view_part}'."
                )
        else:
            if (
                field not in dimension_index.get(bound_view_name, set())
                and field not in measure_index.get(bound_view_name, set())
            ):
                issues.append(
                    f"role_config.selectedColumns[{index}]='{field}' is neither a "
                    f"dimension nor a measure on the bound view '{bound_view_name}'."
                )

    return issues


async def _runtime_preview_preflight(
    *,
    dataset_table_id: int,
    chart_type: str,
    config: dict[str, Any],
) -> list[str]:
    """Dry-run the chart query before saving it.

    This catches runtime-invalid configs that pass symbolic semantic validation
    but still fail when the backend executes the chart query.
    """
    diag = await _runtime_preview_diagnose(
        dataset_table_id=dataset_table_id,
        chart_type=chart_type,
        config=config,
    )
    if diag is None:
        return []
    return diag["errors"]


async def _runtime_preview_diagnose(
    *,
    dataset_table_id: int,
    chart_type: str,
    config: dict[str, Any],
) -> dict[str, Any] | None:
    """Same as _runtime_preview_preflight but returns a structured diagnosis.

    Returns None on success. On failure returns:
      {
        "errors": [str, ...],       # raw error strings for backwards compat
        "raw_error": str,           # the backend exception message
        "root_cause": str | None,   # pattern-matched cause code
        "resolution_options": [...] # actionable next-steps
      }
    Use this when you want to surface a richer payload to the agent or user.
    """
    try:
        await _request(
            "POST",
            "/charts/preview-data",
            json_body={
                "dataset_table_id": int(dataset_table_id),
                "chart_type": chart_type,
                "config": config,
            },
            timeout_seconds=APPBI_LONG_TIMEOUT_SECONDS,
        )
    except RuntimeError as exc:
        raw = str(exc)
        diagnosis = _classify_preview_error(raw, config=config)
        return {
            "errors": [f"preview_chart_data failed for the final stored config: {raw}"],
            "raw_error": raw,
            **diagnosis,
        }
    return None


_PREVIEW_ERROR_PATTERNS: tuple[tuple[str, str, str], ...] = (
    # (regex/substring, root_cause, default_resolution_hint)
    (
        r"unrecognized name[: ]+['\"]?([A-Za-z_][A-Za-z0-9_]*)",
        "UNRECOGNIZED_FIELD",
        "The named field does not exist on the bound view's underlying SQL "
        "table. Either rename it to an existing dimension/measure, or add it "
        "to the bound view (commit_semantic_model) before retrying.",
    ),
    (
        r"must be qualified with a dataset",
        "BIGQUERY_UNQUALIFIED_TABLE",
        "Backend emitted a SQL reference without the BigQuery "
        "`project.dataset.` prefix. This is a known backend defect in the "
        "explore SQL generator — file an issue tagged 'CTE qualifier' or "
        "regenerate the dataset model after the fix lands.",
    ),
    (
        r"column .* does not exist|no such column",
        "COLUMN_NOT_IN_BOUND_VIEW",
        "Field referenced in role_config is not a column on the bound view's "
        "table. If it lives on a joined view, you must materialise it onto "
        "the bound view first (chart runtime does not apply explore joins).",
    ),
    (
        r"timeout|deadline exceeded",
        "PREVIEW_TIMEOUT",
        "Preview query ran past the backend timeout. Reduce dimension "
        "cardinality, add a date filter to baseFilters, or lower the chart's "
        "limit before retrying.",
    ),
)


def _classify_preview_error(
    raw: str, *, config: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Pattern-match a backend preview-data error and propose next steps.

    Defensive — unknown errors return root_cause=None with the raw message
    passed through to resolution_options as a single generic option.
    """
    import re as _re

    lowered = raw.lower()
    for pattern, code, hint in _PREVIEW_ERROR_PATTERNS:
        if _re.search(pattern, lowered):
            options = [{"option": code, "description": hint}]
            # Field-specific enrichment for UNRECOGNIZED_FIELD: surface the
            # offending field name back to the agent in a structured slot.
            if code == "UNRECOGNIZED_FIELD":
                match = _re.search(pattern, lowered)
                if match and match.lastindex:
                    options.append({
                        "offending_field": match.group(1),
                        "check_this": (
                            "Confirm this field is in fields_by_table[].dimensions "
                            "or fields_by_table[].chart_ready_measures for the "
                            "chart's dataset_table_id. If it is a semantic "
                            "measure with expression/filters, see "
                            "agent_contract.chart_incompatible_measures."
                        ),
                    })
            return {"root_cause": code, "resolution_options": options}
    return {
        "root_cause": None,
        "resolution_options": [
            {
                "option": "INSPECT_RAW",
                "description": (
                    "Unrecognised preview error. Read the raw message and "
                    "verify role_config field names against fields_by_table "
                    "from propose_dashboard_blueprint."
                ),
            }
        ],
    }


@tool("all")
async def update_chart(
    chart_id: int,
    name: str | None = None,
    chart_type: str | None = None,
    config: dict[str, Any] | None = None,
    dataset_table_id: int | None = None,
    description: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Update a chart's name/type/config/source/description."""
    changes = _drop_none(
        {
            "name": name,
            "chart_type": chart_type,
            "config": config,
            "dataset_table_id": dataset_table_id,
            "description": description,
        }
    )

    # Phase-12 contract: delegate normalize + validation + runtime preview
    # to the BE single gatekeeper. Same rationale as create_chart — the
    # update path historically drifted from BE rules whenever the contract
    # changed. By calling `/charts/dry-run-create` with the post-update
    # snapshot we get the BE's authoritative answer.
    if {"dataset_table_id", "chart_type", "config"} & set(changes.keys()):
        current_chart = await _request("GET", f"/charts/{int(chart_id)}")
        if not isinstance(current_chart, dict):
            return {"error": f"Chart {chart_id} not found"}
        effective_dataset_table_id = int(
            (dataset_table_id if dataset_table_id is not None else None)
            or current_chart.get("dataset_table_id")
            or 0
        )
        effective_chart_type = str(
            chart_type or current_chart.get("chart_type") or ""
        )
        effective_config = (
            config if isinstance(config, dict) else current_chart.get("config") or {}
        )
        dry_run = await _request(
            "POST",
            "/charts/dry-run-create",
            json_body={
                "name": name or current_chart.get("name") or f"Chart {chart_id}",
                "chart_type": effective_chart_type,
                "dataset_table_id": effective_dataset_table_id,
                "config": effective_config,
                "description": description if description is not None else current_chart.get("description"),
            },
        )
        if not isinstance(dry_run, dict):
            return {"status": "error", "error": "Unexpected dry-run response."}
        if dry_run.get("validation_errors"):
            return {
                "status": "blocked_by_validation",
                "validation_errors": dry_run["validation_errors"],
                "normalized_config": dry_run.get("normalized_config"),
                "fix": (
                    "Fix the validation errors and retry. The update payload "
                    "did not pass the BE's role-config gate."
                ),
            }
        if dry_run.get("runtime_errors"):
            return {
                "status": "blocked_by_runtime_preview",
                "runtime_errors": dry_run["runtime_errors"],
                "root_cause": dry_run.get("runtime_root_cause"),
                "normalized_config": dry_run.get("normalized_config"),
                "fix": (
                    "Adjust the final stored config until dry-run-create returns "
                    "ok=true, then retry the update."
                ),
            }
        normalized_config = dry_run.get("normalized_config") or effective_config
        if "config" in changes:
            changes["config"] = normalized_config

    if not user_confirmed:
        return _requires_confirmation(
            "update_chart",
            {
                "chart_id": int(chart_id),
                "fields": sorted(changes.keys()),
                "config_summary": (
                    _summarize_chart_config(config) if config else None
                ),
            },
        )
    return await _request(
        "PUT", f"/charts/{int(chart_id)}", json_body=changes
    )


@tool("all")
async def delete_chart(
    chart_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Delete a chart. Cascades to dashboard placements that reference it."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "delete_chart", {"chart_id": int(chart_id)}, reversible=False,
        )
    await _request(
        "DELETE", f"/charts/{int(chart_id)}", expect_json=False
    )
    return {"status": "deleted", "chart_id": int(chart_id)}


@tool("report")
async def update_chart_description(
    chart_id: int,
    auto_description: str | None = None,
    insight_keywords: list[str] | dict[str, Any] | None = None,
    common_questions: list[str] | None = None,
    query_aliases: list[str] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Save chart description fields (pure write, no LLM).

    Provide any of: auto_description (1-3 sentences), insight_keywords
    (tags), common_questions (3-5 NL questions), query_aliases (alt phrasings).
    For semantic metadata (domain/intent/metrics/...) use upsert_chart_metadata.
    """
    body = _drop_none(
        {
            "auto_description": auto_description,
            "insight_keywords": insight_keywords,
            "common_questions": common_questions,
            "query_aliases": query_aliases,
        }
    )
    if not body:
        raise ValueError(
            "Provide at least one of auto_description, insight_keywords, "
            "common_questions, query_aliases."
        )
    if not user_confirmed:
        return _requires_confirmation(
            "update_chart_description",
            {
                "chart_id": int(chart_id),
                "fields_to_update": sorted(body.keys()),
                "auto_description_preview": (
                    (auto_description or "")[:200] if auto_description else None
                ),
                "questions_count": (
                    len(common_questions) if common_questions else 0
                ),
            },
        )
    return await _request(
        "PUT", f"/charts/{int(chart_id)}/description", json_body=body
    )


@tool("all")
async def upsert_chart_metadata(
    chart_id: int,
    metadata: dict[str, Any],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Replace the chart's semantic metadata bag.

    Backed by PUT /charts/{id}/metadata. Use this for the searchable
    metadata fields that Explore exposes — typically a dict shaped like
    `{domain, intent, metrics, dimensions, tags, ...}` matching
    ChartMetadataUpsert. Distinct from `update_chart_description`,
    which persists the prose / common questions.
    """
    if not isinstance(metadata, dict) or not metadata:
        raise ValueError("metadata must be a non-empty dict.")
    if not user_confirmed:
        return _requires_confirmation(
            "upsert_chart_metadata",
            {
                "chart_id": int(chart_id),
                "metadata_keys": sorted(metadata.keys()),
            },
        )
    return await _request(
        "PUT", f"/charts/{int(chart_id)}/metadata", json_body=metadata
    )


# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------


@tool("all")
async def replace_chart_parameters(
    chart_id: int,
    parameters: list[dict[str, Any]],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Replace ALL parameters on a chart with the given list.

    Each parameter: {parameter_name, parameter_type ('time_range'|
    'dimension'|'measure'), column_mapping, default_value, description}.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "replace_chart_parameters",
            {
                "chart_id": int(chart_id),
                "parameter_count": len(parameters),
                "parameters_preview": [
                    {"name": p.get("parameter_name"), "type": p.get("parameter_type")}
                    for p in parameters[:10]
                ],
            },
        )
    return await _request(
        "PUT", f"/charts/{int(chart_id)}/parameters", json_body=parameters
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_chart_type(chart_type: str) -> str:
    return str(chart_type or "").strip().upper()


_ALLOWED_METRIC_AGGS: set[str] = {
    "sum", "avg", "count", "min", "max", "count_distinct", "auto",
}


def _normalize_metric(metric: Any) -> dict[str, Any] | None:
    """Coerce a chart spec's metric into the canonical ``{field, agg, ...}``
    shape the AppBI runtime expects.

    ``agg`` falls back to ``"sum"`` when missing AND ``field`` is a bare
    column. For semantic measures (qualified refs like ``view.field``) we
    fall back to ``"auto"`` — the chart runtime then defers to the
    measure's own aggregation, which is the contract Phase-3 introduced.
    Unknown aggregation strings collapse to ``"sum"`` so the chart cannot
    end up with a value that crashes Explore / Pydantic (Phase-9 422).
    """
    if isinstance(metric, str):
        field = metric.strip()
        if not field:
            return None
        default_agg = "auto" if "." in field else "sum"
        return {"field": field, "agg": default_agg}
    if not isinstance(metric, dict):
        return None
    field = str(metric.get("field") or "").strip()
    if not field:
        return None
    raw_agg = metric.get("agg") or metric.get("function")
    agg = str(raw_agg or "").strip().lower()
    if not agg:
        # Match the str-branch default: semantic refs → auto, bare → sum.
        agg = "auto" if "." in field else "sum"
    if agg not in _ALLOWED_METRIC_AGGS:
        agg = "sum"
    normalized = dict(metric)
    normalized["field"] = field
    normalized["agg"] = agg
    return normalized


def _normalize_role_config(chart_type: str, role_config: dict[str, Any] | None) -> dict[str, Any]:
    role = dict(role_config or {})
    metrics = [
        metric
        for metric in (_normalize_metric(metric) for metric in role.get("metrics") or [])
        if metric
    ]
    role["metrics"] = metrics

    for key in (
        "dimension",
        "breakdown",
        "timeField",
        "scatterX",
        "scatterY",
        "tableRowDimension",
        "tableColumnDimension",
    ):
        if isinstance(role.get(key), str):
            role[key] = role[key].strip() or None

    for key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
        metric = _normalize_metric(role.get(key))
        if metric:
            role[key] = metric
        elif key in role:
            role.pop(key, None)

    ctype = _normalize_chart_type(chart_type)
    if ctype not in BREAKDOWN_SUPPORTED_CHART_TYPES:
        role.pop("breakdown", None)
    if ctype in SINGLE_METRIC_CHART_TYPES and len(role["metrics"]) > 1:
        role["metrics"] = role["metrics"][:1]
    if ctype == "MATRIX":
        role["tableMode"] = "pivot"
    elif str(role.get("tableMode") or "").lower() != "pivot":
        role["tableMode"] = "standard"
    return role


def _normalize_chart_config_for_save(config: dict[str, Any], chart_type: str) -> dict[str, Any]:
    """Return a copy of ``config`` with role_config + generatedRoleConfig +
    customRoleConfig run through :func:`_normalize_role_config`.

    Used by ``create_chart`` / ``update_chart`` so MCP can never write a
    config whose ``metrics[].agg`` is missing or invalid — the recurring
    Phase-9 / Phase-10 defect when AI hand-authored configs slipped past
    both the field-level validator and the Pydantic ChartCreate envelope.
    """
    if not isinstance(config, dict):
        return config
    out = dict(config)
    for key in ("roleConfig", "generatedRoleConfig", "customRoleConfig"):
        raw = out.get(key)
        if isinstance(raw, dict):
            out[key] = _normalize_role_config(chart_type, raw)
    return out


def _get_active_role_config(config: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(config, dict):
        return {}
    query_mode = str(config.get("queryMode") or "generated").strip().lower()
    if query_mode == "custom" and isinstance(config.get("customRoleConfig"), dict):
        return config.get("customRoleConfig") or {}
    if query_mode != "custom" and isinstance(config.get("generatedRoleConfig"), dict):
        return config.get("generatedRoleConfig") or {}
    if isinstance(config.get("roleConfig"), dict):
        return config.get("roleConfig") or {}
    return {}


def _bare_field(val: str) -> str:
    """Strip 'view.' prefix from a qualified 'view.field' string."""
    if val and "." in val:
        _, _, name = val.partition(".")
        return name.strip() or val
    return val


def _unqualify_role_config(role_config: dict[str, Any]) -> dict[str, Any]:
    """Strip 'view.' qualifiers from all field names in a role_config dict.

    The backend's LiveQueryService.build_live_agg_query uses role_config field
    names as raw SQL column identifiers. Qualified names like 'orders.amount'
    get wrapped as \"orders.amount\" by _quote_identifier — an invalid SQL
    identifier — causing a 500 in Explore. Strip the qualifier here.
    """
    rc = dict(role_config)
    for key in ("dimension", "breakdown", "timeField", "scatterX", "scatterY",
                "tableRowDimension", "tableColumnDimension"):
        if isinstance(rc.get(key), str):
            rc[key] = _bare_field(rc[key])
    if isinstance(rc.get("metrics"), list):
        rc["metrics"] = [
            {**m, "field": _bare_field(m["field"])}
            if isinstance(m, dict) and isinstance(m.get("field"), str)
            else m
            for m in rc["metrics"]
        ]
    for key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
        if isinstance(rc.get(key), dict) and isinstance(rc[key].get("field"), str):
            rc[key] = {**rc[key], "field": _bare_field(rc[key]["field"])}
    if isinstance(rc.get("selectedColumns"), list):
        rc["selectedColumns"] = [
            _bare_field(c) if isinstance(c, str) else c
            for c in rc["selectedColumns"]
        ]
    return rc


def _unqualify_config_role_fields(config: dict[str, Any] | None) -> dict[str, Any]:
    """Apply _unqualify_role_config to all role_config slots in a chart config."""
    if not isinstance(config, dict):
        return config or {}
    result = dict(config)
    for slot in ("roleConfig", "generatedRoleConfig", "customRoleConfig"):
        if isinstance(result.get(slot), dict):
            result[slot] = _unqualify_role_config(result[slot])
    return result


def _has_metric(role_config: dict[str, Any]) -> bool:
    return bool(role_config.get("metrics") or [])


def _has_named_metric(role_config: dict[str, Any], key: str) -> bool:
    return bool(_normalize_metric(role_config.get(key)))


def _validate_chart_role_config(chart_type: str, role_config: dict[str, Any]) -> dict[str, Any]:
    ctype = _normalize_chart_type(chart_type)
    role = _normalize_role_config(ctype, role_config)
    errors: list[str] = []
    warnings: list[str] = []

    def require_field(field: str, label: str | None = None) -> None:
        if not role.get(field):
            errors.append(f"Missing {label or field}.")

    def require_metric(label: str = "metrics[0]") -> None:
        if not _has_metric(role):
            errors.append(f"Missing {label}.")

    if ctype not in SUPPORTED_CHART_TYPES:
        errors.append(f"Unsupported chart_type '{chart_type}'.")
        return {"valid": False, "errors": errors, "warnings": warnings}

    if ctype == "TABLE":
        return {"valid": True, "errors": [], "warnings": warnings}

    if ctype == "MATRIX":
        if str(role.get("tableMode") or "").lower() != "pivot":
            errors.append("MATRIX requires tableMode='pivot'.")
        require_field("tableRowDimension")
        require_field("tableColumnDimension")
        if not _has_named_metric(role, "tablePivotMetric"):
            errors.append("Missing tablePivotMetric.")
    elif ctype in NO_DIMENSION_METRIC_CHART_TYPES:
        require_metric()
    elif ctype in SCATTER_LIKE_CHART_TYPES:
        require_field("scatterX")
        require_field("scatterY")
        if ctype == "BUBBLE":
            require_metric("size metric")
    elif ctype in PIE_LIKE_CHART_TYPES or ctype in CATEGORY_VALUE_CHART_TYPES or ctype == "PODIUM":
        require_field("dimension")
        require_metric()
    elif ctype in TWO_DIMENSION_CHART_TYPES:
        require_field("dimension", "source dimension")
        require_field("breakdown", "target/breakdown dimension")
        require_metric()
    elif ctype == "RIBBON":
        require_field("timeField")
        require_field("breakdown")
        require_metric()
    elif ctype == "TIMELINE":
        require_field("timeField")
        require_field("dimension", "label dimension")
    elif ctype == "BAR_LINE":
        require_field("dimension")
        require_metric("bar metrics")
        if not _has_named_metric(role, "lineMetric"):
            errors.append("Missing lineMetric.")
    elif ctype in {"GROUPED_BAR", "STACKED_BAR"}:
        require_field("dimension")
        require_field("breakdown")
        require_metric()
    elif ctype == "TIME_SERIES":
        require_field("timeField")
        require_metric()
    else:
        require_field("dimension")
        require_metric()

    if ctype in SINGLE_METRIC_CHART_TYPES and len(role.get("metrics") or []) > 1:
        warnings.append("This chart uses only the first metric.")
    if role.get("breakdown") and ctype not in BREAKDOWN_SUPPORTED_CHART_TYPES:
        warnings.append("breakdown is ignored by this chart type.")
    if ctype in {"LINE", "AREA", "TIME_SERIES"} and role.get("breakdown") and len(role.get("metrics") or []) > 1:
        errors.append("Breakdown cannot be combined with multiple metrics for this chart.")

    return {"valid": not errors, "errors": errors, "warnings": warnings}


def _summarize_nested_dict(value: dict[str, Any], *, max_keys: int = 12) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for index, key in enumerate(sorted(value.keys())):
        if index >= max_keys:
            summary["truncated_keys"] = len(value) - max_keys
            break
        item = value[key]
        if isinstance(item, list):
            summary[key] = item[:6]
            if len(item) > 6:
                summary[f"{key}_truncated"] = len(item) - 6
        elif isinstance(item, dict):
            summary[key] = _summarize_nested_dict(item, max_keys=6)
        else:
            summary[key] = item
    return summary


def _summarize_chart_config(config: dict[str, Any]) -> dict[str, Any]:
    """Compact representation of a chart config for confirmation plans.

    Avoids dumping a 50-field nested config when the human just wants
    'what dimensions / measures / filters'.
    """
    if not isinstance(config, dict):
        return {"raw_type": type(config).__name__}
    keys_of_interest = (
        "chartType",
        "queryMode",
        "roleConfig",
        "generatedRoleConfig",
        "customRoleConfig",
        "dimensions",
        "measures",
        "metrics",
        "filters",
        "baseFilters",
        "sort",
        "limit",
        "explore",
        "pivot",
        "time_grain",
        "styleConfig",
    )
    out: dict[str, Any] = {}
    for k in keys_of_interest:
        if k in config:
            value = config[k]
            if isinstance(value, list):
                out[k] = value[:8]
                if len(value) > 8:
                    out[f"{k}_truncated"] = len(value) - 8
            elif isinstance(value, dict):
                out[k] = _summarize_nested_dict(value)
            else:
                out[k] = value
    out["all_keys"] = sorted(config.keys())
    return out


__all__: list[str] = []
