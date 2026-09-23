# -*- coding: utf-8 -*-
"""What the read step reads, and whether it admits how much is thrown away.

WHERE THIS CAME FROM
--------------------
An author building a flow, describing the step in their own words:

    "Tất cả các dòng đọc được sẽ trở thành context cho node llm tiếp theo => thừa
    context so với query của user (tức là đọc tất cả, ko quan tâm câu hỏi là gì)"

They were right about the behaviour and wrong about the consequence, and both
halves matter. The step WAS question-blind: `chart_ids`, or every chart the
binding allows, in id order. But the rows do not all become context — a step's
result is cut to 2,000 characters on its way into the next prompt. Measured on a
70-chart report with twenty charts planned:

    summary + data, detail=full     71,650 chars     2.8% survives    7/20 charts
    summary only,   detail=full     49,471 chars     4.0%             6/20
    summary only,   detail=compact   8,244 chars    24.3%             7/20

So the author's fix — switching off `Chart data` — moved 71,650 to 49,471 and
changed almost nothing about what reached the model, while the control that
actually moves it eightfold (`detail`) had no builder UI at all.

Three things are pinned here:
  1. the new fields default to exactly what every saved flow already did,
  2. `match_question` reorders by the question and never widens past the binding,
  3. a read that cannot fit downstream says so, with numbers an author can act on.

(That an explicit `chart_ids` list still beats a keyword match is a one-line guard
in the handler — `if node.match_question and not node.chart_ids` — and is not
pinned here, because reaching it needs a whole run context and the assertion would
be about the mock, not the rule.)
"""
from __future__ import annotations

import pytest

from app.services.agent_flows.contract import Flow, upgrade_body
from app.services.agent_flows.runtime.handlers.data import (
    _DOWNSTREAM_CHARS, _warn_if_overflowing,
)


def _read_node(**kw) -> dict:
    # `output_var` because `run_policy` defaults to `when_stale`, and a node meant
    # to be reused across turns must publish something to reuse.
    return {"key": "doc", "type": "report_read", "output_var": "bao_cao", **kw}


def _flow(node: dict) -> Flow:
    body = {"nodes": [node, {"key": "a", "type": "agent", "prompt": "x"}],
            "answer_node": "a"}
    return Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"}
    )


# ── the contract ────────────────────────────────────────────────────────────


def test_the_defaults_are_what_every_existing_flow_already_ran():
    """A flow saved before these fields existed must behave identically after."""
    node = _flow(_read_node()).nodes[0]

    assert node.match_question is False, "reading everything stays the default"
    assert node.max_charts == 20, "the old hard-coded [:20]"
    assert node.detail == "compact"
    assert node.query == ""


def test_max_charts_is_bounded_on_both_sides():
    """Zero charts is a step that does nothing; fifty is past the point where the
    next step can use any of it."""
    assert _flow(_read_node(max_charts=1)).nodes[0].max_charts == 1
    assert _flow(_read_node(max_charts=50)).nodes[0].max_charts == 50
    with pytest.raises(Exception):
        _flow(_read_node(max_charts=0))
    with pytest.raises(Exception):
        _flow(_read_node(max_charts=51))


def test_detail_is_the_control_the_builder_was_missing():
    """`index` is the mode that answers the reported complaint — no warehouse read
    at all, the next step's tools fetch the exact figure. It has always existed in
    the contract; until now nothing in the UI could set it."""
    for mode in ("index", "compact", "full"):
        assert _flow(_read_node(detail=mode)).nodes[0].detail == mode
    with pytest.raises(Exception):
        _flow(_read_node(detail="everything"))


# ── choosing charts by the question ─────────────────────────────────────────


def _stub_node(*, query="", name="", **kw):
    """A stand-in for ReportReadNode carrying every field the code reads.

    A hand-built stub that omits a field does not test tolerance, it tests the
    stub: `_warn_if_overflowing` derives its remedies from `match_question`,
    `chart_ids` and `detail`, and a stub without them raised AttributeError while
    the real node has all three. Defaults mirror the contract.
    """
    fields = {"query": query, "key": "doc", "name": name,
              "match_question": False, "chart_ids": [], "detail": "compact",
              "max_charts": 20}
    fields.update(kw)
    return type("N", (), fields)()


class _FakeState:
    def __init__(self):
        self.notices = []
        self.tool_log = []
        self.budget = self

    def spend_tool(self):
        self.tool_log.append("spent")

    def resolve_text(self, text):
        return text or ""


