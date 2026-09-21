# -*- coding: utf-8 -*-
"""An answer with figures and NO evidence is the most suspect case, not the safest.

REPRODUCED DEFECT (P0). Both verification layers began with the same guard:

    _verify_figures   (executor)  ->  if not state.evidence: return None
    _figure_check     (agent)     ->  if not text or not state.evidence: return [], 0

So the numeric check switched itself off in exactly the situation it exists for.
SCENARIO E: the Report Read fails, nothing reaches the answering model, the model
answers "khoảng 12.000 đơn hàng" from its own memory of the domain — and because
there is no evidence to contradict it, zero figures are reported unsupported, no
verification block is emitted, and the run presents as healthy.

INVARIANT: absence of evidence is not evidence of support. A figure with nothing
behind it is unsupported, and it is unsupported *most* when the ledger is empty.

Not a refusal — the existing answer contract already handles a flagged figure.
What changes is that the flag is raised.
"""
import types

import pytest

from app.services.agent_flows.envelope import Answer
from app.services.agent_flows.runtime import executor as E


class _State:
    """Shaped like RunState for the fields the verifier reaches."""

    def __init__(self, evidence=None):
        self.evidence = evidence or []
        self.evidence_labels = set()
        self.question_grounding = {}
        self.notices = []
        self.citations = []
        self.outputs = {}
        self.trace = []


def answer(markdown):
    return Answer.model_validate({"blocks": [{"type": "text", "markdown": markdown}]})


# ── the reported scenario ────────────────────────────────────────────────────

def test_a_number_with_an_empty_ledger_is_reported_unsupported():
    """The read failed, so nothing is in evidence; the model answered anyway."""
    got = E._verify_figures(_State(evidence=[]),
                            answer("Tổng số đơn hàng khoảng 12.000 đơn."))
    assert got is not None, (
        "verification returned None on an empty ledger — the run then shows no "
        "verification at all, which is the defect"
    )
    assert got.get("unmatched"), "12.000 had nothing behind it and was not flagged"
    assert 12000 in [float(x) for x in got["unmatched"]] or \
        any(abs(float(x) - 12000) < 1 for x in got["unmatched"]), got["unmatched"]


def test_several_invented_figures_are_all_flagged():
    got = E._verify_figures(_State(evidence=[]),
                            answer("Doanh thu 10.000 và 12.000 đơn hàng."))
    assert len(got["unmatched"]) >= 2, got


def test_a_metric_block_counts_too():
    """A fabricated number in a metric tile is just as wrong as one in prose —
    arguably more so, because a tile reads as data."""
    a = Answer.model_validate({"blocks": [
        {"type": "text", "markdown": "Kết quả:"},
        {"type": "metric", "label": "Đơn hàng", "value": 12000, "format": "number"},
    ]})
    got = E._verify_figures(_State(evidence=[]), a)
    assert got and got.get("unmatched")


# ── what must NOT be flagged ─────────────────────────────────────────────────

def test_an_honest_refusal_carries_no_figures_and_is_not_flagged():
    """The correct behaviour when the read failed: say so. Nothing to verify."""
    got = E._verify_figures(
        _State(evidence=[]),
        answer("Tôi chưa đọc được dữ liệu của báo cáo nên chưa thể trả lời con số."))
    assert not (got or {}).get("unmatched"), got


def test_a_year_is_not_treated_as_a_business_figure():
    """Guard against the check becoming noise. The verifier's own parser decides;
    this test exists so a future change that makes every integer a finding fails
    here rather than in production."""
    got = E._verify_figures(_State(evidence=[]), answer("Báo cáo kỳ 2026."))
    flagged = [float(x) for x in (got or {}).get("unmatched", [])]
    assert 2026 not in flagged, flagged


def test_with_real_evidence_the_normal_path_is_unchanged():
    """A supported figure stays supported — this must not become 'flag everything'."""
    # `RunState.evidence` is a list of NUMBERS the tools actually returned — the
    # ledger the verifier matches against, not the raw payloads.
    state = _State(evidence=[99441.0, 13591643.7])
    got = E._verify_figures(state, answer("Số đơn hàng là 99.441."))
    assert got is not None, "a run WITH evidence must still be verified"
    assert not got.get("no_evidence"), "the empty-ledger branch must not fire here"
    assert not got.get("unmatched"), got["unmatched"]


def test_an_answer_with_no_numbers_at_all_is_quiet():
    got = E._verify_figures(_State(evidence=[]),
                            answer("Báo cáo này nói về doanh thu theo danh mục."))
    assert not (got or {}).get("unmatched")


def test_the_empty_ledger_case_is_marked_so_the_reader_is_told_the_right_thing():
    """"Does not match the data read" is the wrong sentence when nothing was read.
    The flag is what lets the run say the honest one."""
    got = E._verify_figures(_State(evidence=[]), answer("Khoảng 12.000 đơn hàng."))
    assert got.get("no_evidence") is True


# ── relevance is a separate question from existence ─────────────────────────

def test_a_verified_figure_from_unresolved_evidence_is_not_silently_healthy():
    """EVIDENCE TRUTH IS NOT QUESTION RELEVANCE.

    The reported case: an Olist assistant asked "thời tiết Hà Nội hôm nay"
    answered with GMV and orders. Every figure existed in the evidence, so the
    numeric check passed and the run looked healthy. It was not: the evidence had
    never been selected for that question.

    The verifier is NOT turned into a relevance judge — it still only asks whether
    a number exists. What changes is that the run carries WHY the evidence is
    there, so "the numbers check out" can no longer stand alone."""
    state = _State(evidence=[13591643.7])
    state.question_grounding = {"overview": {"mode": "question", "status": "none",
                                             "unsupported": True}}
    got = E._verify_figures(state, answer("Tổng doanh thu là 13.591.643,70."))

    assert not got.get("unmatched"), "the figure genuinely is in the evidence"
    assert got["grounding"]["unresolved_steps"] == ["overview"], (
        "a verified number from evidence that answered no question must not look "
        "like a grounded answer"
    )


def test_a_resolved_read_leaves_no_grounding_flag():
    state = _State(evidence=[13591643.7])
    state.question_grounding = {"overview": {"mode": "question", "status": "semantic",
                                             "selected_ids": [681]}}
    got = E._verify_figures(state, answer("Tổng doanh thu là 13.591.643,70."))
    assert "grounding" not in got


def test_an_explicit_report_overview_is_grounded_by_design():
    """`report_order` mode is an author saying "summarise this report". Its
    evidence answers the configured intent, so it is not unresolved."""
    state = _State(evidence=[13591643.7])
    state.question_grounding = {"overview": {"mode": "report_order"}}
    got = E._verify_figures(state, answer("Tổng doanh thu là 13.591.643,70."))
    assert "grounding" not in got
