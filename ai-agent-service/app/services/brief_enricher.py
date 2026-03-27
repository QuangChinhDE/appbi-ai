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
from app.schemas.agent import AgentBriefRequest, ParsedBriefArtifact
from app.services.llm_client import generate_json
from app.services.output_language import infer_output_language, is_vietnamese

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def enrich_brief(
    brief: AgentBriefRequest,
    baseline: ParsedBriefArtifact,
    table_descriptions: List[Dict[str, Any]],
) -> ParsedBriefArtifact:
    """Call the LLM to enrich *baseline* with domain-aware KPIs, questions, etc.

    *table_descriptions* is a list of dicts, each with at least:
        workspace_id, table_id, table_name, auto_description,
        column_descriptions, common_questions, columns.

    If the LLM call fails the original *baseline* is returned unchanged.
    """
    vi = is_vietnamese(baseline.output_language)
    system_prompt = _build_system_prompt(vi)
    user_prompt = _build_user_prompt(brief, baseline, table_descriptions, vi)

    result = await generate_json(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model_override=settings.model_for_phase("enrichment"),
        phase="enrichment",
    )

    if result is None:
        logger.warning("Brief enrichment LLM call returned None — using baseline brief")
        return baseline

    return _merge_enrichment(baseline, result, vi)


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

def _build_system_prompt(vi: bool) -> str:
    if vi:
        return (
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
    return (
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


def _build_user_prompt(
    brief: AgentBriefRequest,
    baseline: ParsedBriefArtifact,
    table_descriptions: List[Dict[str, Any]],
    vi: bool,
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
            "goal": brief.goal,
            "audience": brief.audience,
            "timeframe": brief.timeframe,
            "comparison_period": brief.comparison_period,
            "detail_level": brief.detail_level,
            "notes": brief.notes,
        },
        "tables": tables_payload,
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
