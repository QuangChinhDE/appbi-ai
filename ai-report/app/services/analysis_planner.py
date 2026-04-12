from __future__ import annotations

from typing import Any

from app.schemas.agent import (
    AnalysisPlanArtifact,
    AnalysisQuestionMap,
    DatasetFitArtifactItem,
    ParsedBriefArtifact,
    ProfilingArtifactItem,
    QualityGateArtifact,
    ThesisArtifact,
)
from app.services.output_language import is_vietnamese


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _question_table_score(question: str, fit_item: DatasetFitArtifactItem, profile: ProfilingArtifactItem | None) -> float:
    """Score how well a table answers a given question (higher = better fit)."""
    score = fit_item.fit_score  # baseline from dataset selector

    q_lower = question.lower()

    # Boost if table's coverage_notes or good_for mention keywords in the question
    for text in fit_item.good_for + fit_item.coverage_notes:
        tokens = [t for t in text.lower().split() if len(t) > 3]
        if any(t in q_lower for t in tokens):
            score += 0.15
            break

    # Boost if table name appears in question
    if fit_item.table_name.lower().replace("_", " ") in q_lower:
        score += 0.2

    # Boost if question mentions time-related terms and table has time fields
    time_terms = {"xu hướng", "trend", "thời gian", "time", "tháng", "month", "quý", "quarter", "tuần", "week"}
    if profile and profile.candidate_time_fields and any(t in q_lower for t in time_terms):
        score += 0.15

    # Boost if question mentions segment/breakdown and table has dimensions
    segment_terms = {"phân khúc", "segment", "vùng", "region", "nhóm", "group", "breakdown", "phân rã", "category"}
    if profile and profile.candidate_dimensions and any(t in q_lower for t in segment_terms):
        score += 0.1

    # Boost if question mentions specific column names
    if profile:
        for col in (profile.candidate_metrics + profile.candidate_dimensions)[:10]:
            if col.lower().replace("_", " ") in q_lower:
                score += 0.25
                break

    return min(score, 1.5)


