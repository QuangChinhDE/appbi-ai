# -*- coding: utf-8 -*-
"""Unrelated evidence does not become the answer by being the only evidence.

THE FAILURE:

    web search   disabled
    question     "GDP của Việt Nam năm ngoái là bao nhiêu?"
    flow         a report read that succeeded at reading the report
    answer       an Olist summary

Every figure in it is verifiable. `verify_answer` finds them all in the
evidence, `all_evidence_unresolved` does not fire because nothing RESOLVED to
nothing — the read was never asked to match the question — and the run is stored
`ok`. An operator reading the flow's success rate counts it as a working answer.

WHY THE EXISTING PROVENANCE COULD NOT CATCH IT. It answers "where did this
number come from?", and the number really did come from where it says. Nothing
answered "did any capability actually service what was asked?". Those are
different questions: the first is about the figure, the second about the run.

THE RULE, and it is deliberately a rule about RECORDS, not about meaning. No LLM
relevance judge, no reading of the question text. A report-read step in
`question` mode RESOLVED the viewer's question to charts — a decision the
resolver already made and already recorded on the way in. Any other mode is the
AUTHOR having chosen the charts in advance, which says nothing about THIS
question. If a capability was skipped as unavailable and no step resolved the
question, the answer says so and the run is `partial`.

WHAT MUST SURVIVE IT, and half of these cases exist for that reason alone:
a disabled web step is not a verdict on a flow whose report genuinely answered,
and a run with no skipped capability is untouched.
"""
from __future__ import annotations

import os

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.agent_flows.runtime import executor as EX  # noqa: E402


class _State:
    """Only the three records the rule reads."""

    def __init__(self, skipped=None, grounding=None):
        self.skipped = dict(skipped or {})
        self.question_grounding = dict(grounding or {})


def gap(state, *, cites_numbers=True) -> dict:
    out: dict = {}
    EX._note_capability_gap(state, out, cites_numbers=cites_numbers)
    return out.get("grounding") or {}


# ── the failure ─────────────────────────────────────────────────────────────

def test_a_skipped_capability_with_nothing_servicing_the_question_is_a_gap():
    """THE GDP ANSWER. The web step could not run; the read never matched the
    question; the figures came from charts chosen in advance."""
    g = gap(_State(
        skipped={"web": "web_disabled"},
        grounding={"read": {"mode": "report_order"}},
    ))
    assert g["capability_gap"] is True
    assert g["capability_unavailable"] == ["web"]
    assert g["capability_serviced_intent"] is False


def test_the_gap_downgrades_the_run_from_ok():
    """Recording it changes nothing if the run still reports success."""
    verification = {"grounding": {"capability_gap": True}}
    assert EX._status_after_verification("ok", verification) == "partial"


def test_a_run_already_failed_is_not_promoted():
    verification = {"grounding": {"capability_gap": True}}
    assert EX._status_after_verification("failed", verification) == "failed"


def test_an_unsupported_question_mode_read_does_not_count_as_servicing():
    """The read tried to match the question and could not. That is the opposite
    of evidence that the intent was serviced."""
    for flag in ("unsupported", "needs_clarification", "resolution_unavailable"):
        g = gap(_State(
            skipped={"web": "web_disabled"},
            grounding={"read": {"mode": "question", flag: True}},
        ))
        assert g["capability_gap"] is True, flag


# ── and the legitimate alternatives, which must all survive ─────────────────

def test_web_off_but_the_report_answered_the_question_is_not_a_gap():
    """The explicit guard. A disabled web step is not a verdict on a flow whose
    report genuinely resolved what was asked."""
    g = gap(_State(
        skipped={"web": "web_disabled"},
        grounding={"read": {"mode": "question", "status": "semantic",
                            "selected_ids": [684]}},
    ))
    assert g["capability_serviced_intent"] is True
    assert g["capability_gap"] is False


def test_one_step_servicing_is_enough_when_another_did_not():
    """Multiple capabilities, one genuinely answers — do not reject the run
    because another step resolved to nothing."""
    g = gap(_State(
        skipped={"web": "web_disabled"},
        grounding={
            "read_a": {"mode": "question", "unsupported": True},
            "read_b": {"mode": "question", "status": "exact"},
        },
    ))
    assert g["capability_gap"] is False


def test_no_skipped_capability_means_the_rule_says_nothing():
    """A flow where the web step RAN — whatever it found — is out of scope, and
    so is a flow that never had one."""
    g = gap(_State(grounding={"read": {"mode": "report_order"}}))
    assert g == {}, (
        "the rule spoke about a run with no unavailable capability; it has no "
        "evidence to speak from"
    )


def test_a_branch_that_simply_did_not_run_is_not_an_unavailable_capability():
    """`skipped` records both, and only one of them is a missing capability."""
    g = gap(_State(
        skipped={"branch_b": "condition_false"},
        grounding={"read": {"mode": "report_order"}},
    ))
    assert g == {}


def test_an_answer_with_no_figures_is_not_flagged():
    """A clean refusal is healthy. Telling the viewer that numbers may be
    unrelated when the answer states none is a warning about nothing — the same
    false positive the sibling rule already learned."""
    g = gap(_State(
        skipped={"web": "web_disabled"},
        grounding={"read": {"mode": "report_order"}},
    ), cites_numbers=False)
    assert g["capability_gap"] is False
    assert g["capability_unavailable"] == ["web"], (
        "the FACT that the capability was unavailable is still recorded — only "
        "the warning is withheld"
    )


def test_the_skip_reason_is_matched_as_a_known_code_not_as_prose():
    assert "web_disabled" in EX._CAPABILITY_SKIPS
    g = gap(_State(
        skipped={"web": "web search was disabled by the link"},
        grounding={"read": {"mode": "report_order"}},
    ))
    assert g == {}, (
        "a free-text reason was matched as a capability code; the set exists so "
        "the next reason is ADDED to it rather than pattern-matched"
    )
