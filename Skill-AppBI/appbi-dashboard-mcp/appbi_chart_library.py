"""Stage 4 — pattern-driven chart builders, one tool per chart type.

32 thin wrappers, each with the EXACT role_config shape baked in for its
chart_type. Claude picks the tool by intent ("xu hướng theo thời gian" →
add_line_chart, "tỷ trọng" → add_pie_chart …) and never authors raw
roleConfig / generatedRoleConfig keys.

Every tool:
  - takes the fields its chart_type actually needs (typed params)
  - normalises agg via `agg='auto'` for declared measure refs
  - validates layout via the shared _normalize_chart_layout helper
  - returns auto_logged_to + dashboard placement hint
"""
from __future__ import annotations

from typing import Any, Literal

from appbi_core import (
    Context,
    _append_session_log,
    _drop_none,
    _request,
    _requires_confirmation,
    tool,
)


# ---------------------------------------------------------------------------
# Shared internals
# ---------------------------------------------------------------------------


_LAYOUT_DEFAULTS: dict[str, tuple[int, int]] = {
    "KPI": (3, 2), "GAUGE": (3, 2), "BULLET": (3, 2), "PODIUM": (6, 4),
    "TABLE": (12, 5), "MATRIX": (12, 5),
    "SCATTER": (6, 5), "BUBBLE": (6, 5), "MAP_POINT": (6, 5),
    "MAP_REGION": (6, 5), "HEATMAP": (12, 5), "SANKEY": (12, 5),
    "SUNBURST": (6, 5), "TREEMAP": (6, 5), "RADAR": (6, 5),
    "BAR_LINE": (12, 4), "TIME_SERIES": (12, 4), "RIBBON": (12, 4),
    "TIMELINE": (12, 4),
}
_LAYOUT_FALLBACK = (6, 4)


def _norm_layout(layout: dict[str, Any] | None, chart_type: str) -> dict[str, int]:
    dw, dh = _LAYOUT_DEFAULTS.get(chart_type.upper(), _LAYOUT_FALLBACK)
    if not isinstance(layout, dict):
        return {"x": 0, "y": 0, "w": dw, "h": dh}
    try:
        x = max(0, min(11, int(layout.get("x", 0))))
        y = max(0, int(layout.get("y", 0)))
        w = max(3, min(12, int(layout.get("w", dw))))
        h = max(2, int(layout.get("h", dh)))
    except (TypeError, ValueError):
        return {"x": 0, "y": 0, "w": dw, "h": dh}
    if x + w > 12:
        w = 12 - x
    return {"x": x, "y": y, "w": w, "h": h}


def _metric(field: str, agg: str = "auto") -> dict[str, str]:
    return {"field": field.strip(), "agg": (agg or "auto").strip()}


def _metrics_list(items: list[dict[str, Any]] | list[str]) -> list[dict[str, Any]]:
    """Accept ['view.col', ...] or [{field, agg}, ...]."""
    out: list[dict[str, Any]] = []
    for it in items or []:
        if isinstance(it, str):
            out.append(_metric(it))
        elif isinstance(it, dict):
            out.append(_metric(it.get("field", ""), it.get("agg", "auto")))
    return out


async def _post_chart(
    chart_type: str,
    dataset_table_id: int,
    role_config: dict[str, Any],
    title: str,
    layout: dict[str, Any] | None,
    description: str | None,
    user_confirmed: bool,
    base_filters: list[dict[str, Any]] | None = None,
    dashboard_id: int | None = None,
) -> dict[str, Any]:
    """Internal: build chart-create body, optionally place on a dashboard."""
    if not user_confirmed:
        return _requires_confirmation(
            f"add_{chart_type.lower()}_chart",
            {
                "chart_type": chart_type,
                "title": title,
                "dataset_table_id": int(dataset_table_id),
                "role_config_keys": sorted(role_config.keys()),
                "role_config": role_config,
                "layout": _norm_layout(layout, chart_type),
                "dashboard_id": dashboard_id,
            },
        )
    config = {
        "chartType": chart_type,
        "queryMode": "generated",
        "roleConfig": role_config,
        "generatedRoleConfig": role_config,
        "customRoleConfig": {"metrics": []},
        "styleConfig": {},
        "filters": [],
        "baseFilters": base_filters or [],
    }
    body = _drop_none({
        "name": title,
        "description": description,
        "chart_type": chart_type,
        "dataset_table_id": int(dataset_table_id),
        "config": config,
    })
    chart_result = await _request("POST", "/charts/", json_body=body)
    chart_id = chart_result.get("id") if isinstance(chart_result, dict) else None
    log_path = _append_session_log(
        "charts",
        f"add_{chart_type.lower()}_chart",
        {
            "chart_id": chart_id,
            "title": title,
            "chart_type": chart_type,
            "dataset_table_id": int(dataset_table_id),
            "role_config_keys": sorted(role_config.keys()),
        },
    )
    placement_result: dict[str, Any] | None = None
    if dashboard_id is not None and chart_id is not None:
        layout_resolved = _norm_layout(layout, chart_type)
        placement_result = await _request(
            "POST",
            f"/dashboards/{int(dashboard_id)}/charts",
            json_body={
                "chart_id": int(chart_id),
                "layout": layout_resolved,
                "widget_type": "chart",
            },
        )
        _append_session_log(
            "report",
            f"add_{chart_type.lower()}_chart.placement",
            {
                "dashboard_id": int(dashboard_id),
                "chart_id": int(chart_id),
                "layout": layout_resolved,
            },
        )
    return {
        "status": "committed",
        "chart_id": chart_id,
        "chart_type": chart_type,
        "title": title,
        "placement": placement_result,
        "auto_logged_to": log_path,
    }


