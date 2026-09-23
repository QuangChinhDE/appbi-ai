# -*- coding: utf-8 -*-
"""A low final period is a question. Only the filters can answer it.

THE ORIGINAL DEFECT, measured on real Olist data:

    compare_periods(chart 684)  ->  current  2018-09 = 166.46
                                    baseline 2018-08 = 1,003,308.47
                                    pct_change -99.98,  verdict "worsening"

2018-09 is a data-cutoff stub. The reader was told revenue collapsed by 99.98%.

THE FIRST FIX WAS WRONG IN THE OTHER DIRECTION, and this file exists mostly to
say why. It dropped any edge bucket under 15% of the median and reported
`partial_last: True` with a note reading "Kỳ 2018-09 chưa đủ dữ liệu" — a
statement about the calendar, derived from nothing but the size of a number.

A business whose revenue genuinely collapsed produces the IDENTICAL series. So
the second version would have hidden a real collapse and reported a calm figure
between the two healthy months before it. One confident wrong answer traded for
another.

WHAT THIS FILE LOCKS

1. Magnitude alone cannot distinguish the two. The two controls below are
   byte-identical in their values and differ only in what the applied filters
   declare; the tool must not claim the calendar fact for the one that has no
   evidence for it.
2. The one completeness fact reachable at this cost IS used: a filter saying the
   data stops before the bucket's period ends PROVES the bucket is partial.
3. The observed final value never disappears from the payload merely by being
   low — `observed_latest` is unconditional.

No Olist dates are hardcoded. The series is synthetic and the low edge is defined
the way the canonical helper defines it, so the test moves with the helper rather
than against it.
"""
from __future__ import annotations

import pytest

from app.services.dashboard_ai_bot.thinking import advanced_tools as A


class _Ctx:
    """Only what the tool touches."""

    def assert_chart_in_scope(self, chart_id: int) -> None:
        return None


#: Twelve complete months plus a final bucket at 1.0. Against a median near 1,000
#: that is far under the helper's 15% floor — which is what makes it a LOW EDGE,
#: and, on its own, nothing more than that.
COMPLETE = [(f"2024-{m:02d}", 1000.0 + m * 10) for m in range(1, 13)]
LOW_FINAL = COMPLETE + [("2025-01", 1.0)]

#: CONTROL A — the data is declared to stop on 2025-01-04, four days into a
#: thirty-one day month. January is provably a stub.
CUTOFF_FILTERS = [{"field": "order_date", "op": "<=", "value": "2025-01-04"}]

#: CONTROL B — same numbers, no such declaration. January may have ended badly.
NO_FILTERS: list[dict] = []


def _chart(series, filters):
    return {
        "columns": ["order_date_dim.year_month", "revenue"],
        "rows": [[label, value] for label, value in series],
        "filters_applied": list(filters),
    }


@pytest.fixture(autouse=True)
def _stub(monkeypatch):
    """Stub the warehouse only. Every decision under test is real code."""
    holder = {"series": LOW_FINAL, "filters": NO_FILTERS}

    def fake_fetch(ctx, chart_id, **kw):
        return _chart(holder["series"], holder["filters"])

    monkeypatch.setattr(A, "_fetch_chart_data", fake_fetch)
    monkeypatch.setattr(A, "_attach_delta_unit",
                        lambda ctx, chart_id, measure, payload: payload)
    return holder


def run(mode=None, **extra):
    args = {"chart_id": 1, **extra}
    if mode:
        args["mode"] = mode
    return A.tool_compare_periods(_Ctx(), args)


# ── the fact that magnitude cannot establish ────────────────────────────────

def test_the_two_controls_are_the_same_numbers(_stub):
    """If they ever differ, every case below is testing something else."""
    _stub["filters"] = CUTOFF_FILTERS
    a = run("mom")["data"]
    _stub["filters"] = NO_FILTERS
    b = run("mom")["data"]
    assert a["observed_latest"] == b["observed_latest"]
    assert a["excluded_periods"] == b["excluded_periods"]


