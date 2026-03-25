from __future__ import annotations

from typing import Any

from app.schemas.agent import DatasetFitArtifactItem, ParsedBriefArtifact
from app.services.output_language import is_vietnamese


def _fit_score(parsed_brief: ParsedBriefArtifact, profile: Any) -> float:
    score = 0.35
    if profile.primary_metric:
        score += 0.15
    if profile.primary_time:
        score += 0.1
    if profile.primary_dimension:
        score += 0.1
    if profile.question_matches:
        score += min(0.15, 0.05 * len(profile.question_matches))
    if any(term.lower() in profile.business_summary.lower() for term in parsed_brief.risk_focus):
        score += 0.1
    if profile.date_columns:
        score += 0.05
    return round(min(score, 0.98), 2)


def build_dataset_fit_report(parsed_brief: ParsedBriefArtifact, profiles: list[Any]) -> list[DatasetFitArtifactItem]:
    vi = is_vietnamese(parsed_brief.output_language)
    items: list[DatasetFitArtifactItem] = []
    for profile in profiles:
        role = "supporting_detail_table"
        if profile.primary_metric and profile.primary_time:
            role = "core_monitoring_table"
        elif profile.primary_dimension and not profile.primary_metric:
            role = "breakdown_table"
        elif profile.primary_dimension:
            role = "driver_analysis_table"

        good_for: list[str] = []
        weak_for: list[str] = []
        coverage_notes: list[str] = []

        if profile.primary_time:
            good_for.append("theo dõi xu hướng" if vi else "trend monitoring")
        else:
            weak_for.append("phân tích chuỗi thời gian" if vi else "time-series analysis")

        if profile.primary_dimension:
            good_for.append("phân khúc và phân rã" if vi else "segmentation and breakdowns")
        else:
            weak_for.append("so sánh theo phân khúc" if vi else "segment-level comparisons")

        if profile.metric_candidates:
            good_for.append("theo dõi KPI chính" if vi else "headline KPI tracking")
        else:
            weak_for.append("phân tích tổng/trung bình theo metric" if vi else "sum/average metric analysis")
            coverage_notes.append(
                "Bảng này phù hợp hơn với phân tích đếm bản ghi hoặc tồn kê kiểu inventory."
                if vi
                else "This table is better suited to count-based or inventory-style analysis."
            )

        if profile.question_matches:
            coverage_notes.append(
                f"Khớp với các câu hỏi nêu trong brief: {', '.join(profile.question_matches[:2])}."
                if vi
                else f"Matches explicit brief questions: {', '.join(profile.question_matches[:2])}."
            )
        if profile.business_summary:
            coverage_notes.append(profile.business_summary)

        metadata_risk = "low"
        if not profile.primary_dimension or not profile.context.table_description.get("auto_description"):
            metadata_risk = "medium"
        if not profile.metric_candidates and not profile.date_columns:
            metadata_risk = "high"

        items.append(
            DatasetFitArtifactItem(
                workspace_id=profile.context.workspace_id,
                workspace_name=profile.context.workspace_name,
                table_id=profile.context.table_id,
                table_name=profile.context.table_name,
                fit_score=_fit_score(parsed_brief, profile),
                suggested_role=role,
                good_for=good_for[:4],
                weak_for=weak_for[:4],
                metadata_risk=metadata_risk,
                coverage_notes=coverage_notes[:4],
                notes=(
                    (
                        f"Ưu tiên dùng {profile.context.table_name} cho "
                        f"{good_for[0] if good_for else 'phân tích chi tiết hỗ trợ'}."
                    )
                    if vi
                    else (
                        f"Use {profile.context.table_name} primarily for "
                        f"{good_for[0] if good_for else 'supporting detail work'}."
                    )
                ),
            )
        )

    return sorted(items, key=lambda item: item.fit_score, reverse=True)
