# -*- coding: utf-8 -*-
"""A business question resolves to the right chart, or says it cannot.

Success is NOT "always find a chart". It is: the correct chart when the evidence
supports it, AMBIGUOUS when the question genuinely points at more than one thing,
NONE when nothing matches — and never a confident pick of an unrelated chart.

Deterministic by construction: the two underlying searches are stubbed, so this
measures the RESOLUTION POLICY rather than the warehouse behind it.
"""
import pytest

from app.services.agent_flows import resolver

ALLOWED = [101, 102, 103]


class Fake:
    """Stands in for the two audited searches the resolver composes."""

    def __init__(self, lexical=("none", []), results=None, bridge=None):
        self.lexical = lexical
        self.results = results or []
        self.bridge = bridge or {}

    def install(self, monkeypatch):
        monkeypatch.setattr(resolver, "_lexical", lambda call, q: self.lexical)

        def semantic(call, q):
            out = []
            for asset in self.results:
                for cand in self.bridge.get(asset["id"], []):
                    if cand.get("match") != "measure":
                        continue
                    out.append({"chart_id": cand["chart_id"],
                                "chart_name": cand.get("chart_name", ""),
                                "via": asset["type"], "concept": asset["id"],
                                "why": "stub"})
            return out

        monkeypatch.setattr(resolver, "_semantic", semantic)


def resolve(monkeypatch, fake, question="q", allowed=None):
    fake.install(monkeypatch)
    return resolver.resolve_charts(
        question, ALLOWED if allowed is None else allowed,
        call=lambda tool, args: (_ for _ in ()).throw(
            AssertionError("both searches are stubbed; `call` must not be reached")),
    )


# ── the reported scenario ────────────────────────────────────────────────────

def test_vietnamese_paraphrase_reaches_an_english_chart_through_the_metric(monkeypatch):
    """SCENARIO A. "phân tích biến động mrr qua từng tháng" shares only "mrr"
    with "[Demo_NetSuite] MRR Active by time", so the lexical pass cannot decide.
    The governed metric `mrr_active` can, and the bridge walks it to the chart."""
    fake = Fake(
        lexical=("ambiguous", [101, 102, 103]),
        results=[{"type": "metric", "id": "mrr_active", "name": "Mrr active"}],
        bridge={"mrr_active": [{"chart_id": 102, "chart_name": "MRR Active by time",
                                "match": "measure"}]},
    )
    got = resolve(monkeypatch, fake, "phân tích biến động mrr qua từng tháng")
    assert got["status"] == "semantic"
    assert got["chart_ids"] == [102]
    assert got["candidates"][0]["why"], "a semantic match must carry its reason"


def test_exact_chart_title_short_circuits_without_the_semantic_pass(monkeypatch):
    fake = Fake(lexical=("matched", [103]))
    got = resolve(monkeypatch, fake, "MRR Active by time")
    assert got["status"] == "exact" and got["chart_ids"] == [103]


def test_business_phrase_reaches_a_raw_semantic_field(monkeypatch):
    fake = Fake(
        results=[{"type": "field", "id": "year_month", "name": "Tháng"}],
        bridge={"year_month": [{"chart_id": 101, "match": "measure"}]},
    )
    assert resolve(monkeypatch, fake, "qua từng tháng")["chart_ids"] == [101]


# ── ambiguity and absence must stay visible ──────────────────────────────────

def test_two_unrelated_concepts_is_ambiguous_not_a_pick(monkeypatch):
    fake = Fake(
        results=[{"type": "metric", "id": "mrr_active", "name": "MRR"},
                 {"type": "metric", "id": "churn_rate", "name": "Churn"}],
        bridge={"mrr_active": [{"chart_id": 101, "match": "measure"}],
                "churn_rate": [{"chart_id": 102, "match": "measure"}]},
    )
    got = resolve(monkeypatch, fake, "mrr và churn")
    assert got["status"] == "ambiguous"
    assert got["chart_ids"] == [], "an ambiguous question must not yield a pick"
    assert {c["chart_id"] for c in got["candidates"]} == {101, 102}


def test_two_charts_realising_ONE_metric_is_a_ranked_answer_not_ambiguity(monkeypatch):
    fake = Fake(
        results=[{"type": "metric", "id": "mrr_active", "name": "MRR"}],
        bridge={"mrr_active": [{"chart_id": 101, "match": "measure"},
                               {"chart_id": 102, "match": "measure"}]},
    )
    got = resolve(monkeypatch, fake, "mrr")
    assert got["status"] == "semantic" and got["chart_ids"] == [101, 102]


def test_no_corresponding_chart_is_none(monkeypatch):
    assert resolve(monkeypatch, Fake(), "thời tiết sao Hỏa hôm nay")["status"] == "none"


