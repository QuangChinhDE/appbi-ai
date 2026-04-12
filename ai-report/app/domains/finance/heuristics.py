from __future__ import annotations

from typing import Any, Dict, Iterable, List

from app.domains.finance.config import METADATA
from app.domains.finance.glossary import FINANCE_GLOSSARY, FINANCE_PRIMARY_KPIS, FINANCE_SECTION_ARCHETYPES
from app.domains.finance.narrative import FINANCE_DOMAIN_LENS_EN, FINANCE_DOMAIN_LENS_VI
from app.domains.finance.prompts import (
    FINANCE_ENRICHMENT_PROMPT_EN,
    FINANCE_ENRICHMENT_PROMPT_VI,
    FINANCE_INSIGHT_PROMPT_EN,
    FINANCE_INSIGHT_PROMPT_VI,
    FINANCE_PLANNER_PROMPT_EN,
    FINANCE_PLANNER_PROMPT_VI,
)
from app.schemas.agent import AgentBriefRequest, ParsedBriefArtifact


def _find_column_matches(table_descriptions: List[Dict[str, Any]], keywords: Iterable[str]) -> List[str]:
    lowered_keywords = {keyword.lower() for keyword in keywords}
    matches: List[str] = []
    for table in table_descriptions:
        for column in table.get("columns") or []:
            column_name = str(column.get("name") or "").strip()
            if not column_name:
                continue
            lowered = column_name.lower().replace("_", " ")
            if any(keyword in lowered for keyword in lowered_keywords):
                matches.append(column_name)
    return list(dict.fromkeys(matches))


def prepare_finance_brief(brief: AgentBriefRequest, parsed_brief: ParsedBriefArtifact) -> ParsedBriefArtifact:
    glossary_terms = list(dict.fromkeys([*parsed_brief.glossary_terms, *FINANCE_GLOSSARY]))
    success_criteria = list(parsed_brief.success_criteria)
    success_criteria.append(
        "Explain the top financial signal with a variance, margin, cost, or cash lens when the data allows it."
    )
    required_sections = list(dict.fromkeys([*parsed_brief.required_sections, *FINANCE_SECTION_ARCHETYPES[:3]]))
    explicit_assumptions = list(parsed_brief.explicit_assumptions)
    explicit_assumptions.append(
        "Treat the selected scope through a finance lens first; avoid unrelated business-function framing."
    )
    return parsed_brief.model_copy(
        update={
            "domain_id": METADATA.id,
            "domain_version": METADATA.version,
            "glossary_terms": glossary_terms,
            "required_sections": required_sections,
            "success_criteria": list(dict.fromkeys(success_criteria)),
            "explicit_assumptions": list(dict.fromkeys(explicit_assumptions)),
        }
    )


def finance_enrichment_context(
    brief: AgentBriefRequest,
    parsed_brief: ParsedBriefArtifact,
    table_descriptions: List[Dict[str, Any]],
    vi: bool,
) -> Dict[str, Any]:
    if not table_descriptions:
        table_descriptions = []
    metric_hints = _find_column_matches(
        table_descriptions,
        ["revenue", "sales", "amount", "expense", "cost", "profit", "margin", "budget", "forecast", "cash", "ar", "ap"],
    )
    time_hints = _find_column_matches(table_descriptions, ["date", "time", "month", "quarter", "year", "period"])
    return {
        "system_appendix": FINANCE_ENRICHMENT_PROMPT_VI if vi else FINANCE_ENRICHMENT_PROMPT_EN,
        "user_context": {
            "selected_domain": "finance",
            "finance_kpi_canon": FINANCE_PRIMARY_KPIS,
            "finance_section_archetypes": FINANCE_SECTION_ARCHETYPES,
            "finance_detected_metric_hints": metric_hints[:12],
            "finance_detected_time_hints": time_hints[:8],
        },
    }


def finance_planner_context(parsed_brief: ParsedBriefArtifact, vi: bool) -> Dict[str, Any]:
    return {
        "system_appendix": FINANCE_PLANNER_PROMPT_VI if vi else FINANCE_PLANNER_PROMPT_EN,
        "user_context": {
            "selected_domain": "finance",
            "section_archetypes": FINANCE_SECTION_ARCHETYPES,
            "finance_glossary_terms": FINANCE_GLOSSARY,
            "domain_lens": FINANCE_DOMAIN_LENS_VI if vi else FINANCE_DOMAIN_LENS_EN,
            "parsed_domain_id": parsed_brief.domain_id,
            "parsed_domain_version": parsed_brief.domain_version,
        },
    }


def finance_insight_context(parsed_brief: ParsedBriefArtifact, vi: bool) -> Dict[str, Any]:
    return {
        "system_appendix": FINANCE_INSIGHT_PROMPT_VI if vi else FINANCE_INSIGHT_PROMPT_EN,
        "user_context": {
            "selected_domain": "finance",
            "domain_lens": FINANCE_DOMAIN_LENS_VI if vi else FINANCE_DOMAIN_LENS_EN,
            "finance_section_archetypes": FINANCE_SECTION_ARCHETYPES,
        },
    }
