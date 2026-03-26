from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Dict, Iterable, List, Optional

from fastapi import HTTPException

from app.clients.bi_client import bi_client
from app.config import settings
from app.schemas.agent import (
    AgentBriefRequest,
    AgentChartPlan,
    AnalysisPlanArtifact,
    AgentPlanEvent,
    AgentPlanResponse,
    AgentSectionPlan,
    AgentRuntimeMetadata,
    DatasetFitArtifactItem,
    ParsedBriefArtifact,
    ProfilingArtifactItem,
    QualityGateArtifact,
)
from app.services.analysis_planner import build_analysis_plan
from app.services.brief_parser import parse_brief
from app.services.data_profiler import build_profiling_report
from app.services.dataset_selector import build_dataset_fit_report
from app.services.llm_client import generate_json
from app.services.output_language import infer_output_language, is_vietnamese
from app.services.quality_gate import evaluate_quality_gate
from app.services.runtime_metadata import llm_runtime_metadata, rule_runtime_metadata


SUPPORTED_CHART_TYPES = {"KPI", "BAR", "LINE", "AREA", "PIE", "TABLE", "TIME_SERIES", "GROUPED_BAR", "STACKED_BAR"}

@dataclass
class TableContext:
    workspace_id: int
    workspace_name: str
    workspace_description: Optional[str]
    table_id: int
    table_name: str
    columns: List[Dict[str, Any]]
    sample_rows: List[Dict[str, Any]]
    table_description: Dict[str, Any]


@dataclass
class TableProfile:
    context: TableContext
    typed_columns: List[Dict[str, str]]
    numeric_columns: List[str]
    date_columns: List[str]
    categorical_columns: List[str]
    low_cardinality_columns: List[str]
    metric_candidates: List[str]
    dimension_candidates: List[str]
    table_kind: str
    primary_metric: Optional[str]
    primary_time: Optional[str]
    primary_dimension: Optional[str]
    question_matches: List[str]
    business_summary: str


def _slugify(value: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")


def _normalize_columns(columns: Iterable[Any]) -> List[Dict[str, Any]]:
    normalized = []
    for column in columns or []:
        if isinstance(column, dict):
            normalized.append(
                {
                    "name": column.get("name", ""),
                    "type": str(column.get("type", "string")).lower(),
                }
            )
        else:
            normalized.append({"name": str(column), "type": "string"})
    return [column for column in normalized if column["name"]]


def _infer_type(column: Dict[str, Any], sample_rows: List[Dict[str, Any]]) -> str:
    declared = (column.get("type") or "").lower()
    if any(token in declared for token in ("int", "float", "double", "number", "numeric", "decimal")):
        return "number"
    if any(token in declared for token in ("date", "time", "timestamp")):
        return "date"
    values = [row.get(column["name"]) for row in sample_rows if row.get(column["name"]) not in (None, "")]
    if not values:
        lowered_name = column["name"].lower()
        if any(token in lowered_name for token in ("date", "time", "month", "year", "week")):
            return "date"
        return "string"
    if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in values):
        return "number"
    lowered_name = column["name"].lower()
    if any(token in lowered_name for token in ("date", "time", "month", "year", "week")):
        return "date"
    return "string"


def _unique_count(column_name: str, sample_rows: List[Dict[str, Any]]) -> int:
    values = {
        str(row.get(column_name)).strip()
        for row in sample_rows
        if row.get(column_name) not in (None, "")
    }
    return len(values)


def _score_name_against_terms(name: str, terms: List[str]) -> float:
    lowered = name.lower().replace("_", " ")
    score = 0.0
    for term in terms:
        cleaned = term.lower().strip()
        if not cleaned:
            continue
        if cleaned in lowered:
            score += 1.0
        else:
            overlap = set(cleaned.split()) & set(lowered.split())
            score += min(len(overlap) * 0.35, 0.7)
    return score


def _match_questions(text: str, questions: List[str]) -> List[str]:
    lowered = text.lower()
    matches = []
    for question in questions:
        tokens = [token for token in question.lower().replace("?", "").split() if len(token) > 3]
        if any(token in lowered for token in tokens):
            matches.append(question)
    return matches[:3]


def _truncate_text(value: Any, limit: int = 140) -> str:
    text = str(value).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _representative_rows(sample_rows: List[Dict[str, Any]], max_rows: int = 6) -> List[Dict[str, Any]]:
    selected: List[Dict[str, Any]] = []
    seen_signatures: set[str] = set()
    for row in sample_rows:
        signature = json.dumps(row, sort_keys=True, default=str)
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        selected.append(row)
        if len(selected) >= max_rows:
            break
    return selected


def _table_kind(column_names: List[str], sample_rows: List[Dict[str, Any]]) -> str:
    lowered = " ".join(column_names).lower()
    if any(token in lowered for token in ("date", "event", "created", "occurred", "timestamp")):
        return "event"
    if any(token in lowered for token in ("snapshot", "balance", "inventory", "status")):
        return "snapshot"
    if len(sample_rows) <= 10:
        return "lookup"
    return "fact"


def _count_field(columns: List[Dict[str, Any]]) -> str:
    for preferred in ("id", "record_id", "uuid"):
        for column in columns:
            if column["name"].lower() == preferred:
                return column["name"]
    return columns[0]["name"] if columns else "id"


