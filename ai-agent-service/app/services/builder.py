from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Dict, List

from fastapi import HTTPException

from app.clients.bi_client import bi_client
from app.schemas.agent import AgentBuildEvent, AgentBuildRequest, AgentChartPlan, AgentPlanResponse


LEVEL_ORDER = {"none": 0, "view": 1, "edit": 2, "full": 3}


def _has_level(permissions: Dict[str, str], module: str, required: str) -> bool:
    return LEVEL_ORDER.get(permissions.get(module, "none"), 0) >= LEVEL_ORDER[required]


def _event(
    event_type: str,
    phase: str,
    message: str,
    *,
    chart_id: int | None = None,
    dashboard_id: int | None = None,
    dashboard_url: str | None = None,
    error: str | None = None,
) -> str:
    payload = AgentBuildEvent(
        type=event_type,
        phase=phase,
        message=message,
        chart_id=chart_id,
        dashboard_id=dashboard_id,
        dashboard_url=dashboard_url,
        error=error,
    )
    return json.dumps(payload.model_dump(), ensure_ascii=False) + "\n"


def _chart_height(chart_type: str) -> int:
    if chart_type == "KPI":
        return 2
    if chart_type == "TABLE":
        return 5
    if chart_type == "PIE":
        return 4
    return 4


def _build_layouts(plan: AgentPlanResponse) -> Dict[str, Dict[str, int]]:
    layouts: Dict[str, Dict[str, int]] = {}
    current_y = 0
    chart_map = {chart.key: chart for chart in plan.charts}

    for section in plan.sections:
        section_charts = [chart_map[key] for key in section.chart_keys if key in chart_map]
        if not section_charts:
            continue

        kpis = [chart for chart in section_charts if chart.chart_type == "KPI"]
        analytics = [chart for chart in section_charts if chart.chart_type != "KPI"]

        if kpis:
            width = max(3, 12 // len(kpis))
            for index, chart in enumerate(kpis):
                layouts[chart.key] = {"x": index * width, "y": current_y, "w": width, "h": 2}
            current_y += 2

        if len(analytics) == 1:
            chart = analytics[0]
            layouts[chart.key] = {"x": 0, "y": current_y, "w": 12, "h": _chart_height(chart.chart_type)}
            current_y += _chart_height(chart.chart_type)
        elif len(analytics) >= 2:
            first, second, *rest = analytics
            layouts[first.key] = {"x": 0, "y": current_y, "w": 6, "h": _chart_height(first.chart_type)}
            layouts[second.key] = {"x": 6, "y": current_y, "w": 6, "h": _chart_height(second.chart_type)}
            current_y += max(_chart_height(first.chart_type), _chart_height(second.chart_type))
            for chart in rest:
                height = _chart_height(chart.chart_type)
                layouts[chart.key] = {"x": 0, "y": current_y, "w": 12, "h": height}
                current_y += height

        current_y += 1

    return layouts


def _normalize_chart_payload(chart: AgentChartPlan, run_suffix: str) -> Dict[str, Any]:
    config = dict(chart.config or {})
    config["workspace_id"] = chart.workspace_id
    config["chartType"] = chart.chart_type.upper()
    config["roleConfig"] = config.get("roleConfig") or {}
    config["filters"] = config.get("filters") or []
    return {
        "name": f"{chart.title} [{run_suffix}]",
        "description": chart.rationale,
        "workspace_table_id": chart.workspace_table_id,
        "chart_type": chart.chart_type.upper(),
        "config": config,
    }


async def build_dashboard_stream(
    request: AgentBuildRequest,
    token: str,
) -> AsyncGenerator[str, None]:
    perms_payload = await bi_client.get_my_permissions(token)
    permissions = perms_payload.get("permissions", {})

    if not _has_level(permissions, "ai_agent", "edit"):
        raise HTTPException(status_code=403, detail="Requires ai_agent >= edit")
    if not _has_level(permissions, "dashboards", "edit"):
        raise HTTPException(status_code=403, detail="Requires dashboards >= edit")
    if not _has_level(permissions, "explore_charts", "edit"):
        raise HTTPException(status_code=403, detail="Requires explore_charts >= edit")

    yield _event("phase", "validate", "Validated permissions and selected plan.")

    layouts = _build_layouts(request.plan)
    created_charts: List[Dict[str, Any]] = []
    run_suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    yield _event("phase", "create_charts", "Creating charts from approved plan.")
    for chart in request.plan.charts:
        payload = _normalize_chart_payload(chart, run_suffix)
        try:
            created = await bi_client.create_chart(token=token, **payload)
            chart_data = await bi_client.get_chart_data(created["id"], token)
            if not chart_data.get("data"):
                raise ValueError("Chart returned no rows")
            created_charts.append(
                {
                    "key": chart.key,
                    "chart_id": created["id"],
                    "layout": layouts.get(chart.key, {"x": 0, "y": 0, "w": 6, "h": 4}),
                    "title": chart.title,
                }
            )
            yield _event(
                "chart_created",
                "create_charts",
                f"Created chart '{chart.title}'.",
                chart_id=created["id"],
            )
        except Exception as exc:
            yield _event(
                "chart_failed",
                "create_charts",
                f"Failed to create chart '{chart.title}'.",
                error=str(exc),
            )

    if not created_charts:
        yield _event(
            "error",
            "create_charts",
            "All charts failed. Dashboard was not created.",
            error="No charts were created successfully.",
        )
        return

    yield _event("phase", "assemble_dashboard", "Creating dashboard shell and attaching charts.")
    dashboard = await bi_client.create_dashboard(
        name=f"{request.plan.dashboard_title} [{run_suffix}]",
        description=request.plan.dashboard_summary,
        token=token,
    )
    dashboard_id = dashboard["id"]

    dashboard_chart_layouts: List[Dict[str, Any]] = []
    current_dashboard = dashboard
    for chart in created_charts:
        current_dashboard = await bi_client.add_chart_to_dashboard(
            dashboard_id,
            chart["chart_id"],
            chart["layout"],
            token,
        )
        dashboard_chart = next(
            (item for item in current_dashboard.get("dashboard_charts", []) if item.get("chart_id") == chart["chart_id"]),
            None,
        )
        if dashboard_chart:
            dashboard_chart_layouts.append({"id": dashboard_chart["id"], "layout": chart["layout"]})

    if dashboard_chart_layouts:
        await bi_client.update_dashboard_layout(dashboard_id, dashboard_chart_layouts, token)

    yield _event(
        "dashboard_created",
        "assemble_dashboard",
        f"Dashboard '{request.plan.dashboard_title}' created.",
        dashboard_id=dashboard_id,
        dashboard_url=f"/dashboards/{dashboard_id}",
    )
    yield _event(
        "done",
        "done",
        "AI Agent finished building the dashboard.",
        dashboard_id=dashboard_id,
        dashboard_url=f"/dashboards/{dashboard_id}",
    )
