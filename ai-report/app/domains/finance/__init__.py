from app.domains.core.base import DomainPack
from app.domains.finance.config import METADATA
from app.domains.finance.heuristics import (
    finance_enrichment_context,
    finance_insight_context,
    finance_planner_context,
    prepare_finance_brief,
)
from app.domains.finance.review import review_finance_plan

PACK = DomainPack(
    metadata=METADATA,
    prepare_brief=prepare_finance_brief,
    enrichment_context=finance_enrichment_context,
    planner_context=finance_planner_context,
    insight_context=finance_insight_context,
    review_plan=review_finance_plan,
)
