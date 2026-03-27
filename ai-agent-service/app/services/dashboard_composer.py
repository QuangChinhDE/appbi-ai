from __future__ import annotations

import json
from typing import Any, Dict, Optional, Tuple

from app.config import settings
from app.schemas.agent import (
    AgentPlanResponse,
    AgentRuntimeMetadata,
    DashboardBlueprintArtifact,
    InsightReportArtifact,
)
from app.services.llm_client import generate_json
from app.services.output_language import is_vietnamese
from app.services.runtime_metadata import llm_runtime_metadata, rule_runtime_metadata


def _compose_rule_based_dashboard_blueprint(
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
        "Bat dau bang phan tom tat dieu hanh, sau do di tu cac tin hieu rong sang cac phan phan ra theo tung section, roi ket thuc bang bang chi tiet de follow-up van hanh."
        if vi
        else
        "Lead with the executive summary, then move from broad signal charts into section-specific breakdowns, and close with detail tables for operational follow-up."
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


def _llm_enabled(plan: AgentPlanResponse) -> bool:
    if not settings.openrouter_api_key:
        return False
    if not plan.parsed_brief:
        return False
    return bool(plan.parsed_brief.narrative_preferences.get("include_text_narrative", True))


async def _generate_blueprint_overrides(
    plan: AgentPlanResponse,
    insight_report: InsightReportArtifact,
    base_blueprint: DashboardBlueprintArtifact,
) -> Optional[Dict[str, Any]]:
    vi = is_vietnamese(plan.parsed_brief.output_language if plan.parsed_brief else None)
    system_prompt = (
        "Ban la BI lead dang polish dashboard reader blueprint. "
        "Hay toi uu thu tu doc, intro tung section va thong diep tong quan duoc viet cho nguoi doc nghiep vu. "
        "Khong duoc bịa them chart key, section hay bang chung. Tra ve JSON hop le va viet bang tieng Viet."
        if vi
        else
        "You are a BI lead polishing a dashboard reader blueprint. "
        "Optimize reading order, section intros, and the executive narrative for a business audience. "
        "Do not invent chart keys, sections, or evidence. Return valid JSON only."
    )
    user_prompt = json.dumps(
        {
            "dashboard_title": plan.dashboard_title,
            "dashboard_summary": plan.dashboard_summary,
            "analysis_plan": plan.analysis_plan.model_dump(mode="json") if plan.analysis_plan else None,
            "insight_report": insight_report.model_dump(mode="json"),
            "base_blueprint": base_blueprint.model_dump(mode="json"),
            "output_contract": {
                "executive_summary": "string",
                "reading_order": ["string"],
                "section_intro_overrides": [
                    {
                        "section_title": "string",
                        "intro": "string",
                    }
                ],
                "narrative_flow": ["string"],
                "layout_strategy": "string",
                "callout_priority": ["string"],
            },
        },
        ensure_ascii=False,
        default=str,
    )
    return await generate_json(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model_override=settings.model_for_phase("narrative"),
        phase="narrative",
    )


def _merge_blueprint_overrides(
    base_blueprint: DashboardBlueprintArtifact,
    overrides: Dict[str, Any],
) -> DashboardBlueprintArtifact:
    existing_sections = set(base_blueprint.reading_order)
    reading_order = [
        item for item in (overrides.get("reading_order") or []) if isinstance(item, str) and item in existing_sections
    ] or base_blueprint.reading_order

    section_intro_text = dict(base_blueprint.section_intro_text)
    for item in overrides.get("section_intro_overrides") or []:
        key = str(item.get("section_title") or "").strip()
        value = str(item.get("intro") or "").strip()
        if key in existing_sections and value:
            section_intro_text[key] = value

    narrative_flow = [
        item for item in (overrides.get("narrative_flow") or []) if isinstance(item, str) and item.strip()
    ] or base_blueprint.narrative_flow
    callout_priority = [
        item for item in (overrides.get("callout_priority") or []) if isinstance(item, str) and item.strip()
    ] or base_blueprint.callout_priority

    return DashboardBlueprintArtifact(
        dashboard_title=base_blueprint.dashboard_title,
        executive_summary=str(overrides.get("executive_summary") or base_blueprint.executive_summary).strip(),
        reading_order=reading_order,
        section_intro_text=section_intro_text,
        chart_caption_map=base_blueprint.chart_caption_map,
        narrative_flow=narrative_flow,
        layout_strategy=str(overrides.get("layout_strategy") or base_blueprint.layout_strategy).strip(),
        callout_priority=callout_priority,
    )


async def compose_dashboard_blueprint(
    plan: AgentPlanResponse,
    insight_report: InsightReportArtifact,
) -> Tuple[DashboardBlueprintArtifact, AgentRuntimeMetadata]:
    base_blueprint = _compose_rule_based_dashboard_blueprint(plan, insight_report)
    if not _llm_enabled(plan):
        return base_blueprint, rule_runtime_metadata()

    overrides = await _generate_blueprint_overrides(plan, insight_report, base_blueprint)
    if not overrides:
        return base_blueprint, rule_runtime_metadata()

    return _merge_blueprint_overrides(base_blueprint, overrides), llm_runtime_metadata("narrative")