async def load_table_contexts(brief: AgentBriefRequest, token: str) -> List[TableContext]:
    contexts: List[TableContext] = []
    for ref in brief.selected_tables:
        workspace = await bi_client.get_workspace(ref.workspace_id, token)
        table = next((item for item in workspace.get("tables", []) if item.get("id") == ref.table_id), None)
        if table is None:
            raise HTTPException(
                status_code=404,
                detail=f"Table {ref.table_id} not found in workspace {ref.workspace_id}",
            )
        preview = await bi_client.preview_workspace_table(ref.workspace_id, ref.table_id, limit=40, token=token)
        description = await bi_client.get_table_description(ref.workspace_id, ref.table_id, token)
        columns = _normalize_columns(table.get("columns_cache", {}).get("columns") or preview.get("columns", []))
        contexts.append(
            TableContext(
                workspace_id=ref.workspace_id,
                workspace_name=workspace.get("name", f"Workspace {ref.workspace_id}"),
                workspace_description=workspace.get("description"),
                table_id=ref.table_id,
                table_name=table.get("display_name") or table.get("source_table_name") or f"Table {ref.table_id}",
                columns=columns,
                sample_rows=preview.get("rows", []),
                table_description=description,
            )
        )
    return contexts


def profile_table(brief: AgentBriefRequest, context: TableContext) -> TableProfile:
    language = infer_output_language(
        brief.output_language,
        [brief.goal, brief.audience, brief.decision_context, brief.notes, " ".join(brief.questions)],
    )
    vi = is_vietnamese(language)
    typed_columns = [{"name": column["name"], "type": _infer_type(column, context.sample_rows)} for column in context.columns]
    numeric_columns = [column["name"] for column in typed_columns if column["type"] == "number"]
    date_columns = [column["name"] for column in typed_columns if column["type"] == "date"]
    categorical_columns = [column["name"] for column in typed_columns if column["type"] == "string"]
    low_cardinality_columns = [
        column_name
        for column_name in categorical_columns
        if 1 < _unique_count(column_name, context.sample_rows) <= 10
    ]

    scoring_terms = brief.kpis + brief.questions + [brief.goal, brief.audience or "", brief.report_type or ""]
    metric_candidates = sorted(
        numeric_columns,
        key=lambda name: (_score_name_against_terms(name, scoring_terms), -len(name)),
        reverse=True,
    )
    dimension_candidates = sorted(
        categorical_columns,
        key=lambda name: (_score_name_against_terms(name, brief.questions + [brief.goal]), -len(name)),
        reverse=True,
    )

    description_text = context.table_description.get("auto_description") or ""
    table_kind = _table_kind([column["name"] for column in typed_columns], context.sample_rows)
    primary_metric = metric_candidates[0] if metric_candidates else None
    primary_time = date_columns[0] if date_columns else None
    primary_dimension = (low_cardinality_columns or dimension_candidates or categorical_columns or [None])[0]

    business_summary = description_text or (
        (
            f"{context.table_name} có vẻ là bảng kiểu {table_kind} với "
            f"{len(typed_columns)} cột và {len(context.sample_rows)} dòng mẫu."
        )
        if vi
        else (
            f"{context.table_name} looks like a {table_kind} table with "
            f"{len(typed_columns)} columns and {len(context.sample_rows)} sampled rows."
        )
    )
    question_matches = _match_questions(
        " ".join([context.table_name, business_summary, " ".join(column["name"] for column in typed_columns)]),
        brief.questions,
    )

    return TableProfile(
        context=context,
        typed_columns=typed_columns,
        numeric_columns=numeric_columns,
        date_columns=date_columns,
        categorical_columns=categorical_columns,
        low_cardinality_columns=low_cardinality_columns,
        metric_candidates=metric_candidates,
        dimension_candidates=dimension_candidates,
        table_kind=table_kind,
        primary_metric=primary_metric,
        primary_time=primary_time,
        primary_dimension=primary_dimension,
        question_matches=question_matches,
        business_summary=business_summary,
    )


def _profile_prompt_payload(profile: TableProfile) -> Dict[str, Any]:
    return {
        "workspace_id": profile.context.workspace_id,
        "workspace_name": profile.context.workspace_name,
        "table_id": profile.context.table_id,
        "table_name": profile.context.table_name,
        "table_kind": profile.table_kind,
        "business_summary": _truncate_text(profile.business_summary, 260),
        "numeric_columns": profile.numeric_columns[:8],
        "date_columns": profile.date_columns[:6],
        "dimension_candidates": profile.dimension_candidates[:8],
        "primary_metric": profile.primary_metric,
        "primary_time": profile.primary_time,
        "primary_dimension": profile.primary_dimension,
        "common_questions": (profile.context.table_description.get("common_questions") or [])[:4],
        "sample_rows": _representative_rows(profile.context.sample_rows, max_rows=4),
        "columns": [{"name": column["name"], "type": column["type"]} for column in profile.typed_columns],
    }


