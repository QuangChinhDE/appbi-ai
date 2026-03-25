from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi import HTTPException

from app.clients.bi_client import bi_client
from app.config import settings
from app.schemas.agent import AgentBuildEvent, AgentBuildRequest, AgentChartPlan, AgentPlanResponse
from app.services.dashboard_composer import compose_dashboard_blueprint
from app.services.insight_generator import generate_insight_report
from app.services.output_language import is_vietnamese


LEVEL_ORDER = {"none": 0, "view": 1, "edit": 2, "full": 3}


def _has_level(permissions: Dict[str, str], module: str, required: str) -> bool:
    return LEVEL_ORDER.get(permissions.get(module, "none"), 0) >= LEVEL_ORDER[required]


def _runtime_metadata() -> Dict[str, Any]:
    return {
        "provider": settings.active_llm_provider,
        "model": settings.active_llm_model,
        "fallback_chain": settings.active_llm_fallback_chain,
        "timeout_seconds": settings.active_llm_timeout_seconds,
    }


def _event(
    event_type: str,
    phase: str,
    message: str,
    *,
    chart_id: int | None = None,
    dashboard_id: int | None = None,
    dashboard_url: str | None = None,
    report_url: str | None = None,
    error: str | None = None,
) -> str:
    payload = AgentBuildEvent(
        type=event_type,
        phase=phase,
        message=message,
        chart_id=chart_id,
        dashboard_id=dashboard_id,
        dashboard_url=dashboard_url,
        report_url=report_url,
        error=error,
    )
    return json.dumps(payload.model_dump(), ensure_ascii=False) + "\n"


async def _patch_run(
    request: AgentBuildRequest,
    token: str,
    payload: Dict[str, Any],
) -> None:
    if not request.report_spec_id or not request.report_run_id:
        return
    await bi_client.update_agent_report_run(
        spec_id=request.report_spec_id,
        run_id=request.report_run_id,
        payload=payload,
        token=token,
    )


def _chart_height(chart_type: str) -> int:
    if chart_type == "KPI":
        return 2
    if chart_type == "TABLE":
        return 6
    if chart_type in {"PIE", "BAR", "LINE", "AREA", "TIME_SERIES"}:
        return 4
    return 4


def _build_layouts(plan: AgentPlanResponse) -> Dict[str, Dict[str, int]]:
    layouts: Dict[str, Dict[str, int]] = {}
    current_y = 0
    chart_map = {chart.key: chart for chart in plan.charts}

    for section in sorted(plan.sections, key=lambda item: item.priority):
        section_charts = [chart_map[key] for key in section.chart_keys if key in chart_map]
        if not section_charts:
            continue

        kpis = [chart for chart in section_charts if chart.chart_type == "KPI"]
        visuals = [chart for chart in section_charts if chart.chart_type not in {"KPI", "TABLE"}]
        tables = [chart for chart in section_charts if chart.chart_type == "TABLE"]

        if kpis:
            width = max(3, 12 // len(kpis))
            for index, chart in enumerate(kpis):
                layouts[chart.key] = {"x": index * width, "y": current_y, "w": width, "h": 2}
            current_y += 2

        if visuals:
            row_y = current_y
            for index, chart in enumerate(visuals[:2]):
                layouts[chart.key] = {"x": index * 6, "y": row_y, "w": 6, "h": _chart_height(chart.chart_type)}
            if len(visuals) == 1:
                layouts[visuals[0].key] = {"x": 0, "y": row_y, "w": 12, "h": _chart_height(visuals[0].chart_type)}
            current_y += max((_chart_height(chart.chart_type) for chart in visuals[:2]), default=0)
            for chart in visuals[2:]:
                height = _chart_height(chart.chart_type)
                layouts[chart.key] = {"x": 0, "y": current_y, "w": 12, "h": height}
                current_y += height

        for chart in tables:
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
        "description": chart.why_this_chart or chart.rationale,
        "workspace_table_id": chart.workspace_table_id,
        "chart_type": chart.chart_type.upper(),
        "config": config,
    }


