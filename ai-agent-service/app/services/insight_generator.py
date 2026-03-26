from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional, Tuple

from app.config import settings
from app.schemas.agent import (
    AgentChartPlan,
    AgentPlanResponse,
    AgentRuntimeMetadata,
    ChartInsightArtifact,
    InsightReportArtifact,
    SectionInsightArtifact,
)
from app.services.llm_client import generate_json
from app.services.output_language import is_vietnamese
from app.services.runtime_metadata import llm_runtime_metadata, rule_runtime_metadata


def _is_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    try:
        float(str(value).replace(",", ""))
        return True
    except (TypeError, ValueError):
        return False


def _to_number(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _dimension_label(value: Any, language: str | None) -> str:
    vi = is_vietnamese(language)
    if value is None:
        return "Khong xac dinh" if vi else "Unknown"
    text = str(value).strip()
    if not text or text.lower() in {"none", "null", "nan", "n/a"}:
        return "Khong xac dinh" if vi else "Unknown"
    return text


def _pick_fields(rows: List[Dict[str, Any]]) -> tuple[Optional[str], Optional[str]]:
    if not rows:
        return None, None
    keys = list(rows[0].keys())
    numeric_fields = [key for key in keys if any(_is_number(row.get(key)) for row in rows)]
    text_fields = [key for key in keys if key not in numeric_fields]
    dimension_field = text_fields[0] if text_fields else (keys[0] if keys else None)
    metric_field = numeric_fields[0] if numeric_fields else None
    return dimension_field, metric_field


def _summarize_rows(
    rows: List[Dict[str, Any]],
    dimension_field: Optional[str],
    metric_field: Optional[str],
    language: str | None,
) -> str:
    vi = is_vietnamese(language)
    if not rows:
        return "Khong co dong du lieu nao duoc tra ve." if vi else "No data rows were returned."
    if metric_field and dimension_field:
        ranked = sorted(
            [row for row in rows if _to_number(row.get(metric_field)) is not None],
            key=lambda row: _to_number(row.get(metric_field)) or 0,
            reverse=True,
        )
        snippets = []
        for row in ranked[:3]:
            snippets.append(f"{_dimension_label(row.get(dimension_field), language)} = {row.get(metric_field)}")
        if snippets:
            return "; ".join(snippets)
    if metric_field:
        values = [_to_number(row.get(metric_field)) for row in rows]
        values = [value for value in values if value is not None]
        if values:
            if vi:
                return f"{metric_field} dao dong tu {min(values):,.0f} den {max(values):,.0f} tren {len(rows)} dong."
            return f"{metric_field} ranges from {min(values):,.0f} to {max(values):,.0f} across {len(rows)} rows."
    return f"Tra ve {len(rows)} dong du lieu." if vi else f"Returned {len(rows)} rows."


def _build_chart_insight(
    chart: AgentChartPlan,
    chart_id: Optional[int],
    rows: List[Dict[str, Any]],
    language: str | None,
    warning_if_any: Optional[str] = None,
) -> ChartInsightArtifact:
    vi = is_vietnamese(language)
    dimension_field, metric_field = _pick_fields(rows)
    evidence_summary = _summarize_rows(rows, dimension_field, metric_field, language)

    finding = chart.expected_signal or chart.rationale
    caption = chart.title

    if rows and chart.chart_type in {"TIME_SERIES", "LINE", "AREA"} and metric_field:
        values = [_to_number(row.get(metric_field)) for row in rows]
        values = [value for value in values if value is not None]
        if len(values) >= 2:
            delta = values[-1] - values[0]
            if vi:
                direction = "tang len" if delta > 0 else "giam xuong" if delta < 0 else "di ngang tuong doi"
                finding = f"{chart.title} {direction} trong giai doan mau, dua tren {metric_field}."
                caption = f"{chart.title}: tin hieu xu huong cho {metric_field.replace('_', ' ')}."
            else:
                direction = "increased" if delta > 0 else "decreased" if delta < 0 else "stayed broadly flat"
                finding = f"{chart.title} {direction} across the sampled period, based on {metric_field}."
                caption = f"{chart.title}: trend signal for {metric_field.replace('_', ' ')}."
    elif rows and metric_field and dimension_field and chart.chart_type in {"BAR", "GROUPED_BAR", "STACKED_BAR", "PIE"}:
        ranked = sorted(
            [row for row in rows if _to_number(row.get(metric_field)) is not None],
            key=lambda row: _to_number(row.get(metric_field)) or 0,
            reverse=True,
        )
        if ranked:
            leader = ranked[0]
            label = _dimension_label(leader.get(dimension_field), language)
            if vi:
                finding = f"{label} noi bat trong {chart.title} voi gia tri {leader.get(metric_field)}."
                caption = f"{chart.title}: so sanh {metric_field.replace('_', ' ')} theo {dimension_field.replace('_', ' ')}."
            else:
                finding = f"{label} stands out in {chart.title} with {leader.get(metric_field)}."
                caption = f"{chart.title}: compare how {metric_field.replace('_', ' ')} varies by {dimension_field.replace('_', ' ')}."
    elif rows and chart.chart_type == "TABLE":
        if vi:
            finding = f"{chart.title} giu lai goc nhin van hanh chi tiet voi {len(rows)} dong hien thi de follow-up."
            caption = f"{chart.title}: du lieu chi tiet ho tro viec kiem tra."
        else:
            finding = f"{chart.title} keeps a detailed operational view with {len(rows)} visible rows for follow-up."
            caption = f"{chart.title}: detailed supporting records for investigation."

    return ChartInsightArtifact(
        chart_key=chart.key,
        chart_id=chart_id,
        title=chart.title,
        chart_type=chart.chart_type,
        caption=caption,
        finding=finding,
        evidence_summary=evidence_summary,
        confidence=max(0.35, min(0.95, chart.confidence or 0.6)),
        warning_if_any=warning_if_any,
    )


def _build_rule_based_insight_report(
    plan: AgentPlanResponse,
    chart_payloads: Iterable[Dict[str, Any]],
) -> InsightReportArtifact:
    language = plan.parsed_brief.output_language if plan.parsed_brief else None
    vi = is_vietnamese(language)
    chart_map = {chart.key: chart for chart in plan.charts}
    chart_insights: List[ChartInsightArtifact] = []

    for payload in chart_payloads:
        chart = chart_map.get(payload.get("key"))
        if not chart:
            continue
        chart_insights.append(
            _build_chart_insight(
                chart=chart,
                chart_id=payload.get("chart_id"),
                rows=list(payload.get("data_rows") or []),
                language=language,
                warning_if_any=payload.get("warning_if_any"),
            )
        )

    section_insights: List[SectionInsightArtifact] = []
    for section in plan.sections:
        related = [item for item in chart_insights if item.chart_key in section.chart_keys]
        if not related:
            continue
        key_findings = [item.finding for item in related[:3]]
        caveats = [item.warning_if_any for item in related if item.warning_if_any][:2]
        recommended_actions: List[str] = []

        if any("inactive" in finding.lower() or "deactive" in finding.lower() for finding in key_findings):
            recommended_actions.append(
                "Uu tien ra soat cac nhom co ty trong bang khong hoat dong cao nhat."
                if vi
                else "Prioritize review of the segments with the highest inactive asset concentration."
            )
        if any("ownership" in finding.lower() or "stewardship" in finding.lower() or "metadata" in finding.lower() for finding in key_findings):
            recommended_actions.append(
                "Xac minh do phu metadata va ownership truoc khi dung cac tai san nay cho bao cao quan trong."
                if vi
                else "Validate metadata and ownership coverage before using these assets for critical reporting."
            )
        if not recommended_actions:
            recommended_actions.append(
                "Dung phan nay de dan huong vong follow-up van hanh va xac minh tiep theo."
                if vi
                else "Use this section to guide the next round of operational follow-up and validation."
            )

        section_insights.append(
            SectionInsightArtifact(
                section_title=section.title,
                table_name=section.table_name,
                summary=related[0].finding,
                key_findings=key_findings,
                caveats=caveats,
                recommended_actions=recommended_actions[:2],
                confidence=round(sum(item.confidence for item in related) / max(len(related), 1), 2),
                chart_keys=[item.chart_key for item in related],
                chart_ids=[item.chart_id for item in related if item.chart_id is not None],
            )
        )

    top_findings = [item.finding for item in chart_insights[:3]]
    headline_risks = [warning for warning in plan.warnings[:3] if warning]
    priority_actions: List[str] = []
    for section in section_insights[:3]:
        priority_actions.extend(section.recommended_actions)
    priority_actions = list(dict.fromkeys(priority_actions))[:4]

    executive_summary = plan.dashboard_summary
    if top_findings:
        executive_summary = (
            f"{plan.dashboard_summary} Tin hieu noi bat: {' '.join(top_findings[:2])}"
            if vi
            else f"{plan.dashboard_summary} Top signals: {' '.join(top_findings[:2])}"
        )

    return InsightReportArtifact(
        executive_summary=executive_summary,
        top_findings=top_findings,
        headline_risks=headline_risks,
        priority_actions=priority_actions,
        section_insights=section_insights,
        chart_insights=chart_insights,
    )


def _llm_enabled(plan: AgentPlanResponse) -> bool:
    if not settings.openrouter_api_key:
        return False
    if not plan.parsed_brief:
        return False
    return bool(plan.parsed_brief.narrative_preferences.get("include_text_narrative", True))


def _chart_payload_summary(base_report: InsightReportArtifact) -> List[Dict[str, Any]]:
    return [
        {
            "chart_key": item.chart_key,
            "title": item.title,
            "chart_type": item.chart_type,
            "caption": item.caption,
            "finding": item.finding,
            "evidence_summary": item.evidence_summary,
            "warning_if_any": item.warning_if_any,
            "confidence": item.confidence,
        }
        for item in base_report.chart_insights
    ]


def _section_payload_summary(base_report: InsightReportArtifact) -> List[Dict[str, Any]]:
    return [
        {
            "section_title": item.section_title,
            "table_name": item.table_name,
            "summary": item.summary,
            "key_findings": item.key_findings,
            "caveats": item.caveats,
            "recommended_actions": item.recommended_actions,
            "confidence": item.confidence,
            "chart_keys": item.chart_keys,
        }
        for item in base_report.section_insights
    ]


async def _generate_llm_overrides(
    plan: AgentPlanResponse,
    base_report: InsightReportArtifact,
) -> Optional[Dict[str, Any]]:
    language = plan.parsed_brief.output_language if plan.parsed_brief else None
    vi = is_vietnamese(language)
    system_prompt = (
        "Ban la senior data analyst viet narrative bao cao. "
        "Hay viet lai insight report dua tren bang chung co san, khong duoc bịa them so lieu, khong duoc doi nghia chart key. "
        "Tra ve JSON hop le va giu tat ca cau chu hien thi bang tieng Viet."
        if vi
        else
        "You are a senior data analyst writing a report narrative. "
        "Rewrite the insight report from the supplied evidence only, without inventing numbers or changing chart keys. "
        "Return valid JSON only."
    )
    user_prompt = json.dumps(
        {
            "dashboard_title": plan.dashboard_title,
            "dashboard_summary": plan.dashboard_summary,
            "strategy_summary": plan.strategy_summary,
            "quality_score": plan.quality_score,
            "warnings": plan.warnings[:6],
            "analysis_plan": plan.analysis_plan.model_dump(mode="json") if plan.analysis_plan else None,
            "base_report": {
                "executive_summary": base_report.executive_summary,
                "top_findings": base_report.top_findings,
                "headline_risks": base_report.headline_risks,
                "priority_actions": base_report.priority_actions,
                "sections": _section_payload_summary(base_report),
                "charts": _chart_payload_summary(base_report),
            },
            "output_contract": {
                "executive_summary": "string",
                "top_findings": ["string"],
                "headline_risks": ["string"],
                "priority_actions": ["string"],
                "section_overrides": [
                    {
                        "section_title": "string",
                        "summary": "string",
                        "key_findings": ["string"],
                        "caveats": ["string"],
                        "recommended_actions": ["string"],
                    }
                ],
                "chart_overrides": [
                    {
                        "chart_key": "string",
                        "caption": "string",
                        "finding": "string",
                        "evidence_summary": "string|null",
                        "warning_if_any": "string|null",
                    }
                ],
            },
        },
        ensure_ascii=False,
        default=str,
    )
    return await generate_json(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model_override=settings.model_for_phase("insight"),
    )


def _coerce_string_list(value: Any, limit: int) -> List[str]:
    if not isinstance(value, list):
        return []
    cleaned: List[str] = []
    for item in value:
        text = str(item).strip()
        if text:
            cleaned.append(text)
        if len(cleaned) >= limit:
            break
    return cleaned


def _merge_llm_overrides(
    base_report: InsightReportArtifact,
    overrides: Dict[str, Any],
) -> InsightReportArtifact:
    chart_map = {item.chart_key: item for item in base_report.chart_insights}
    merged_chart_insights: List[ChartInsightArtifact] = []
    override_by_chart_key = {}
    for item in overrides.get("chart_overrides") or []:
        chart_key = str(item.get("chart_key") or "").strip()
        if chart_key:
            override_by_chart_key[chart_key] = item

    for chart in base_report.chart_insights:
        override = override_by_chart_key.get(chart.chart_key) or {}
        merged_chart_insights.append(
            chart.model_copy(
                update={
                    "caption": str(override.get("caption") or chart.caption).strip(),
                    "finding": str(override.get("finding") or chart.finding).strip(),
                    "evidence_summary": str(override.get("evidence_summary") or chart.evidence_summary).strip(),
                    "warning_if_any": (
                        str(override.get("warning_if_any")).strip()
                        if override.get("warning_if_any") not in (None, "")
                        else chart.warning_if_any
                    ),
                }
            )
        )

    merged_chart_map = {item.chart_key: item for item in merged_chart_insights}
    override_by_section = {}
    for item in overrides.get("section_overrides") or []:
        section_title = str(item.get("section_title") or "").strip()
        if section_title:
            override_by_section[section_title] = item

    merged_sections: List[SectionInsightArtifact] = []
    for section in base_report.section_insights:
        override = override_by_section.get(section.section_title) or {}
        merged_sections.append(
            section.model_copy(
                update={
                    "summary": str(override.get("summary") or section.summary).strip(),
                    "key_findings": _coerce_string_list(override.get("key_findings"), 4) or section.key_findings,
                    "caveats": _coerce_string_list(override.get("caveats"), 3) or section.caveats,
                    "recommended_actions": _coerce_string_list(override.get("recommended_actions"), 3)
                    or section.recommended_actions,
                    "chart_ids": [
                        merged_chart_map[key].chart_id
                        for key in section.chart_keys
                        if key in merged_chart_map and merged_chart_map[key].chart_id is not None
                    ],
                }
            )
        )

    return InsightReportArtifact(
        executive_summary=str(overrides.get("executive_summary") or base_report.executive_summary).strip(),
        top_findings=_coerce_string_list(overrides.get("top_findings"), 5) or base_report.top_findings,
        headline_risks=_coerce_string_list(overrides.get("headline_risks"), 4) or base_report.headline_risks,
        priority_actions=_coerce_string_list(overrides.get("priority_actions"), 4) or base_report.priority_actions,
        section_insights=merged_sections,
        chart_insights=merged_chart_insights,
    )


async def generate_insight_report(
    plan: AgentPlanResponse,
    chart_payloads: Iterable[Dict[str, Any]],
) -> Tuple[InsightReportArtifact, AgentRuntimeMetadata]:
    base_report = _build_rule_based_insight_report(plan, chart_payloads)
    if not _llm_enabled(plan):
        return base_report, rule_runtime_metadata()

    overrides = await _generate_llm_overrides(plan, base_report)
    if not overrides:
        return base_report, rule_runtime_metadata()

    return _merge_llm_overrides(base_report, overrides), llm_runtime_metadata("insight")
