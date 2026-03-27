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


def _pick_fields(rows: List[Dict[str, Any]], chart: Optional["AgentChartPlan"] = None) -> tuple[Optional[str], Optional[str]]:
    # Prefer roleConfig fields set by the planner — they reflect actual analytical intent
    if chart is not None:
        role_config = (chart.config or {}).get("roleConfig") or {}
        metrics = role_config.get("metrics") or []
        metric_field = metrics[0].get("field") if metrics else None
        dimension_field = role_config.get("dimension") or role_config.get("timeField") or None
        if metric_field or dimension_field:
            return dimension_field, metric_field

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
    # Fallback: still extract whatever we can from the data
    if dimension_field and not metric_field:
        # Count per dimension group
        from collections import Counter
        counts = Counter(str(row.get(dimension_field, "")).strip() for row in rows if row.get(dimension_field) not in (None, ""))
        top_items = counts.most_common(3)
        if top_items:
            snippets = [f"{label} = {count}" for label, count in top_items]
            return "; ".join(snippets) + (f" ({len(rows)} {('dòng' if vi else 'rows')} tổng)" if len(rows) > 3 else "")
    return f"Trả về {len(rows)} dòng dữ liệu." if vi else f"Returned {len(rows)} rows."


def _compute_signals(
    rows: List[Dict[str, Any]],
    dimension_field: Optional[str],
    metric_field: Optional[str],
) -> Dict[str, Any]:
    """Compute statistical signals from real data rows for LLM to reason over."""
    signals: Dict[str, Any] = {"row_count": len(rows)}
    if not rows or not metric_field:
        return signals

    values = [_to_number(row.get(metric_field)) for row in rows if _to_number(row.get(metric_field)) is not None]
    if not values:
        return signals

    total = sum(values)
    signals["total"] = round(total, 2)
    signals["mean"] = round(total / len(values), 2)
    signals["min"] = round(min(values), 2)
    signals["max"] = round(max(values), 2)

    # Trend: compare first half vs second half
    if len(values) >= 4:
        mid = len(values) // 2
        first_avg = sum(values[:mid]) / mid
        second_avg = sum(values[mid:]) / (len(values) - mid)
        if first_avg != 0:
            trend_pct = round((second_avg - first_avg) / abs(first_avg) * 100, 1)
            signals["trend_pct"] = trend_pct
            signals["trend_direction"] = "up" if trend_pct > 2 else "down" if trend_pct < -2 else "flat"

    # Top/bottom segments
    if dimension_field:
        ranked = sorted(
            [row for row in rows if _to_number(row.get(metric_field)) is not None],
            key=lambda r: _to_number(r.get(metric_field)) or 0,
            reverse=True,
        )
        if ranked:
            top_val = _to_number(ranked[0].get(metric_field)) or 0
            signals["top_segment"] = str(ranked[0].get(dimension_field, ""))
            signals["top_value"] = round(top_val, 2)
            if total > 0:
                signals["top_share_pct"] = round(top_val / total * 100, 1)
            if len(ranked) >= 2:
                signals["second_segment"] = str(ranked[1].get(dimension_field, ""))

    return signals