def _listing(charts, *, matched=True, question="doanh thu", terms=3, best=3):
    """A `list_charts` reply, carrying the structured `selection` block.

    `status` is what a deterministic caller branches on; `terms`/`best` travel
    beside it so a caller that wants its own rule can still have one, and so the
    decision is auditable in a trace rather than being a bare verdict.
    """
    coverage = {"returned": len(charts), "total": len(charts)}
    ids = list(charts)
    if matched:
        coverage["query"] = question
        coverage["query_terms"] = terms
        coverage["query_best_hits"] = best
        status = "matched" if best * 3 >= terms else "ambiguous"
    else:
        coverage["query_matched_nothing"] = question
        status = "none"
    return {"ok": True, "data": {
        "charts": [{"chart_id": c, "chart_name": f"Chart {c}"} for c in charts],
        "coverage": coverage,
        "selection": {
            "status": status,
            "mode": "query",
            "fallback_used": status in ("none", "ambiguous"),
            "selected_ids": ids,
            "query_terms": terms if matched else 0,
            "best_hits": best if matched else 0,
            "reason": "test fixture",
        },
    }}


@pytest.fixture
def selector(monkeypatch):
    """`_charts_for_question` with `list_charts` replaced by a scripted answer."""
    from app.services.agent_flows.runtime.handlers import data as mod

    calls: list[dict] = []
    scripted: dict = {}

    def fake_execute(ctx, tool, args, allowed=None):
        calls.append({"tool": tool, "args": args})
        return scripted.get("result", _listing([]))

    monkeypatch.setattr(mod.tool_registry, "execute", fake_execute)

    class Harness:
        def __init__(self):
            self.calls = calls

        def returns(self, result):
            scripted["result"] = result

        def run(self, allowed, *, query="", question="doanh thu theo tháng"):
            node = _stub_node(query=query)
            rctx = type("R", (), {})()
            rctx.ctx = object()
            rctx.inp = type("I", (), {})()
            rctx.inp.question = type("Q", (), {"text": lambda self: question})()
            return mod._charts_for_question(node, _FakeState(), rctx, allowed)

    return Harness()


def test_the_question_reorders_the_allowed_charts(selector):
    """Best match first — the order the step then truncates with `max_charts`."""
    selector.returns(_listing([990, 412]))

    ordered, why = selector.run([412, 687, 990])

    assert ordered == [990, 412]
    assert why["status"] in ("exact", "semantic")
    assert selector.calls[0]["tool"] == "list_charts"
    assert selector.calls[0]["args"]["query"] == "doanh thu theo tháng"


def test_a_match_can_never_widen_the_binding(selector):
    """THE ONE THING THAT MUST NOT BREAK. `list_charts` is scoped to the context,
    but a selector that trusted its output to define scope would be a second
    implementation of entitlement — and this is the class of bug where being
    wrong is a data leak, not a bad answer."""
    selector.returns(_listing([990, 412, 1001]))   # 1001 is NOT allowed

    ordered, _ = selector.run([412, 990])

    assert 1001 not in ordered
    assert set(ordered) <= {412, 990}


def test_a_question_that_matches_nothing_says_so(selector):
    """`list_charts` falls back to the FULL listing on a miss, which is right for a
    model that reads the coverage note. Taken at face value it would turn "read
    what the question is about" into "read everything in id order", silently."""
    selector.returns(_listing([412, 687, 990], matched=False))

    ordered, why = selector.run([412, 687, 990])

    # CONTRACT CORRECTED. This used to end "falls back to the full scope, not to
    # nothing" — and that fallback is exactly how an unrelated question became an
    # Olist summary. A miss now reads nothing and says the report does not support
    # the question.
    assert why["status"] == "none"
    assert why["unsupported"] is True
    assert ordered == [], "a miss must read nothing, not the whole report"


def test_an_empty_question_does_not_even_ask(selector):
    ordered, why = selector.run([412, 990], question="")

    assert why["status"] == "no_question"
    assert ordered == [412, 990], "no question to resolve is not a failed match"
    assert selector.calls == [], "no tool budget spent deciding nothing"


def test_an_explicit_query_beats_the_viewer_s_question(selector):
    selector.returns(_listing([687]))

    selector.run([687, 990], query="tỉ lệ giao đúng hạn")

    assert selector.calls[0]["args"]["query"] == "tỉ lệ giao đúng hạn"


def test_a_failed_lookup_falls_back_rather_than_reading_nothing(selector):
    """A step that reads no charts because a keyword search broke is worse than a
    step that reads them in the old order."""
    selector.returns({"ok": False, "error": "boom"})

    ordered, why = selector.run([412, 990])

    # SUPERSEDED. Degrading was still fail-open: it asserted relevance on no
    # evidence. Reading nothing is not a refusal either — see the status below.
    assert ordered == [], "a broken lookup must not guess at relevance"
    # A BROKEN LOOKUP IS NOT A VERDICT ABOUT THE DOMAIN. Folding it into
    # `none` would skip the read and tell a viewer the report cannot answer
    # them, on a transient tool failure.
    assert why["status"] == "lookup_failed"
    assert why["resolution_unavailable"] is True
    assert why.get("fell_back_to") is None