def _preflight_validate_chart(chart: AgentChartPlan) -> Optional[str]:
    role_config = (chart.config or {}).get("roleConfig") or {}
    if chart.chart_type == "KPI" and not role_config.get("metrics"):
        return "KPI chart is missing roleConfig.metrics"
    if chart.chart_type == "TIME_SERIES":
        if not role_config.get("timeField"):
            return "Time series chart is missing roleConfig.timeField"
        if not role_config.get("metrics"):
            return "Time series chart is missing roleConfig.metrics"
    if chart.chart_type in {"BAR", "LINE", "AREA", "GROUPED_BAR", "STACKED_BAR", "PIE"}:
        if not role_config.get("dimension"):
            return f"{chart.chart_type} chart is missing roleConfig.dimension"
        if not role_config.get("metrics"):
            return f"{chart.chart_type} chart is missing roleConfig.metrics"
    if chart.chart_type == "TABLE" and not role_config.get("selectedColumns"):
        return "Table chart is missing roleConfig.selectedColumns"
    return None


async def _resolve_target_dashboard(
    request: AgentBuildRequest,
    token: str,
    run_suffix: str,
) -> Dict[str, Any]:
    if request.build_mode == "replace_existing" and request.target_dashboard_id:
        dashboard = await bi_client.get_dashboard(request.target_dashboard_id, token)
        for dashboard_chart in list(dashboard.get("dashboard_charts", [])):
            await bi_client.remove_chart_from_dashboard(request.target_dashboard_id, dashboard_chart["chart_id"], token)
        updated = await bi_client.update_dashboard(
            request.target_dashboard_id,
            name=request.plan.dashboard_title,
            description=request.plan.dashboard_summary,
            token=token,
        )
        return updated

    suffix = run_suffix if request.build_mode in {"new_dashboard", "new_version"} else ""
    name = request.plan.dashboard_title if not suffix else f"{request.plan.dashboard_title} [{suffix}]"
    return await bi_client.create_dashboard(
        name=name,
        description=request.plan.dashboard_summary,
        token=token,
    )


