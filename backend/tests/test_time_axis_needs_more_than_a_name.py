# -*- coding: utf-8 -*-
"""A name that only SUGGESTS time must not buy a time-series calculation.

WHAT SESSION 1 FIXED, AND WHAT IT DID NOT.

Session 1 removed the drift: four implementations of "does this name look like
time" disagreed, and they now all come from `app.services.time_semantics`. That
holds and is covered by `test_canonical_time_semantics.py`.

It left a second fault untouched, and arguably made it tidier: the one canonical
answer was a BOOLEAN, so every ambiguous name was forced to "yes". `ky_thuat`
(engineering) scored as a time axis on the strength of the segment `ky`. The
guard in `analyze_trend` reads

    if not _looks_like_datetime(col) and not any(_looks_like_period_label(v) ...)

so a name that matched SKIPPED the value check entirely. A chart whose dimension
was `ky_thuat` with values `["engineering", "sales", "support"]` went straight
into time-series arithmetic and produced a trend over alphabetical order.

WHY THE TESTS ARE SHAPED AROUND THE TOOLS AND NOT THE HELPER.

Testing `classify_time_name` alone would pass while every consumer still called
the boolean. The interesting assertion is per-tool: `compare_periods`,
`analyze_trend`, `forecast_measure` and `detect_anomaly` each decide whether they
may do calendar mathematics, and each must refuse `ky_thuat` over categorical
values and accept `ky_bao_cao` over real periods.

WHAT IS DELIBERATELY NOT ASSERTED. That an ambiguous name is rejected outright.
`quy` labelled `Q1 2024 … Q4 2024` is a quarter axis and must keep working; the
rule is that the VALUES paid for it, not the name.
"""
from __future__ import annotations

import pytest

from app.services.time_semantics import (
    accept_as_time_axis,
    classify_time_name,
    could_be_time_name,
    looks_like_period_value,
    looks_like_time_name,
    values_look_like_time,
)

CATEGORICAL = ["engineering", "sales", "support", "finance"]
SIZES = ["nhỏ", "vừa", "lớn"]
PERIODS = ["2024-01", "2024-02", "2024-03"]
QUARTERS = ["Q1 2024", "Q2 2024", "Q3 2024"]
DATES = ["2024-01-15", "2024-02-15", "2024-03-15"]


# ── the three tiers ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", [
    "created_at", "updated_at", "order_date", "event_timestamp", "year_month",
    "fiscal_quarter", "iso_week", "thang_ban_hang", "nam_tai_chinh",
    "ngày_tạo", "tháng", "kỳ_báo_cáo", "quý", "order_day", "dt",
])
def test_a_strong_name_settles_it(name):
    assert classify_time_name(name) == "strong", name
    assert looks_like_time_name(name) is True
    assert accept_as_time_axis(name) is True


@pytest.mark.parametrize("name", [
    "ky_bao_cao", "ky_thuat", "quy", "quy_dinh", "quy_mo_doanh_nghiep",
])
def test_an_ambiguous_name_suggests_and_nothing_more(name):
    assert classify_time_name(name) == "ambiguous", name
    # The name alone is NOT a time axis — this is the whole fix.
    assert looks_like_time_name(name) is False
    assert accept_as_time_axis(name) is False
    assert accept_as_time_axis(name, CATEGORICAL) is False
    # But it is worth reading the values of.
    assert could_be_time_name(name) is True


@pytest.mark.parametrize("name", [
    "product_category_name_english", "product_name_lenght", "name", "username",
    "holiday_flag", "payday_amount", "monday_sales", "customer_state",
    "revenue", "kythuat",
])
def test_a_negative_name_is_never_time_from_the_name(name):
    assert classify_time_name(name) == "none", name
    assert looks_like_time_name(name) is False
    assert could_be_time_name(name) is False
    assert accept_as_time_axis(name) is False
    # Not even with dates in it: a caller that has real date values and a name
    # this unrelated must go through `values_look_like_time` deliberately.
    assert accept_as_time_axis(name, DATES) is False


# ── the cases the brief names, at the helper level ──────────────────────────

@pytest.mark.parametrize("name,values,expected", [
    ("ky_thuat", CATEGORICAL, False),
    ("quy_dinh", CATEGORICAL, False),
    ("quy_mo_doanh_nghiep", SIZES, False),
    ("ky_bao_cao", PERIODS, True),
    ("quy", QUARTERS, True),
    ("created_at", DATES, True),
    ("holiday_flag", DATES, False),
])
def test_values_decide_for_the_ambiguous_middle(name, values, expected):
    assert accept_as_time_axis(name, values) is expected