async def _generate_strategy_with_llm(
    brief: AgentBriefRequest,
    profiles: List[TableProfile],
    parsed_brief: ParsedBriefArtifact,
    dataset_fit_report: List[DatasetFitArtifactItem],
    profiling_report: List[ProfilingArtifactItem],
    quality_gate_report: QualityGateArtifact,
    analysis_plan: AnalysisPlanArtifact,
) -> Optional[Dict[str, Any]]:
    vi = is_vietnamese(parsed_brief.output_language)
    system_prompt = (
        (
            "Bạn là một chuyên gia BI/DA cấp cao đang thiết kế kế hoạch dashboard. "
            "Hãy dùng brief và hồ sơ bảng để tạo chiến lược báo cáo theo hướng nghiệp vụ trước. "
            "Không được bịa thêm bảng hoặc cột. Chỉ trả về JSON hợp lệ. "
            "Mọi câu chữ hiển thị cho người dùng phải viết bằng tiếng Việt."
        )
        if vi
        else (
            "You are a senior BI analyst designing a dashboard plan. "
            "Use the brief and table profiles to create a business-first report strategy. "
            "Do not invent columns or tables. Return strict JSON only."
        )
    )
    user_prompt = json.dumps(
        {
            "brief": brief.model_dump(),
            "parsed_brief": parsed_brief.model_dump(mode="json"),
            "dataset_fit_report": [item.model_dump(mode="json") for item in dataset_fit_report],
            "profiling_report": [item.model_dump(mode="json") for item in profiling_report],
            "quality_gate_report": quality_gate_report.model_dump(mode="json"),
            "analysis_plan": analysis_plan.model_dump(mode="json"),
            "tables": [_profile_prompt_payload(profile) for profile in profiles],
            "output_contract": {
                "dashboard_title": "string",
                "dashboard_summary": "string",
                "strategy_summary": "string",
                "warnings": ["string"],
                "sections": [
                    {
                        "table_id": "number",
                        "title": "string",
                        "intent": "string",
                        "why_this_section": "string",
                        "questions_covered": ["string"],
                        "priority": "number",
                        "charts": [
                            {
                                "title": "string",
                                "chart_type": "KPI|BAR|LINE|AREA|PIE|TABLE|TIME_SERIES|GROUPED_BAR|STACKED_BAR",
                                "insight_goal": "string",
                                "why_this_chart": "string",
                                "metric_hint": "string|null",
                                "dimension_hint": "string|null",
                                "time_hint": "string|null",
                                "expected_signal": "string|null",
                                "alternative_considered": "string|null",
                                "confidence": "0.0-1.0"
                            }
                        ]
                    }
                ]
            },
        },
        ensure_ascii=False,
        default=str,
    )
    return await generate_json(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model_override=settings.model_for_phase("planning"),
    )