# ── admitting what will not fit ─────────────────────────────────────────────


def _node(name="Đọc báo cáo"):
    return _stub_node(name=name)


def test_a_read_that_fits_says_nothing():
    state = _FakeState()

    _warn_if_overflowing(_node(), {"charts": [{"chart_id": 1}]}, state)

    assert state.notices == [], "a notice on a healthy run is noise"


def test_a_read_that_cannot_fit_reports_the_real_numbers():
    """THE GAP THIS CLOSES IS A MENTAL MODEL. An author cannot reason about a
    ceiling nobody showed them; they tune the controls they can see, conclude the
    step is wasteful, and switch things off."""
    big = {"charts": [{"chart_id": c, "summary": {"ok": True, "data": {"x": "y" * 400}}}
                      for c in range(20)]}
    state = _FakeState()

    _warn_if_overflowing(_node(), big, state)

    assert len(state.notices) == 1
    note = state.notices[0]
    assert note.code == "read_exceeds_context"
    assert "20 biểu đồ" in note.text
    assert "8.000 ký tự" in note.text, "the ceiling, in the reader's number format"


def test_the_notice_names_a_remedy_that_exists():
    """A warning an author cannot act on is a warning they learn to ignore. Each
    remedy named here is a control now present in the inspector."""
    big = {"charts": [{"chart_id": c, "summary": {"ok": True, "data": {"x": "y" * 400}}}
                      for c in range(20)]}
    state = _FakeState()

    _warn_if_overflowing(_node(), big, state)
    note = state.notices[0]
    # CONTRACT MOVED, not weakened: remedies live in `remedies`, once. They used
    # to be appended to `text` as well — from a time when no surface rendered the
    # field — and both author surfaces render it now, so the append printed every
    # remedy twice on screen.
    remedies = " ".join(note.remedies)

    assert "đọc theo câu hỏi" in remedies     # match_question
    assert "số biểu đồ" in remedies           # max_charts
    assert "chỉ mục" in remedies              # detail=index
    assert note.text.strip(), "the sentence must still state the problem"
    for r in note.remedies:
        assert r not in note.text, "remedy duplicated into the sentence"


def test_no_notice_without_a_step_name_crashing():
    """The node may be unnamed — the key stands in, rather than “Bước “”…”."""
    big = {"charts": [{"chart_id": c, "summary": {"ok": True, "data": {"x": "y" * 400}}}
                      for c in range(20)]}
    state = _FakeState()

    _warn_if_overflowing(_node(name=""), big, state)

    assert "doc" in state.notices[0].text


def test_an_empty_read_is_not_an_overflow():
    state = _FakeState()

    _warn_if_overflowing(_node(), {"charts": []}, state)

    assert state.notices == []


def test_the_downstream_ceiling_is_not_invented_here():
    """ORIGINALLY it mirrored `_MAX_STEP_CHARS` by hand, and the invariant in this
    docstring came true: that constant was replaced by the context compiler's
    budget and the mirrored copy was not, so the notice quoted a 2.000-character
    limit that no longer existed. There is one source now, and this asserts both
    users read it rather than that two numbers happen to be equal."""
    from app.services.agent_flows.runtime.context import HANDOFF_CHARS
    from app.services.agent_flows.runtime.handlers.agent import _HANDOFF_CHARS

    assert _DOWNSTREAM_CHARS is HANDOFF_CHARS
    assert _HANDOFF_CHARS is HANDOFF_CHARS


# ── a match this tool calls a match is not always one ────────────────────────


def test_an_off_topic_question_is_not_treated_as_a_match(selector):
    """FOUND BY ASKING THE FEATURE A QUESTION ABOUT THE WEATHER.

    One shared token is enough for `list_charts` to rank a chart, which is right
    when a model reads the listing and judges. This step has no judge. On the real
    Olist report "thời tiết sao Hỏa hôm nay" matched four charts — "sao" from "Tỷ
    lệ 5 sao", "thời" from "Dòng thời gian" — and the step would have read them as
    though they answered it.
    """
    selector.returns(_listing([717, 724, 730, 742], terms=6, best=1))

    ordered, why = selector.run([717, 724, 730, 742, 686],
                                question="thời tiết sao Hỏa hôm nay")

    # THIS TEST NAMED THE BUG AND THEN LOCKED IT AS CORRECT. Its docstring says a
    # weather question matched four charts on "sao" and "thời", and it went on to
    # assert that reading all five was the right outcome. A user asked the shipped
    # assistant the same kind of question and got GMV, orders and AOV back.
    assert why["status"] in ("ambiguous", "none")
    assert why.get("fell_back_to") is None
    assert ordered == [], "a weather question must read no Olist charts"


