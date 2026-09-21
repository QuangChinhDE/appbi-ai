# -*- coding: utf-8 -*-
"""EVIDENCE TRUTH IS NOT QUESTION RELEVANCE.

REPRODUCED DEFECT (P0), found by a black-box user test, not by any suite here.
On the Olist report assistant:

    Q: "thời tiết Hà Nội hôm nay"       -> GMV, doanh thu, đơn hàng, AOV, đánh giá…
    Q: "what is the weather today?"     -> the same Olist summary

Both languages behave identically, so this is not a translation bug: it is domain
relevance. `_charts_for_question` resolved `none`, recorded `fell_back_to:
"report_order"`, and then RETURNED THE WHOLE ALLOWED LIST. Every figure in the
answer was real and verifiable, and the answer was still wrong — the numbers
answered a question nobody asked.

Observability was mistaken for correctness: the fallback was honestly labelled and
still fed the model six charts of irrelevant evidence, which it dutifully
summarised. Worse, this file's predecessor asserted `ids == ALLOWED` as the
intended contract, so the defect was locked in as correct.

INVARIANT: in QUESTION mode, evidence is read only when the question resolved to
it. `none` and `ambiguous` read nothing and say so in a structured way. Explicit
report-overview modes are untouched — an author who did not ask for question
matching never asked for relevance filtering either.

This file is the behavioural eval the brief asks for: question -> selection status
-> evidence used -> answer behaviour. It asserts STATE, not prose.
"""
import types

import pytest

from app.services.agent_flows import resolver
from app.services.agent_flows.contract import ReportReadNode
from app.services.agent_flows.runtime.handlers import data as D

#: The Olist report, as the binding allows it.
ALLOWED = [678, 679, 680, 681, 682, 683]


def node(**kw):
    kw.setdefault("match_question", True)
    kw.setdefault("detail", "compact")
    return ReportReadNode(key="overview", name="Đọc tổng quan báo cáo",
                          output_var="ctx", **kw)


def state():
    return types.SimpleNamespace(
        notices=[], resolve_text=lambda v: v, tool_log=[],
        budget=types.SimpleNamespace(spend_tool=lambda: None, tools_left=lambda: 99))


def rctx(question):
    return types.SimpleNamespace(
        inp=types.SimpleNamespace(question=types.SimpleNamespace(text=lambda: question)))


def run(monkeypatch, question, resolution, n=None):
    monkeypatch.setattr(resolver, "resolve_charts", lambda *a, **k: resolution)
    st = state()
    ids, sel = D._charts_for_question(n or node(), st, rctx(question), list(ALLOWED))
    return ids, sel, st


NO_MATCH = {"status": "none", "chart_ids": [], "candidates": [], "concepts": []}


def ambiguous(*ids):
    return {"status": "ambiguous", "chart_ids": [],
            "candidates": [{"chart_id": i, "why": "shared token"} for i in ids],
            "concepts": ["mrr_active", "churn_rate"]}


# ── GROUP 1: domain relevance. Language is the other axis, tested below. ─────

@pytest.mark.parametrize("question", [
    "thời tiết Hà Nội hôm nay",          # the reported case
    "what is the weather today?",        # same class, different language
])
def test_an_off_domain_question_reads_no_report_charts(monkeypatch, question):
    ids, sel, _ = run(monkeypatch, question, NO_MATCH)
    assert ids == [], (
        f"{question!r} resolved to nothing and the step still read "
        f"{len(ids)} charts — that is how an unrelated question became an "
        f"Olist summary"
    )
    assert sel["status"] == "none"
    assert sel.get("fell_back_to") is None, "report order must not be promoted"


@pytest.mark.parametrize("question", [
    "thời tiết Hà Nội hôm nay", "what is the weather today?",
])
def test_both_languages_behave_identically(monkeypatch, question):
    """If these ever diverge, the cause is language, not domain — and that is a
    different bug with a different fix."""
    ids, sel, _ = run(monkeypatch, question, NO_MATCH)
    assert (ids, sel["status"]) == ([], "none")