def _build_heuristic_strategy(
    brief: AgentBriefRequest,
    profiles: List[TableProfile],
    parsed_brief: ParsedBriefArtifact,
    dataset_fit_report: List[DatasetFitArtifactItem],
    analysis_plan: AnalysisPlanArtifact,
) -> Dict[str, Any]:
    vi = is_vietnamese(parsed_brief.output_language)
    warnings: List[str] = []
    sections: List[Dict[str, Any]] = []
    fit_by_table_id = {item.table_id: item for item in dataset_fit_report}

    executive_profile = max(
        profiles,
        key=lambda profile: (
            fit_by_table_id.get(profile.context.table_id).fit_score if fit_by_table_id.get(profile.context.table_id) else 0,
            1 if profile.primary_metric else 0,
            1 if profile.primary_time else 0,
            len(profile.metric_candidates),
            len(profile.typed_columns),
        ),
    )

    def _base_chart_requests(profile: TableProfile) -> List[Dict[str, Any]]:
        requests: List[Dict[str, Any]] = []
        count_field = _count_field(profile.typed_columns)
        requests.append(
            {
                "title": f"{profile.context.table_name} - Tổng quy mô" if vi else f"{profile.context.table_name} - Total volume",
                "chart_type": "KPI",
                "insight_goal": "Thiết lập quy mô nền của tập dữ liệu hoặc hoạt động" if vi else "Establish the baseline size of the dataset or activity",
                "why_this_chart": "Dashboard nên bắt đầu bằng một KPI nền dễ đọc." if vi else "A dashboard should begin with a simple baseline KPI.",
                "metric_hint": count_field,
                "dimension_hint": None,
                "time_hint": None,
                "expected_signal": "quy mô và khối lượng tổng thể" if vi else "Overall scale and volume",
                "alternative_considered": "Mở đầu bằng bảng chi tiết sẽ khó đọc hơn." if vi else "A detail table would be less useful as the opening visual.",
                "confidence": 0.72,
            }
        )
        if profile.primary_metric:
            requests.append(
                {
                    "title": (
                        f"{profile.context.table_name} - {profile.primary_metric.replace('_', ' ')}"
                        if vi
                        else f"{profile.context.table_name} - {profile.primary_metric.replace('_', ' ').title()}"
                    ),
                    "chart_type": "KPI",
                    "insight_goal": (
                        f"Theo dõi metric hiệu suất chính quanh {profile.primary_metric}."
                        if vi
                        else f"Track the main performance metric around {profile.primary_metric}."
                    ),
                    "why_this_chart": "KPI chính giúp người đọc quét nhanh kết quả nghiệp vụ quan trọng nhất." if vi else "A headline KPI makes it easier to scan the main business outcome quickly.",
                    "metric_hint": profile.primary_metric,
                    "dimension_hint": None,
                    "time_hint": None,
                    "expected_signal": "biến động KPI chính" if vi else "Headline KPI movement",
                    "alternative_considered": "Bar chart sẽ làm mờ con số top-line." if vi else "A bar chart would hide the top-line number.",
                    "confidence": 0.84,
                }
            )
        if profile.primary_metric and profile.primary_time:
            requests.append(
                {
                    "title": f"{profile.context.table_name} - Xu hướng theo thời gian" if vi else f"{profile.context.table_name} - Trend over time",
                    "chart_type": "TIME_SERIES",
                    "insight_goal": (
                        f"Thể hiện {profile.primary_metric} thay đổi theo {profile.primary_time} như thế nào."
                        if vi
                        else f"Show how {profile.primary_metric} changes over {profile.primary_time}."
                    ),
                    "why_this_chart": "Biểu đồ xu hướng là phần cốt lõi cho báo cáo theo dõi và điều hành." if vi else "A trend view is essential for monitoring and executive reporting.",
                    "metric_hint": profile.primary_metric,
                    "dimension_hint": None,
                    "time_hint": profile.primary_time,
                    "expected_signal": "xu hướng, tăng trưởng hoặc suy giảm theo thời gian" if vi else "Trend, growth, or decline over time",
                    "alternative_considered": "Chỉ dùng KPI sẽ che mất chiều hướng và tính mùa vụ." if vi else "A KPI alone would hide direction and seasonality.",
                    "confidence": 0.88,
                }
            )
        if profile.primary_dimension:
            requests.append(
                {
                    "title": (
                        f"{profile.context.table_name} - Phân rã theo {profile.primary_dimension.replace('_', ' ')}"
                        if vi
                        else f"{profile.context.table_name} - Breakdown by {profile.primary_dimension.replace('_', ' ').title()}"
                    ),
                    "chart_type": "BAR",
                    "insight_goal": (
                        f"So sánh hiệu suất giữa các giá trị của {profile.primary_dimension}."
                        if vi
                        else f"Compare performance across {profile.primary_dimension}."
                    ),
                    "why_this_chart": "Phân rã theo phân khúc giúp thấy phần nào đang kéo kết quả chung." if vi else "Breakdowns help explain which segment drives the overall result.",
                    "metric_hint": profile.primary_metric or count_field,
                    "dimension_hint": profile.primary_dimension,
                    "time_hint": None,
                    "expected_signal": "nhóm tốt nhất và nhóm yếu nhất" if vi else "Top and bottom performing segments",
                    "alternative_considered": "Pie chart dễ làm mất thứ hạng." if vi else "A pie chart may hide rank order.",
                    "confidence": 0.81,
                }
            )
        if profile.low_cardinality_columns:
            requests.append(
                {
                    "title": f"{profile.context.table_name} - Cơ cấu tỷ trọng" if vi else f"{profile.context.table_name} - Share mix",
                    "chart_type": "PIE",
                    "insight_goal": "Thể hiện tỷ trọng trên toàn bộ tập theo phân khúc đơn giản nhất." if vi else "Show share of total across the simplest low-cardinality segment.",
                    "why_this_chart": "Biểu đồ cơ cấu gọn giúp bổ sung cho chart so sánh." if vi else "A compact composition chart complements the comparison chart.",
                    "metric_hint": profile.primary_metric or count_field,
                    "dimension_hint": profile.low_cardinality_columns[0],
                    "time_hint": None,
                    "expected_signal": "cơ cấu và tỷ trọng trên tổng thể" if vi else "Composition and share-of-total",
                    "alternative_considered": "Thêm một bar chart nữa sẽ khá lặp." if vi else "A second bar chart would feel repetitive.",
                    "confidence": 0.68,
                }
            )
        requests.append(
            {
                "title": f"{profile.context.table_name} - Bảng chi tiết" if vi else f"{profile.context.table_name} - Detail view",
                "chart_type": "TABLE",
                "insight_goal": "Giữ một góc nhìn drill-down để soi ở mức bản ghi." if vi else "Keep a drill-down style view for record-level inspection.",
                "why_this_chart": "Bảng chi tiết là phương án fallback thực dụng để follow-up." if vi else "A table gives the report a practical fallback for follow-up inspection.",
                "metric_hint": None,
                "dimension_hint": None,
                "time_hint": None,
                "expected_signal": "các dòng chi tiết phục vụ kiểm tra vận hành" if vi else "Detailed rows for operational follow-up",
                "alternative_considered": "Thêm một chart tổng hợp nữa sẽ không hỗ trợ điều tra." if vi else "A second summary chart would not support investigation.",
                "confidence": 0.64,
            }
        )
        return requests

    executive_questions = brief.questions[:3] or executive_profile.question_matches
    sections.append(
        {
            "table_id": executive_profile.context.table_id,
            "title": "Tóm tắt điều hành" if vi else "Executive summary",
            "intent": (
                f"Trả lời mục tiêu cấp cao nhất: {parsed_brief.business_goal}"
                if vi
                else f"Answer the top-level goal: {parsed_brief.business_goal}"
            ),
            "why_this_section": (
                (
                    "Phần này đi trước với các KPI và xu hướng liên quan nhất tới quyết định để người đọc định vị nhanh. "
                    f"Góc nhìn người đọc: {parsed_brief.target_audience}."
                )
                if vi
                else (
                    "This section leads with the most decision-relevant KPIs and trend so the audience can orient quickly. "
                    f"Audience lens: {parsed_brief.target_audience}."
                )
            ),
            "questions_covered": executive_questions,
            "priority": 1,
            "charts": _base_chart_requests(executive_profile)[:4],
        }
    )

    for index, profile in enumerate(profiles, start=1):
        charts = _base_chart_requests(profile)
        fit = fit_by_table_id.get(profile.context.table_id)
        if profile.context.table_id == executive_profile.context.table_id:
            charts = charts[2:5] + charts[-1:]
        if not profile.primary_time and any(section.lower() == "trend" for section in brief.must_include_sections):
            warnings.append(
                f"{profile.context.table_name} không có trường thời gian đủ rõ để làm phần xu hướng mạnh hơn."
                if vi
                else f"{profile.context.table_name} has no clear time field for a stronger trend section."
            )
        sections.append(
            {
                "table_id": profile.context.table_id,
                "title": f"{profile.context.workspace_name} / {profile.context.table_name}",
                "intent": (
                    (
                        f"Giải thích hiệu suất và các yếu tố dẫn dắt trong {profile.context.table_name}. "
                        f"Vai trò gợi ý: {(fit.suggested_role if fit else 'supporting analysis').replace('_', ' ')}."
                    )
                    if vi
                    else (
                        f"Explain performance and drivers in {profile.context.table_name}. "
                        f"Suggested role: {(fit.suggested_role if fit else 'supporting analysis').replace('_', ' ')}."
                    )
                ),
                "why_this_section": (fit.notes if fit and fit.notes else profile.business_summary),
                "questions_covered": profile.question_matches or brief.questions[:2],
                "priority": index + 1,
                "charts": charts[:4],
            }
        )

    dashboard_title = brief.report_name or brief.goal.strip().rstrip(".")
    dashboard_summary_parts = [
        (
            f"Dashboard này được thiết kế cho {parsed_brief.target_audience or 'người đọc mục tiêu'} để theo dõi {parsed_brief.business_goal.strip().lower()}."
            if vi
            else f"This dashboard is designed for {parsed_brief.target_audience or 'the target audience'} to monitor {parsed_brief.business_goal.strip().lower()}."
        ),
    ]
    if brief.timeframe:
        dashboard_summary_parts.append(f"Khung thời gian chính: {brief.timeframe}." if vi else f"Primary timeframe: {brief.timeframe}.")
    if brief.comparison_period:
        dashboard_summary_parts.append(f"So sánh với: {brief.comparison_period}." if vi else f"Compare against: {brief.comparison_period}.")
    if brief.alert_focus:
        dashboard_summary_parts.append(f"Trọng tâm cảnh báo: {', '.join(brief.alert_focus[:3])}." if vi else f"Alert focus: {', '.join(brief.alert_focus[:3])}.")
    if parsed_brief.decision_context:
        dashboard_summary_parts.append(f"Bối cảnh ra quyết định: {parsed_brief.decision_context}." if vi else f"Decision context: {parsed_brief.decision_context}.")

    return {
        "dashboard_title": dashboard_title,
        "dashboard_summary": " ".join(dashboard_summary_parts),
        "strategy_summary": analysis_plan.business_thesis or (
            (
                "Bắt đầu bằng phần tổng quan điều hành, sau đó đi vào các phần phân rã theo từng bảng để giải thích yếu tố dẫn dắt, "
                "và luôn giữ ít nhất một góc nhìn chi tiết cho việc follow-up vận hành."
            )
            if vi
            else
            "Lead with an executive overview, then move into per-table breakdowns that explain the main drivers "
            "and preserve at least one detail view for operational follow-up."
        ),
        "warnings": warnings,
        "sections": sections,
    }


