"""The Analyst's words are computed from the governed rows; they must never claim
more than the rows support.

Found by the real-model browser run (2026-10-21): the model grouped by product
instead of category, the result hit the row bound and was cut mid-period, and
the narrative reported "25,040 -> 276.18 (-98.9%)" — a trend that exists only
because the last period was truncated. A truncated result states that it is
incomplete and draws no trend, ranking or total from it.
"""
from __future__ import annotations

from datetime import date

from app.services.analyst.narrative import describe

AFTER = date(2026, 11, 5)  # every period in _rows() has ended

COLS = [{"name": "d", "ref": "v.order_date", "role": "dimension", "label": "Order date"},
        {"name": "c", "ref": "v.category", "role": "dimension", "label": "Category"},
        {"name": "r", "ref": "v.revenue", "role": "measure", "label": "Revenue"}]


def _rows():
    out = []
    for m in ("2026-08-01", "2026-09-01", "2026-10-01"):
        for c, base in (("a", 100.0), ("b", 50.0)):
            out.append({"d": m, "c": c, "r": base + (10 if m == "2026-10-01" and c == "a" else 0)})
    return out


def test_a_complete_result_reports_the_trend_from_the_rows():
    story = describe(COLS, _rows(), time_ref="v.order_date", truncated=False, today=AFTER)
    assert "150 → 160" in story["headline"]
    assert any(f["claim"] == "total 2026-10" and f["value"] == 160 for f in story["facts"])


def test_a_truncated_result_draws_no_trend():
    story = describe(COLS, _rows()[:-1], time_ref="v.order_date", truncated=True)
    assert "→" not in story["headline"] and "%" not in story["headline"]
    assert story["bullets"] == [] and story["facts"] == []
    assert story.get("incomplete") is True
    assert any(c["name"] == "complete" and not c["ok"] for c in story["checks"])


def test_a_truncated_ranking_draws_no_ranking():
    cols = [COLS[1], COLS[2]]
    story = describe(cols, [{"c": "a", "r": 5.0}], time_ref=None, truncated=True)
    assert story["bullets"] == [] and story["facts"] == [] and story.get("incomplete") is True


# ── time trends that do not mislead (PO gate 2) ─────────────────────────────

def _series(points, cat="a"):
    return [{"d": d, "c": cat, "r": v} for d, v in points]


def test_the_period_not_yet_ended_is_not_compared():
    rows = _series([("2026-08-01", 100.0), ("2026-09-01", 100.0), ("2026-10-01", 20.0)])
    story = describe(COLS, rows, time_ref="v.order_date", truncated=False, grain="month", today=date(2026, 10, 21))
    assert "2026-10" not in story["headline"] and "-80" not in story["headline"]
    assert story["periods"]["partial"] == ["2026-10"] and "chưa kết thúc" in story["note"]


def test_a_missing_period_is_named_and_never_counted_as_zero():
    rows = _series([("2026-06-01", 100.0), ("2026-08-01", 120.0)])
    story = describe(COLS, rows, time_ref="v.order_date", truncated=False, grain="month", today=AFTER)
    assert story["periods"]["window"] == ["2026-06", "2026-07", "2026-08"]  # consecutive calendar periods
    assert story["periods"]["missing"] == ["2026-07"]
    assert "khác với giá trị 0" in story["note"]
    assert "100 → 120" in story["headline"]


def test_a_missing_end_period_gives_no_change():
    rows = _series([("2026-07-01", 100.0), ("2026-08-01", 120.0), ("2026-10-01", 5.0)])
    story = describe(COLS, rows, time_ref="v.order_date", truncated=False, grain="month", today=date(2026, 10, 2))
    # window = Jul, Aug, Sep (Oct has not ended); Sep has no rows
    assert story["periods"]["missing"] == ["2026-09"]
    assert "%" not in story["headline"] and "không tính mức thay đổi" in story["headline"]


def test_a_null_measure_is_unknown_not_zero():
    rows = _series([("2026-07-01", 100.0), ("2026-08-01", None)])
    story = describe(COLS, rows, time_ref="v.order_date", truncated=False, grain="month", today=AFTER)
    assert "%" not in story["headline"]
    assert not any(f["value"] == 0 for f in story["facts"])


def test_quarter_and_year_grains_keep_their_own_periods():
    rows = _series([("2025-07-01", 10.0), ("2025-10-01", 20.0), ("2026-01-01", 30.0)])
    q = describe(COLS, rows, time_ref="v.order_date", truncated=False, grain="quarter", today=date(2026, 4, 2))
    assert q["periods"]["window"] == ["2025-Q3", "2025-Q4", "2026-Q1"] and "+200.0%" in q["headline"]
    y = describe(COLS, _series([("2024-01-01", 5.0), ("2025-01-01", 10.0), ("2026-01-01", 1.0)]),
                 time_ref="v.order_date", truncated=False, grain="year", today=date(2026, 10, 21))
    assert y["periods"]["window"] == ["2024", "2025"] and y["periods"]["partial"] == ["2026"]


def test_daily_grain_is_not_collapsed_into_months():
    rows = _series([("2026-10-01", 1.0), ("2026-10-02", 2.0), ("2026-10-03", 4.0)])
    story = describe(COLS, rows, time_ref="v.order_date", truncated=False, grain="day", today=AFTER)
    assert story["periods"]["window"] == ["2026-10-01", "2026-10-02", "2026-10-03"]
    assert "1 → 4" in story["headline"]


def test_one_complete_period_with_groups_ranks_the_groups_in_it():
    rows = [{"d": "2025-01-01", "c": "Nam", "r": 30.0}, {"d": "2025-01-01", "c": "Bắc", "r": 10.0},
            {"d": "2026-01-01", "c": "Nam", "r": 1.0}]
    story = describe(COLS, rows, time_ref="v.order_date", truncated=False, grain="year", today=date(2026, 10, 21))
    assert story["periods"]["window"] == ["2025"] and story["periods"]["partial"] == ["2026"]
    assert story["bullets"][:2] == ["Nam: 30 (75.0%)", "Bắc: 10 (25.0%)"]
