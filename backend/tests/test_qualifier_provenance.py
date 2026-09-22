# -*- coding: utf-8 -*-
"""The words around a number are claims, and a claim needs a source.

MEASURED, over Brazilian data with no currency declared anywhere:

    run A   "1,258,681.34 USD"
    run B   "1.258.681,34 VNĐ"

Both answers passed figure verification, because the digits were right. The
currency was invented twice, differently, and nothing looked at it.

`verify_answer` asks whether a figure exists in the evidence. It passes
"1.258.681,34 VNĐ doanh thu tháng 9" as readily as "1.258.681,34", and that
sentence carries three further assertions the verifier never examines: a unit, a
period, and (elsewhere) a claim about how far the data reaches.

ONE RULE, NOT FIVE:

    A QUALIFIER MAY BE STATED ONLY IF IT APPEARS IN THE EVIDENCE.

Deterministic, no model, and the same test the figure verifier applies to
numbers — extended to the words that give them meaning.

WHAT THESE CASES DELIBERATELY DO NOT ASSERT. Whether a qualifier is APT. A
period that appears in the evidence passes even if the answer attached it to the
wrong figure; catching that is the dimension work in `resolve_chart_candidates`,
not a text rule. And half the cases below exist for the FALSE POSITIVES, because
a correction round costs an LLM call and teaches the model to hedge a right
answer — each rule fires only when the evidence is positively silent.
"""
from __future__ import annotations

import os

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.agent_flows.qualifiers import check_qualifiers  # noqa: E402


#: A result with no unit declared — the shape `measure_meta` produces for a
#: measure the semantic layer never described. This is the common case: 161 of
#: 5,721 fields on this deployment carry a description.
NO_UNIT = {
    "ok": True,
    "data": {"measure": "revenue", "value": 1258681.34,
             "unit": None, "unit_known": False, "aggregation": "sum"},
}

#: And one where it IS declared.
DECLARED_BRL = {
    "ok": True,
    "data": {"measure": "revenue", "value": 1258681.34,
             "unit": "BRL", "unit_known": True, "aggregation": "sum"},
}

MONTHLY_ROWS = {
    "ok": True,
    "data": {"columns": ["year_month", "revenue"],
             "rows": [["2018-08", 1003308.47], ["2018-09", 166.46]],
             "aggregation": "sum"},
}

COVERAGE = {
    "ok": True,
    "data": {"from": "2016-09-04", "to": "2018-10-17", "grain": "month",
             "latest_period": "2018-10"},
}


def check(text, results, tools=()):
    return check_qualifiers(text, list(results), list(tools))


def kinds(violations):
    return sorted(v["kind"] for v in violations)


# ── UNIT ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("written", [
    "Doanh thu là 1.258.681,34 VNĐ.",
    "Revenue was 1,258,681.34 USD.",
    "Tổng doanh thu $1,258,681.34.",
    "Doanh thu 1.258.681,34 đồng.",
])
def test_an_undeclared_unit_cannot_be_asserted(written):
    """THE MEASURED FAILURE."""
    v = check(written, [NO_UNIT])
    assert "unit" in kinds(v), (
        f"{written!r}: a currency was asserted over a measure whose unit the "
        "semantic layer never declared"
    )


def test_a_declared_currency_is_preserved():
    """The rule must not cost a right answer its unit."""
    v = check("Doanh thu là 1.258.681,34 BRL.", [DECLARED_BRL])
    assert "unit" not in kinds(v)


def test_a_currency_present_in_the_evidence_passes_even_when_undeclared():
    """A document or a row that names the currency IS evidence. `unit_known` is
    the measure's own metadata, not the only place a unit can be established."""
    doc = {"ok": True, "data": {"passages": ["Toàn bộ số liệu quy đổi ra VNĐ."]}}
    v = check("Doanh thu 1.258.681,34 VNĐ.", [NO_UNIT, doc])
    assert "unit" not in kinds(v)


def test_a_number_with_no_unit_at_all_is_fine():
    v = check("Doanh thu là 1.258.681,34.", [NO_UNIT])
    assert v == []


def test_only_one_unit_violation_is_reported():
    """Five currency names in one sentence is one mistake, not five."""
    v = check("Doanh thu 1.000 USD tương đương 25.000.000 VNĐ.", [NO_UNIT])
    assert len([x for x in v if x["kind"] == "unit"]) == 1


# ── TIME ────────────────────────────────────────────────────────────────────

def test_a_coverage_range_cannot_come_from_a_row_sample():
    """The rows the run read are a sample. They cannot establish where the data
    starts and stops, and the tool that can was never called."""
    v = check("Dữ liệu trải dài từ 2016 đến 2018.", [MONTHLY_ROWS])
    assert "time" in kinds(v)


def test_the_same_range_is_fine_once_the_coverage_tool_has_run():
    v = check("Dữ liệu trải dài từ 2016 đến 2018.", [MONTHLY_ROWS, COVERAGE],
              tools=["describe_time_coverage"])
    assert "time" not in kinds(v)


def test_an_ordinary_sentence_about_a_month_is_not_a_coverage_claim():
    """Narrow on purpose: a range inside a chart's own reading is not a claim
    about the dataset's extent."""
    v = check("Doanh thu tháng 8 cao hơn tháng 9.", [MONTHLY_ROWS])
    assert "time" not in kinds(v)


# ── SCOPE ───────────────────────────────────────────────────────────────────

def test_an_all_time_scalar_cannot_be_called_september():
    """The run read one unfiltered total. Nothing in it is about September."""
    v = check("Doanh thu tháng 9 là 1.258.681,34.", [NO_UNIT])
    assert "scope" in kinds(v)
    assert any(v_["claim"].lower().startswith("tháng 9") for v_ in v
               if v_["kind"] == "scope")


