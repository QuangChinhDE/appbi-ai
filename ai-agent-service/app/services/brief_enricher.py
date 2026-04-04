"""LLM-powered brief enrichment — turns a 6-field brief into senior-DA-level analysis context.

This is the first LLM call in the planning pipeline.  It receives the raw
brief plus table descriptions / column metadata and returns an enriched
ParsedBriefArtifact with inferred KPIs, domain-specific questions,
table relationships and a narrative arc.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from app.config import settings
from app.domains.core.base import DomainPack
from app.schemas.agent import AgentBriefRequest, AgentPlanResponse, ParsedBriefArtifact, ThesisArtifact
from app.services.llm_client import generate_json
from app.services.output_language import infer_output_language, is_vietnamese

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def derive_thesis(parsed_brief: ParsedBriefArtifact) -> ThesisArtifact:
    """Derive a ThesisArtifact from an enriched ParsedBriefArtifact.

    Rule-based — no additional LLM call.  Must be called after enrich_brief so
    that business_domain, narrative_arc, primary_kpis, and must_answer_questions
    are populated.  Works on a non-enriched brief too, producing a weaker thesis.
    """
    vi = is_vietnamese(parsed_brief.output_language)
    domain_tag = f" [{parsed_brief.business_domain}]" if parsed_brief.business_domain else ""

    # decision_context was enriched by LLM-1 as "expanded decision context based on
    # domain understanding" — it's substantively richer than the raw business_goal.
    # Use it as the thesis body when it adds meaningful content (>10 chars more than goal).
    # Fallback to raw goal + domain when enrichment did not produce a richer context.
    if (
        parsed_brief.decision_context
        and len(parsed_brief.decision_context) > len(parsed_brief.business_goal) + 10
    ):
        central_thesis = parsed_brief.decision_context.rstrip(".") + domain_tag + "."
    else:
        central_thesis = parsed_brief.business_goal.rstrip(".") + domain_tag + "."

    arguments: List[str] = []

    # Ordered analytical questions are the strongest supporting arguments
    for question in parsed_brief.must_answer_questions[:4]:
        arguments.append(question)

    # Fill remaining slots with primary KPIs (labelled so they read as arguments)
    for kpi in parsed_brief.primary_kpis:
        if len(arguments) >= 5:
            break
        label = f"KPI chính cần theo dõi: {kpi}" if vi else f"Primary KPI to track: {kpi}"
        if label not in arguments:
            arguments.append(label)

    # Cross-table relationship as a final argument if room remains
    if parsed_brief.table_relationships and len(arguments) < 5:
        rel = parsed_brief.table_relationships[0]
        arguments.append(
            f"Khai thác mối quan hệ dữ liệu: {rel}" if vi else f"Leverage data relationship: {rel}"
        )

    return ThesisArtifact(
        central_thesis=central_thesis,
        supporting_arguments=arguments[:5],
        narrative_arc=parsed_brief.narrative_arc or "",
    )


def _clean_string_list(values: List[Any], limit: int = 5) -> List[str]:
    cleaned: List[str] = []
    for value in values:
        text = str(value).strip()
        if text:
            cleaned.append(text)
        if len(cleaned) >= limit:
            break
    return cleaned


def rehydrate_plan_thesis(plan: AgentPlanResponse) -> Optional[ThesisArtifact]:
    """Recover a thesis from the richest plan artifact that is still available."""
    if plan.thesis and plan.thesis.central_thesis.strip():
        return plan.thesis

    if plan.parsed_brief is not None:
        return derive_thesis(plan.parsed_brief)

    if plan.analysis_plan and plan.analysis_plan.business_thesis.strip():
        narrative_flow = _clean_string_list(plan.analysis_plan.narrative_flow, limit=3)
        supporting_arguments = _clean_string_list(plan.analysis_plan.hypotheses, limit=5)
        return ThesisArtifact(
            central_thesis=plan.analysis_plan.business_thesis.strip(),
            supporting_arguments=supporting_arguments,
            narrative_arc=narrative_flow[0] if narrative_flow else "",
        )

    if plan.strategy_summary and plan.strategy_summary.strip():
        return ThesisArtifact(
            central_thesis=plan.strategy_summary.strip(),
            supporting_arguments=[],
            narrative_arc="",
        )

    return None


def ensure_plan_thesis(plan: AgentPlanResponse) -> AgentPlanResponse:
    """Guarantee that a build-time plan carries a thesis, backfilling older saved plans."""
    thesis = rehydrate_plan_thesis(plan)
    if thesis is None or not thesis.central_thesis.strip():
        raise ValueError("Agent plan is missing thesis context. Regenerate the report plan before building.")

    updates: Dict[str, Any] = {}
    if plan.thesis is None or not plan.thesis.central_thesis.strip():
        updates["thesis"] = thesis
    if not (plan.strategy_summary or "").strip():
        updates["strategy_summary"] = thesis.central_thesis

    return plan.model_copy(update=updates) if updates else plan


async def enrich_brief(
    brief: AgentBriefRequest,
    baseline: ParsedBriefArtifact,
    table_descriptions: List[Dict[str, Any]],
    domain_pack: DomainPack,
) -> ParsedBriefArtifact:
    """Call the LLM to enrich *baseline* with domain-aware KPIs, questions, etc.

    *table_descriptions* is a list of dicts, each with at least:
        dataset_id, table_id, table_name, auto_description,
        column_descriptions, common_questions, columns.

    If the LLM call fails the original *baseline* is returned unchanged.
    """
    vi = is_vietnamese(baseline.output_language)
    domain_context = domain_pack.enrichment_context(brief, baseline, table_descriptions, vi) if domain_pack.enrichment_context else {}
    system_prompt = _build_system_prompt(vi, domain_context.get("system_appendix"))
    user_prompt = _build_user_prompt(brief, baseline, table_descriptions, vi, domain_context.get("user_context"))

    result = await generate_json(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model_override=settings.model_for_phase("enrichment"),
        phase="enrichment",
    )

    if result is None:
        logger.warning("Brief enrichment LLM call returned None — using baseline brief")
        return baseline

    enriched = _merge_enrichment(baseline, result, vi)
    if domain_pack.prepare_brief:
        enriched = domain_pack.prepare_brief(brief, enriched)
    return enriched


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

def _build_system_prompt(vi: bool, domain_appendix: Optional[str] = None) -> str:
    if vi:
        prompt = (
            "Bạn là một senior Data Analyst với hơn 10 năm kinh nghiệm trong ngành BI. "
            "Khi nhận một brief kinh doanh ngắn cùng mô tả các bảng dữ liệu, bạn luôn thực hiện "
            "6 bước tư duy sau TRƯỚC KHI đề xuất bất kỳ điều gì:\n\n"
            "1. NHẬN DIỆN DOMAIN: Từ tên bảng, tên cột, mô tả → xác định đây là ngành gì "
            "(e-commerce, finance, HR, logistics, manufacturing, healthcare…).\n"
            "2. SUY LUẬN KPI: Với goal + domain, KPI nào là primary (xuất hiện trang đầu), "
            "KPI nào là secondary (đi sâu hơn)? Chỉ dùng cột thực tế trong bảng.\n"
            "3. TẠO CÂU HỎI CỤ THỂ: Viết 4-6 câu hỏi phân tích mà MỘT NGƯỜI HIỂU NGÀNH sẽ hỏi. "
            "Không viết câu generic kiểu 'cái gì thay đổi?'. Mỗi câu hỏi phải liên quan trực tiếp "
            "đến goal và dữ liệu có sẵn.\n"
            "4. PHÁT HIỆN QUAN HỆ BẢNG: Nếu có >1 bảng, xem cột nào có thể join/liên kết "
            "→ gợi ý phân tích kết hợp. Viết dưới dạng 'tableA.colX → tableB.colY: ý nghĩa phân tích'.\n"
            "5. PHÁC THẢO CÂU CHUYỆN (narrative arc): Report kể câu chuyện gì từ đầu đến cuối? "
            "Mở bằng gì? Đỉnh điểm ở đâu? Kết bằng action gì?\n"
            "6. CẢNH BÁO: Dựa trên mô tả cột và dữ liệu, có risk nào về data cần nêu?\n\n"
            "Trả về JSON hợp lệ duy nhất. Mọi text phải bằng tiếng Việt."
        )
        if domain_appendix:
            prompt += "\n\n" + domain_appendix
        return prompt
    prompt = (
        "You are a senior Data Analyst with over 10 years of experience in BI. "
        "When you receive a short business brief together with table descriptions, you always perform "
        "6 thinking steps BEFORE proposing anything:\n\n"
        "1. IDENTIFY DOMAIN: From table names, column names, descriptions → determine the industry "
        "(e-commerce, finance, HR, logistics, manufacturing, healthcare…).\n"
        "2. INFER KPIs: Given the goal + domain, which KPIs are primary (front page) and "
        "which are secondary (drill-down)? Only use columns that actually exist.\n"
        "3. CREATE SPECIFIC QUESTIONS: Write 4-6 analytical questions a DOMAIN EXPERT would ask. "
        "No generic questions like 'what changed?'. Each question must directly relate to the goal "
        "and available data.\n"
        "4. DETECT TABLE RELATIONSHIPS: If >1 table, find columns that can join/link "
        "→ suggest combined analysis. Format: 'tableA.colX → tableB.colY: analytical meaning'.\n"
        "5. SKETCH NARRATIVE ARC: What story does this report tell from start to finish? "
        "What is the opening? Where is the climax? What action closes it?\n"
        "6. FLAG RISKS: Based on column descriptions and data, are there data risks to flag?\n\n"
        "Return valid JSON only."
    )
    if domain_appendix:
        prompt += "\n\n" + domain_appendix
    return prompt


def _build_user_prompt(
    brief: AgentBriefRequest,
    baseline: ParsedBriefArtifact,
    table_descriptions: List[Dict[str, Any]],
    vi: bool,
    domain_context: Optional[Dict[str, Any]] = None,
) -> str:
    tables_payload = []
    for td in table_descriptions:
        entry: Dict[str, Any] = {
            "table_id": td.get("table_id"),
            "table_name": td.get("table_name"),
            "auto_description": td.get("auto_description") or "",
            "common_questions": (td.get("common_questions") or [])[:6],
        }
        col_descs = td.get("column_descriptions") or {}
        columns = td.get("columns") or []
        entry["columns"] = [
            {
                "name": c.get("name", ""),
                "type": c.get("type", "string"),
                "description": col_descs.get(c.get("name", ""), ""),
            }
            for c in columns[:30]
        ]
        tables_payload.append(entry)

    payload = {
        "brief": {
            "domain_id": brief.domain_id,
            "goal": brief.goal,
            "audience": brief.audience,
            "timeframe": brief.timeframe,
            "comparison_period": brief.comparison_period,
            "detail_level": brief.detail_level,
            "notes": brief.notes,
        },
        "tables": tables_payload,
        "selected_domain_context": domain_context or {},
        "output_contract": {
            "business_domain": "string — identified industry/domain",
            "primary_kpis": ["string — max 4, using actual column names where possible"],
            "secondary_kpis": ["string — max 4"],
            "must_answer_questions": ["string — 4-6 domain-specific analytical questions"],
            "important_dimensions": ["string — key dimension columns for breakdowns"],
            "table_relationships": [
                "string — format: 'tableA.col → tableB.col: analytical meaning'"
            ],
            "narrative_arc": "string — the story arc from opening to closing action",
            "risk_focus": ["string — data risks or caveats"],
            "decision_context": "string — expanded decision context based on domain understanding",
        },
    }
    return json.dumps(payload, ensure_ascii=False, default=str)


# ---------------------------------------------------------------------------
# Merge LLM output back into the baseline ParsedBriefArtifact
# ---------------------------------------------------------------------------

def _safe_str_list(value: Any, limit: int = 8) -> List[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()][:limit]
    return []


def _merge_enrichment(
    baseline: ParsedBriefArtifact,
    llm_output: Dict[str, Any],
    vi: bool,
) -> ParsedBriefArtifact:
    """Overlay LLM enrichment onto the rule-based baseline without losing any existing data."""
    updates: Dict[str, Any] = {}

    # Business domain
    domain = (llm_output.get("business_domain") or "").strip()
    if domain:
        updates["business_domain"] = domain

    # KPIs — LLM output overwrites the empty baseline lists
    primary = _safe_str_list(llm_output.get("primary_kpis"), 4)
    if primary:
        updates["primary_kpis"] = primary
    secondary = _safe_str_list(llm_output.get("secondary_kpis"), 4)
    if secondary:
        updates["secondary_kpis"] = secondary

    # Questions — replace generic ones with domain-specific
    questions = _safe_str_list(llm_output.get("must_answer_questions"), 6)
    if questions:
        updates["must_answer_questions"] = questions

    # Dimensions
    dims = _safe_str_list(llm_output.get("important_dimensions"), 8)
    if dims:
        updates["important_dimensions"] = dims

    # Table relationships
    rels = _safe_str_list(llm_output.get("table_relationships"), 6)
    if rels:
        updates["table_relationships"] = rels

    # Narrative arc
    arc = (llm_output.get("narrative_arc") or "").strip()
    if arc:
        updates["narrative_arc"] = arc

    # Risk focus
    risks = _safe_str_list(llm_output.get("risk_focus"), 6)
    if risks:
        updates["risk_focus"] = risks

    # Decision context — keep original if LLM returns empty
    decision = (llm_output.get("decision_context") or "").strip()
    if decision:
        updates["decision_context"] = decision

    if not updates:
        return baseline

    return baseline.model_copy(update=updates)