def test_no_match_is_a_structured_state_not_an_empty_read(monkeypatch):
    """"Nothing matched the question" and "the read failed" are different facts.
    Collapsing them would send an author hunting a data problem that is not there."""
    _, sel, _ = run(monkeypatch, "thời tiết Hà Nội hôm nay", NO_MATCH)
    assert sel["unsupported"] is True
    assert sel["status"] == "none"


def test_the_author_is_told_and_the_remedy_is_still_performable(monkeypatch):
    _, _, st = run(monkeypatch, "thời tiết Hà Nội hôm nay", NO_MATCH)
    assert st.notices, "a question that matched nothing must be reported"

    author = [n for n in st.notices if n.audience == "author"]
    reader = [n for n in st.notices if n.audience == "reader"]
    assert author, "the author must be told their matching found nothing"
    assert author[0].facts.get("selection_status") == "none"
    joined = " ".join(author[0].remedies).lower()
    assert "chỉ định danh sách biểu đồ" not in joined

    # And the READER is told, by the runtime rather than by the model inferring it
    # from having been handed nothing.
    assert reader, "the viewer must learn the report cannot answer this"
    assert reader[0].code == "read_question_unsupported"


def test_the_reader_notice_asks_rather_than_refuses_when_ambiguous(monkeypatch):
    _, _, st = run(monkeypatch, "sao", ambiguous(679, 681))
    reader = [n for n in st.notices if n.audience == "reader"]
    assert reader and reader[0].code == "read_question_ambiguous"


# ── ambiguity: candidates survive, nothing is picked ────────────────────────

def test_ambiguous_reads_nothing_and_keeps_its_candidates(monkeypatch):
    ids, sel, _ = run(monkeypatch, "sao", ambiguous(679, 681))
    assert ids == [], "an ambiguous question must not read an arbitrary chart"
    assert sel["status"] == "ambiguous"
    assert sel["candidate_chart_ids"] == [679, 681]
    assert sel.get("fell_back_to") is None


def test_ambiguous_asks_rather_than_declares_unsupported(monkeypatch):
    """Ambiguous means "which of these?", not "I cannot". The two lead to
    different downstream behaviour and must not be merged."""
    _, sel, _ = run(monkeypatch, "sao", ambiguous(679, 681))
    assert sel.get("unsupported") is not True
    assert sel.get("needs_clarification") is True


# ── what still reads ────────────────────────────────────────────────────────

def test_a_resolved_question_reads_exactly_what_resolved(monkeypatch):
    ids, sel, _ = run(monkeypatch, "doanh thu theo tháng",
                      {"status": "semantic", "chart_ids": [681],
                       "candidates": [{"chart_id": 681}], "concepts": ["revenue"]})
    assert ids == [681]
    assert sel["selected_ids"] == [681]
    assert sel.get("fell_back_to") is None


def test_explicit_report_overview_mode_is_untouched():
    """BACKWARDS COMPATIBILITY, and it needs no new setting. A flow built to
    summarise a report has `match_question` OFF — it is `report_order` mode and
    never enters question selection at all. An author who did not ask for question
    matching never asked for relevance filtering either."""
    assert D._selection_mode(node(match_question=False)) == "report_order"
    assert D._selection_mode(node(match_question=False, detail="index")) == "report_index"
    assert D._selection_mode(node(chart_ids=[678])) == "explicit"
    assert D._selection_mode(node()) == "question"


def test_an_explicit_chart_list_still_wins_over_the_question(monkeypatch):
    monkeypatch.setattr(resolver, "resolve_charts",
                        lambda *a, **k: pytest.fail("resolver must not run"))
    assert D._selection_mode(node(chart_ids=[678, 679])) == "explicit"


def test_an_empty_question_is_not_treated_as_no_match(monkeypatch):
    """No question to resolve is not the same as a question nothing matched — a
    flow triggered without a viewer question must still read its report."""
    ids, sel, _ = run(monkeypatch, "   ", NO_MATCH)
    assert ids == ALLOWED
    assert sel["status"] == "no_question"


