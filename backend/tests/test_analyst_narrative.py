"""The Analyst's words are computed from the governed rows; they must never claim
more than the rows support.

Found by the real-model browser run (2026-10-21): the model grouped by product
instead of category, the result hit the row bound and was cut mid-period, and
the narrative reported "25,040 -> 276.18 (-98.9%)" — a trend that exists only
because the last period was truncated. A truncated result states that it is
incomplete and draws no trend, ranking or total from it.
"""
from __future__ import annotations

from app.services.analyst.narrative import describe

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
    story = describe(COLS, _rows(), time_ref="v.order_date", truncated=False)
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
