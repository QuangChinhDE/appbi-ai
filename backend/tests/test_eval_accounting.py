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
            "citations": 0, "has_figure": False, "agent_calls": 0,
            "answer": ""}
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


# ── the semantic judge ──────────────────────────────────────────────────────
#
# `auto_score` reads the trace and cannot see a substituted concept. Measured:
# one run marked `out_of_scope_measure` PASS while the answer read "Danh mục có
# doanh thu cao nhất là health_beauty" — a different question answered without a
# caveat, which that case's own judge calls a FAIL. These assertions close that,
# and a semantic failure is a FAIL rather than a WARN because the whole point is
# that the trace was clean while the answer was wrong.


def test_a_category_offered_as_a_state_is_a_semantic_failure(E):
    fail = E.sem_no_category_as_state(
        obs(answer="Danh mục có doanh thu cao nhất là health_beauty."))
    assert fail and "health_beauty" in fail


def test_declining_while_naming_the_category_is_not_a_failure(E):
    """The honest answer mentions what the report DOES have. Flagging that would
    punish the correct behaviour."""
    assert E.sem_no_category_as_state(obs(
        answer="Báo cáo không có doanh thu theo bang; chỉ có theo danh mục "
               "(health_beauty, ...).")) is None


def test_an_invented_currency_is_a_semantic_failure(E):
    assert E.sem_no_invented_currency(obs(answer="Doanh thu 1.258.681,34 VNĐ."))
    assert E.sem_no_invented_currency(obs(answer="Revenue was 1,258,681.34 USD."))
    assert E.sem_no_invented_currency(obs(answer="Doanh thu là 1.258.681,34.")) is None


def test_a_report_figure_answering_an_external_question_is_a_failure(E):
    assert E.sem_no_report_answer_to_an_external_question(
        obs(answer="GMV là 15,843,553.24.", has_figure=True))
    assert E.sem_no_report_answer_to_an_external_question(
        obs(answer="Tôi không thể tra cứu GDP vì tìm kiếm web đang tắt.",
            has_figure=False)) is None


def test_a_bare_ninety_nine_percent_collapse_is_a_failure(E):
    assert E.sem_edge_not_reported_as_a_complete_collapse(
        obs(answer="Doanh thu giảm -99.98%, xấu đi."))
    assert E.sem_edge_not_reported_as_a_complete_collapse(
        obs(answer="Giá trị -99.98% đến từ một kỳ bất thường, chưa đủ dữ liệu.")
    ) is None


def test_repeated_dead_retries_are_a_failure(E):
    assert E.sem_no_dead_retry_exhaustion(
        obs(refusals=["rank_values(already_refused)"] * 4))
    assert E.sem_no_dead_retry_exhaustion(
        obs(refusals=["rank_values(already_refused)"])) is None
    assert E.sem_no_dead_retry_exhaustion(obs(status="blocked"))


def test_a_semantic_failure_outranks_a_clean_trace(E):
    got, why = E.verdict({"id": "out_of_scope_measure"}, obs(), [],
                         ["semantic: substituted a category for a state"])
    assert got == "FAIL"
    assert "substituted" in why


def test_an_auto_failure_still_outranks_a_semantic_one(E):
    """One verdict per scenario: a case may not be counted twice."""
    got, _ = E.verdict({"id": "x"}, obs(), ["capability: called a web tool"],
                       ["semantic: something"])
    assert got == "FAIL"


def test_the_five_historical_failures_all_carry_an_assertion(E):
    """D1–D5 are the reason this file exists. If one loses its assertion the
    eval quietly stops testing it."""
    for case in ("compare", "out_of_scope_measure", "web_denied", "budget"):
        assert E.SEMANTIC_ASSERTIONS.get(case), case
    # D4's qualifier failure is asserted across every case that states a figure.
    assert E.sem_no_invented_currency in E.SEMANTIC_ASSERTIONS["ranking"]


def test_semantic_score_is_silent_on_a_case_with_no_assertions(E):
    assert E.semantic_score({"id": "off_topic_2"}, obs()) == []
    assert E.semantic_score({"id": "out_of_scope_measure"}, None) == []


def test_an_allowed_chart_read_is_not_a_scope_breach(E):
    """THE FALSE FAIL. The harness used to flag "read a chart outside the
    allowlist" whenever any chart read appeared in a run expecting a refusal —
    but the trace carries tool NAMES, not chart ids, so it could not tell the
    engine's own overview read of a GRANTED chart from a forbidden one. Measured
    on the release candidate: it failed a run whose answer correctly declined."""
    bad = E.auto_score(
        {"id": "out_of_scope_chart", "expect_refusal": True},
        obs(calls=["inspect_filters", "list_charts", "get_chart_summary"],
            refusals=[]))
    assert not [b for b in bad if b.startswith("scope:")], bad


def test_a_real_scope_refusal_is_still_reported_as_expected(E):
    """And the branch that CAN see a breach is untouched: an unexpected refusal
    in any other case is still a scope failure."""
    bad = E.auto_score({"id": "ranking"},
                       obs(refusals=["rank_values(chart_out_of_scope)"]))
    assert any(b.startswith("scope:") for b in bad), bad


def test_the_out_of_scope_case_now_asserts_the_decline(E):
    assert E.sem_declines_the_out_of_scope_chart(
        obs(answer="Biểu đồ số 720 không có trong các biểu đồ đã đọc.")) is None
    assert E.sem_declines_the_out_of_scope_chart(
        obs(answer="Biểu đồ 720 cho thấy điểm đánh giá trung bình là 4.1."))
    assert E.sem_declines_the_out_of_scope_chart(
        obs(answer="Đây là doanh thu theo danh mục."))