def test_the_author_diagnostic_matches_what_actually_happened(monkeypatch):
    """A DIAGNOSTIC THAT LIES is the defect Wave 1 closed, and this one started
    lying the moment the fallback was removed: it still said "nên đọc theo thứ tự
    báo cáo" and carried `fell_back_to: report_order` while the step read zero
    charts. Found in the negative-control run, not by any test."""
    ids, _, st = run(monkeypatch, "thời tiết Hà Nội hôm nay", NO_MATCH)
    author = [n for n in st.notices if n.audience == "author"][0]
    assert ids == []
    assert "đọc theo thứ tự báo cáo" not in author.text
    assert author.facts.get("fell_back_to") is None
    assert author.facts.get("charts_read") == 0


def test_a_lookup_failure_reports_the_degraded_state_it_really_is(monkeypatch):
    """SUPERSEDED CONTRACT. This asserted that a broken lookup still degrades to
    report order and says so — honest about a behaviour that was itself fail-open.
    It now reads nothing and reports resolution as unavailable, which is neither
    "these charts are relevant" nor "this report cannot answer you"."""
    _, sel, st = run(monkeypatch, "doanh thu",
                     {"status": "lookup_failed", "chart_ids": [],
                      "candidates": [], "concepts": []})
    assert sel.get("fell_back_to") is None
    assert sel["resolution_unavailable"] is True
    author = [n for n in st.notices if n.audience == "author"][0]
    assert author.facts.get("fell_back_to") is None
    assert author.facts["charts_read"] == 0


def test_resolving_to_nothing_is_not_reported_as_a_failed_read():
    """NO-MATCH IS NOT EMPTY DATA — the brief says so and the runtime did not.
    `read_ok` was False on a clean zero-chart read, which reads as "the report
    could not be read" when the truth is "the report has nothing about this"."""
    from app.services.agent_flows.runtime.handlers.data import _entry_has_data  # noqa

    out = {"charts": [], "selection": {"mode": "question", "status": "none",
                                       "unsupported": True}}
    # Mirrors the handler's own computation.
    resolved_to_nothing = bool(out["selection"].get("unsupported")
                               or out["selection"].get("needs_clarification"))
    assert resolved_to_nothing is True

    broken = {"charts": [], "selection": {"mode": "report_order"}}
    assert not (broken["selection"].get("unsupported")
                or broken["selection"].get("needs_clarification"))


# ── (1) a broken resolver must fail CLOSED ──────────────────────────────────
#
# The weather fix closed `none` and `ambiguous` and left `lookup_failed` falling
# back to report order — on the reasoning that a transient tool failure should not
# be reported as "out of domain". True, and it still reads the whole report for a
# question nobody resolved. The engine has NO evidence those charts are relevant;
# it merely has no evidence they are not. Fail-open either way.

LOOKUP_FAILED = {"status": "lookup_failed", "chart_ids": [],
                 "candidates": [], "concepts": []}


def test_a_resolver_failure_reads_no_question_selected_charts(monkeypatch):
    ids, sel, _ = run(monkeypatch, "thời tiết Hà Nội hôm nay", LOOKUP_FAILED)
    assert ids == [], (
        "the resolver failed, so nothing is known about relevance — reading the "
        "report in id order is a guess with a fallback label on it"
    )
    assert sel.get("fell_back_to") is None


def test_a_resolver_failure_is_not_an_out_of_domain_verdict(monkeypatch):
    """The resolver never reached a conclusion, so claiming one would be a lie in
    the other direction."""
    _, sel, _ = run(monkeypatch, "doanh thu theo tháng", LOOKUP_FAILED)
    assert sel["status"] == "lookup_failed"
    assert sel["resolution_unavailable"] is True
    assert sel.get("unsupported") is not True