@pytest.mark.parametrize("mode", [None, "auto", "mom", "yoy"])
def test_an_unexplained_low_edge_is_not_called_an_incomplete_period(_stub, mode):
    """THE REOPENED FINDING. Identical numbers, no declared cutoff: the tool may
    say the value is suspicious, and may not say the period was short."""
    _stub["filters"] = NO_FILTERS
    data = run(mode)["data"]

    assert data["partial_last"] is False, (
        f"mode={mode}: the tool asserted the final period was incomplete with "
        "nothing but its magnitude to go on. A genuine collapse produces this "
        "exact series."
    )
    assert data["edge_completeness"] == "suspected_incomplete"
    assert data["edge_completeness_basis"] == "low_outlier_vs_median"


@pytest.mark.parametrize("mode", [None, "auto", "mom", "yoy"])
def test_a_declared_cutoff_does_prove_it(_stub, mode):
    """And the honesty must not cost the tool the case it CAN establish."""
    _stub["filters"] = CUTOFF_FILTERS
    data = run(mode)["data"]

    assert data["partial_last"] is True, (
        f"mode={mode}: the applied filter stops the data on 2025-01-04, inside a "
        "31-day month. That is proof, and refusing to use it would make the tool "
        "useless on exactly the case it was built for."
    )
    assert data["edge_completeness"] == "proven_incomplete"
    assert data["edge_completeness_basis"] == "declared_filter_upper_bound"


def test_the_note_says_which_of_the_two_it_is(_stub):
    """The note is what the model reads. It must not claim the calendar fact when
    the calendar fact is not known."""
    _stub["filters"] = NO_FILTERS
    unproven = run("mom")["data"]["note_partial"]
    _stub["filters"] = CUTOFF_FILTERS
    proven = run("mom")["data"]["note_partial"]

    assert "bộ lọc" in proven and "KHÔNG phải kết quả cả kỳ" in proven
    assert "chưa đủ dữ liệu" not in unproven, (
        "the unproven note asserts missing data — that is the original defect "
        "in the note text rather than in the flag"
    )
    assert "sụt giảm thật" in unproven, (
        "the unproven note must offer the reader BOTH readings; naming only one "
        "of them is choosing silently"
    )


# ── a real collapse cannot vanish for being small ───────────────────────────

@pytest.mark.parametrize("filters", [NO_FILTERS, CUTOFF_FILTERS])
@pytest.mark.parametrize("mode", [None, "auto", "mom", "yoy"])
def test_the_observed_final_value_is_always_in_the_payload(_stub, filters, mode):
    """The regression the first fix would have introduced: excluding the edge
    from the COMPARISON must never remove it from the ANSWER."""
    _stub["filters"] = filters
    data = run(mode)["data"]
    assert data["observed_latest"] == {"label": "2025-01", "value": 1.0}, (
        "the real latest value is missing or altered — a reader asking 'how is "
        "this month going' has been handed a series that stops a month early"
    )


@pytest.mark.parametrize("mode", [None, "auto", "mom", "yoy"])
def test_the_low_edge_is_still_not_the_headline_comparison(_stub, mode):
    """Unchanged from the original fix: whatever the cause, comparing a stub
    against a full month manufactures a -99.98%."""
    _stub["filters"] = NO_FILTERS
    data = run(mode)["data"]
    assert data["current"]["label"] != "2025-01", (
        f"mode={mode}: the 1.0 bucket was compared as a real latest period"
    )
    assert data["pct_change"] is None or data["pct_change"] > -90
    assert any(e.get("label") == "2025-01" for e in data.get("excluded_periods") or [])


# ── and the ordinary case still works ───────────────────────────────────────

def test_a_complete_series_claims_nothing_about_its_edges(_stub):
    _stub["series"] = COMPLETE
    data = run("mom")["data"]
    assert data["current"]["label"] == "2024-12"
    assert data["baseline"]["label"] == "2024-11"
    assert not (data.get("excluded_periods") or [])
    assert data["partial_last"] is False
    assert data["edge_completeness"] == "not_suspected"
    assert data["edge_completeness_basis"] is None
    assert "note_partial" not in data


def test_a_cutoff_filter_alone_does_not_condemn_a_healthy_final_month(_stub):
    """The filter proves the period is short; it does not make a full-looking
    month suspicious. Both halves have to hold before the tool excludes."""
    _stub["series"] = COMPLETE
    _stub["filters"] = CUTOFF_FILTERS
    data = run("mom")["data"]
    assert data["current"]["label"] == "2024-12"
    assert data["partial_last"] is False
    assert data["edge_completeness"] == "not_suspected"


