from __future__ import annotations

from app.schemas.agent import AgentBriefRequest, ParsedBriefArtifact
from app.services.output_language import infer_output_language, is_vietnamese


def parse_brief(brief: AgentBriefRequest) -> ParsedBriefArtifact:
    output_language = infer_output_language(
        brief.output_language,
        [
            brief.goal,
            brief.audience,
            brief.timeframe,
            brief.why_now,
            brief.business_background,
            brief.decision_context,
            brief.notes,
            " ".join(brief.kpis),
            " ".join(brief.questions),
            " ".join(brief.must_include_sections),
            " ".join(brief.alert_focus),
        ],
    )
    vi = is_vietnamese(output_language)
    primary_kpis = brief.kpis[:3]
    secondary_kpis = brief.kpis[3:]

    explicit_assumptions: list[str] = []
    clarification_gaps: list[str] = []
    success_criteria: list[str] = []

    if not brief.audience:
        explicit_assumptions.append(
            "Giả định báo cáo phục vụ nhóm người đọc nghiệp vụ tổng quát."
            if vi
            else "Assume the dashboard should work for a general business audience."
        )
    if not brief.decision_context:
        clarification_gaps.append(
            "Bối cảnh ra quyết định chưa được nêu rõ, nên Agent sẽ ưu tiên insight giám sát tổng quan."
            if vi
            else "Decision context is not explicit, so the Agent will prioritize broad monitoring insights."
        )
    if not brief.timeframe:
        explicit_assumptions.append(
            "Sử dụng lát cắt dữ liệu mới nhất hiện có vì brief chưa chỉ ra mốc thời gian cụ thể."
            if vi
            else "Use the latest available data snapshot because no timeframe was specified."
        )
    if not brief.kpis:
        clarification_gaps.append(
            "Chưa có danh sách KPI rõ ràng, nên Agent sẽ tự suy luận các chỉ số chính từ những bảng đã chọn."
            if vi
            else "No KPI list was provided, so the Agent will infer headline metrics from the selected tables."
        )
    if not brief.questions:
        clarification_gaps.append(
            "Chưa có câu hỏi nghiệp vụ cụ thể, nên Agent sẽ ưu tiên hướng giám sát tổng quan và phát hiện bất thường."
            if vi
            else "No explicit business questions were provided, so the Agent will focus on broad monitoring and anomaly prompts."
        )
    if not brief.report_style:
        explicit_assumptions.append(
            "Mặc định dùng cấu trúc báo cáo theo kiểu điều hành."
            if vi
            else "Default to an executive-style report structure."
        )
    if not brief.preferred_dashboard_structure:
        explicit_assumptions.append(
            "Mặc định ưu tiên cấu trúc tóm tắt trước, chi tiết sau nếu brief không yêu cầu thứ tự đọc khác."
            if vi
            else "Use a summary-first dashboard structure unless the brief implies another reading order."
        )

    if primary_kpis:
        success_criteria.append(
            f"Làm rõ các KPI chính: {', '.join(primary_kpis[:3])}."
            if vi
            else f"Clearly cover the primary KPIs: {', '.join(primary_kpis[:3])}."
        )
    if brief.questions:
        success_criteria.append(
            f"Trả lời các câu hỏi nghiệp vụ trọng tâm: {', '.join(brief.questions[:3])}."
            if vi
            else f"Answer the top business questions: {', '.join(brief.questions[:3])}."
        )
    if brief.include_data_quality_notes:
        success_criteria.append(
            "Nêu rõ các lưu ý về chất lượng dữ liệu đi cùng mỗi phát hiện quan trọng."
            if vi
            else "Call out data quality caveats alongside any major finding."
        )
    if brief.include_action_items:
        success_criteria.append(
            "Kết thúc mỗi phần lớn bằng hành động tiếp theo thực tế khi dữ liệu đủ bằng chứng."
            if vi
            else "End each major section with practical follow-up actions where evidence supports them."
        )

    return ParsedBriefArtifact(
        output_language=output_language,
        business_goal=brief.goal,
        target_audience=brief.audience,
        decision_context=brief.decision_context,
        report_style=brief.report_style,
        insight_depth=brief.insight_depth,
        recommendation_style=brief.recommendation_style,
        primary_kpis=primary_kpis,
        secondary_kpis=secondary_kpis,
        must_answer_questions=brief.questions,
        required_sections=brief.must_include_sections,
        risk_focus=brief.alert_focus,
        important_dimensions=brief.important_dimensions,
        columns_to_avoid=brief.columns_to_avoid,
        glossary_terms=brief.business_glossary,
        known_data_issues=brief.known_data_issues,
        table_role_hints=brief.table_roles_hint,
        narrative_preferences={
            "preferred_dashboard_structure": brief.preferred_dashboard_structure,
            "include_text_narrative": brief.include_text_narrative,
            "include_action_items": brief.include_action_items,
            "include_data_quality_notes": brief.include_data_quality_notes,
            "confidence_preference": brief.confidence_preference,
            "why_now": brief.why_now,
            "business_background": brief.business_background,
        },
        explicit_assumptions=explicit_assumptions,
        clarification_gaps=clarification_gaps,
        success_criteria=success_criteria,
    )