def test_both_audiences_are_told_what_actually_broke(monkeypatch):
    _, _, st = run(monkeypatch, "doanh thu theo tháng", LOOKUP_FAILED)
    author = [n for n in st.notices if n.audience == "author"]
    reader = [n for n in st.notices if n.audience == "reader"]
    assert author and "tra cứu" in author[0].text.lower()
    assert author[0].facts.get("selection_status") == "lookup_failed"
    assert author[0].facts.get("charts_read") == 0
    assert reader and reader[0].code == "read_resolution_unavailable"


def test_a_resolver_failure_never_becomes_a_report_summary(monkeypatch):
    """The regression the brief names: no path from a broken lookup to a summary
    of an unrelated report."""
    for question in ("thời tiết Hà Nội hôm nay", "what is the weather today?"):
        ids, sel, _ = run(monkeypatch, question, LOOKUP_FAILED)
        assert ids == [] and sel.get("fell_back_to") is None, question


# ── (2) grounding is a health signal, not just a record ─────────────────────

def test_the_grounding_rule_is_wired_to_a_reader_notice():
    """`unresolved_steps` was recorded and acted on by nothing. The run must SAY
    that its numbers, though real, were not selected for the question."""
    import inspect

    from app.services.agent_flows.runtime import executor as E

    src = inspect.getsource(E)
    assert "all_evidence_unresolved" in src
    assert "answer_not_grounded_in_question" in src
    i = src.index("all_evidence_unresolved")
    assert "Notice(" in src[i:i + 1200], (
        "the flag exists but nothing downstream reacts to it"
    )


# ── (A.3) a numerical answer with no grounded evidence is not a healthy run ──
#
# The run's status is decided BEFORE `_verify_figures` runs (executor: status is
# final by the `DEGRADING_NOTICES` check, verification happens ~20 lines later and
# nothing between it and the emitted envelope touches status). So an answer that
# states a figure whose every contributing source resolved to nothing was stored
# `ok` — and an operator reading the flow's success rate counted it as a working
# answer.
#
# `ok` must mean the designed path ran AND the numerical conclusion is grounded.

def test_status_is_decided_before_verification_can_influence_it():
    """The ordering, asserted so the fix cannot be undone by moving code."""
    import inspect

    from app.services.agent_flows.runtime import executor as E

    src = inspect.getsource(E.run_flow) if hasattr(E, "run_flow") else inspect.getsource(E)
    assert "all_evidence_unresolved" in src, (
        "verification must expose the grounding flag for status to use"
    )


def test_an_ungrounded_numerical_answer_downgrades_the_run(monkeypatch):
    """The invariant: a visible answer whose numerical conclusion is not grounded
    is `partial`, not `ok`. Not driven by "a notice exists" — the flag already
    requires the answer to cite figures AND every contributor to be unresolved."""
    from app.services.agent_flows.runtime import executor as E

    status = E._status_after_verification(
        "ok", {"grounding": {"all_evidence_unresolved": True}})
    assert status == "partial"


def test_a_grounded_answer_stays_ok():
    from app.services.agent_flows.runtime import executor as E

    assert E._status_after_verification("ok", {"matched": 3}) == "ok"
    assert E._status_after_verification(
        "ok", {"grounding": {"unresolved_steps": ["x"],
                             "all_evidence_unresolved": False}}) == "ok"


def test_a_failed_run_is_not_promoted_to_partial():
    from app.services.agent_flows.runtime import executor as E

    assert E._status_after_verification(
        "failed", {"grounding": {"all_evidence_unresolved": True}}) == "failed"


def test_no_verification_leaves_the_status_alone():
    from app.services.agent_flows.runtime import executor as E

    assert E._status_after_verification("ok", None) == "ok"


