# -*- coding: utf-8 -*-
"""A correct refusal is not an error, and the reader must be told which it was.

THE DEFECT THIS LOCKS.

Every reader surface counted its errors from `tool_result.ok`. That is a
TRANSPORT fact: it says a call returned no payload, and nothing about whether
anything went wrong. So three things that are not alike at all —

    a link correctly withholding a chart it does not share,
    a tool correctly declining a chart that has no date axis,
    a warehouse that actually fell over

— were counted identically, and a viewer who had just received a correct,
honest answer was shown `Đã đọc 3 bước · 3 lỗi` above it. A product that
reports its own governance working as three failures teaches readers not to
trust it, which is the opposite of what every guard in this module is for.

The classification a reader needs was never missing. `error_code` had it, and
`reader_error` was already translating that same code into the sentence the
viewer reads. The severity was simply dropped one layer before the only
consumer that needed it.

WHY THE TESTS ARE SHAPED THIS WAY.

The interesting assertions are not "the function returns a string". They are:

  * the three classes carve the codes the way a READER would — a scope boundary
    is not a failure, a broken warehouse is;
  * an unrecognised code fails towards `error`, because quietly downgrading an
    unknown failure to a notice hides real breakage;
  * the WIRE carries it, since a classification that never leaves the backend
    changes nothing;
  * `ok` keeps its old meaning, so nothing reading it had its contract changed
    underneath it.

WHAT IS DELIBERATELY NOT ASSERTED. The exact Vietnamese wording. That is
`reader_error`'s job and it has its own coverage; pinning prose here would make
this test fail on a copy edit that changed no behaviour.
"""
from __future__ import annotations

import pytest

from app.services.agent_flows.reader_diagnostics import (
    READER_OUTCOMES,
    reader_error,
    reader_outcome,
)
from app.services.agent_flows.wire import event_to_envelope


def _fail(code: str, **detail) -> dict:
    out: dict = {"ok": False, "error": "technical message for the model", "error_code": code}
    if detail:
        out["detail"] = detail
    return out


# ── the classification ───────────────────────────────────────────────────────

@pytest.mark.parametrize("code", [
    # Governance and scope. The system working exactly as designed.
    "chart_out_of_scope", "not_granted", "gated", "dimension_mismatch",
    # Ran fine, nothing to return. `result.py` says it outright: "NOT an error
    # to hide".
    "no_data", "not_applicable",
])
def test_a_correct_refusal_is_a_notice_not_an_error(code):
    assert reader_outcome(_fail(code)) == "notice", code


@pytest.mark.parametrize("code", ["chart_not_found", "bad_argument"])
def test_a_request_that_could_not_be_served_as_asked_is_a_limitation(code):
    """Worth telling the reader, and not a breakage — the agent usually recovers."""
    assert reader_outcome(_fail(code)) == "limitation", code


@pytest.mark.parametrize("code", ["query_failed", "internal", "unknown_tool"])
def test_a_real_failure_stays_an_error(code):
    assert reader_outcome(_fail(code)) == "error", code


@pytest.mark.parametrize("code", ["", "a_code_added_next_month", "totally_unknown"])
def test_an_unrecognised_code_fails_towards_error(code):
    """The one place this module does NOT say less when unsure.

    `reader_error` answers an unknown code with a generic sentence, because
    saying less is safe for TEXT. Severity is the opposite: downgrading an
    unrecognised failure to a notice would hide real breakage from the only
    person who can report it.
    """
    assert reader_outcome(_fail(code)) == "error", code


def test_success_is_not_a_failure_of_any_kind():
    assert reader_outcome({"ok": True, "kind": "ranking", "data": {}}) == "ok"
    # And a caller can classify anything, including a body that is not a result.
    assert reader_outcome(None) == "ok"
    assert reader_outcome("not a dict") == "ok"


def test_every_outcome_is_one_the_contract_declares():
    for code in ("chart_out_of_scope", "bad_argument", "query_failed", "nonsense", ""):
        assert reader_outcome(_fail(code)) in READER_OUTCOMES


# ── it has to reach the reader ───────────────────────────────────────────────

class _Event:
    """The shape `event_to_envelope` reads. Only the fields it touches."""

    def __init__(self, result):
        self.type = "tool_result"
        self.tool_name = "rank_values"
        self.tool_result = result
        self.tool_call_id = "call_1"


def test_the_wire_carries_the_outcome_to_every_reader_surface():
    """A classification that never leaves the backend changes nothing.

    `wire.py` is the ONE SSE format behind the public bot, the embed surface and
    Direct Chat, so asserting here covers all three — and a surface that started
    parsing events separately would be the regression, not this test.
    """
    env = event_to_envelope(_Event(_fail("chart_out_of_scope")))
    assert env["type"] == "tool_result"
    assert env["outcome"] == "notice"
    # The reader's sentence is still built from structured facts, not the
    # model-facing message.
    assert env["error"]
    assert "rank_values" not in env["error"]


def test_ok_keeps_its_old_meaning_so_nothing_reading_it_broke():
    """`outcome` is additive. `ok` still answers "did this call return a payload"."""
    refused = event_to_envelope(_Event(_fail("chart_out_of_scope")))
    assert refused["ok"] is False and refused["outcome"] == "notice"

    broken = event_to_envelope(_Event(_fail("query_failed")))
    assert broken["ok"] is False and broken["outcome"] == "error"

    fine = event_to_envelope(_Event({"ok": True, "kind": "value", "data": {"value": 1}}))
    assert fine["ok"] is True and fine["outcome"] == "ok"
    assert fine["error"] is None


def test_the_tool_name_a_reader_sees_is_still_the_products_word():
    """Unchanged behaviour, asserted because this envelope now has one more field
    and a future edit here must not quietly re-expose the registry id."""
    env = event_to_envelope(_Event(_fail("query_failed")))
    assert env["tool"] != "rank_values"
    assert "_" not in env["tool"]


def test_a_dimension_refusal_says_the_business_label_and_no_field_key():
    """The refusal that the reader-diagnostics module was written for.

    Kept here because it is now also the case that most needs to be classified
    correctly: it is the single most common way a governed answer is refused,
    and calling it an error made the safest possible outcome look like a crash.
    """
    result = _fail("dimension_mismatch", requested_label="Customer state",
                   requested_dimension="customer_state", chart_id=684)
    assert reader_outcome(result) == "notice"
    text = reader_error(result)
    assert "Customer state" in text
    assert "customer_state" not in text
    assert "684" not in text