def test_a_scoped_figure_may_name_its_period():
    """`2018-09` is in the rows, so the answer may be about it."""
    v = check("Doanh thu 2018-09 là 166,46.", [MONTHLY_ROWS])
    assert "scope" not in kinds(v)


def test_a_period_proven_by_a_filter_may_be_named():
    filtered = {
        "ok": True,
        "data": {"value": 166.46,
                 "filters_applied": [{"field": "order_date", "op": "between",
                                      "values": ["2018-09-01", "2018-09-30"]}]},
    }
    v = check("Doanh thu 2018-09 là 166,46.", [filtered])
    assert "scope" not in kinds(v)


def test_an_english_month_is_held_to_the_same_rule():
    v = check("September revenue was 1,258,681.34.", [NO_UNIT])
    assert "scope" in kinds(v)


# ── AGGREGATION ─────────────────────────────────────────────────────────────

def test_a_rate_is_not_renamed_a_total():
    rate = {"ok": True, "data": {"measure": "on_time_rate", "value": 91.89,
                                 "aggregation": "avg", "unit": "%",
                                 "unit_known": True}}
    v = check("Tổng tỷ lệ giao đúng hạn là 91,89%.", [rate])
    assert "aggregation" in kinds(v)


def test_a_sum_may_be_called_a_total():
    v = check("Tổng doanh thu là 1.258.681,34.", [NO_UNIT])
    assert "aggregation" not in kinds(v)


def test_a_run_that_both_summed_and_averaged_is_left_alone():
    """Fires only when EVERY declared aggregation is non-additive — otherwise the
    'total' in the answer may be about the thing that really was summed."""
    rate = {"ok": True, "data": {"aggregation": "avg", "value": 91.89}}
    v = check("Tổng doanh thu là 1.258.681,34.", [rate, NO_UNIT])
    assert "aggregation" not in kinds(v)


# ── and the two silences that must stay silent ──────────────────────────────

def test_a_refusal_with_no_numbers_is_untouched():
    """A clean refusal is healthy. The rule must not append a caveat to it."""
    v = check("Báo cáo này không có dữ liệu về GDP, nên tôi chưa trả lời được.",
              [NO_UNIT])
    assert v == []


def test_a_run_with_no_tool_results_is_not_judged():
    """Nothing was read, so the evidence cannot be 'silent' on anything. That
    case belongs to the figure verifier, which already owns it."""
    assert check("Doanh thu là 1.258.681,34 VNĐ tháng 9.", []) == []


def test_reused_evidence_still_carries_its_qualifiers():
    """A prior step's output is passed in as a result, so a range established
    earlier in the run is a real source and is not flagged."""
    prior = "STEP read: {'from': '2016-09-04', 'to': '2018-10-17'}"
    v = check("Dữ liệu trải dài từ 2016 đến 2018.", [MONTHLY_ROWS, prior],
              tools=["describe_time_coverage"])
    assert v == []


# ── the two false positives the live suite found ────────────────────────────
#
# BOTH WERE THIS FILE'S OWN RULE MISFIRING, found by running the 18 live cases
# after the first version shipped. Each cost an LLM correction round and attached
# a reader notice telling the viewer to double-check something the answer had not
# claimed — which is the failure mode this module's docstring says to fear.

def test_naming_a_period_to_deny_it_is_not_a_scope_claim():
    """MEASURED on the `no_data` case. The answer is the CORRECT refusal:

        "Báo cáo không chứa bất kỳ dữ liệu nào cho tháng 12 năm 2030."

    It attaches no figure to that month — it says there is none. The first
    version flagged it, so the rule now needs a number in the same sentence that
    is not part of the period's own digits.
    """
    v = check("Báo cáo không chứa bất kỳ dữ liệu nào cho tháng 12 năm 2030. "
              "Dữ liệu mới nhất có sẵn là từ năm 2017.", [NO_UNIT])
    assert "scope" not in kinds(v), (
        f"a correct refusal was flagged: {v}"
    )


def test_a_period_written_in_prose_matches_the_same_period_in_iso():
    """MEASURED on the `coverage` case. The answer wrote "tháng 09 năm 2016" and
    `describe_time_coverage` had returned "2016-09-04". Same month, two
    spellings, and the first version reported a correctly sourced period as
    unsourced. A rendering difference is not a provenance failure."""
    v = check("Dữ liệu được thu thập từ ngày 01 tháng 09 năm 2016.",
              [COVERAGE], tools=["describe_time_coverage"])
    assert "scope" not in kinds(v), (
        f"a period present in the evidence as ISO was reported missing: {v}"
    )


def test_a_period_the_evidence_really_does_not_reach_is_still_flagged():
    """The control for the case above. Coverage ends 2018-10-17; an answer that
    says the data stops in September 2018 is wrong, and softening the comparison
    must not have cost the rule that catch."""
    v = check("Dữ liệu kéo dài đến ngày 01 tháng 09 năm 2018.",
              [COVERAGE], tools=["describe_time_coverage"])
    assert "scope" in kinds(v)


def test_an_english_month_written_with_its_year_is_matched_canonically():
    v = check("September 2016 revenue was 1,234.", [COVERAGE],
              tools=["describe_time_coverage"])
    assert "scope" not in kinds(v)


def test_a_quarter_resolves_to_the_month_it_starts_in():
    v = check("Doanh thu quý 3 năm 2016 là 1.234.", [COVERAGE],
              tools=["describe_time_coverage"])
    assert "scope" not in kinds(v)
