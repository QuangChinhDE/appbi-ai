"""AppBI AI ChatBot Evaluation Framework.

Deterministic-first quality measurement for the dashboard AI bot. A BI bot has
ground truth (every answer resolves to a query result over the semantic layer),
so we grade correctness WITHOUT an LLM judge wherever possible — the reliable,
cheap, reproducible path the research (Chang 2023; Abeysinghe 2024) recommends.

Tiers:
  Tier-1 (this module, deterministic): numeric match w/ tolerance, result-set
          overlap, out-of-scope refusal, citation-in-scope, grounding guard.
  Tier-2 (later, LLM-judge, narrative only): RAGAS-style faithfulness / answer
          relevance — de-biased, fed the real result + retrieved context.

Public API:
  - schema.GoldCase / GoldSuite
  - graders.grade_case(case, answer, *, allowed_chart_ids=None) -> CaseResult
  - graders.extract_numbers / numeric_match / refusal_detected / citations_in_scope
  - runner.run_suite(...) — score a whole suite and aggregate by intent tier
"""
from app.services.dashboard_ai_bot.eval.schema import GoldCase, GoldSuite  # noqa: F401
from app.services.dashboard_ai_bot.eval.graders import (  # noqa: F401
    CaseResult,
    grade_case,
    extract_numbers,
    numeric_match,
    refusal_detected,
    citations_in_scope,
)
