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

from app.services.data_core.narrative import describe

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


def test_a_shape_a_line_cannot_carry_is_drafted_as_a_table_of_every_column():
    from types import SimpleNamespace

    from app.services.data_core.narrative import chart_draft

    plan = SimpleNamespace(dimensions=["c.region", "o.channel", "o.order_date"], measures=["l.net_sales"],
                           time_grains={"o.order_date": "quarter"}, filters={}, limit=None, sorts=[],
                           explore=SimpleNamespace(dataset_table_id=7))
    d, _ = chart_draft(plan, "Doanh số theo vùng và kênh hằng quý")
    assert d["chart_type"] == "TABLE"
    assert d["config"]["roleConfig"]["selectedColumns"] == ["c.region", "o.channel", "o.order_date", "l.net_sales"]


def test_an_asked_year_spans_the_whole_year_not_the_recent_window():
    """Dogfood 2026-10-22: "Số đơn hàng theo tháng năm 2025" was headlined
    "2025-10 -> 2025-12" and called that "gần đây" though the person asked for
    the whole of 2025. An explicit range is compared first-to-last month."""
    rows = [{"d": f"2025-{mo:02d}-01", "c": "a", "r": float(100 + mo)} for mo in range(1, 13)]
    story = describe(COLS, rows, time_ref="v.order_date", truncated=False, grain="month", today=AFTER,
                     period=(date(2025, 1, 1), date(2026, 1, 1)))
    assert story["periods"]["window"][0] == "2025-01" and story["periods"]["window"][-1] == "2025-12"
    assert "2025-01 → 2025-12" in story["headline"]
    assert "Gần đây" not in story["note"]


def test_an_asked_range_reports_a_missing_edge_month_instead_of_shrinking():
    rows = [{"d": f"2025-{mo:02d}-01", "c": "a", "r": 10.0} for mo in range(2, 13)]  # January absent
    story = describe(COLS, rows, time_ref="v.order_date", truncated=False, grain="month", today=AFTER,
                     period=(date(2025, 1, 1), date(2026, 1, 1)))
    assert "2025-01" in story["periods"]["missing"]
    assert "Thiếu dữ liệu" in story["headline"]  # never compared as zero


def test_without_an_asked_range_recent_is_still_the_last_three_complete_periods():
    rows = [{"d": f"2025-{mo:02d}-01", "c": "a", "r": 10.0} for mo in range(1, 13)]
    story = describe(COLS, rows, time_ref="v.order_date", truncated=False, grain="month", today=AFTER)
    assert story["periods"]["window"] == ["2025-10", "2025-11", "2025-12"]


RANK = [{"name": "c", "ref": "v.channel", "role": "dimension", "label": "Channel"},
        {"name": "r", "ref": "v.orders", "role": "measure", "label": "Orders"}]


def test_a_tie_has_no_single_highest():
    """Dogfood real-model smoke 2026-10-22: three channels with 498 orders each were
    headlined "highest: Cửa hàng (498)" - a winner that does not exist."""
    story = describe(RANK, [{"c": "Cửa hàng", "r": 498}, {"c": "Đại lý", "r": 498}, {"c": "Online", "r": 498}],
                     time_ref=None, truncated=False)
    assert "cao nhất:" not in story["headline"] and "bằng nhau" in story["headline"]
    story = describe(RANK, [{"c": "A", "r": 5}, {"c": "B", "r": 5}, {"c": "C", "r": 1}], time_ref=None, truncated=False)
    assert "A, B" in story["headline"] and "bằng nhau" in story["headline"]


def test_a_null_group_is_not_ranked_as_zero():
    story = describe(RANK, [{"c": "A", "r": 5}, {"c": "B", "r": None}], time_ref=None, truncated=False)
    assert story["headline"].startswith("Orders cao nhất: A")
    assert all(f["claim"] != "B" for f in story["facts"])
    assert any("B" in b and "không tính là 0" in b for b in story["bullets"])


def test_a_clear_leader_is_still_named():
    story = describe(RANK, [{"c": "A", "r": 5}, {"c": "B", "r": 3}], time_ref=None, truncated=False)
    assert story["headline"] == "Orders cao nhất: A (5)."


def test_a_filtered_answer_drafts_a_chart_with_exactly_those_filters():
    """PO 2026-10-22 (Workstream C): an answer with filters was never offered as a chart.
    Its filters are now the chart's base filters, selecting exactly the same rows."""
    from types import SimpleNamespace

    from app.services.data_core.narrative import chart_draft

    plan = SimpleNamespace(dimensions=["c.region"], measures=["l.net_sales"], time_grains={}, sorts=[], limit=None,
                           explore=SimpleNamespace(dataset_table_id=7), filters={
                               "o.channel": {"operator": "ne", "value": "Online"},
                               "o.order_date": {"operator": "date_range", "value": {"from": "2025-01-01", "to": "2026-01-01"}}})
    d, why = chart_draft(plan, "t")
    assert d is not None, why
    assert d["config"]["baseFilters"] == d["config"]["filters"] == [
        {"field": "o.channel", "semanticField": "o.channel", "operator": "neq", "value": "Online"},
        {"field": "o.order_date", "semanticField": "o.order_date", "operator": "between", "value": ["2025-01-01", "2025-12-31"]}]
    plan.filters = {"p.name": {"operator": "contains", "value": "Lap"}}   # no exact chart equivalent
    d, why = chart_draft(plan, "t")
    assert d is None and why