def _pick_best_name(candidates: List[str], hint: Optional[str], fallback: Optional[str]) -> Optional[str]:
    if not candidates:
        return fallback
    if hint:
        ranked = sorted(candidates, key=lambda name: _score_name_against_terms(name, [hint]), reverse=True)
        if ranked and _score_name_against_terms(ranked[0], [hint]) > 0:
            return ranked[0]
    return fallback or candidates[0]


def _metric_payload(profile: TableProfile, metric_hint: Optional[str], label: Optional[str] = None) -> Dict[str, str]:
    numeric_candidates = profile.metric_candidates or profile.numeric_columns
    numeric_metric = _pick_best_name(numeric_candidates, metric_hint, profile.primary_metric)
    if numeric_metric and numeric_metric in numeric_candidates:
        return {
            "field": numeric_metric,
            "agg": "sum",
            "label": label or numeric_metric.replace("_", " ").title(),
        }

    count_field = _count_field(profile.typed_columns)
    return {
        "field": count_field,
        "agg": "count",
        "label": label or "Record Count",
    }


def _build_chart_config(profile: TableProfile, chart_request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    chart_type = str(chart_request.get("chart_type", "TABLE")).upper()
    if chart_type not in SUPPORTED_CHART_TYPES:
        chart_type = "TABLE"

    metric_hint = chart_request.get("metric_hint")
    dimension_hint = chart_request.get("dimension_hint")
    time_hint = chart_request.get("time_hint")
    metric_payload = _metric_payload(profile, metric_hint, chart_request.get("title"))
    dimension = _pick_best_name(profile.low_cardinality_columns + profile.dimension_candidates, dimension_hint, profile.primary_dimension)
    time_field = _pick_best_name(profile.date_columns, time_hint, profile.primary_time)

    if chart_type == "KPI":
        return {
            "workspace_id": profile.context.workspace_id,
            "chartType": "KPI",
            "roleConfig": {"metrics": [metric_payload]},
            "filters": [],
        }

    if chart_type == "TIME_SERIES":
        if not time_field:
            return None
        return {
            "workspace_id": profile.context.workspace_id,
            "chartType": "TIME_SERIES",
            "roleConfig": {
                "timeField": time_field,
                "metrics": [metric_payload],
            },
            "filters": [],
        }

    if chart_type in {"BAR", "LINE", "AREA", "GROUPED_BAR", "STACKED_BAR"}:
        if not dimension:
            return None
        role_config: Dict[str, Any] = {"dimension": dimension, "metrics": [metric_payload]}
        if chart_type in {"GROUPED_BAR", "STACKED_BAR"} and len(profile.dimension_candidates) > 1:
            breakdown = next((item for item in profile.dimension_candidates if item != dimension), None)
            if breakdown:
                role_config["breakdown"] = breakdown
        return {
            "workspace_id": profile.context.workspace_id,
            "chartType": chart_type,
            "roleConfig": role_config,
            "filters": [],
        }

    if chart_type == "PIE":
        if not dimension:
            return None
        return {
            "workspace_id": profile.context.workspace_id,
            "chartType": "PIE",
            "roleConfig": {
                "dimension": dimension,
                "metrics": [_metric_payload(profile, metric_hint, "Share")],
            },
            "filters": [],
        }

    selected_columns = [column["name"] for column in profile.typed_columns[: min(8, len(profile.typed_columns))]]
    return {
        "workspace_id": profile.context.workspace_id,
        "chartType": "TABLE",
        "roleConfig": {"selectedColumns": selected_columns},
        "filters": [],
    }


def _materialize_strategy(
    brief: AgentBriefRequest,
    strategy: Dict[str, Any],
    profiles: List[TableProfile],
    parsed_brief: ParsedBriefArtifact,
    dataset_fit_report: List[DatasetFitArtifactItem],
    profiling_report: List[ProfilingArtifactItem],
    quality_gate_report: QualityGateArtifact,
    analysis_plan: AnalysisPlanArtifact,
    phase_runtimes: Dict[str, AgentRuntimeMetadata],
) -> AgentPlanResponse:
    vi = is_vietnamese(parsed_brief.output_language)
    profile_map = {profile.context.table_id: profile for profile in profiles}
    charts: List[AgentChartPlan] = []
    sections: List[AgentSectionPlan] = []
    warnings = list(strategy.get("warnings") or [])

    for section_index, raw_section in enumerate(strategy.get("sections") or [], start=1):
        table_id = raw_section.get("table_id")
        profile = profile_map.get(table_id)
        if not profile:
            warnings.append(
                f"Planner tham chiếu tới bảng không tồn tại {table_id}; section này đã bị bỏ qua."
                if vi
                else f"Planner referenced unknown table {table_id}; skipped section."
            )
            continue

        section_chart_keys: List[str] = []
        for chart_index, raw_chart in enumerate(raw_section.get("charts") or [], start=1):
            chart_type = str(raw_chart.get("chart_type", "TABLE")).upper()
            config = _build_chart_config(profile, raw_chart)
            if not config:
                warnings.append(
                    (
                        f"Bỏ qua chart '{raw_chart.get('title', chart_type)}' cho {profile.context.table_name} vì thiếu trường bắt buộc."
                    )
                    if vi
                    else f"Skipped chart '{raw_chart.get('title', chart_type)}' for {profile.context.table_name} because required fields were missing."
                )
                continue
            key = f"{_slugify(profile.context.workspace_name)}-{_slugify(profile.context.table_name)}-{section_index}-{chart_index}"
            section_chart_keys.append(key)
            charts.append(
                AgentChartPlan(
                    key=key,
                    title=raw_chart.get("title") or f"{profile.context.table_name} {chart_type.title()}",
                    chart_type=chart_type,
                    workspace_id=profile.context.workspace_id,
                    workspace_table_id=profile.context.table_id,
                    workspace_name=profile.context.workspace_name,
                    table_name=profile.context.table_name,
                    rationale=raw_chart.get("insight_goal")
                    or raw_chart.get("why_this_chart")
                    or ("Hỗ trợ trực tiếp cho mục tiêu của báo cáo." if vi else "Supports the report objective."),
                    insight_goal=raw_chart.get("insight_goal"),
                    why_this_chart=raw_chart.get("why_this_chart"),
                    confidence=float(raw_chart.get("confidence") or 0.6),
                    alternative_considered=raw_chart.get("alternative_considered"),
                    expected_signal=raw_chart.get("expected_signal"),
                    config=config,
                )
            )

        if section_chart_keys:
            sections.append(
                AgentSectionPlan(
                    title=raw_section.get("title") or f"{profile.context.workspace_name} / {profile.context.table_name}",
                    workspace_id=profile.context.workspace_id,
                    workspace_table_id=profile.context.table_id,
                    workspace_name=profile.context.workspace_name,
                    table_name=profile.context.table_name,
                    intent=raw_section.get("intent") or (f"Phân tích {profile.context.table_name}" if vi else f"Analyze {profile.context.table_name}"),
                    why_this_section=raw_section.get("why_this_section"),
                    questions_covered=list(raw_section.get("questions_covered") or []),
                    priority=int(raw_section.get("priority") or section_index),
                    chart_keys=section_chart_keys,
                )
            )

    if not charts:
        warnings.append(
            "Planner chưa tạo được chart hợp lệ nào từ các bảng đã chọn."
            if vi
            else "Planner could not produce any valid charts from the selected tables."
        )

    charts = charts[:12]
    allowed_keys = {chart.key for chart in charts}
    sections = [
        section.model_copy(update={"chart_keys": [key for key in section.chart_keys if key in allowed_keys]})
        for section in sections
        if any(key in allowed_keys for key in section.chart_keys)
    ]
    sections = sorted(sections, key=lambda section: section.priority)

    return AgentPlanResponse(
        dashboard_title=(strategy.get("dashboard_title") or brief.report_name or brief.goal).strip()[:120],
        dashboard_summary=(strategy.get("dashboard_summary") or brief.goal).strip(),
        strategy_summary=strategy.get("strategy_summary"),
        planning_mode=brief.planning_mode,
        sections=sections,
        charts=charts,
        warnings=warnings,
        parsed_brief=parsed_brief,
        dataset_fit_report=dataset_fit_report,
        profiling_report=profiling_report,
        quality_gate_report=quality_gate_report,
        analysis_plan=analysis_plan,
        runtime=phase_runtimes.get("planning"),
        phase_runtimes=phase_runtimes,
    )


def _review_plan_quality(
    plan: AgentPlanResponse,
    brief: AgentBriefRequest,
    quality_gate_report: QualityGateArtifact,
) -> AgentPlanResponse:
    vi = is_vietnamese(plan.parsed_brief.output_language if plan.parsed_brief else None)
    active_question_hits = sum(
        1
        for question in brief.questions
        if any(question in section.questions_covered for section in plan.sections)
    )
    question_coverage = active_question_hits / max(len(brief.questions), 1) if brief.questions else 1.0

    metric_text = " ".join(
        " ".join(
            [
                chart.title,
                chart.rationale or "",
                chart.insight_goal or "",
                json.dumps(chart.config, ensure_ascii=False),
            ]
        )
        for chart in plan.charts
    ).lower()
    kpi_hits = sum(1 for kpi in brief.kpis if kpi.lower() in metric_text)
    kpi_coverage = kpi_hits / max(len(brief.kpis), 1) if brief.kpis else 1.0

    unique_chart_types = len({chart.chart_type for chart in plan.charts})
    chart_diversity = min(unique_chart_types / 4.0, 1.0)
    section_balance = min(len(plan.sections) / max(len(brief.selected_tables), 1), 1.0)
    dataset_fit = 1.0 if plan.charts and plan.sections else 0.0
    penalty_points = sum(float(value) for value in quality_gate_report.confidence_penalties.values())
    confidence_penalty = min(max(penalty_points, 0.0), 0.4)

    quality_breakdown = {
        "question_coverage": round(question_coverage, 3),
        "kpi_coverage": round(kpi_coverage, 3),
        "chart_diversity": round(chart_diversity, 3),
        "section_balance": round(section_balance, 3),
        "dataset_fit": round(dataset_fit, 3),
        "data_quality": round(max(0.0, 1.0 - confidence_penalty), 3),
    }
    quality_score = (
        question_coverage * 0.26
        + kpi_coverage * 0.22
        + chart_diversity * 0.16
        + section_balance * 0.16
        + dataset_fit * 0.20
    )
    quality_score = max(0.0, min(1.0, quality_score - confidence_penalty))

    warnings = list(plan.warnings)
    if quality_breakdown["question_coverage"] < 0.6 and brief.questions:
        warnings.append(
            "Bản nháp mới chỉ bao phủ một phần các câu hỏi nghiệp vụ đã nêu; nên tinh chỉnh brief thêm."
            if vi
            else "Draft only partially maps to the explicit business questions; consider refining the brief."
        )
    if quality_breakdown["chart_diversity"] < 0.5:
        warnings.append(
            "Bản nháp còn ít đa dạng loại chart. Hãy cân nhắc thay một chart trong bước review."
            if vi
            else "Draft has limited chart variety. Consider replacing one chart during review."
        )
    warnings.extend(quality_gate_report.blockers)
    warnings.extend(quality_gate_report.warnings)

    return plan.model_copy(
        update={
            "quality_score": round(quality_score, 3),
            "quality_breakdown": quality_breakdown,
            "warnings": warnings,
        }
    )


async def generate_agent_plan(brief: AgentBriefRequest, token: str) -> AgentPlanResponse:
    phase_runtimes: Dict[str, AgentRuntimeMetadata] = {
        "brief": rule_runtime_metadata(),
        "dataset_fit": rule_runtime_metadata(),
        "profiling": rule_runtime_metadata(),
        "quality_gate": rule_runtime_metadata(),
        "analysis_plan": rule_runtime_metadata(),
        "review": rule_runtime_metadata(),
    }
    parsed_brief = parse_brief(brief)
    contexts = await load_table_contexts(brief, token)
    profiles = [profile_table(brief, context) for context in contexts]
    profiling_report = build_profiling_report(profiles, parsed_brief.output_language)
    dataset_fit_report = build_dataset_fit_report(parsed_brief, profiles)
    quality_gate_report = evaluate_quality_gate(
        profiling_report,
        parsed_brief.known_data_issues,
        parsed_brief.output_language,
    )
    analysis_plan = build_analysis_plan(parsed_brief, dataset_fit_report, profiling_report, quality_gate_report)
    strategy = (
        await _generate_strategy_with_llm(
            brief,
            profiles,
            parsed_brief,
            dataset_fit_report,
            profiling_report,
            quality_gate_report,
            analysis_plan,
        )
        if brief.planning_mode == "deep"
        else None
    )
    phase_runtimes["planning"] = (
        llm_runtime_metadata("planning")
        if strategy is not None
        else rule_runtime_metadata()
    )
    if strategy is None:
        strategy = _build_heuristic_strategy(brief, profiles, parsed_brief, dataset_fit_report, analysis_plan)
    plan = _materialize_strategy(
        brief,
        strategy,
        profiles,
        parsed_brief,
        dataset_fit_report,
        profiling_report,
        quality_gate_report,
        analysis_plan,
        phase_runtimes,
    )
    return _review_plan_quality(plan, brief, quality_gate_report)


def _plan_event(event_type: str, phase: str, message: str, plan: Optional[AgentPlanResponse] = None, error: Optional[str] = None) -> str:
    event = AgentPlanEvent(type=event_type, phase=phase, message=message, plan=plan, error=error)
    return json.dumps(event.model_dump(), ensure_ascii=False) + "\n"


async def generate_agent_plan_stream(brief: AgentBriefRequest, token: str) -> AsyncGenerator[str, None]:
    parsed_brief = parse_brief(brief)
    vi = is_vietnamese(parsed_brief.output_language)
    phase_runtimes: Dict[str, AgentRuntimeMetadata] = {
        "brief": rule_runtime_metadata(),
        "dataset_fit": rule_runtime_metadata(),
        "profiling": rule_runtime_metadata(),
        "quality_gate": rule_runtime_metadata(),
        "analysis_plan": rule_runtime_metadata(),
        "review": rule_runtime_metadata(),
    }
    yield _plan_event(
        "phase",
        "parse_brief",
        "Đang diễn giải brief nghiệp vụ, nhóm người đọc và kỳ vọng đầu ra."
        if vi
        else "Interpreting the business brief, audience, and reporting expectations.",
    )

    yield _plan_event(
        "phase",
        "collect_context",
        "Đang kiểm tra các bảng đã chọn trong workspace và dữ liệu mẫu."
        if vi
        else "Inspecting the selected workspace tables and sample data.",
    )
    contexts = await load_table_contexts(brief, token)

    yield _plan_event(
        "phase",
        "profile_tables",
        "Đang profile metric, trường thời gian, phân khúc và ý nghĩa nghiệp vụ có khả năng cao."
        if vi
        else "Profiling metrics, time fields, segments, and likely business meaning.",
    )
    profiles = [profile_table(brief, context) for context in contexts]
    profiling_report = build_profiling_report(profiles, parsed_brief.output_language)

    yield _plan_event(
        "phase",
        "dataset_fit",
        "Đang chấm mức độ phù hợp của từng bảng với câu hỏi báo cáo và mục tiêu KPI."
        if vi
        else "Scoring how each selected table fits the report questions and KPI goals.",
    )
    dataset_fit_report = build_dataset_fit_report(parsed_brief, profiles)

    yield _plan_event(
        "phase",
        "quality_gate",
        "Đang kiểm tra độ phủ dữ liệu, freshness và tín hiệu rủi ro trước khi dựng bản nháp."
        if vi
        else "Checking data coverage, freshness, and risk signals before drafting the report.",
    )
    quality_gate_report = evaluate_quality_gate(
        profiling_report,
        parsed_brief.known_data_issues,
        parsed_brief.output_language,
    )

    yield _plan_event(
        "phase",
        "analysis_plan",
        "Đang xây logic phân tích kiểu DA để ánh xạ câu hỏi sang phương pháp và bằng chứng."
        if vi
        else "Building a DA-style analysis logic that maps questions to methods and evidence.",
    )
    analysis_plan = build_analysis_plan(parsed_brief, dataset_fit_report, profiling_report, quality_gate_report)

    yield _plan_event(
        "phase",
        "report_strategy",
        "Đang dựng chiến lược dashboard từ brief nghiệp vụ."
        if vi
        else "Building a dashboard strategy from the business brief.",
    )
    strategy = (
        await _generate_strategy_with_llm(
            brief,
            profiles,
            parsed_brief,
            dataset_fit_report,
            profiling_report,
            quality_gate_report,
            analysis_plan,
        )
        if brief.planning_mode == "deep"
        else None
    )
    phase_runtimes["planning"] = (
        llm_runtime_metadata("planning")
        if strategy is not None
        else rule_runtime_metadata()
    )
    if strategy is None:
        yield _plan_event(
            "phase",
            "report_strategy",
            "Không có chiến lược từ LLM, nên Agent sẽ dùng planner fallback có hướng dẫn."
            if vi
            else "No LLM strategy was available, so the Agent is using the guided fallback planner.",
        )
        strategy = _build_heuristic_strategy(brief, profiles, parsed_brief, dataset_fit_report, analysis_plan)

    yield _plan_event(
        "phase",
        "chart_candidates",
        "Đang chuyển chiến lược thành các chart candidate cụ thể."
        if vi
        else "Translating the strategy into concrete chart candidates.",
    )
    plan = _materialize_strategy(
        brief,
        strategy,
        profiles,
        parsed_brief,
        dataset_fit_report,
        profiling_report,
        quality_gate_report,
        analysis_plan,
        phase_runtimes,
    )

    yield _plan_event(
        "phase",
        "plan_review",
        "Đang review bản nháp theo độ phủ câu hỏi, độ đa dạng chart, cân bằng báo cáo và rủi ro chất lượng dữ liệu."
        if vi
        else "Reviewing the draft for question coverage, chart diversity, report balance, and data quality risk.",
    )
    plan = _review_plan_quality(plan, brief, quality_gate_report)

    yield _plan_event("done", "done", "Bản nháp đã sẵn sàng để review." if vi else "Draft ready for review.", plan=plan)