def _best_table_for_question(
    question: str,
    dataset_fit_report: list[DatasetFitArtifactItem],
    profile_map: dict[int, ProfilingArtifactItem],
) -> DatasetFitArtifactItem | None:
    """Find the single best table for a given question."""
    if not dataset_fit_report:
        return None
    scored = [
        (item, _question_table_score(question, item, profile_map.get(item.table_id)))
        for item in dataset_fit_report
    ]
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return scored[0][0]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_analysis_plan(
    parsed_brief: ParsedBriefArtifact,
    dataset_fit_report: list[DatasetFitArtifactItem],
    profiling_report: list[ProfilingArtifactItem],
    quality_gate_report: QualityGateArtifact,
    thesis: ThesisArtifact,
) -> AnalysisPlanArtifact:
    vi = is_vietnamese(parsed_brief.output_language)
    fit_map = {item.table_id: item for item in dataset_fit_report}
    profile_map = {item.table_id: item for item in profiling_report}
    ranked_fit = sorted(dataset_fit_report, key=lambda item: item.fit_score, reverse=True)

    # --- Question → Table mapping (now per-question, not all-to-top-1) ---
    question_map: list[AnalysisQuestionMap] = []
    for question in parsed_brief.must_answer_questions:
        target = _best_table_for_question(question, dataset_fit_report, profile_map)
        suggested_method = "giám sát tổng quan" if vi else "summary monitoring"
        target_metric = None
        target_dimension = None
        target_time_field = None
        expected_signal = "biến động hiệu suất tổng quan" if vi else "Broad performance shift"

        if target:
            profile = profile_map.get(target.table_id)
            if profile:
                if profile.candidate_time_fields and profile.candidate_metrics:
                    suggested_method = "phân tích xu hướng và mức đóng góp" if vi else "trend and contribution analysis"
                    target_metric = profile.candidate_metrics[0]
                    target_time_field = profile.candidate_time_fields[0]
                    target_dimension = profile.candidate_dimensions[0] if profile.candidate_dimensions else None
                    expected_signal = "biến động xu hướng và các phân khúc dẫn dắt" if vi else "Trend changes and segment drivers"
                elif profile.candidate_dimensions:
                    suggested_method = "xếp hạng phân khúc và phân tích thiếu hụt metadata" if vi else "segment ranking and metadata gap analysis"
                    target_metric = profile.candidate_metrics[0] if profile.candidate_metrics else None
                    target_dimension = profile.candidate_dimensions[0]
                    expected_signal = (
                        "những phân khúc tập trung rủi ro hoặc cơ hội mạnh nhất"
                        if vi
                        else "Segments with the strongest concentration of risk or opportunity"
                    )
                else:
                    suggested_method = "rà soát tồn kê và đếm bản ghi" if vi else "inventory and count-based review"
                    expected_signal = (
                        "phân bố và thay đổi số lượng trên tập inventory đã chọn"
                        if vi
                        else "Distribution and count changes across the selected inventory"
                    )

        question_map.append(
            AnalysisQuestionMap(
                question=question,
                target_table_id=target.table_id if target else None,
                target_table_name=target.table_name if target else None,
                suggested_method=suggested_method,
                target_metric=target_metric,
                target_dimension=target_dimension,
                target_time_field=target_time_field,
                expected_signal=expected_signal,
            )
        )

    # --- Hypotheses: thesis arguments are the primary hypotheses ---
    # thesis.supporting_arguments carry the ordered analytical questions/KPIs
    # derived from enrichment; they must stay ordered and separate from generic
    # operational notes so downstream LLMs can treat them as distinct claims.
    hypotheses: list[str] = list(thesis.supporting_arguments)
    if parsed_brief.business_domain and not any(parsed_brief.business_domain in h for h in hypotheses):
        hypotheses.append(
            f"Domain đã nhận diện: {parsed_brief.business_domain}. Phân tích nên dùng góc nhìn và KPI phù hợp ngành này."
            if vi
            else f"Identified domain: {parsed_brief.business_domain}. Analysis should use industry-appropriate perspectives and KPIs."
        )
    if quality_gate_report.warnings:
        hypotheses.append(
            "Vấn đề chất lượng dữ liệu có thể làm giảm độ tin cậy của các kết luận chi tiết, nên narrative từng phần cần có caveat."
            if vi
            else "Data quality issues may reduce confidence in granular findings, so section narratives should include caveats."
        )

    # --- Section logic ---
    section_logic = {
        item.table_name: (
            (
                f"Dùng {item.table_name} như một {item.suggested_role.replace('_', ' ')} để bao phủ "
                f"{', '.join(item.good_for[:2]) or 'phần chi tiết hỗ trợ'}."
            )
            if vi
            else (
                f"Use {item.table_name} as a {item.suggested_role.replace('_', ' ')} to cover "
                f"{', '.join(item.good_for[:2]) or 'supporting detail'}."
            )
        )
        for item in ranked_fit
    }

    # --- Analysis objectives: grounded in thesis arguments, not generic templates ---
    # Each supporting argument becomes a concrete analysis objective so that
    # section designers (LLM or heuristic) can map sections 1-to-1 to objectives.
    analysis_objectives: list[str] = []
    for i, arg in enumerate(thesis.supporting_arguments, start=1):
        analysis_objectives.append(
            f"Luận điểm {i}: {arg}" if vi else f"Argument {i}: {arg}"
        )
    if parsed_brief.table_relationships:
        for rel in parsed_brief.table_relationships[:2]:
            analysis_objectives.append(
                f"Khai thác mối quan hệ: {rel}" if vi else f"Leverage relationship: {rel}"
            )
    if not analysis_objectives:
        analysis_objectives = [
            "Chuyển brief thành một nhóm nhỏ câu hỏi nghiệp vụ quan trọng nhất." if vi else "Translate the brief into a small set of business-critical questions.",
            "Ánh xạ từng câu hỏi vào bảng phù hợp nhất và phương pháp phân tích mạnh nhất." if vi else "Map each question to the strongest available table and analysis method.",
        ]

    priority_checks = [
        "Xác nhận bảng nào phù hợp nhất để làm phần tóm tắt điều hành." if vi else "Confirm which selected table is strongest for the executive summary.",
        "Kiểm tra nơi nào caveat về chất lượng dữ liệu cần làm giảm confidence hoặc giới hạn lựa chọn chart." if vi else "Check where data-quality caveats should lower confidence or limit chart choice.",
        "Đảm bảo mỗi câu hỏi nghiệp vụ lớn đều có ít nhất một section trả lời." if vi else "Ensure each major business question is covered by at least one section.",
    ]
    fallback_checks = [
        "Dùng KPI dạng đếm bản ghi khi chưa có metric số đáng tin." if vi else "Use count-based KPIs when no trusted numeric metric exists.",
        "Ưu tiên bảng chi tiết khi giả định để dựng chart còn mong manh." if vi else "Prefer detail tables when chart assumptions would be fragile.",
        "Nếu rủi ro chất lượng dữ liệu cao, narrative phải nói rõ caveat." if vi else "If quality risks are high, keep the narrative explicit about caveats.",
    ]

    # --- Narrative flow: thesis.narrative_arc is the canonical first entry ---
    # The arc (open → climax → close) is the structural contract for all sections.
    # It must be the first item so downstream prompts can treat it as the lead.
    narrative_flow: list[str] = []
    if thesis.narrative_arc:
        narrative_flow.append(thesis.narrative_arc)
    narrative_flow.extend([
        "Bắt đầu từ tín hiệu nghiệp vụ tổng quan quan trọng nhất." if vi else "Start with the top-line business signal.",
        "Đi tiếp vào các bảng phù hợp nhất để phân rã và tìm nguyên nhân." if vi else "Move into the highest-fit supporting tables for breakdown and root-cause analysis.",
        "Kết thúc bằng stewardship, caveat và hành động đề xuất." if vi else "Close with stewardship, caveats, and recommended actions.",
    ])

    return AnalysisPlanArtifact(
        # thesis.central_thesis is the controlling thesis; it is richer than the
        # raw business_goal because it has been enriched with domain context.
        business_thesis=thesis.central_thesis,
        analysis_objectives=analysis_objectives,
        question_map=question_map,
        hypotheses=hypotheses,
        priority_checks=priority_checks,
        fallback_checks=fallback_checks,
        section_logic=section_logic,
        narrative_flow=narrative_flow,
    )