def test_a_question_whose_terms_are_mostly_covered_still_matches(selector):
    """The other side of the threshold. Measured on report 67, a real question
    covers 0.40–1.00 of its own terms; an off-topic one 0.17–0.20."""
    selector.returns(_listing([686, 694], terms=5, best=2))   # 0.40

    _, why = selector.run([686, 694, 700], question="đánh giá của khách hàng")

    assert why["status"] in ("exact", "semantic")


def test_a_one_word_question_that_hits_is_a_match(selector):
    """"GMV" is one term and three charts carry it. A rule stated as "at least two
    terms" would have rejected the clearest match on the report."""
    selector.returns(_listing([693, 684, 678], terms=1, best=1))

    ordered, why = selector.run([693, 684, 678, 686], question="GMV")

    assert why["status"] in ("exact", "semantic")
    assert ordered == [693, 684, 678]


def test_the_threshold_is_exactly_a_third(selector):
    """Stated as a test so moving it is a decision, not a drift."""
    selector.returns(_listing([1], terms=3, best=1))          # 1/3 - kept
    assert selector.run([1, 2], question="q")[1]["status"] in ("exact", "semantic")

    selector.returns(_listing([1], terms=4, best=1))          # 0.25 - rejected
    rejected = selector.run([1, 2], question="q")[1]
    assert rejected["status"] in ("ambiguous", "none")
    assert rejected.get("fell_back_to") is None, (
        "a weak match must not promote report order into relevance"
    )


def test_a_listing_without_strength_is_trusted(selector):
    """An older deployment, or a `list_charts` that did not report strength, must
    keep working rather than have every match rejected."""
    selector.returns({"ok": True, "data": {
        "charts": [{"chart_id": 686}],
        "coverage": {"query": "doanh thu"},
    }})

    ordered, why = selector.run([686, 700], question="doanh thu")

    assert why["status"] in ("exact", "semantic")
    assert ordered == [686]


# ── the status the REAL tool computes, not the one a fixture hands it ────────


class _CatalogueCtx:
    """The smallest context `list_charts` reads. No warehouse: it is metadata-only."""

    dashboard = None
    read_rows = True
    web_search = True
    allowed_chart_ids = {41, 42}
    knowledge_scope: dict = {}
    max_result_tokens = 4000
    max_rows_per_call = 50
    public_filters: list = []
    pages: list = []
    chart_meta = {
        41: {"name": "Doanh thu theo danh mục", "chart_type": "BAR",
             "measures": [{"field": "revenue"}],
             "dimensions": [{"field": "category"}]},
        42: {"name": "Tỷ lệ giao đúng hẹn", "chart_type": "LINE",
             "measures": [{"field": "on_time_rate"}],
             "dimensions": [{"field": "month"}]},
    }


def _selection(query: str) -> dict:
    from app.services.agent_flows.tools.registry import execute

    out = execute(_CatalogueCtx(), "list_charts", {"query": query}, use_cache=False)
    assert out["ok"], out
    return (out.get("data") or {}).get("selection") or {}


def test_the_real_tool_reports_none_when_the_question_matches_nothing():
    """FOUND BY A MUTATION THAT ESCAPED.

    Every other test in this file hands `_charts_for_question` a fixture that
    already contains a `selection` block, so they check the CALLER's rule and never
    the code that decides `status`. Flipping `list_charts` to report `matched` on a
    miss changed nothing and the suite stayed green — the fallback-is-not-a-match
    invariant was guarded on one side only.
    """
    sel = _selection("cong thuc nau pho bo gia truyen")

    assert sel.get("status") == "none", sel
    assert sel.get("fallback_used") is True


def test_the_real_tool_reports_matched_when_the_question_names_a_chart():
    """The control. Without it the test above would pass on a tool that reports
    `none` for everything."""
    sel = _selection("doanh thu theo danh mục")

    assert sel.get("status") == "matched", sel
    assert sel.get("fallback_used") is False
    assert 41 in (sel.get("selected_ids") or [])


def test_the_real_tool_reports_ambiguous_on_a_weak_overlap():
    """One shared token out of many is the shape that produced the "thời tiết sao
    Hỏa" incident: enough for the ranker, not enough to act on."""
    sel = _selection("bao nhieu thang nua thi xong du an xay dung nha may")

    assert sel.get("status") in ("ambiguous", "none"), sel
    assert sel.get("fallback_used") is True


def test_an_explicit_listing_with_no_query_is_not_a_fallback():
    from app.services.agent_flows.tools.registry import execute

    out = execute(_CatalogueCtx(), "list_charts", {}, use_cache=False)
    sel = (out.get("data") or {}).get("selection") or {}

    assert sel.get("mode") == "explicit"
    assert sel.get("fallback_used") is False
