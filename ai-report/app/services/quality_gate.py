from __future__ import annotations

from typing import Iterable

from app.schemas.agent import ProfilingArtifactItem, QualityGateArtifact
from app.services.output_language import is_vietnamese


def evaluate_quality_gate(
    profiling_report: Iterable[ProfilingArtifactItem],
    known_data_issues: list[str],
    language: str | None = None,
) -> QualityGateArtifact:
    vi = is_vietnamese(language)
    blockers: list[str] = []
    warnings: list[str] = []
    acceptable_risks: list[str] = []
    recommended_adjustments: list[str] = []
    fields_with_issues: list[str] = []
    confidence_penalties: dict[str, float] = {}

    for item in profiling_report:
        if item.row_sample_count == 0:
            blockers.append(
                f"{item.table_name} không trả về dòng mẫu nào, nên Agent không thể dựng báo cáo đáng tin từ bảng này."
                if vi
                else f"{item.table_name} returned no sampled rows, so the Agent cannot build a reliable report from it."
            )
            confidence_penalties[str(item.table_id)] = 0.5
        if item.null_risk_columns:
            warnings.append(
                (
                    f"{item.table_name} có các trường null cao: {', '.join(item.null_risk_columns[:3])}."
                    if vi
                    else f"{item.table_name} has high-null fields: {', '.join(item.null_risk_columns[:3])}."
                )
            )
            fields_with_issues.extend(item.null_risk_columns[:3])
            confidence_penalties[str(item.table_id)] = max(confidence_penalties.get(str(item.table_id), 0.0), 0.12)
        if not item.candidate_time_fields:
            acceptable_risks.append(
                f"{item.table_name} không có trường thời gian rõ ràng, nên phân tích xu hướng có thể còn nông."
                if vi
                else f"{item.table_name} has no clear time field, so trend analysis may be shallow."
            )
        if not item.candidate_metrics:
            acceptable_risks.append(
                f"{item.table_name} không có metric số rõ ràng, nên góc nhìn đếm bản ghi có thể chiếm ưu thế."
                if vi
                else f"{item.table_name} has no clear numeric metric, so count-based views may dominate."
            )
        if item.freshness_summary is None:
            warnings.append(
                f"{item.table_name} chưa cho thấy trường freshness đủ rõ để parse từ dữ liệu mẫu."
                if vi
                else f"{item.table_name} does not expose a clearly parseable freshness field in the sample."
            )
            confidence_penalties[str(item.table_id)] = max(confidence_penalties.get(str(item.table_id), 0.0), 0.08)

    for issue in known_data_issues:
        warnings.append(f"Người dùng đã lưu ý vấn đề dữ liệu: {issue}" if vi else f"User-noted data issue: {issue}")

    if blockers:
        recommended_adjustments.append(
            "Hãy loại bỏ hoặc thay thế các bảng bị chặn trước khi dùng báo cáo cho quyết định vận hành."
            if vi
            else "Remove or replace blocked datasets before relying on the report for operational decisions."
        )
    if warnings:
        recommended_adjustments.append(
            "Giữ các caveat hiển thị rõ trong narrative cuối và giảm confidence ở các phần bị ảnh hưởng."
            if vi
            else "Keep visible caveats in the final narrative and lower confidence on affected sections."
        )
    if acceptable_risks:
        recommended_adjustments.append(
            "Ưu tiên insight giám sát hoặc tồn kê thay vì dự báo chính xác trên các bảng còn rủi ro."
            if vi
            else "Prefer monitoring or inventory-style insights over precise forecasting for risky tables."
        )

    if blockers:
        overall_status = "blocker"
    elif warnings:
        overall_status = "warning"
    else:
        overall_status = "pass"

    quality_summary = (
        "Agent đã kiểm tra độ đầy đủ mẫu, freshness, khả năng dùng metric và các vấn đề dữ liệu đã biết trước khi chọn hướng phân tích."
        if vi
        else
        "The Agent checked sample completeness, freshness, metric readiness, and known data issues "
        "before choosing analysis paths."
    )

    return QualityGateArtifact(
        overall_status=overall_status,
        blockers=blockers,
        warnings=warnings,
        acceptable_risks=acceptable_risks,
        confidence_penalties=confidence_penalties,
        recommended_adjustments=recommended_adjustments,
        fields_with_issues=sorted(set(fields_with_issues)),
        quality_summary=quality_summary,
    )