async def build_dashboard_stream(
    request: AgentBuildRequest,
    token: str,
) -> AsyncGenerator[str, None]:
    vi = is_vietnamese(request.brief.output_language if hasattr(request.brief, "output_language") else None)
    perms_payload = await bi_client.get_my_permissions(token)
    permissions = perms_payload.get("permissions", {})

    if not _has_level(permissions, "ai_agent", "edit"):
        raise HTTPException(status_code=403, detail="Requires ai_agent >= edit")
    if not _has_level(permissions, "dashboards", "edit"):
        raise HTTPException(status_code=403, detail="Requires dashboards >= edit")
    if not _has_level(permissions, "explore_charts", "edit"):
        raise HTTPException(status_code=403, detail="Requires explore_charts >= edit")

    await _patch_run(request, token, {"status": "planning_charts"})
    yield _event("phase", "validate", "Đã xác thực quyền và dữ liệu đầu vào để build." if vi else "Validated permissions and build inputs.")

    layouts = _build_layouts(request.plan)
    created_charts: List[Dict[str, Any]] = []
    run_suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    await _patch_run(request, token, {"status": "planning_charts"})
    yield _event("phase", "preflight", "Đang chạy kiểm tra preflight cho chart trước khi tạo tài nguyên." if vi else "Running chart preflight checks before creating resources.")
    preflight_failures = 0
    for chart in request.plan.charts:
        validation_error = _preflight_validate_chart(chart)
        if validation_error:
            preflight_failures += 1
            yield _event("chart_failed", "preflight", f"Đã bỏ qua '{chart.title}' ở bước preflight." if vi else f"Skipped '{chart.title}' during preflight.", error=validation_error)

    await _patch_run(request, token, {"status": "building_dashboard"})
    yield _event("phase", "create_charts", "Đang tạo chart từ kế hoạch báo cáo đã được duyệt." if vi else "Creating charts from the approved report plan.")
    for chart in request.plan.charts:
        validation_error = _preflight_validate_chart(chart)
        if validation_error:
            continue
        payload = _normalize_chart_payload(chart, run_suffix)
        try:
            created = await bi_client.create_chart(token=token, **payload)
            chart_data = await bi_client.get_chart_data(created["id"], token)
            if not chart_data.get("data"):
                raise ValueError("Chart returned no rows")
            created_charts.append(
                {
                    "key": chart.key,
                    "chart": chart.model_dump(mode="json"),
                    "chart_id": created["id"],
                    "layout": layouts.get(chart.key, {"x": 0, "y": 0, "w": 6, "h": 4}),
                    "title": chart.title,
                    "data_rows": chart_data.get("data") or [],
                }
            )
            yield _event("chart_created", "create_charts", f"Đã tạo chart '{chart.title}'." if vi else f"Created chart '{chart.title}'.", chart_id=created["id"])
        except Exception as exc:
            yield _event("chart_failed", "create_charts", f"Không tạo được chart '{chart.title}'." if vi else f"Failed to create chart '{chart.title}'.", error=str(exc))

    if not created_charts:
        await _patch_run(
            request,
            token,
            {
                "status": "failed",
                "error": "No charts were created successfully.",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "result_summary_json": {"created_chart_count": 0, "preflight_failures": preflight_failures},
            },
        )
        yield _event("error", "create_charts", "Tất cả chart đều lỗi nên chưa tạo được dashboard." if vi else "All charts failed. Dashboard was not created.", error="No charts were created successfully." if not vi else "Không có chart nào được tạo thành công.")
        return

    await _patch_run(request, token, {"status": "building_dashboard"})
    yield _event("phase", "assemble_dashboard", "Đang tạo hoặc cập nhật dashboard và gắn các chart vào đó." if vi else "Creating or updating the dashboard and attaching charts.")
    dashboard = await _resolve_target_dashboard(request, token, run_suffix)
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

    await _patch_run(request, token, {"status": "generating_insights"})
    yield _event("phase", "generating_insights", "Đang đọc dữ liệu chart đã build và viết insight dạng narrative." if vi else "Reading the built charts and drafting narrative insights.")
    insight_report = generate_insight_report(request.plan, created_charts)

    await _patch_run(request, token, {"status": "composing_report"})
    yield _event("phase", "composing_report", "Đang ghép report reader với tóm tắt điều hành, phát hiện theo section và caption cho chart." if vi else "Composing the AI report reader with executive summary, section findings, and chart captions.")
    dashboard_blueprint = compose_dashboard_blueprint(request.plan, insight_report)
    report_url = f"/ai-reports/{request.report_spec_id}" if request.report_spec_id else None

    await _patch_run(
        request,
        token,
        {
            "status": "succeeded",
            "dashboard_id": dashboard_id,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "result_summary_json": {
                "created_chart_count": len(created_charts),
                "preflight_failures": preflight_failures,
                "build_mode": request.build_mode,
                "executive_summary": insight_report.executive_summary,
                "top_findings": insight_report.top_findings,
                "headline_risks": insight_report.headline_risks,
                "priority_actions": insight_report.priority_actions,
                "insight_report": insight_report.model_dump(mode="json"),
                "dashboard_blueprint": dashboard_blueprint.model_dump(mode="json"),
                "planning_runtime": request.plan.runtime.model_dump(mode="json") if request.plan.runtime else None,
                "build_runtime": _runtime_metadata(),
                "chart_data_summary": {
                    item["key"]: {
                        "chart_id": item["chart_id"],
                        "row_count": len(item.get("data_rows") or []),
                    }
                    for item in created_charts
                },
            },
        },
    )

    yield _event(
        "dashboard_created",
        "assemble_dashboard",
        f"Dashboard '{request.plan.dashboard_title}' đã sẵn sàng." if vi else f"Dashboard '{request.plan.dashboard_title}' is ready.",
        dashboard_id=dashboard_id,
        dashboard_url=f"/dashboards/{dashboard_id}",
        report_url=report_url,
    )
    yield _event(
        "done",
        "done",
        "AI Agent đã hoàn tất việc dựng dashboard." if vi else "AI Agent finished building the dashboard.",
        dashboard_id=dashboard_id,
        dashboard_url=f"/dashboards/{dashboard_id}",
        report_url=report_url,
    )
