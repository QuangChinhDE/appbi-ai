# -*- coding: utf-8 -*-
"""When Report Read cannot tell which chart the question means, it says so.

DEFECT (P0). Question matching could fail and the node carried on reading the
default allowed order. Nothing downstream could tell the difference between
"these charts answer the question" and "these are simply the first charts", so
report order silently became semantic relevance.

INVARIANT: selection carries a machine-readable status. Falling back to report
order is allowed — breaking stored flows is not — but it may never be presented
as a question match, and the author is told what actually happened.

SCENARIO B is `test_notice_says_matching_ran_and_failed`: with matching already
ON, the advice must not be "turn matching on".
"""
import types

import pytest

from app.services.agent_flows import resolver
from app.services.agent_flows.contract import ReportReadNode
from app.services.agent_flows.runtime.handlers import data as D

ALLOWED = [101, 102, 103]


def node(**kw):
    kw.setdefault("match_question", True)
    return ReportReadNode(key="read", name="Đọc báo cáo", output_var="ctx", **kw)


def fake_ctx(question="phân tích biến động mrr qua từng tháng"):
    return types.SimpleNamespace(
        inp=types.SimpleNamespace(question=types.SimpleNamespace(text=lambda: question)))


def state():
    return types.SimpleNamespace(notices=[], resolve_text=lambda v: v)


def notice_for(st, audience):
    """Pick by AUDIENCE, not by position. A reader notice now precedes the author
    diagnostic, and `notices[0]` silently became the wrong one."""
    for n in st.notices:
        if n.audience == audience:
            return n
    raise AssertionError(f"no {audience} notice in {[n.code for n in st.notices]}")


def select(monkeypatch, resolution, n=None, st=None):
    monkeypatch.setattr(resolver, "resolve_charts", lambda *a, **k: resolution)
    st = st or state()
    ids, sel = D._charts_for_question(n or node(), st, fake_ctx(), list(ALLOWED))
    return ids, sel, st


# ── the status is machine-readable ──────────────────────────────────────────

def test_a_semantic_match_is_reported_as_a_match(monkeypatch):
    ids, sel, _ = select(monkeypatch, {"status": "semantic", "chart_ids": [102],
                                       "candidates": [{"chart_id": 102}], "concepts": ["mrr_active"]})
    assert ids == [102]
    assert sel["status"] == "semantic"
    assert sel.get("fell_back_to") in (None, "")


def test_no_match_reads_nothing_rather_than_falling_back(monkeypatch):
    """CONTRACT CORRECTED — and this test previously encoded the defect.

    It asserted `ids == ALLOWED` under the banner "compatibility: stored flows
    must keep reading", which made "the question resolved to nothing" mean "read
    the whole report". A black-box user test then found the consequence: an Olist
    assistant answered "thời tiết Hà Nội hôm nay" with GMV, orders and AOV.

    Labelling the fallback was not enough. Full behaviour lives in
    `test_question_grounding.py`; this keeps the lock where the old claim was."""
    ids, sel, _ = select(monkeypatch, {"status": "none", "chart_ids": [],
                                       "candidates": [], "concepts": []})
    assert ids == [], "question mode must not promote report order into relevance"
    assert sel["status"] == "none"
    assert sel.get("fell_back_to") is None
    assert sel["unsupported"] is True


def test_ambiguous_keeps_the_candidates_for_the_author(monkeypatch):
    """The evidence goes to the AUTHOR diagnostic; the model-facing selection
    carries the status and the ids only — it is serialised into the prompt, and
    candidate reasoning there is context spent on something no model can act on."""
    ids, sel, st = select(monkeypatch, {"status": "ambiguous", "chart_ids": [],
                                        "candidates": [{"chart_id": 101, "why": "metric mrr"},
                                                       {"chart_id": 102, "why": "metric churn"}],
                                        "concepts": ["mrr_active", "churn_rate"]})
    assert sel["status"] == "ambiguous"
    assert ids == [] and sel.get("fell_back_to") is None
    assert sel["candidate_chart_ids"] == [101, 102]
    assert "why" not in repr(sel), "evidence prose must not ride into the prompt"
    assert len(notice_for(st, "author").facts["candidates"]) == 2


def test_an_explicit_chart_list_is_never_second_guessed(monkeypatch):
    """The author already answered "which charts"."""
    n = node(chart_ids=[103])
    monkeypatch.setattr(resolver, "resolve_charts",
                        lambda *a, **k: pytest.fail("resolver must not run"))
    assert D._selection_mode(n) == "explicit"


def test_index_mode_is_its_own_selection_mode():
    assert D._selection_mode(node(detail="index", match_question=False)) == "report_index"


# ── SCENARIO B: the notice must reflect what happened ───────────────────────

def test_notice_says_matching_ran_and_failed(monkeypatch):
    _, _, st = select(monkeypatch, {"status": "none", "chart_ids": [],
                                    "candidates": [], "concepts": []})
    assert st.notices, "a failed selection must be reported"
    n = notice_for(st, "author")
    blob = " ".join([n.text] + list(n.remedies))
    assert "Bật “đọc theo câu hỏi”" not in blob, (
        "matching is already on — recommending it is the reported defect"
    )
    assert n.audience == "author"
    assert n.facts.get("selection_status") == "none"