# ---------------------------------------------------------------------------
# Category: KPI / single-value tiles
# ---------------------------------------------------------------------------


@tool("report")
async def add_kpi_chart(
    dataset_table_id: int,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    benchmark_field: str | None = None,
    benchmark_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """KPI tile — one big number with optional benchmark."""
    role: dict[str, Any] = {"metrics": [_metric(metric_field, metric_agg)]}
    if benchmark_field:
        role["benchmarkMetric"] = _metric(benchmark_field, benchmark_agg)
    return await _post_chart("KPI", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_gauge_chart(
    dataset_table_id: int,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    benchmark_field: str | None = None,
    benchmark_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Gauge — value vs target on a semicircle/dial."""
    role: dict[str, Any] = {"metrics": [_metric(metric_field, metric_agg)]}
    if benchmark_field:
        role["benchmarkMetric"] = _metric(benchmark_field, benchmark_agg)
    return await _post_chart("GAUGE", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_bullet_chart(
    dataset_table_id: int,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    benchmark_field: str | None = None,
    benchmark_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Bullet — horizontal progress bar with benchmark marker."""
    role: dict[str, Any] = {"metrics": [_metric(metric_field, metric_agg)]}
    if benchmark_field:
        role["benchmarkMetric"] = _metric(benchmark_field, benchmark_agg)
    return await _post_chart("BULLET", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_podium_chart(
    dataset_table_id: int,
    dimension: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Podium — Top-N ranking visual (1st / 2nd / 3rd on a podium)."""
    role = {"dimension": dimension.strip(), "metrics": [_metric(metric_field, metric_agg)]}
    return await _post_chart("PODIUM", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


# ---------------------------------------------------------------------------
# Category: BAR family
# ---------------------------------------------------------------------------


@tool("report")
async def add_bar_chart(
    dataset_table_id: int,
    dimension: str,
    metrics: list[dict[str, Any]] | list[str],
    title: str,
    breakdown: str | None = None,
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """BAR — vertical bars by category. `metrics` can be ['view.col', ...] or [{field, agg}, ...].

    `dimension` / `metrics[].field` / `breakdown` MAY reference fields on
    views OTHER than the anchor `dataset_table_id` view, as long as a
    dataset-model relationship connects them (see
    `add_dataset_model_join` / `suggest_dataset_model_join`).
    """
    role: dict[str, Any] = {"dimension": dimension.strip(), "metrics": _metrics_list(metrics)}
    if breakdown:
        role["breakdown"] = breakdown.strip()
    return await _post_chart("BAR", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_horizontal_bar_chart(
    dataset_table_id: int,
    dimension: str,
    metrics: list[dict[str, Any]] | list[str],
    title: str,
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """HORIZONTAL_BAR — horizontal bars by category. Best for long category labels."""
    role = {"dimension": dimension.strip(), "metrics": _metrics_list(metrics)}
    return await _post_chart("HORIZONTAL_BAR", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_grouped_bar_chart(
    dataset_table_id: int,
    dimension: str,
    breakdown: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """GROUPED_BAR — bars grouped side-by-side by breakdown. Single metric."""
    role = {
        "dimension": dimension.strip(),
        "breakdown": breakdown.strip(),
        "metrics": [_metric(metric_field, metric_agg)],
    }
    return await _post_chart("GROUPED_BAR", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_stacked_bar_chart(
    dataset_table_id: int,
    dimension: str,
    breakdown: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """STACKED_BAR — bars stacked by breakdown share. Single metric."""
    role = {
        "dimension": dimension.strip(),
        "breakdown": breakdown.strip(),
        "metrics": [_metric(metric_field, metric_agg)],
    }
    return await _post_chart("STACKED_BAR", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_bar_line_chart(
    dataset_table_id: int,
    dimension: str,
    bar_metrics: list[dict[str, Any]] | list[str],
    line_metric_field: str,
    title: str,
    line_metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """BAR_LINE — combo: bars + secondary-axis line. Common for revenue + growth %."""
    role = {
        "dimension": dimension.strip(),
        "metrics": _metrics_list(bar_metrics),
        "lineMetric": _metric(line_metric_field, line_metric_agg),
    }
    return await _post_chart("BAR_LINE", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_waterfall_chart(
    dataset_table_id: int,
    dimension: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """WATERFALL — running-total chart showing positive / negative contributions."""
    role = {"dimension": dimension.strip(), "metrics": [_metric(metric_field, metric_agg)]}
    return await _post_chart("WATERFALL", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


# ---------------------------------------------------------------------------
# Category: Trend (LINE / AREA / time-series specific)
# ---------------------------------------------------------------------------


@tool("report")
async def add_line_chart(
    dataset_table_id: int,
    dimension: str,
    metrics: list[dict[str, Any]] | list[str],
    title: str,
    time_grain: Literal["day", "week", "month", "quarter", "year"] | None = None,
    breakdown: str | None = None,
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """LINE — trend over a category/date axis. Set `time_grain` if `dimension` is a date.

    Cross-table refs (e.g. dimension="calendar.month",
    metrics=[{field:"sales.revenue"}]) work when a dataset-model
    relationship connects the views.
    """
    role: dict[str, Any] = {"dimension": dimension.strip(), "metrics": _metrics_list(metrics)}
    if breakdown:
        role["breakdown"] = breakdown.strip()
    if time_grain:
        role["timeGrains"] = {dimension.strip(): time_grain}
    return await _post_chart("LINE", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_area_chart(
    dataset_table_id: int,
    dimension: str,
    metrics: list[dict[str, Any]] | list[str],
    title: str,
    time_grain: Literal["day", "week", "month", "quarter", "year"] | None = None,
    breakdown: str | None = None,
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """AREA — line chart with filled area. Good for cumulative / proportion-over-time."""
    role: dict[str, Any] = {"dimension": dimension.strip(), "metrics": _metrics_list(metrics)}
    if breakdown:
        role["breakdown"] = breakdown.strip()
    if time_grain:
        role["timeGrains"] = {dimension.strip(): time_grain}
    return await _post_chart("AREA", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_time_series_chart(
    dataset_table_id: int,
    time_field: str,
    metrics: list[dict[str, Any]] | list[str],
    title: str,
    time_grain: Literal["day", "week", "month", "quarter", "year"] = "month",
    breakdown: str | None = None,
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """TIME_SERIES — explicit time-axis chart (distinct from LINE)."""
    role: dict[str, Any] = {
        "timeField": time_field.strip(),
        "metrics": _metrics_list(metrics),
        "timeGrains": {time_field.strip(): time_grain},
    }
    if breakdown:
        role["breakdown"] = breakdown.strip()
    return await _post_chart("TIME_SERIES", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_ribbon_chart(
    dataset_table_id: int,
    time_field: str,
    breakdown: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    time_grain: Literal["day", "week", "month", "quarter", "year"] = "month",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """RIBBON — ranked time series, like Power BI ribbon chart."""
    role = {
        "timeField": time_field.strip(),
        "breakdown": breakdown.strip(),
        "metrics": [_metric(metric_field, metric_agg)],
        "timeGrains": {time_field.strip(): time_grain},
    }
    return await _post_chart("RIBBON", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_timeline_chart(
    dataset_table_id: int,
    time_field: str,
    dimension: str,
    title: str,
    metric_field: str | None = None,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """TIMELINE — events over time, one row per `dimension` value."""
    role: dict[str, Any] = {
        "timeField": time_field.strip(),
        "dimension": dimension.strip(),
    }
    if metric_field:
        role["metrics"] = [_metric(metric_field, metric_agg)]
    return await _post_chart("TIMELINE", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


# ---------------------------------------------------------------------------
# Category: Composition (PIE / DONUT / TREEMAP / FUNNEL / WORD_CLOUD)
# ---------------------------------------------------------------------------


@tool("report")
async def add_pie_chart(
    dataset_table_id: int,
    slice_field: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """PIE — share-of-total slices. Best for ≤6 categories."""
    role = {"dimension": slice_field.strip(), "metrics": [_metric(metric_field, metric_agg)]}
    return await _post_chart("PIE", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_donut_chart(
    dataset_table_id: int,
    slice_field: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """DONUT — share-of-total with center hole (often shows total in middle)."""
    role = {"dimension": slice_field.strip(), "metrics": [_metric(metric_field, metric_agg)]}
    return await _post_chart("DONUT", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_polar_area_chart(
    dataset_table_id: int,
    slice_field: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """POLAR_AREA — pie with variable slice radii (encodes 2 dimensions)."""
    role = {"dimension": slice_field.strip(), "metrics": [_metric(metric_field, metric_agg)]}
    return await _post_chart("POLAR_AREA", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_treemap_chart(
    dataset_table_id: int,
    dimension: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """TREEMAP — nested rectangles sized by metric. Compact for many categories."""
    role = {"dimension": dimension.strip(), "metrics": [_metric(metric_field, metric_agg)]}
    return await _post_chart("TREEMAP", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_funnel_chart(
    dataset_table_id: int,
    stage_field: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """FUNNEL — sequential stages with drop-off (typical for lead → close pipelines)."""
    role = {"dimension": stage_field.strip(), "metrics": [_metric(metric_field, metric_agg)]}
    return await _post_chart("FUNNEL", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_word_cloud_chart(
    dataset_table_id: int,
    dimension: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """WORD_CLOUD — text size proportional to metric value."""
    role = {"dimension": dimension.strip(), "metrics": [_metric(metric_field, metric_agg)]}
    return await _post_chart("WORD_CLOUD", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


# ---------------------------------------------------------------------------
# Category: Multi-dim (HEATMAP / SANKEY / SUNBURST)
# ---------------------------------------------------------------------------


@tool("report")
async def add_heatmap_chart(
    dataset_table_id: int,
    dimension: str,
    breakdown: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """HEATMAP — grid of color-coded cells; rows=dimension, cols=breakdown."""
    role = {
        "dimension": dimension.strip(),
        "breakdown": breakdown.strip(),
        "metrics": [_metric(metric_field, metric_agg)],
    }
    return await _post_chart("HEATMAP", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_sankey_chart(
    dataset_table_id: int,
    source_field: str,
    target_field: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """SANKEY — flow between source and target nodes (e.g. journey paths)."""
    role = {
        "dimension": source_field.strip(),
        "breakdown": target_field.strip(),
        "metrics": [_metric(metric_field, metric_agg)],
    }
    return await _post_chart("SANKEY", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_sunburst_chart(
    dataset_table_id: int,
    inner_field: str,
    outer_field: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """SUNBURST — radial hierarchy: inner ring = inner_field, outer ring = outer_field."""
    role = {
        "dimension": inner_field.strip(),
        "breakdown": outer_field.strip(),
        "metrics": [_metric(metric_field, metric_agg)],
    }
    return await _post_chart("SUNBURST", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


# ---------------------------------------------------------------------------
# Category: Scatter / Relationship
# ---------------------------------------------------------------------------


@tool("report")
async def add_scatter_chart(
    dataset_table_id: int,
    x_field: str,
    y_field: str,
    title: str,
    point_dimension: str | None = None,
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """SCATTER — correlate 2 numeric measures. `point_dimension` colors points."""
    role: dict[str, Any] = {"scatterX": x_field.strip(), "scatterY": y_field.strip()}
    if point_dimension:
        role["dimension"] = point_dimension.strip()
    return await _post_chart("SCATTER", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_bubble_chart(
    dataset_table_id: int,
    x_field: str,
    y_field: str,
    size_metric_field: str,
    title: str,
    size_metric_agg: str = "auto",
    point_dimension: str | None = None,
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """BUBBLE — scatter with point-size encoding a 3rd metric."""
    role: dict[str, Any] = {
        "scatterX": x_field.strip(),
        "scatterY": y_field.strip(),
        "metrics": [_metric(size_metric_field, size_metric_agg)],
    }
    if point_dimension:
        role["dimension"] = point_dimension.strip()
    return await _post_chart("BUBBLE", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_radar_chart(
    dataset_table_id: int,
    dimension: str,
    metrics: list[dict[str, Any]] | list[str],
    title: str,
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """RADAR — spider/radar plot. Pass multiple metrics for multiple series."""
    role = {"dimension": dimension.strip(), "metrics": _metrics_list(metrics)}
    return await _post_chart("RADAR", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_boxplot_chart(
    dataset_table_id: int,
    dimension: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """BOXPLOT — distribution stats (median / quartiles / outliers) per category."""
    role = {"dimension": dimension.strip(), "metrics": [_metric(metric_field, metric_agg)]}
    return await _post_chart("BOXPLOT", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


# ---------------------------------------------------------------------------
# Category: Geo
# ---------------------------------------------------------------------------


@tool("report")
async def add_map_point_chart(
    dataset_table_id: int,
    longitude_field: str,
    latitude_field: str,
    title: str,
    point_dimension: str | None = None,
    metric_field: str | None = None,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """MAP_POINT — points on a world map. X=lng, Y=lat."""
    role: dict[str, Any] = {
        "scatterX": longitude_field.strip(),
        "scatterY": latitude_field.strip(),
    }
    if point_dimension:
        role["dimension"] = point_dimension.strip()
    if metric_field:
        role["metrics"] = [_metric(metric_field, metric_agg)]
    return await _post_chart("MAP_POINT", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_map_region_chart(
    dataset_table_id: int,
    region_field: str,
    metric_field: str,
    title: str,
    metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """MAP_REGION — choropleth: regions colored by metric (e.g. country/province)."""
    role = {"dimension": region_field.strip(), "metrics": [_metric(metric_field, metric_agg)]}
    return await _post_chart("MAP_REGION", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


# ---------------------------------------------------------------------------
# Category: Tables
# ---------------------------------------------------------------------------


@tool("report")
async def add_table_chart(
    dataset_table_id: int,
    title: str,
    selected_columns: list[str] | None = None,
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """TABLE — raw row-listing. `selected_columns` whitelists what to show
    (omit = show all). Qualified refs like `view.col`.

    `selected_columns` can mix fields from MULTIPLE views (e.g. a sales
    table whose row lists `deals.amount`, `owner.name`,
    `customer.region`) when the dataset model has the relationships.
    """
    role: dict[str, Any] = {}
    if selected_columns:
        role["selectedColumns"] = [c.strip() for c in selected_columns]
    return await _post_chart("TABLE", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


@tool("report")
async def add_pivot_table_chart(
    dataset_table_id: int,
    row_dimension: str,
    column_dimension: str,
    value_metric_field: str,
    title: str,
    value_metric_agg: str = "auto",
    description: str | None = None,
    layout: dict[str, Any] | None = None,
    dashboard_id: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """MATRIX — pivot table. Rows=row_dimension, cols=column_dimension, cell=metric.

    `row_dimension` / `column_dimension` / `value_metric_field` MAY
    reference fields across views (e.g. rows=customer.region,
    cols=calendar.month, metric=sales.revenue) when the dataset has
    relationships between those views.
    """
    role = {
        "tableMode": "pivot",
        "tableRowDimension": row_dimension.strip(),
        "tableColumnDimension": column_dimension.strip(),
        "tablePivotMetric": _metric(value_metric_field, value_metric_agg),
    }
    return await _post_chart("MATRIX", dataset_table_id, role, title, layout,
                              description, user_confirmed, dashboard_id=dashboard_id)


__all__ = [
    # KPI family
    "add_kpi_chart", "add_gauge_chart", "add_bullet_chart", "add_podium_chart",
    # Bar family
    "add_bar_chart", "add_horizontal_bar_chart", "add_grouped_bar_chart",
    "add_stacked_bar_chart", "add_bar_line_chart", "add_waterfall_chart",
    # Trend
    "add_line_chart", "add_area_chart", "add_time_series_chart",
    "add_ribbon_chart", "add_timeline_chart",
    # Composition
    "add_pie_chart", "add_donut_chart", "add_polar_area_chart",
    "add_treemap_chart", "add_funnel_chart", "add_word_cloud_chart",
    # Multi-dim
    "add_heatmap_chart", "add_sankey_chart", "add_sunburst_chart",
    # Relationship
    "add_scatter_chart", "add_bubble_chart", "add_radar_chart", "add_boxplot_chart",
    # Geo
    "add_map_point_chart", "add_map_region_chart",
    # Tables
    "add_table_chart", "add_pivot_table_chart",
]