def test_a_top_n_draft_only_when_the_chart_limit_gives_the_same_rows():
    from types import SimpleNamespace

    from app.services.data_core.narrative import chart_draft

    cols = [{"name": "c", "role": "dimension"}, {"name": "m", "role": "measure"}]
    plan = SimpleNamespace(dimensions=["c.region"], measures=["l.net_sales"], time_grains={}, filters={}, limit=2,
                           sorts=[{"field": "l.net_sales", "direction": "desc"}], explore=SimpleNamespace(dataset_table_id=7))
    d, why = chart_draft(plan, "t", rows=[{"c": "A", "m": 9}, {"c": "B", "m": 5}], columns=cols)
    assert d["config"]["styleConfig"]["dataLimit"] == 2 and d["config"]["styleConfig"]["dataLimitDirection"] == "top"
    tie, why = chart_draft(plan, "t", rows=[{"c": "A", "m": 9}, {"c": "B", "m": 5}, {"c": "C", "m": 5}], columns=cols)
    assert tie is None and why                        # a tie at the cut: LIMIT would drop one
    nul, why = chart_draft(plan, "t", rows=[{"c": "A", "m": 9}, {"c": "B", "m": None}], columns=cols)
    assert nul is None and why



def test_a_cut_off_last_period_is_not_the_end_of_the_recent_window():
    """Live 2026-10-28 (Olist): "GMV 2018-07 → 2018-09: 1.06 triệu → 166.46 (-100.0%)"
    - 2018-09 has ended on the calendar but holds a few orders. A first or last period
    far below a typical one (the chart footnote's rule) is not compared."""
    cols = [{"name": "d", "ref": "v.order_date", "role": "dimension", "label": "Order date"},
            {"name": "r", "ref": "v.revenue", "role": "measure", "label": "Revenue"}]
    rows = [{"d": f"2018-{m:02d}-01", "r": v}
            for m, v in [(1, 1000.0), (2, 1100.0), (3, 1200.0), (4, 1300.0), (5, 1250.0), (6, 1400.0), (7, 3.0)]]
    story = describe(cols, rows, time_ref="v.order_date", truncated=False, today=AFTER)
    assert "2018-04 → 2018-06" in story["headline"] and "-100" not in story["headline"]
    assert "2018-07" in story["note"] and "chưa đầy đủ" in story["note"]
    assert "2018-07" in story["periods"]["partial"]


def test_no_share_of_total_for_an_average_a_rate_or_a_top_n_cut():
    """Customer demo 2026-10-28: a report showing 72.7% was explained with another % - the
    narrative printed value / sum of rows for every measure, averages and rates included,
    and over a top-N cut. A share of the total only where rows add up."""
    cols = [{"name": "c", "ref": "v.unit", "role": "dimension", "label": "Đơn vị"},
            {"name": "r", "ref": "v.rate", "role": "measure", "label": "Tỷ lệ đạt", "aggregation": "avg"}]
    rows = [{"c": "A", "r": 72.7}, {"c": "B", "r": 64.0}, {"c": "C", "r": 90.1}]
    story = describe(cols, rows, time_ref=None, truncated=False)
    assert story["bullets"] and not any("%" in b for b in story["bullets"]), story["bullets"]

    summed = [{**cols[0]}, {**cols[1], "aggregation": "sum", "label": "Doanh thu"}]
    assert any("%" in b for b in describe(summed, rows, time_ref=None, truncated=False)["bullets"])
    top = describe(summed, rows, time_ref=None, truncated=False, top=2)
    assert not any("%" in b for b in top["bullets"]), top["bullets"]   # share of a top-N cut's sum

    # over time, an average of several groups has no one total to compare
    tcols = [{"name": "d", "ref": "v.order_date", "role": "dimension", "label": "Kỳ"}] + cols
    trows = [{"d": f"2026-0{m}-01", "c": c, "r": v} for m in (7, 8, 9) for c, v in (("A", 70.0 + m), ("B", 60.0))]
    story = describe(tcols, trows, time_ref="v.order_date", truncated=False, today=AFTER)
    assert "không cộng gộp được" in story["headline"]
    assert not any(f["claim"].startswith("total") for f in story["facts"])   # per-group changes stay
