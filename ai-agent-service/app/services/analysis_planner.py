from __future__ import annotations

from typing import Any

from app.schemas.agent import (
    AnalysisPlanArtifact,
    AnalysisQuestionMap,
    DatasetFitArtifactItem,
    ParsedBriefArtifact,
    ProfilingArtifactItem,
    QualityGateArtifact,
)
from app.services.output_language import is_vietnamese


def build_analysis_plan(
    parsed_brief: ParsedBriefArtifact,
    dataset_fit_report: list[DatasetFitArtifactItem],
    profiling_report: list[ProfilingArtifactItem],
    quality_gate_report: QualityGateArtifact,
) -> AnalysisPlanArtifact:
    vi = is_vietnamese(parsed_brief.output_language)
    fit_map = {item.table_id: item for item in dataset_fit_report}
    profile_map = {item.table_id: item for item in profiling_report}
    ranked_fit = sorted(dataset_fit_report, key=lambda item: item.fit_score, reverse=True)

    question_map: list[AnalysisQuestionMap] = []
    for question in parsed_brief.must_answer_questions:
        target = ranked_fit[0] if ranked_fit else None
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

    hypotheses = [
        (
            "Những khu vực rủi ro cao nhất thường đồng thời có dấu hiệu không hoạt động và thiếu metadata stewardship."
            if vi
            else "The highest-risk areas will combine inactivity with weak stewardship metadata."
        ),
        (
            "Những phần hữu ích nhất của dashboard nên tách rõ giám sát tổng quan với chi tiết phục vụ follow-up vận hành."
            if vi
            else "The most useful dashboard sections will separate summary monitoring from operational follow-up detail."
        ),
    ]
    if quality_gate_report.warnings:
        hypotheses.append(
            "Vấn đề chất lượng dữ liệu có thể làm giảm độ tin cậy của các kết luận chi tiết, nên narrative từng phần cần có caveat."
            if vi
            else "Data quality issues may reduce confidence in granular findings, so section narratives should include caveats."
        )

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

    analysis_objectives = [
        "Chuyển brief thành một nhóm nhỏ câu hỏi nghiệp vụ quan trọng nhất." if vi else "Translate the brief into a small set of business-critical questions.",
        "Ánh xạ từng câu hỏi vào bảng phù hợp nhất và phương pháp phân tích mạnh nhất." if vi else "Map each question to the strongest available table and analysis method.",
        "Cân bằng giữa góc nhìn điều hành tổng quan và đủ chi tiết để follow-up hành động." if vi else "Balance executive monitoring with enough detail for follow-up action.",
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
    narrative_flow = [
        "Bắt đầu từ tín hiệu nghiệp vụ tổng quan quan trọng nhất." if vi else "Start with the top-line business signal.",
        "Đi tiếp vào các bảng phù hợp nhất để phân rã và tìm nguyên nhân." if vi else "Move into the highest-fit supporting tables for breakdown and root-cause analysis.",
        "Kết thúc bằng stewardship, caveat và hành động đề xuất." if vi else "Close with stewardship, caveats, and recommended actions.",
    ]

    return AnalysisPlanArtifact(
        business_thesis=(
            parsed_brief.business_goal
            if parsed_brief.business_goal
            else (
                "Xây dựng báo cáo giám sát giúp người đọc nắm tín hiệu nhanh và hành động trên các điểm rủi ro lớn nhất."
                if vi
                else "Build a monitoring report that helps the audience orient quickly and act on the riskiest signals."
            )
        ),
        analysis_objectives=analysis_objectives,
        question_map=question_map,
        hypotheses=hypotheses,
        priority_checks=priority_checks,
        fallback_checks=fallback_checks,
        section_logic=section_logic,
        narrative_flow=narrative_flow,
    )