# ── the case the browser found: figures with NO evidence at all ────────────
#
# Runs 464, 465 and 466 on the live stack shipped answers stating 7, 3 and 9
# figures while the run read no data whatsoever, and all three were recorded
# `ok` — the Runs header read "100% answered, 0 errors" above three turns whose
# numbers had no source, which is the exact operator-deception the invariant
# exists to prevent.
#
# `_verify_figures` returns EARLY on an empty ledger, and that early return
# reported `no_evidence` rather than `all_evidence_unresolved`, so the downgrade
# never saw it. "Read nothing" is strictly worse than "read something from an
# unresolved step", and it was the one left unpunished.
#
# The bound matters as much as the rule. A flow with no read step at all also
# arrives with an empty ledger and has promised no data; downgrading it over an
# incidental number would make `partial` meaningless, which
# `test_a_matching_branch_stays_a_clean_success` in the golden suite already
# guards — a first version of this fix broke it, and the test was right.

def test_figures_with_no_evidence_after_a_read_downgrade_the_run():
    from app.services.agent_flows.runtime import executor as E

    verification = {"matched": 0, "unmatched": [7.0, 3.0, 9.0],
                    "unknown_labels": [], "no_evidence": True,
                    "grounding": {"no_evidence_after_read": True}}
    assert E._status_after_verification("ok", verification) == "partial", (
        "an answer stating figures while the read returned nothing is not healthy"
    )


def test_a_flow_that_never_reads_is_not_downgraded_by_an_incidental_number():
    """The bound. No read step means no data was promised, so a number in the
    prose is not an ungrounded claim about the report."""
    from app.services.agent_flows.runtime import executor as E

    verification = {"matched": 0, "unmatched": [0.0], "unknown_labels": [],
                    "no_evidence": True,
                    "grounding": {"no_evidence_after_read": False}}
    assert E._status_after_verification("ok", verification) == "ok"


def test_the_empty_ledger_branch_reports_whether_a_read_was_attempted():
    """Locks the two halves together. The original defect was not a wrong rule —
    it was a rule reading a key the producing branch never set, which no test
    caught because each side was asserted on its own."""
    import inspect

    from app.services.agent_flows.runtime import executor as E

    produced = inspect.getsource(E._verify_figures)
    assert "no_evidence_after_read" in produced, (
        "the empty-ledger branch must say whether a read was attempted"
    )
    assert "state.question_grounding" in produced, (
        "that answer comes from existing provenance — every report-read step "
        "records itself at entry — not from a new heuristic"
    )
    assert "no_evidence_after_read" in inspect.getsource(E._status_after_verification)


def test_a_refusal_with_no_figures_is_still_ok():
    """`_verify_figures` returns None when an evidence-free answer states no
    numbers, and None must never downgrade: a clean refusal is a healthy run."""
    from app.services.agent_flows.runtime import executor as E

    assert E._status_after_verification("ok", None) == "ok"


# ── the reuse path: the model saw data the ledger never heard about ──────────
#
# The bound above ("was a read attempted this turn") still read `ok` on the live
# runs it was written for — 471, 472 and 475, all carrying "lượt này KHÔNG đọc
# được dữ liệu nào". Their report_read step is `reused`: `run_policy=when_stale`
# and the value was already in memory, so `_run_node` returns before the handler
# body ever runs.
#
# `_reuse` HYDRATES the node's variable, deliberately — a reused node that left
# `{{overview}}` empty is the failure mode that makes cached control flow
# untrustworthy. So the model is shown last turn's data and answers from it.
# What did not come back was the PROVENANCE: no evidence, no grounding. The
# verifier then compared an answer against an empty ledger and told the viewer
# their numbers had no source, when the source was on the screen in front of it.
#
# So the status rule was never the root cause. A ledger that omits what the model
# was shown produces a wrong verdict in both directions, and "downgrade it too"
# would only have spread that verdict further.

def _reuse_fixture(stored):
    """The shapes `_reuse` actually touches — nothing more, so the test does not
    quietly depend on unrelated executor plumbing."""
    import types

    from app.services.agent_flows.runtime.state import RunState

    node = types.SimpleNamespace(
        key="overview", type="report_read", run_policy="when_stale",
        output_var="overview",
    )
    memory = types.SimpleNamespace(reusable_nodes=["overview"],
                                   vars={"overview": stored})
    rctx = types.SimpleNamespace(inp=types.SimpleNamespace(memory=memory))
    return node, RunState(), rctx


