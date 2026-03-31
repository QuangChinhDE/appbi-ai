from __future__ import annotations

from app.domains.core.base import DomainReviewResult
from app.schemas.agent import AgentBriefRequest, AgentPlanResponse, QualityGateArtifact


def _contains_any(text: str, tokens: list[str]) -> bool:
    lowered = text.lower()
    return any(token in lowered for token in tokens)


def review_finance_plan(
    plan: AgentPlanResponse,
    brief: AgentBriefRequest,
    quality_gate_report: QualityGateArtifact,
) -> DomainReviewResult:
    tokens = " ".join(
        [
            plan.dashboard_summary or "",
            plan.strategy_summary or "",
            " ".join(section.title for section in plan.sections),
            " ".join(section.intent for section in plan.sections),
            " ".join(plan.analysis_plan.hypotheses if plan.analysis_plan else []),
        ]
    )
    result = DomainReviewResult()

    finance_health_tokens = [
        "finance", "financial", "tài chính", "tai chinh",
        "profit", "lợi nhuận", "loi nhuan",
        "margin", "biên độ", "bien do",
        "cost", "chi phí", "chi phi",
        "cash", "dòng tiền", "dong tien",
        "variance", "phương sai", "phuong sai",
    ]
    if not _contains_any(tokens, finance_health_tokens):
        result.warnings.append(
            "Finance domain review: the plan still reads too generic and lacks a clear finance lens."
        )
        result.quality_breakdown["domain_lens"] = 0.3
        result.quality_score_delta -= 0.08
    else:
        result.quality_breakdown["domain_lens"] = 0.9

    has_time_signal = any(item.candidate_time_fields for item in plan.profiling_report)
    if has_time_signal and not _contains_any(tokens, [
        "variance", "phương sai", "trend", "xu hướng",
        "month", "tháng", "quarter", "quý", "year", "năm",
        "budget", "ngân sách",
    ]):
        result.warnings.append(
            "Finance domain review: comparable time signals exist but the plan lacks a clear variance or trend framing."
        )
        result.quality_breakdown["variance_framing"] = 0.35
        result.quality_score_delta -= 0.06
    elif has_time_signal:
        result.quality_breakdown["variance_framing"] = 0.9

    has_financial_metric = any(
        _contains_any(" ".join(item.candidate_metrics), ["revenue", "sales", "expense", "cost", "profit", "margin", "cash", "budget"])
        for item in plan.profiling_report
    )
    if has_financial_metric and not _contains_any(tokens, [
        "margin", "biên độ", "profit", "lợi nhuận", "cost", "chi phí", "expense", "chi tiêu",
    ]):
        result.warnings.append(
            "Finance domain review: finance metrics exist but the plan does not surface a cost or profitability lens."
        )
        result.quality_breakdown["profitability_lens"] = 0.4
        result.quality_score_delta -= 0.05
    elif has_financial_metric:
        result.quality_breakdown["profitability_lens"] = 0.88

    return result
