from __future__ import annotations

from app.schemas.agent import AgentBriefRequest, ParsedBriefArtifact
from app.services.output_language import infer_output_language, is_vietnamese


AUDIENCE_LABELS = {
    'exec': {'vi': 'ban điều hành', 'en': 'executive leadership'},
    'manager': {'vi': 'quản lý vận hành', 'en': 'managers'},
    'analyst': {'vi': 'analyst', 'en': 'analysts'},
}

COMPARISON_LABELS = {
    'previous_period': {'vi': 'kỳ trước', 'en': 'the previous period'},
    'same_period': {'vi': 'cùng kỳ', 'en': 'the same period'},
    'none': {'vi': 'không ép so sánh cố định', 'en': 'no fixed comparison baseline'},
}

DETAIL_LABELS = {
    'overview': {'vi': 'tổng quan', 'en': 'overview'},
    'detailed': {'vi': 'chi tiết', 'en': 'detailed'},
}


def _label(value: str | None, mapping: dict[str, dict[str, str]], lang: str, fallback: str) -> str:
    if not value:
        return fallback
    return mapping.get(value, {}).get(lang, fallback)


def _infer_questions(brief: AgentBriefRequest, vi: bool) -> list[str]:
    timeframe = brief.timeframe or ('30 ngày gần nhất' if vi else 'the last 30 days')
    comparison = _label(
        brief.comparison_period,
        COMPARISON_LABELS,
        'vi' if vi else 'en',
        'một mốc tham chiếu phù hợp' if vi else 'a sensible baseline',
    )
    detail = brief.detail_level or 'overview'

    questions = [
        (
            f'Điều gì thay đổi nổi bật nhất trong {timeframe} khi nhìn so với {comparison}?'
            if vi
            else f'What changed most across {timeframe} compared with {comparison}?'
        ),
        (
            'Nhóm, phân khúc hoặc bảng nào đang dẫn dắt tín hiệu chính này?'
            if vi
            else 'Which segment, domain, or table is driving the main signal?'
        ),
    ]

    questions.append(
        (
            'Những caveat dữ liệu hoặc rủi ro nào cần xem trước khi hành động?'
            if vi
            else 'Which data caveats or risks should be reviewed before acting?'
        )
        if detail == 'detailed'
        else (
            'Điểm quyết định hoặc rủi ro nào nên được ưu tiên theo dõi tiếp?'
            if vi
            else 'Which decision point or risk should be prioritised next?'
        )
    )

    if brief.notes:
        questions.append(
            (
                'Lưu ý nào trong notes cần được phản ánh rõ trong narrative cuối?'
                if vi
                else 'Which note should be explicitly reflected in the final narrative?'
            )
        )

    return questions[:3]


def parse_brief(brief: AgentBriefRequest) -> ParsedBriefArtifact:
    output_language = infer_output_language(
        brief.output_language,
        [
            brief.goal,
            brief.audience,
            brief.timeframe,
            brief.comparison_period,
            brief.detail_level,
            brief.notes,
        ],
    )
    vi = is_vietnamese(output_language)
    audience_label = _label(
        brief.audience,
        AUDIENCE_LABELS,
        'vi' if vi else 'en',
        'người đọc mục tiêu' if vi else 'the target audience',
    )
    comparison_label = _label(
        brief.comparison_period,
        COMPARISON_LABELS,
        'vi' if vi else 'en',
        'không ép mốc so sánh cố định' if vi else 'no forced comparison baseline',
    )
    detail_label = _label(
        brief.detail_level,
        DETAIL_LABELS,
        'vi' if vi else 'en',
        'tổng quan' if vi else 'overview',
    )
    inferred_questions = _infer_questions(brief, vi)

    explicit_assumptions: list[str] = []
    clarification_gaps: list[str] = []
    success_criteria: list[str] = []

    if not brief.audience:
        explicit_assumptions.append(
            'Giả định report phục vụ một nhóm business cần nhìn nhanh tín hiệu quan trọng nhất.'
            if vi
            else 'Assume the report should work for a business reader who needs the key signal quickly.'
        )
    if not brief.timeframe:
        explicit_assumptions.append(
            'Mặc định đọc trên lát cắt dữ liệu gần nhất vì brief không chỉ rõ mốc thời gian.'
            if vi
            else 'Default to the latest data window because the brief does not specify a timeframe.'
        )
    if not brief.comparison_period:
        explicit_assumptions.append(
            'Agent có thể chọn mốc so sánh hợp lý nhất từ tín hiệu dữ liệu hiện có.'
            if vi
            else 'The Agent may choose the most sensible comparison baseline from the available data.'
        )
    if not brief.detail_level:
        explicit_assumptions.append(
            'Ưu tiên nhịp đọc summary-first trước, rồi mới đi sâu khi dữ liệu cho phép.'
            if vi
            else 'Prefer a summary-first readout before going deeper when the data supports it.'
        )

    success_criteria.append(
        (
            f'Làm rõ quyết định trọng tâm mà report này phải hỗ trợ: {brief.goal}.'
            if vi
            else f'Clarify the core decision this report needs to support: {brief.goal}.'
        )
    )
    success_criteria.append(
        (
            f'Giữ giọng giải thích phù hợp với audience là {audience_label}.'
            if vi
            else f'Keep the explanation style appropriate for {audience_label}.'
        )
    )
    success_criteria.append(
        (
            f'Ưu tiên mức đọc {detail_label} và framing so sánh theo {comparison_label}.'
            if vi
            else f'Prioritise a {detail_label} readout framed against {comparison_label}.'
        )
    )
    if brief.notes:
        success_criteria.append(
            'Phản ánh các lưu ý business hoặc dữ liệu trong narrative cuối mà không làm report trở nên lan man.'
            if vi
            else 'Reflect the business or data notes in the final narrative without making the report noisy.'
        )

    return ParsedBriefArtifact(
        output_language=output_language,
        business_goal=brief.goal,
        target_audience=audience_label,
        decision_context=brief.goal,
        report_style='executive' if brief.audience == 'exec' else ('operational' if brief.audience == 'manager' else 'analytical'),
        insight_depth='deep' if brief.detail_level == 'detailed' else 'balanced',
        recommendation_style='suggested_actions' if brief.audience in {'exec', 'manager'} else 'analytical_next_steps',
        primary_kpis=[],
        secondary_kpis=[],
        must_answer_questions=inferred_questions,
        required_sections=[],
        risk_focus=[],
        important_dimensions=[],
        columns_to_avoid=[],
        glossary_terms=[],
        known_data_issues=[],
        table_role_hints=[],
        narrative_preferences={
            'preferred_dashboard_structure': 'summary_then_drivers' if brief.detail_level == 'detailed' else 'summary_first',
            'include_text_narrative': True,
            'include_action_items': brief.audience in {'exec', 'manager'},
            'include_data_quality_notes': True,
            'confidence_preference': 'include_tentative_with_caveats',
            'timeframe': brief.timeframe,
            'comparison_period': brief.comparison_period,
            'detail_level': brief.detail_level,
            'notes': brief.notes,
        },
        explicit_assumptions=explicit_assumptions,
        clarification_gaps=clarification_gaps,
        success_criteria=success_criteria,
    )