def test_yoy_still_reaches_twelve_months_back(_stub):
    _stub["series"] = COMPLETE
    data = run("yoy")["data"]
    assert data["current"]["label"] == "2024-12"
    assert data["baseline"]["label"] == "2024-01"


def test_custom_mode_is_untouched_because_the_caller_named_both_periods(_stub):
    data = run("custom", period_a="2025-01", period_b="2024-12")["data"]
    assert data["current"]["label"] == "2025-01"
    assert data["baseline"]["label"] == "2024-12"


def test_a_short_series_does_not_lose_its_only_points(_stub):
    """The helper refuses to trim below three points; the comparison must still
    produce an answer rather than an error."""
    _stub["series"] = [("2024-01", 100.0), ("2024-02", 120.0)]
    res = run("mom")
    assert res.get("ok") is True, res
    assert res["data"]["current"]["label"] == "2024-02"


# ── the two tools still agree about what they TRIMMED ───────────────────────

def test_compare_periods_and_analyze_trend_trim_the_same_buckets(_stub):
    """`analyze_trend` trims low edges to fit a line, which is a modelling choice
    and stays one. What must not drift is WHICH buckets the two tools set aside
    on the same series."""
    _stub["filters"] = NO_FILTERS
    cmp_data = run("mom")["data"]
    trend = A.tool_analyze_trend(_Ctx(), {"chart_id": 1})
    assert trend.get("ok") is True, trend

    cmp_excluded = {e["label"] for e in (cmp_data.get("excluded_periods") or [])}
    trend_excluded = {e["label"] for e in (trend["data"].get("excluded_periods") or [])}
    assert cmp_excluded == trend_excluded, (
        f"compare_periods excluded {cmp_excluded} and analyze_trend excluded "
        f"{trend_excluded} on the SAME series — two answers to one question"
    )


# ── the period arithmetic the proof rests on ────────────────────────────────

def test_a_period_label_resolves_to_the_day_its_period_ends():
    import datetime as dt

    assert A._period_end("2025-01") == dt.date(2025, 1, 31)
    assert A._period_end("2024-02") == dt.date(2024, 2, 29)      # leap
    assert A._period_end("2023-02") == dt.date(2023, 2, 28)
    assert A._period_end("2100-02") == dt.date(2100, 2, 28)      # not a leap year
    assert A._period_end("2024-06-15") == dt.date(2024, 6, 15)
    assert A._period_end("2024") == dt.date(2024, 12, 31)
    assert A._period_end("Q2 2024") == dt.date(2024, 6, 30)
    assert A._period_end("2024-Q4") == dt.date(2024, 12, 31)
    assert A._period_end("health_beauty") is None
    assert A._period_end("2024-13") is None


def test_only_an_upper_bound_on_a_time_field_is_a_ceiling():
    import datetime as dt

    ceiling = A._declared_data_ceiling
    assert ceiling([{"field": "order_date", "op": "<=", "value": "2025-01-04"}]) \
        == dt.date(2025, 1, 4)
    # `<` admits up to the day before.
    assert ceiling([{"field": "order_date", "op": "<", "value": "2025-01-04"}]) \
        == dt.date(2025, 1, 3)
    assert ceiling([{"field": "order_date", "op": "between",
                     "values": ["2024-01-01", "2025-01-04"]}]) == dt.date(2025, 1, 4)
    # The narrowest bound wins.
    assert ceiling([
        {"field": "order_date", "op": "<=", "value": "2025-03-01"},
        {"field": "ship_date", "op": "<=", "value": "2025-01-04"},
    ]) == dt.date(2025, 1, 4)

    # Not ceilings, and each for its own reason.
    assert ceiling([]) is None
    assert ceiling([{"field": "order_date", "op": ">=", "value": "2024-01-01"}]) is None
    assert ceiling([{"field": "customer_state", "op": "<=", "value": "SP"}]) is None
    assert ceiling([{"field": "order_date", "op": "<=", "value": "recently"}]) is None
    assert ceiling([{"field": "order_date", "op": "=", "value": "2025-01-04"}]) is None