def _build_chart_insight(
    chart: AgentChartPlan,
    chart_id: Optional[int],
    rows: List[Dict[str, Any]],
    language: str | None,
    warning_if_any: Optional[str] = None,
) -> ChartInsightArtifact:
    vi = is_vietnamese(language)
    dimension_field, metric_field = _pick_fields(rows, chart)
    signals = _compute_signals(rows, dimension_field, metric_field)
    evidence_summary = _summarize_rows(rows, dimension_field, metric_field, language)

    finding = chart.hypothesis or chart.expected_signal or chart.rationale
    caption = chart.title

    if rows and chart.chart_type in {"TIME_SERIES", "LINE", "AREA"} and metric_field:
        trend_dir = signals.get("trend_direction")
        trend_pct = signals.get("trend_pct")
        if trend_dir and trend_pct is not None:
            if vi:
                dir_text = "tăng" if trend_dir == "up" else "giảm" if trend_dir == "down" else "đi ngang"
                finding = f"{chart.title}: {metric_field.replace('_', ' ')} {dir_text} {abs(trend_pct):.1f}% so với nửa đầu cùng kỳ."
                caption = f"{chart.title}: xu hướng {metric_field.replace('_', ' ')}."
            else:
                dir_text = "up" if trend_dir == "up" else "down" if trend_dir == "down" else "flat"
                finding = f"{chart.title}: {metric_field.replace('_', ' ')} trended {dir_text} {abs(trend_pct):.1f}% vs the earlier period."
                caption = f"{chart.title}: {metric_field.replace('_', ' ')} trend."
    elif rows and metric_field and dimension_field and chart.chart_type in {"BAR", "GROUPED_BAR", "STACKED_BAR", "PIE"}:
        top_seg = signals.get("top_segment")
        top_share = signals.get("top_share_pct")
        if top_seg:
            label = _dimension_label(top_seg, language)
            if vi:
                share_text = f" ({top_share:.0f}% tổng)" if top_share is not None else ""
                finding = f"{label} dẫn đầu trong {chart.title}{share_text} theo {metric_field.replace('_', ' ')}."
                caption = f"{chart.title}: so sánh {metric_field.replace('_', ' ')} theo {dimension_field.replace('_', ' ')}."
            else:
                share_text = f" ({top_share:.0f}% of total)" if top_share is not None else ""
                finding = f"{label} leads in {chart.title}{share_text} by {metric_field.replace('_', ' ')}."
                caption = f"{chart.title}: {metric_field.replace('_', ' ')} by {dimension_field.replace('_', ' ')}."
    elif rows and chart.chart_type == "TABLE":
        if vi:
            finding = f"{chart.title} giữ lại góc nhìn vận hành chi tiết với {len(rows)} dòng hiển thị để follow-up."
            caption = f"{chart.title}: dữ liệu chi tiết hỗ trợ việc kiểm tra."
        else:
            finding = f"{chart.title} keeps a detailed operational view with {len(rows)} visible rows for follow-up."
            caption = f"{chart.title}: detailed supporting records for investigation."

    # Enrich evidence with actual signal numbers when available
    signal_parts = []
    if signals.get("total") is not None and metric_field:
        signal_parts.append(f"total({metric_field})={signals['total']:,.2f}")
    if signals.get("mean") is not None:
        signal_parts.append(f"avg={signals['mean']:,.2f}")
    if signals.get("top_segment"):
        share = f" ({signals['top_share_pct']:.0f}%)" if signals.get("top_share_pct") is not None else ""
        signal_parts.append(f"top: {signals['top_segment']}={signals.get('top_value', '?')}{share}")
    if signals.get("trend_pct") is not None:
        signal_parts.append(f"trend: {signals['trend_pct']:+.1f}%")
    if signal_parts:
        evidence_summary = f"{evidence_summary} [{'; '.join(signal_parts)}]"

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
    chart_payloads: List[Dict[str, Any]],
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

    # Map quality gate warnings to tables so sections can inherit them as caveats
    quality_warnings_by_table: Dict[str, List[str]] = {}
    if plan.quality_gate_report:
        for warning in (plan.quality_gate_report.warnings or []):
            for section in plan.sections:
                if section.table_name and section.table_name.lower() in warning.lower():
                    quality_warnings_by_table.setdefault(section.table_name, []).append(warning)
        for blocker in (plan.quality_gate_report.blockers or []):
            for section in plan.sections:
                if section.table_name and section.table_name.lower() in blocker.lower():
                    quality_warnings_by_table.setdefault(section.table_name, []).append(blocker)

    section_insights: List[SectionInsightArtifact] = []
    for section in plan.sections:
        related = [item for item in chart_insights if item.chart_key in section.chart_keys]
        if not related:
            continue
        key_findings = [item.finding for item in related[:3]]
        # Combine chart-level warnings with quality gate warnings for this table
        chart_caveats = [item.warning_if_any for item in related if item.warning_if_any]
        table_caveats = quality_warnings_by_table.get(section.table_name, [])
        caveats = list(dict.fromkeys(chart_caveats + table_caveats))[:4]

        # Generate context-aware recommended actions from the section's analysis intent
        recommended_actions: List[str] = []
        section_intent = getattr(section, "intent", "") or ""
        top_finding = key_findings[0] if key_findings else ""
        low_confidence = any(item.confidence < 0.55 for item in related)

        if low_confidence:
            recommended_actions.append(
                "Kiểm tra lại chất lượng dữ liệu cho section này trước khi đưa vào báo cáo chính thức."
                if vi
                else "Verify data quality for this section before using it in a formal report."
            )
        if section_intent:
            recommended_actions.append(
                f"Dùng section này để trả lời: {section_intent[:120]}."
                if vi
                else f"Use this section to address: {section_intent[:120]}."
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
        signal_text = " ".join(top_findings[:2])
        executive_summary = (
            f"{plan.dashboard_summary} Tín hiệu nổi bật: {signal_text}"
            if vi
            else f"{plan.dashboard_summary} Top signals: {signal_text}"
        )

    # Inject cross-table relationship context when available
    table_relationships = (plan.parsed_brief.table_relationships if plan.parsed_brief else []) or []
    if table_relationships:
        rel_text = "; ".join(table_relationships[:2])
        executive_summary += (
            f" Mối quan hệ giữa các bảng: {rel_text}."
            if vi
            else f" Cross-table relationships: {rel_text}."
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
    chart_signals: Optional[Dict[str, Any]] = None,
    chart_sample_rows: Optional[Dict[str, List[Dict[str, Any]]]] = None,
) -> Optional[Dict[str, Any]]:
    language = plan.parsed_brief.output_language if plan.parsed_brief else None
    vi = is_vietnamese(language)
    system_prompt = (
        "Bạn là senior data analyst đang viết narrative báo cáo BI. "
        "Nhiệm vụ: phân tích dữ liệu thực tế được cung cấp và viết lại insight report với nhận định sắc bén, "
        "chỉ ra xu hướng, segment nổi bật, và đề xuất hành động có căn cứ từ số liệu. "
        "Không được bịa thêm số liệu, không được đổi chart_key. Trả về JSON hợp lệ, viết bằng tiếng Việt."
        if vi
        else
        "You are a senior data analyst writing a BI report narrative. "
        "Analyze the real data signals provided and rewrite the insight report with sharp analytical findings: "
        "identify trends, highlight standout segments, and suggest evidence-backed actions. "
        "Do not invent numbers or change chart keys. Return valid JSON only."
    )
    user_prompt = json.dumps(
        {
            "dashboard_title": plan.dashboard_title,
            "dashboard_summary": plan.dashboard_summary,
            "strategy_summary": plan.strategy_summary,
            "analysis_plan": plan.analysis_plan.model_dump(mode="json") if plan.analysis_plan else None,
            "chart_signals": chart_signals or {},
            "chart_sample_rows": {k: v[:10] for k, v in (chart_sample_rows or {}).items()},
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
        phase="insight",
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
    payloads_list = list(chart_payloads)
    base_report = _build_rule_based_insight_report(plan, payloads_list)
    if not _llm_enabled(plan):
        return base_report, rule_runtime_metadata()

    # Build signals and sample rows per chart for LLM to reason over real data
    chart_map = {chart.key: chart for chart in plan.charts}
    chart_signals: Dict[str, Any] = {}
    chart_sample_rows: Dict[str, List[Dict[str, Any]]] = {}
    for payload in payloads_list:
        key = payload.get("key") or ""
        rows = list(payload.get("data_rows") or [])
        chart = chart_map.get(key)
        if chart and rows:
            dim, met = _pick_fields(rows, chart)
            chart_signals[key] = _compute_signals(rows, dim, met)
            chart_sample_rows[key] = rows[:10]

    overrides = await _generate_llm_overrides(plan, base_report, chart_signals, chart_sample_rows)
    if not overrides:
        return base_report, rule_runtime_metadata()

    return _merge_llm_overrides(base_report, overrides), llm_runtime_metadata("insight")
