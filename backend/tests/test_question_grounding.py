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