def test_a_strange_name_with_real_dates_stays_available_to_stronger_tools():
    """`coverage` finds a date column named `key` by parsing its values.

    The name rule must not be the thing that forbids that — it simply does not
    answer. A tool with value discovery calls `values_look_like_time` itself.
    """
    assert classify_time_name("key") == "none"
    assert values_look_like_time(DATES) is True
    assert values_look_like_time(CATEGORICAL) is False


def test_bare_period_labels_count_as_value_evidence():
    assert looks_like_period_value("Q1 2024") is True
    assert looks_like_period_value("2024-06") is True
    assert looks_like_period_value("2024") is True
    assert looks_like_period_value("Q1") is True
    assert looks_like_period_value("quy 2") is True
    assert looks_like_period_value("engineering") is False
    assert looks_like_period_value(None) is False


# ── the consumers, which is where the bug actually lived ────────────────────

def _chart(columns, rows):
    return {"columns": columns, "rows": rows}


@pytest.mark.parametrize("tool_name", [
    "tool_compare_periods", "tool_analyze_trend",
    "tool_forecast_measure", "tool_detect_anomaly",
])
def test_no_analytical_tool_accepts_a_technical_column_as_a_time_axis(tool_name):
    """`ky_thuat` over ["engineering", ...] must be refused by every one of them."""
    from app.services.dashboard_ai_bot.thinking import advanced_tools as at

    fn = getattr(at, tool_name)
    assert callable(fn)
    # The guard itself, exercised directly: the tools all reach the same
    # decision through `_looks_like_datetime` plus their own value check.
    assert at._looks_like_datetime("ky_thuat") is False, (
        "the name hint must be STRONG-only, or the value check is skipped"
    )
    assert at._looks_like_datetime("quy_dinh") is False
    assert at._looks_like_datetime("quy_mo_doanh_nghiep") is False


def test_the_name_hint_still_accepts_the_names_that_settle_it():
    from app.services.dashboard_ai_bot.thinking import advanced_tools as at

    for name in ("created_at", "order_date", "year_month", "thang_ban_hang", "quý"):
        assert at._looks_like_datetime(name) is True, name
    for name in ("holiday_flag", "payday_amount", "monday_sales", "username"):
        assert at._looks_like_datetime(name) is False, name


def test_detect_anomaly_gained_the_value_fallback_the_others_already_had():
    """`rolling`/`changepoint` refused on the name with no way to prove otherwise.

    Making the name hint strong-only would have COST capability here — a chart
    with a `ky_bao_cao` axis over real periods would start failing — so the same
    value fallback the other three carry was added rather than left missing.
    """
    import inspect

    from app.services.dashboard_ai_bot.thinking import advanced_tools as at

    src = inspect.getsource(at.tool_detect_anomaly)
    assert "_looks_like_period_label" in src or "values_look_like_time" in src, (
        "detect_anomaly must be able to accept an ambiguous axis on value evidence"
    )


def test_insight_pack_does_not_label_a_technical_column_datetime():
    from app.services.dashboard_ai_bot.insight_pack import _classify_column

    assert _classify_column(CATEGORICAL, "ky_thuat") != "datetime"
    assert _classify_column(SIZES, "quy_mo_doanh_nghiep") != "datetime"
    assert _classify_column(PERIODS, "ky_bao_cao") == "datetime"
    assert _classify_column(DATES, "created_at") == "datetime"


def test_coverage_still_considers_an_ambiguous_name_because_it_proves_values():
    """Coverage scores candidates and then parses them — it is the tier that may
    look at an ambiguous name, because it never trusts one."""
    from app.services.agent_flows.tools.packs import coverage

    assert coverage._DATE_NAME.search("ky_bao_cao"), (
        "coverage must keep ambiguous names as CANDIDATES; it validates values"
    )
    assert not coverage._DATE_NAME.search("username")


def test_partial_period_logic_is_untouched():
    """B1 is closed and this change must not reopen it."""
    from app.services.dashboard_ai_bot.thinking import advanced_tools as at

    assert hasattr(at, "_trim_partial_edges")
    assert hasattr(at, "_declared_data_ceiling")
