"""Stage 4 — Charts.

Tools for creating and editing charts. Charts target a `dataset_table_id`
and pass a `config` blob whose shape depends on `chart_type`.

Removed vs the legacy MCP:
  - `ai_chart_preview` — delegated to backend LLM. Claude proposes the
    config directly and uses `preview_chart_data` to verify.
  - `regenerate_chart_description` — backend LLM. Claude writes the
    description; `update_chart_description` saves it as plain text.
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
    dataset_id: int | None = None,
    dataset_table_id: int | None = None,
    summary: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """List charts. Filter by dataset or specific table when narrowing scope.

    Default returns the full chart records (config payload included — a list
    of 40+ charts can exceed 500KB). Pass `summary=True` to keep only
    id/name/chart_type/dataset_table_id/owner plus a one-line role summary,
    which is enough to choose which chart to inspect with `get_chart`.
    """
    items = await _request(
        "GET",
        _query_path(
            "/charts/",
            {
                "dataset_id": dataset_id,
                "dataset_table_id": dataset_table_id,
            },
        ),
    )
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
    """Run a saved chart's query and return its data + columns.

    Use to pull the actual values a chart renders — useful when verifying
    a dashboard's numbers without opening a browser. The chart's saved
    `limit` (in its config) is honored server-side; this endpoint does
    NOT accept a row cap override.

    `filters_json` is a JSON-encoded array of `{field, operator, value}`
    filter objects to apply on top of the chart's own filters (typically
    used to simulate dashboard filter context).
    `context` is the runtime filter context label (e.g. "dashboard").
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
    context: dict[str, Any] | None = None,
    include_source_sample: bool = False,
    source_sample_limit: int = 50,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Run a chart's query WITHOUT saving the chart.

    Critical for the orchestrator flow: design `config`, preview, verify
    the numbers look right, THEN call `create_chart` (or commit through
    the blueprint flow). If preview fails, iterate the config in chat
    rather than asking the backend to auto-fix — there is no AI fixer.

    `chart_type` values are uppercase AppBI enums (BAR, LINE, KPI, ...).
    `config` is the AppBI Explore shape: `chartType`, `queryMode`,
    `roleConfig`, `generatedRoleConfig` / `customRoleConfig`,
    `styleConfig`, `filters`, `baseFilters`. The blueprint flow builds
    this shape for you; for ad-hoc previews, mirror the structure
    `propose_dashboard_blueprint` returns under `blueprint_template`.
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
    """Create a single chart.

    **Prefer the blueprint flow** (`propose_dashboard_blueprint` →
    `commit_dashboard_blueprint`) when you are building a dashboard.
    Use `create_chart` only for one-off charts the user explicitly asked
    for outside that flow (e.g. "add this single KPI tile to dashboard X").

    Hard gate: every referenced semantic field must resolve to a real
    dimension/measure in the live semantic catalog. Qualified refs such
    as `orders.customer_name` or `creator.email` are preserved; the
    backend chart runtime decides whether the chart stays on the legacy
    single-table path or routes to semantic runtime with JOIN handling.

    `bypass_semantic_check=True` is an escape hatch for the rare case
    where the user wants the chart created anyway (legacy data
    migration, synthetic test charts). Surface the warning in chat
    before using it.

    Workflow:
      1. Profile via `get_table_profile`.
      2. Confirm a SemanticView with the right measures exists; if not,
         go to `propose_semantic_model` first.
      3. `preview_chart_data` to verify the query returns sensible rows.
      4. Author a description.
      5. On user consent, call this with `user_confirmed=True`.
    """
    body = _drop_none(
        {
            "name": name,
            "chart_type": chart_type,
            "dataset_table_id": int(dataset_table_id),
            "config": config,
            "description": description,
        }
    )

    semantic_warnings: list[str] = []
    if not bypass_semantic_check:
        try:
            semantic_warnings = await _semantic_preflight(
                dataset_table_id=int(dataset_table_id),
                config=config,
                chart_type=chart_type,
            )
        except RuntimeError as exc:
            semantic_warnings = [
                f"Semantic pre-flight could not run: {exc}. "
                "Pass bypass_semantic_check=True to proceed anyway."
            ]
        if semantic_warnings:
            return {
                "status": "blocked_by_semantic_check",
                "warnings": semantic_warnings,
                "fix": (
                    "Either: (a) fix the chart so every referenced field "
                    "exists in the semantic model; (b) extend the semantic "
                    "model first via update_semantic_view / "
                    "propose_semantic_model; or (c) pass "
                    "bypass_semantic_check=True after explaining the "
                    "tradeoff to the user."
                ),
            }

    if not user_confirmed:
        return _requires_confirmation(
            "create_chart",
            {
                "name": name,
                "chart_type": chart_type,
                "dataset_table_id": int(dataset_table_id),
                "config_summary": _summarize_chart_config(config),
                "description_preview": (description or "")[:200],
                "semantic_check": "passed" if not semantic_warnings else "bypassed",
            },
        )
    diag = await _runtime_preview_diagnose(
        dataset_table_id=int(dataset_table_id),
        chart_type=chart_type,
        config=body["config"],
    )
    if diag is not None:
        return {
            "status": "blocked_by_runtime_preview",
            "warnings": diag["errors"],
            "raw_error": diag.get("raw_error"),
            "root_cause": diag.get("root_cause"),
            "resolution_options": diag.get("resolution_options"),
            "fix": (
                "Adjust the chart config until preview_chart_data succeeds, then retry. "
                "This guardrail prevents saving charts that later fail in Explore/runtime."
            ),
        }
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

    effective_dataset_table_id = dataset_table_id
    effective_chart_type = chart_type
    effective_config = config
    if {"dataset_table_id", "chart_type", "config"} & set(changes.keys()):
        current_chart = await _request("GET", f"/charts/{int(chart_id)}")
        if not isinstance(current_chart, dict):
            return {"error": f"Chart {chart_id} not found"}
        effective_dataset_table_id = int(
            effective_dataset_table_id
            or current_chart.get("dataset_table_id")
            or 0
        )
        effective_chart_type = str(
            effective_chart_type or current_chart.get("chart_type") or ""
        )
        effective_config = (
            effective_config
            if isinstance(effective_config, dict)
            else current_chart.get("config") or {}
        )
        semantic_warnings = await _semantic_preflight(
            dataset_table_id=effective_dataset_table_id,
            config=effective_config,
            chart_type=effective_chart_type,
        )
        if semantic_warnings:
            return {
                "status": "blocked_by_semantic_check",
                "warnings": semantic_warnings,
                "fix": (
                    "Adjust the chart so every referenced field exists in the "
                    "semantic model, or update the semantic model first, then retry."
                ),
            }
        diag = await _runtime_preview_diagnose(
            dataset_table_id=effective_dataset_table_id,
            chart_type=effective_chart_type,
            config=effective_config,
        )
        if diag is not None:
            return {
                "status": "blocked_by_runtime_preview",
                "warnings": diag["errors"],
                "raw_error": diag.get("raw_error"),
                "root_cause": diag.get("root_cause"),
                "resolution_options": diag.get("resolution_options"),
                "fix": (
                    "Adjust the final stored config until preview_chart_data succeeds, "
                    "then retry the update."
                ),
            }
        if "config" in changes:
            changes["config"] = effective_config

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
    """Save chart description fields that Claude authored.

    Fields persisted on the chart's metadata record (PUT
    /charts/{id}/description). Provide one or more of:

      - auto_description : 1-3 sentence summary of what the chart shows.
      - insight_keywords : tags / themes for similarity search.
      - common_questions : 3-5 natural-language questions the chart answers.
      - query_aliases    : alternative phrasings users might use.

    Sets `description_source='user'` and triggers background re-embedding.
    For the separate semantic metadata bag (domain, intent, metrics,
    dimensions, tags) use `upsert_chart_metadata` instead.
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


def _normalize_metric(metric: Any) -> dict[str, Any] | None:
    if isinstance(metric, str):
        field = metric.strip()
        return {"field": field, "agg": "sum"} if field else None
    if not isinstance(metric, dict):
        return None
    field = str(metric.get("field") or "").strip()
    if not field:
        return None
    agg = str(metric.get("agg") or metric.get("function") or "sum").strip().lower()
    if agg not in {"sum", "avg", "count", "min", "max", "count_distinct"}:
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
