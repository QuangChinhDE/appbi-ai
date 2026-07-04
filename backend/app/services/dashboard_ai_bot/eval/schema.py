"""Gold-case schema for the AI bot evaluation framework.

A gold case is a locked (question → expected) contract on a FROZEN fixture
dashboard. Cases are stratified by INTENT TIER so aggregate scores never hide a
weak category (the Bloom-stratification lesson from Abeysinghe 2024). Correctness
is expressed as deterministically-checkable expectations wherever possible.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

# Intent tiers for a dashboard-QA bot (Benchmarking-LLM-Chatbot + eval-challenges
# Bloom mapping). Aggregate metrics are ALWAYS broken down by these.
IntentTier = Literal[
    "lookup",       # single metric value ("GMV tháng 11/2017?")
    "aggregate",    # sum/avg/count with a filter/slice
    "trend",        # over time / grain, direction + magnitude
    "compare",      # A vs B, delta / %
    "cross_chart",  # multi-hop across ≥2 charts
    "definition",   # semantic: what does a term/measure mean (Govern/glossary)
    "refusal",      # out-of-scope / unanswerable → must decline, not fabricate
]


@dataclass
class GoldCase:
    """One locked evaluation case.

    Expectations (all that are set must hold for a PASS):
      expect_numbers      — every value must appear in the answer (tolerant).
      expect_any_numbers  — at least one must appear (use for "or" acceptance).
      must_mention        — case/diacritic-insensitive substrings that must appear
                            (e.g. a category name, a period label, a unit).
      must_not_mention    — substrings that must NOT appear (e.g. a wrong category).
      must_refuse         — the answer must be a graceful decline (refusal tier).
      allowed_chart_ids   — if set, every [chart:N] cited must be within this set
                            (deterministic grounding/citation-scope guard).
      tolerance           — relative tolerance for numeric match (default 0.5%).
    """
    id: str
    question: str
    tier: IntentTier
    expect_numbers: list[float] = field(default_factory=list)
    expect_any_numbers: list[float] = field(default_factory=list)
    must_mention: list[str] = field(default_factory=list)
    must_not_mention: list[str] = field(default_factory=list)
    must_refuse: bool = False
    allowed_chart_ids: list[int] | None = None
    tolerance: float = 0.005
    notes: str = ""

    def __post_init__(self) -> None:
        valid = {
            "lookup", "aggregate", "trend", "compare",
            "cross_chart", "definition", "refusal",
        }
        if self.tier not in valid:
            raise ValueError(f"GoldCase {self.id}: invalid tier {self.tier!r}")


@dataclass
class GoldSuite:
    """A versioned set of gold cases bound to one fixture dashboard."""
    name: str
    dashboard_token: str
    fixture_note: str
    cases: list[GoldCase] = field(default_factory=list)

    def by_tier(self) -> dict[str, list[GoldCase]]:
        out: dict[str, list[GoldCase]] = {}
        for c in self.cases:
            out.setdefault(c.tier, []).append(c)
        return out