def test_one_shared_generic_token_is_ambiguous_never_exact(monkeypatch):
    """"thời tiết sao Hỏa" matched four charts on "sao" and "thời". One shared
    word is not a match."""
    fake = Fake(lexical=("ambiguous", [101, 102]))
    got = resolve(monkeypatch, fake, "thời tiết sao Hỏa hôm nay")
    assert got["status"] == "ambiguous" and got["chart_ids"] == []


def test_same_table_is_not_a_match(monkeypatch):
    """A chart on the same table may plot something else entirely."""
    fake = Fake(
        results=[{"type": "metric", "id": "mrr_active", "name": "MRR"}],
        bridge={"mrr_active": [{"chart_id": 101, "match": "same_table"}]},
    )
    assert resolve(monkeypatch, fake, "mrr")["status"] == "none"


# ── permission ──────────────────────────────────────────────────────────────

def test_resolution_never_widens_entitlement(monkeypatch):
    """The best candidate is outside the authorised set: it must vanish, not be
    granted. Being wrong here is a leak, not a bad answer."""
    fake = Fake(
        results=[{"type": "metric", "id": "mrr_active", "name": "MRR"}],
        bridge={"mrr_active": [{"chart_id": 999, "match": "measure"}]},
    )
    got = resolve(monkeypatch, fake, "mrr")
    assert 999 not in got["chart_ids"]
    assert got["status"] == "none"


def test_lexical_ids_are_also_intersected(monkeypatch):
    got = resolve(monkeypatch, Fake(lexical=("matched", [999])), "x")
    assert got["chart_ids"] == [] and got["status"] != "exact"


def test_an_empty_authorised_set_resolves_to_nothing(monkeypatch):
    fake = Fake(lexical=("matched", [101]))
    assert resolve(monkeypatch, fake, "x", allowed=[])["status"] == "none"


def test_an_empty_question_resolves_to_nothing(monkeypatch):
    assert resolve(monkeypatch, Fake(lexical=("matched", [101])), "   ")["status"] == "none"


# ── a weak hit is not a semantic match ──────────────────────────────────────
#
# OBSERVED IN PRODUCTION (run 446, public Olist link). Asked "thời tiết Hà Nội hôm
# nay", the resolver returned `status: "semantic"` with `selected_ids: [683, 685]`
# and the assistant answered "Tỷ lệ giao đúng hẹn là 91.89%… Tổng đơn hàng 99,441"
# before adding that it had no weather data. No fallback flag existed to key off,
# because the resolver believed it had matched.
#
# `search_business_assets` ranks anything sharing ONE token — correct for a model
# that reads the list and judges, wrong for a caller with no judge.

class StrengthFake(Fake):
    """Drives the REAL `_semantic`, so the strength rule is what is under test."""

    def __init__(self, results, bridge):
        super().__init__(results=results, bridge=bridge)

    def install(self, monkeypatch):
        monkeypatch.setattr(resolver, "_lexical", lambda call, q: ("none", []))

        def call(tool, args):
            if tool == "search_business_assets":
                return {"ok": True, "data": {"results": self.results}}
            if tool == "resolve_chart_candidates":
                ident = args.get("metric") or args.get("measure")
                return {"ok": True, "data": {"candidates": self.bridge.get(ident, [])}}
            return {"ok": False}

        self._call = call


def resolve_real(monkeypatch, fake, question):
    fake.install(monkeypatch)
    return resolver.resolve_charts(question, ALLOWED, call=fake._call)


ONE_TOKEN_HIT = [{"type": "metric", "id": "ty_le_giao_dung_hen",
                  "name": "Tỷ lệ giao đúng hẹn"}]
BRIDGE = {"ty_le_giao_dung_hen": [{"chart_id": 101, "match": "measure"}]}


@pytest.mark.parametrize("question", [
    "thời tiết Hà Nội hôm nay",
    "what is the weather today?",
])
def test_an_off_domain_question_is_not_a_semantic_match(monkeypatch, question):
    got = resolve_real(monkeypatch, StrengthFake(ONE_TOKEN_HIT, BRIDGE), question)
    assert got["status"] == "none", (
        f"{question!r} was reported as a {got['status']} match on "
        f"{got['chart_ids']} — that is run 446"
    )


def test_a_real_business_question_still_resolves(monkeypatch):
    """The threshold must not cost in-domain resolution. Measured against the
    deployment's own governed vocabulary."""
    got = resolve_real(monkeypatch, StrengthFake(ONE_TOKEN_HIT, BRIDGE),
                       "tỷ lệ giao đúng hạn")
    assert got["status"] == "semantic" and got["chart_ids"] == [101]


def test_a_one_word_question_that_fully_matches_still_resolves(monkeypatch):
    """A short question cannot reach two shared terms; matching ALL of them is the
    same evidence proportionally."""
    got = resolve_real(monkeypatch, StrengthFake(
        [{"type": "metric", "id": "gmv", "name": "GMV"}],
        {"gmv": [{"chart_id": 102, "match": "measure"}]}), "GMV")
    assert got["status"] == "semantic" and got["chart_ids"] == [102]
