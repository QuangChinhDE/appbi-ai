# -*- coding: utf-8 -*-
"""An incomplete edge period must not be compared as if it were a complete one.

THE FAILURE THIS LOCKS, measured on real Olist data before the fix:

    compare_periods(chart 684)  ->  current  2018-09 = 166.46
                                    baseline 2018-08 = 1,003,308.47
                                    pct_change -99.98,  verdict "worsening"

2018-09 is a data-cutoff stub, not a month the business had. The reader was told
revenue collapsed by 99.98%, in every mode — default, auto, mom and yoy.

WHY IT IS A CONTRACT AND NOT A JUDGEMENT CALL. The sibling tool on the SAME
series already answers this question: `analyze_trend` runs `_trim_partial_edges`
and reports what it dropped in `excluded_periods`, with `edge: "first"/"last"`.
So the product already has one canonical notion of "this bucket is incomplete";
`compare_periods` simply never asked it. Two tools disagreeing about the same
edge fact on the same chart is the defect.

THE RULE, kept as small as the disagreement: an ordinary period comparison
compares COMPLETE periods. The partial edge is not hidden — it is named in the
payload — but it is not the headline `current` either. `mode="custom"` is
untouched: there the caller named both periods and meant them.

No Olist dates are hardcoded here. The series is synthetic and the partial edge
is defined the way the canonical helper defines it — a severe low outlier against
the median — so the test moves with the helper rather than against it.
"""
from __future__ import annotations

import pytest

from app.services.dashboard_ai_bot.thinking import advanced_tools as A


class _Ctx:
    """Only what the tool touches."""

    def assert_chart_in_scope(self, chart_id: int) -> None:
        return None


#: Twelve complete months plus a cutoff stub. `1.0` against a median near 1,000
#: is far under the helper's 15% floor, which is what makes it partial.
COMPLETE = [(f"2024-{m:02d}", 1000.0 + m * 10) for m in range(1, 13)]
PARTIAL_TAIL = COMPLETE + [("2025-01", 1.0)]


def _chart(series):
    return {
        "columns": ["order_date_dim.year_month", "revenue"],
        "rows": [[label, value] for label, value in series],
        "filters_applied": [],
    }


@pytest.fixture(autouse=True)
def _stub(monkeypatch):
    """Stub the warehouse only. Every decision under test is real code."""
    holder = {"series": PARTIAL_TAIL}

    def fake_fetch(ctx, chart_id, **kw):
        return _chart(holder["series"])

    monkeypatch.setattr(A, "_fetch_chart_data", fake_fetch)
    monkeypatch.setattr(A, "_attach_delta_unit",
                        lambda ctx, chart_id, measure, payload: payload)
    return holder


def run(mode=None, **extra):
    args = {"chart_id": 1, **extra}
    if mode:
        args["mode"] = mode
    return A.tool_compare_periods(_Ctx(), args)


# ── the defect ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("mode", [None, "auto", "mom", "yoy"])
def test_a_partial_final_period_is_not_the_headline_current(mode):
    res = run(mode)
    assert res.get("ok") is True, res
    data = res["data"]
    assert data["current"]["label"] != "2025-01", (
        f"mode={mode}: the cutoff stub 2025-01 (1.0) was compared as a real "
        "latest period. `analyze_trend` on this same series excludes it."
    )
    assert data["pct_change"] is None or data["pct_change"] > -90, (
        f"mode={mode}: reported {data['pct_change']}% — a collapse manufactured "
        "from an incomplete bucket"
    )


@pytest.mark.parametrize("mode", [None, "auto", "mom", "yoy"])
def test_the_partial_period_is_named_rather_than_hidden(mode):
    """Excluding it silently would trade one wrong answer for a missing one."""
    data = run(mode)["data"]
    excluded = data.get("excluded_periods") or []
    assert any(e.get("label") == "2025-01" for e in excluded), (
        "the incomplete period was dropped without being reported; a caller "
        "asking about period-to-date has no way to see it"
    )
    assert data.get("partial_last") is True


# ── and the ordinary case still works ───────────────────────────────────────

def test_a_complete_series_compares_the_last_two_months(_stub):
    _stub["series"] = COMPLETE
    data = run("mom")["data"]
    assert data["current"]["label"] == "2024-12"
    assert data["baseline"]["label"] == "2024-11"
    assert not (data.get("excluded_periods") or [])
    assert data.get("partial_last") is False


def test_yoy_still_reaches_twelve_months_back(_stub):
    _stub["series"] = COMPLETE
    data = run("yoy")["data"]
    assert data["current"]["label"] == "2024-12"
    assert data["baseline"]["label"] == "2024-01"


def test_custom_mode_is_untouched_because_the_caller_named_both_periods(_stub):
    """The caller who asks for the partial period by name means it."""
    data = run("custom", period_a="2025-01", period_b="2024-12")["data"]
    assert data["current"]["label"] == "2025-01"
    assert data["baseline"]["label"] == "2024-12"


# ── the two tools must agree about the same edge fact ───────────────────────

def test_compare_periods_and_analyze_trend_agree_on_what_is_partial():
    """The whole reason this is a contract: one canonical notion, two tools."""
    cmp_data = run("mom")["data"]
    trend = A.tool_analyze_trend(_Ctx(), {"chart_id": 1})
    assert trend.get("ok") is True, trend

    cmp_excluded = {e["label"] for e in (cmp_data.get("excluded_periods") or [])}
    trend_excluded = {e["label"] for e in (trend["data"].get("excluded_periods") or [])}
    assert cmp_excluded == trend_excluded, (
        f"compare_periods excluded {cmp_excluded} and analyze_trend excluded "
        f"{trend_excluded} on the SAME series — two answers to one question"
    )


def test_a_short_series_does_not_lose_its_only_points(_stub):
    """The helper refuses to trim below three points; the comparison must still
    produce an answer rather than an error."""
    _stub["series"] = [("2024-01", 100.0), ("2024-02", 120.0)]
    res = run("mom")
    assert res.get("ok") is True, res
    assert res["data"]["current"]["label"] == "2024-02"