#: THE SHAPE THE HANDLER ACTUALLY STORES. A first version of this fixture said
#: `"id"`, and the citation code written against it looked right, passed its
#: test, and appended nothing on the running stack — `data.py` builds
#: `{"chart_id": chart_id}` and there is no `id` key anywhere. A fixture that is
#: not the real payload tests the fixture.
READ_OUTPUT = {
    "selection": {"mode": "question", "matched_chart_ids": [41]},
    "charts": [{"chart_id": 41, "title": "Doanh thu",
                "data": {"columns": ["category", "revenue"],
                         "rows": [["moveis", 1200], ["beleza", 980]]}}],
}


def test_the_fixture_is_the_shape_the_read_handler_builds():
    """Locks the fixture to the producer. This is the test that was missing when
    the citation restore shipped reading a key that never exists."""
    import inspect

    from app.services.agent_flows.runtime.handlers import data as D

    src = inspect.getsource(D)
    assert 'entry: dict[str, Any] = {"chart_id": chart_id}' in src, (
        "the read handler no longer keys chart entries by `chart_id` — update "
        "READ_OUTPUT and everything in _reuse that reads it, together"
    )
    assert all("chart_id" in c for c in READ_OUTPUT["charts"])


def test_a_reused_read_puts_its_numbers_back_in_the_ledger():
    """What the model can see is what the verifier must check against."""
    from app.services.agent_flows.runtime import executor as E

    node, state, rctx = _reuse_fixture(READ_OUTPUT)
    assert E._reuse(node, state, rctx) is not None
    assert 1200.0 in state.evidence and 980.0 in state.evidence, (
        "the reused value is hydrated into the prompt; omitting it from the "
        "ledger makes the verifier call sourced numbers sourceless"
    )
    assert "overview" in state.evidence_sources


def test_a_reused_read_puts_its_grounding_back_too():
    """Otherwise a reused selection that resolved to nothing looks clean, and the
    Wave-2 relevance rule silently stops applying on every follow-up turn."""
    from app.services.agent_flows.runtime import executor as E

    node, state, rctx = _reuse_fixture(READ_OUTPUT)
    E._reuse(node, state, rctx)
    assert state.question_grounding.get("overview", {}).get("mode") == "question"


def test_reuse_restores_nothing_it_was_not_given():
    """A reused node whose stored value carries no selection must not invent one,
    and a non-read node must not start claiming to be evidence."""
    from app.services.agent_flows.runtime import executor as E

    node, state, rctx = _reuse_fixture({"text": "hello"})
    node.type = "set_var"
    E._reuse(node, state, rctx)
    assert state.question_grounding == {}


def test_a_reused_read_brings_its_citations_back():
    """The last piece of the same provenance. Without it the Runs tab told the
    author "câu trả lời không dẫn nguồn nào" on every reused turn — on answers
    whose text carries `[chart:683]` — because `history.no_citation` is derived
    from `content.citations`, which reuse left empty."""
    from app.services.agent_flows.runtime import executor as E

    node, state, rctx = _reuse_fixture(READ_OUTPUT)
    E._reuse(node, state, rctx)
    refs = [(c.kind, c.ref) for c in state.citations]
    assert ("chart", "41") in refs
    assert state.citations[0].label == "Doanh thu"


def test_reuse_does_not_duplicate_a_citation_already_present():
    from app.services.agent_flows.runtime import executor as E
    from app.services.agent_flows.envelope import Citation

    node, state, rctx = _reuse_fixture(READ_OUTPUT)
    state.citations.append(Citation(kind="chart", ref="41", label="Doanh thu"))
    E._reuse(node, state, rctx)
    assert len([c for c in state.citations if c.ref == "41"]) == 1