def test_an_ambiguous_notice_offers_the_candidates_it_found(monkeypatch):
    _, _, st = select(monkeypatch, {"status": "ambiguous", "chart_ids": [],
                                    "candidates": [{"chart_id": 101}, {"chart_id": 102}],
                                    "concepts": ["mrr_active", "churn_rate"]})
    n = notice_for(st, "author")
    assert n.facts.get("candidate_chart_ids") == [101, 102]


def test_a_successful_match_says_nothing_to_the_author(monkeypatch):
    _, _, st = select(monkeypatch, {"status": "semantic", "chart_ids": [102],
                                    "candidates": [], "concepts": ["mrr_active"]})
    assert st.notices == [], "a working selection must not produce noise"


# ── the wiring the stubbed tests could not see ──────────────────────────────
#
# THIS IS THE TEST THAT WAS MISSING. `test_asset_resolution.py` stubs both
# searches and passes no context at all, so it stayed green while the whole
# question-matching path died in the running build with
# `'RunContext' object has no attribute 'allowed_chart_ids'` — the resolver was
# handed the RunContext instead of the ToolContext inside it.
#
# A suite that can pass while the feature is dead at runtime is not coverage. This
# exercises the real call path and asserts the three things the direct call broke.

class _Budget:
    def __init__(self):
        self.spent = 0

    def spend_tool(self):
        self.spent += 1

    def tools_left(self):
        return 99


class _RunCtx:
    """Shaped like the real RunContext: the ToolContext lives at `.ctx`."""

    def __init__(self, tool_ctx):
        self.ctx = tool_ctx
        self.inp = types.SimpleNamespace(
            question=types.SimpleNamespace(text=lambda: "biến động mrr qua từng tháng"))


def _wired_state():
    st = state()
    st.budget = _Budget()
    st.tool_log = []
    return st


def test_the_resolver_is_given_the_tool_context_not_the_run_context(monkeypatch):
    sentinel = object()
    rctx = _RunCtx(sentinel)
    seen = []

    def fake_execute(ctx, name, args, **kw):
        seen.append((ctx, name))
        return {"ok": True, "kind": "catalogue", "data": {"results": []}}

    monkeypatch.setattr(D.tool_registry, "execute", fake_execute)
    D._charts_for_question(node(), _wired_state(), rctx, list(ALLOWED))

    assert seen, "the resolver made no tool call at all"
    for ctx, name in seen:
        assert ctx is sentinel, (
            f"{name} was called with {type(ctx).__name__}, not the ToolContext — "
            "this is the exact defect that killed the feature in the running build"
        )


def test_resolution_lookups_are_counted_against_the_tool_budget(monkeypatch):
    """Calling the tool functions directly bypassed budget accounting silently."""
    monkeypatch.setattr(D.tool_registry, "execute",
                        lambda ctx, name, args, **kw: {"ok": True, "data": {"results": []}})
    st = _wired_state()
    D._charts_for_question(node(), st, _RunCtx(object()), list(ALLOWED))
    assert st.budget.spent > 0, "a lookup that costs a tool call was not charged for it"


def test_resolution_lookups_appear_in_the_run_tool_log(monkeypatch):
    monkeypatch.setattr(D.tool_registry, "execute",
                        lambda ctx, name, args, **kw: {"ok": True, "data": {"results": []}})
    st = _wired_state()
    D._charts_for_question(node(), st, _RunCtx(object()), list(ALLOWED))
    assert any("list_charts" in entry for entry in st.tool_log), st.tool_log


def test_selection_remedies_are_performable_too(monkeypatch):
    """The same invariant as the overflow notice: the removed "specify a chart
    list" advice pointed at a control the builder does not have, and must not
    come back through this path either."""
    for status in ("none", "ambiguous"):
        _, _, st = select(monkeypatch, {"status": status, "chart_ids": [],
                                        "candidates": [{"chart_id": 101}],
                                        "concepts": ["mrr_active"]})
        joined = " ".join(notice_for(st, "author").remedies).lower()
        for banned in ("chỉ định danh sách biểu đồ", "chart_ids"):
            assert banned not in joined, (status, notice_for(st, "author").remedies)
        assert notice_for(st, "author").remedies, "a fallback with no advice at all helps nobody"


def test_a_remedy_never_points_somewhere_the_list_is_not(monkeypatch):
    """It said "bên dưới" (below) while the candidate list renders ABOVE the
    remedies in both author surfaces. A remedy that misdirects is the same class
    of defect as one that names a control that does not exist."""
    _, _, st = select(monkeypatch, {"status": "ambiguous", "chart_ids": [],
                                    "candidates": [{"chart_id": 101}],
                                    "concepts": ["a", "b"]})
    joined = " ".join(notice_for(st, "author").remedies)
    assert "bên dưới" not in joined, joined
    assert "ở trên" in joined
