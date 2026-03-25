from __future__ import annotations

from app.schemas.agent import AgentPlanResponse, DashboardBlueprintArtifact, InsightReportArtifact
from app.services.output_language import is_vietnamese


def compose_dashboard_blueprint(
    plan: AgentPlanResponse,
    insight_report: InsightReportArtifact,
) -> DashboardBlueprintArtifact:
    vi = is_vietnamese(plan.parsed_brief.output_language if plan.parsed_brief else None)
    reading_order = [section.title for section in sorted(plan.sections, key=lambda item: item.priority)]
    section_intro_text = {
        section.section_title: section.summary
        for section in insight_report.section_insights
    }
    chart_caption_map = {
        chart.chart_key: chart.caption
        for chart in insight_report.chart_insights
    }

    layout_strategy = (
        "Bắt đầu bằng phần tóm tắt điều hành, sau đó đi từ các tín hiệu rộng sang các phần phân rã theo từng section, rồi kết thúc bằng bảng chi tiết để follow-up vận hành."
        if vi
        else "Lead with the executive summary, then move from broad signal charts into section-specific breakdowns, "
        "and close with detail tables for operational follow-up."
    )
    callout_priority = insight_report.top_findings[:3] + insight_report.headline_risks[:2]

    return DashboardBlueprintArtifact(
        dashboard_title=plan.dashboard_title,
        executive_summary=insight_report.executive_summary,
        reading_order=reading_order,
        section_intro_text=section_intro_text,
        chart_caption_map=chart_caption_map,
        narrative_flow=plan.analysis_plan.narrative_flow if plan.analysis_plan else reading_order,
        layout_strategy=layout_strategy,
        callout_priority=callout_priority,
    )
