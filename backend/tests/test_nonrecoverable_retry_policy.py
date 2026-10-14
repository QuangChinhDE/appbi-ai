# -*- coding: utf-8 -*-
"""A refusal does not become permission by asking again.

MEASURED, on a grant of three tools with no way to discover a chart id: the model
guessed an id, got `chart_out_of_scope`, and called `rank_values` with the SAME
arguments six times until "đã dùng hết số lượt gọi mô hình". Two of three
questions ended `failed` having produced nothing but six identical refusals.

`chart_out_of_scope` cannot become valid by retrying. Neither can `not_granted`,
a schema error, or an unsupported dimension: each says something about the
request, not about the moment. A provider timeout is the opposite — that one is
worth asking again.

THE CONTRACT ALREADY EXISTED AND THE LOOP IGNORED IT. `result.err()` has carried
`retryable` since the error taxonomy landed; the agent's tool loop never read it.
So this is not a new framework — it is the runtime honouring a field the tools
already fill in.

THE RULE, kept as narrow as the evidence: the same tool, with materially the same
arguments, after a non-retryable refusal, is not executed again. The model is
told why instead of being handed the same refusal a second time, and the budget
it would have burned stays available for a call that could work. Changed
arguments are a different request and are allowed.
"""
from __future__ import annotations

import pytest

from app.services.agent_flows.runtime.handlers import agent as AH


def key(name, args):
    return AH._retry_key(name, args)


# ── what counts as "the same request" ───────────────────────────────────────

def test_the_same_call_has_the_same_key():
    assert key("rank_values", {"chart_id": 999}) == key("rank_values", {"chart_id": 999})


def test_argument_order_does_not_make_it_a_different_request():
    a = key("rank_values", {"chart_id": 1, "top_n": 5})
    b = key("rank_values", {"top_n": 5, "chart_id": 1})
    assert a == b, "re-ordering the same arguments must not look like a new call"


def test_a_changed_argument_is_a_different_request():
    assert key("rank_values", {"chart_id": 1}) != key("rank_values", {"chart_id": 2})


def test_a_different_tool_is_a_different_request():
    assert key("rank_values", {"chart_id": 1}) != key("total_measure", {"chart_id": 1})


# ── which refusals are final ────────────────────────────────────────────────

@pytest.mark.parametrize("code", [
    "chart_out_of_scope", "not_granted", "bad_argument", "bad_tool_arguments",
    "not_applicable", "no_data",
])
def test_a_refusal_about_the_request_is_final(code):
    assert AH._is_final_refusal({"ok": False, "error_code": code}) is True, (
        f"{code} says something about the REQUEST — repeating the request cannot "
        "change the answer"
    )


@pytest.mark.parametrize("code", ["query_failed", "timeout", "provider_error"])
def test_a_refusal_about_the_moment_is_not_final(code):
    assert AH._is_final_refusal({"ok": False, "error_code": code}) is False, (
        f"{code} can succeed on a second attempt; blocking it would turn a "
        "transient fault into a permanent one"
    )


def test_an_explicit_retryable_flag_wins_over_the_code():
    """The tools carry the truth; the code list is the fallback for the ones
    that do not set it."""
    assert AH._is_final_refusal(
        {"ok": False, "error_code": "chart_out_of_scope", "retryable": True}) is False
    assert AH._is_final_refusal(
        {"ok": False, "error_code": "query_failed", "retryable": False}) is True


def test_a_success_is_never_a_refusal():
    assert AH._is_final_refusal({"ok": True, "data": {}}) is False


# ── and the budget it protects ──────────────────────────────────────────────

def test_the_second_identical_call_is_refused_without_reaching_the_tool():
    """The whole point: the model gets told why, the tool is never invoked, and
    the call that would have been burned is still available."""
    seen: dict[str, int] = {}
    executed: list[str] = []

    def execute(name, args):
        executed.append(name)
        return {"ok": False, "error_code": "chart_out_of_scope",
                "error": "chart_id 999 is not part of this dashboard."}

    first = AH._call_with_retry_policy("rank_values", {"chart_id": 999}, seen, execute)
    second = AH._call_with_retry_policy("rank_values", {"chart_id": 999}, seen, execute)

    assert first["ok"] is False and first["error_code"] == "chart_out_of_scope"
    assert executed == ["rank_values"], (
        "the tool ran twice — the second call burned budget on a request already "
        "answered"
    )
    assert second["ok"] is False
    assert second["error_code"] == "already_refused"
    assert "chart_out_of_scope" in str(second.get("error", "")), (
        "the second answer must name the original reason, or the model is being "
        "told 'no' without being told what to change"
    )


def test_changing_an_argument_reaches_the_tool_again():
    seen: dict[str, int] = {}
    executed: list[dict] = []

    def execute(name, args):
        executed.append(dict(args))
        return {"ok": False, "error_code": "chart_out_of_scope", "error": "x"}

    AH._call_with_retry_policy("rank_values", {"chart_id": 999}, seen, execute)
    AH._call_with_retry_policy("rank_values", {"chart_id": 686}, seen, execute)
    assert len(executed) == 2, "a corrected call was blocked as if it were a repeat"


def test_a_transient_failure_may_be_retried():
    seen: dict[str, int] = {}
    executed: list[str] = []

    def execute(name, args):
        executed.append(name)
        return {"ok": False, "error_code": "query_failed", "retryable": True,
                "error": "warehouse timed out"}

    AH._call_with_retry_policy("rank_values", {"chart_id": 1}, seen, execute)
    AH._call_with_retry_policy("rank_values", {"chart_id": 1}, seen, execute)
    assert len(executed) == 2, "a transient fault was treated as final"


def test_a_successful_call_can_be_made_again():
    """Asking the same question twice is not an error — a loop step legitimately
    re-reads the same chart."""
    seen: dict[str, int] = {}
    executed: list[str] = []

    def execute(name, args):
        executed.append(name)
        return {"ok": True, "data": {"value": 1}}

    AH._call_with_retry_policy("total_measure", {"chart_id": 1}, seen, execute)
    AH._call_with_retry_policy("total_measure", {"chart_id": 1}, seen, execute)
    assert len(executed) == 2
