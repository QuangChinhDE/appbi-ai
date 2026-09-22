# -*- coding: utf-8 -*-
"""A release verdict has to add up.

The live harness printed `AUTO INVARIANTS: n/m clean` and, separately, a listing
of every broken subcheck grouped by the layer that owns it. Those are two
scoreboards with two denominators: a scenario could appear once as clean for one
property and again as broken for another, and no number in the output was "how
many scenarios passed". A release decision read off that is a decision read off
whichever half was quoted.

Each scenario now gets exactly ONE overall verdict, and the counts sum to the
case count. The subchecks are unchanged and still printed — they are the EVIDENCE
for the verdict, not a second scoreboard beside it.

THE HARNESS IS NOT RUNTIME, which is why this test exists rather than a note in
its docstring: `backend/scripts/**` is tooling, it has no CI gate of its own, and
the arithmetic it produces is what a release is signed off against. The module is
loaded by path because `backend/scripts` is not a package.
"""
from __future__ import annotations

import importlib.util
import pathlib

import pytest

_PATH = (pathlib.Path(__file__).resolve().parents[1]
         / "scripts" / "agent_flow_eval.py")


@pytest.fixture(scope="module")
def E():
    if not _PATH.exists():
        pytest.skip(f"the live-eval harness is not present here: {_PATH}")
    spec = importlib.util.spec_from_file_location("agent_flow_eval", _PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def obs(**over):
    base = {"status": "ok", "notices": [], "calls": [], "refusals": [],
            "citations": 0, "has_figure": False, "agent_calls": 0}
    base.update(over)
    return base


# ── one verdict per scenario ────────────────────────────────────────────────

def test_a_clean_run_passes(E):
    got, _ = E.verdict({"id": "x"}, obs(), [])
    assert got == "PASS"


def test_any_auto_failure_is_a_fail(E):
    """Every subcheck in `auto_score` is correctness-critical by construction —
    an ungranted tool, a scope breach, a blocked run, a figure with no source.
    There is no 'failed but only a little'."""
    for reason in ("capability: called web tool 'web_search'",
                   "scope: a tool was refused",
                   "bounded: the run was blocked",
                   "traceable: the answer carries figures with no tool call"):
        got, why = E.verdict({"id": "x"}, obs(), [reason])
        assert got == "FAIL", reason
        assert why == reason, "the verdict must carry the reason that decided it"


def test_a_case_that_did_not_run_is_a_fail_not_a_gap(E):
    got, _ = E.verdict({"id": "x"}, None, ["http: 500"])
    assert got == "FAIL"


def test_a_warning_notice_is_a_warn_not_a_pass(E):
    got, why = E.verdict({"id": "x"}, obs(notices=["figures_unverified"]), [])
    assert got == "WARN"
    assert "figures_unverified" in why


def test_a_partial_run_is_a_warn(E):
    got, why = E.verdict({"id": "x"}, obs(status="partial"), [])
    assert got == "WARN"
    assert "partial" in why


def test_an_auto_failure_outranks_a_notice(E):
    """A scenario may not be counted once as WARN and once as FAIL."""
    got, _ = E.verdict({"id": "x"},
                       obs(status="partial", notices=["figures_unverified"]),
                       ["capability: called an ungranted tool"])
    assert got == "FAIL"


def test_an_informational_notice_does_not_downgrade_a_clean_run(E):
    """Only notices that say the run distrusts itself count. Otherwise every
    run with any notice at all becomes WARN and the grade means nothing."""
    got, _ = E.verdict({"id": "x"}, obs(notices=["followup_suggested"]), [])
    assert got == "PASS"


# ── and the arithmetic ──────────────────────────────────────────────────────

def test_the_verdicts_sum_to_the_case_count(E):
    rows = [
        {"verdict": "PASS"}, {"verdict": "PASS"}, {"verdict": "WARN"},
        {"verdict": "FAIL"}, {"verdict": "FAIL"}, {"verdict": "FAIL"},
    ]
    counts = E.tally(rows)
    assert counts == {"PASS": 2, "WARN": 1, "FAIL": 3, "total": 6,
                      "balanced": True}
    assert counts["PASS"] + counts["WARN"] + counts["FAIL"] == counts["total"]


def test_every_verdict_is_one_of_exactly_three(E):
    for case in (obs(), obs(status="partial"), obs(notices=["read_truncated"])):
        got, _ = E.verdict({"id": "x"}, case, [])
        assert got in ("PASS", "WARN", "FAIL")
    assert E.verdict({"id": "x"}, obs(), ["scope: x"])[0] in ("PASS", "WARN", "FAIL")


def test_an_empty_run_is_balanced_and_says_nothing(E):
    counts = E.tally([])
    assert counts["total"] == 0 and counts["balanced"] is True


def test_a_row_with_no_verdict_is_a_hard_error_not_a_silent_zero(E):
    """A case that fell out of the accounting must not be invisible. `tally`
    raising is the honest outcome — a counter that skips it would print a total
    that looks right and is not."""
    with pytest.raises(KeyError):
        E.tally([{"verdict": "PASS"}, {}])
