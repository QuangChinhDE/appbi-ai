from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from app.schemas.agent import (
    AgentChartPlan,
    AgentPlanResponse,
    ChartInsightArtifact,
    InsightReportArtifact,
    SectionInsightArtifact,
)
from app.services.output_language import is_vietnamese


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
        return "Không xác định" if vi else "Unknown"
    text = str(value).strip()
    if not text or text.lower() in {"none", "null", "nan", "n/a"}:
        return "Không xác định" if vi else "Unknown"
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
        return "Không có dòng dữ liệu nào được trả về." if vi else "No data rows were returned."
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
                return f"{metric_field} dao động từ {min(values):,.0f} đến {max(values):,.0f} trên {len(rows)} dòng."
            return f"{metric_field} ranges from {min(values):,.0f} to {max(values):,.0f} across {len(rows)} rows."
    return f"Trả về {len(rows)} dòng dữ liệu." if vi else f"Returned {len(rows)} rows."


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
                direction = "tăng lên" if delta > 0 else "giảm xuống" if delta < 0 else "đi ngang tương đối"
                finding = f"{chart.title} {direction} trong giai đoạn mẫu, dựa trên {metric_field}."
                caption = f"{chart.title}: tín hiệu xu hướng cho {metric_field.replace('_', ' ')}."
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
                finding = f"{label} nổi bật trong {chart.title} với giá trị {leader.get(metric_field)}."
                caption = f"{chart.title}: so sánh {metric_field.replace('_', ' ')} theo {dimension_field.replace('_', ' ')}."
            else:
                finding = f"{label} stands out in {chart.title} with {leader.get(metric_field)}."
                caption = f"{chart.title}: compare how {metric_field.replace('_', ' ')} varies by {dimension_field.replace('_', ' ')}."
    elif rows and chart.chart_type == "TABLE":
        if vi:
            finding = f"{chart.title} giữ lại góc nhìn vận hành chi tiết với {len(rows)} dòng hiển thị để follow-up."
            caption = f"{chart.title}: dữ liệu chi tiết hỗ trợ việc kiểm tra."
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


def generate_insight_report(
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
                "Ưu tiên rà soát các nhóm có tỷ trọng bảng không hoạt động cao nhất."
                if vi
                else "Prioritize review of the segments with the highest inactive asset concentration."
            )
        if any("ownership" in finding.lower() or "stewardship" in finding.lower() or "metadata" in finding.lower() for finding in key_findings):
            recommended_actions.append(
                "Xác minh độ phủ metadata và ownership trước khi dùng các tài sản này cho báo cáo quan trọng."
                if vi
                else "Validate metadata and ownership coverage before using these assets for critical reporting."
            )
        if not recommended_actions:
            recommended_actions.append(
                "Dùng phần này để dẫn hướng vòng follow-up vận hành và xác minh tiếp theo."
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
            f"{plan.dashboard_summary} Tín hiệu nổi bật: {' '.join(top_findings[:2])}"
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
