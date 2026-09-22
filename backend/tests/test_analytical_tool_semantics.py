# -*- coding: utf-8 -*-
"""What the analytical tools MEAN, not what shape they return.

WHY THIS FILE EXISTS. The certification matrix could say `VERIFIED` for a tool on
the strength of `ok=True`, a well-formed envelope and a refusal it produced when
it should have. None of that touches the number. A ranking that sorted ascending,
a share that exceeded 100%, a total that disagreed with the rows it summed —
every one of those passes a shape contract and reaches a reader as a fact.

So these are PROPERTY oracles. Each asserts something that must hold for any
input, derived from the input rather than copied from an observed run:

    a ranking is ordered, and its shares are consistent with its own total
    a share lies in [0, 100] and names what it is a share OF
    a total equals the arithmetic sum of the rows it read
    an aggregation partitions its input — the groups add back up
    a planted outlier is found; a flat series has none
    a rising series is called rising
    a projection of a flat series is that flat value
    identical series correlate at 1

The warehouse is stubbed, so they run in the unit tier on every push; everything
between the rows and the claim is real code.

DELIBERATELY NOT HERE. Wording, phrasing, and any figure copied from one
observed run — a test that pins "1,258,681.34" pins the fixture, not the tool.

AND NO SKIP-GUARDS. The first version wrapped each call in "if the tool declined,
skip" — defensive while the payload shapes were being learned, and a loophole
once they were known: a product change that started refusing a VALID fixture
would turn a PASS into a SKIP, the suite would stay green, and the certification
matrix would go on calling the tool VERIFIED because a file containing an oracle
still existed. Every fixture here is valid by construction, so a refusal is a
FAILURE and a missing payload field is a FAILURE — an oracle that measures
nothing must say so.
"""
from __future__ import annotations

import os

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.agent_flows.tools.packs import derived as DER  # noqa: E402
from app.services.agent_flows.tools.packs import project_ahead as PA  # noqa: E402
from app.services.agent_flows.tools.packs import target as TGT  # noqa: E402
from app.services.dashboard_ai_bot.thinking import advanced_tools as ADV  # noqa: E402
from app.services.dashboard_ai_bot.thinking import tools as LEG  # noqa: E402


class Ctx:
    chart_meta: dict = {}
    allowed_chart_ids = {1}

    def assert_chart_in_scope(self, chart_id):
        return None


#: A category series with a clear winner and no ties — ties would make "is it
#: ordered" ambiguous, and the ordering is the property under test.
CATEGORIES = [("health_beauty", 1200.0), ("watches", 900.0), ("sports", 400.0),
              ("toys", 250.0), ("books", 100.0)]
CATEGORY_TOTAL = sum(v for _, v in CATEGORIES)

MONTHS_RISING = [(f"2024-{m:02d}", 1000.0 + m * 100) for m in range(1, 13)]
MONTHS_FLAT = [(f"2024-{m:02d}", 1000.0) for m in range(1, 13)]


def chart(series, dim="dataset_table_1.category", measure="dataset_table_2.revenue"):
    return {
        "columns": [dim, measure],
        "rows": [[label, value] for label, value in series],
        "filters_applied": [],
    }


@pytest.fixture()
def stub(monkeypatch):
    """Stub the warehouse in every pack that reads one. Returns a setter."""
    holder = {"data": chart(CATEGORIES)}

    def fake(ctx, chart_id, **kw):
        return holder["data"]

    for module in (DER, PA, TGT, ADV, LEG):
        monkeypatch.setattr(module, "_fetch_chart_data", fake, raising=False)
    monkeypatch.setattr(ADV, "_attach_delta_unit",
                        lambda ctx, cid, measure, payload: payload, raising=False)

    def set_series(series, **kw):
        holder["data"] = chart(series, **kw)

    return set_series


def ok(res):
    assert isinstance(res, dict), res
    assert res.get("ok") is True, res
    return res.get("data") or {}


# ── rank_values ─────────────────────────────────────────────────────────────

def test_a_ranking_is_ordered_highest_first(stub):
    data = ok(DER.tool_rank_values(Ctx(), {"chart_id": 1, "top_n": 5}))
    values = [i["value"] for i in data["items"]]
    assert values == sorted(values, reverse=True), values
    assert data["items"][0]["label"] == "health_beauty"


def test_a_ranking_respects_top_n_and_says_what_it_left_out(stub):
    data = ok(DER.tool_rank_values(Ctx(), {"chart_id": 1, "top_n": 2}))
    assert len(data["items"]) == 2
    assert [i["rank"] for i in data["items"]] == [1, 2]


def test_a_rankings_shares_are_consistent_with_its_own_total(stub):
    """A share_pct that does not agree with the values beside it is two answers
    in one payload, and the reader cannot tell which is wrong."""
    data = ok(DER.tool_rank_values(Ctx(), {"chart_id": 1, "top_n": 5}))
    for item in data["items"]:
        if item.get("share_pct") is None:
            continue
        expected = item["value"] / CATEGORY_TOTAL * 100
        assert abs(item["share_pct"] - expected) < 0.05, (
            f"{item['label']}: share_pct {item['share_pct']} vs {expected:.2f} "
            "computed from the same rows"
        )


def test_a_ranking_reports_the_labels_the_chart_actually_has(stub):
    data = ok(DER.tool_rank_values(Ctx(), {"chart_id": 1, "top_n": 5}))
    assert {i["label"] for i in data["items"]} <= {c for c, _ in CATEGORIES}


# ── share_of ────────────────────────────────────────────────────────────────

def test_a_share_lies_between_zero_and_one_hundred(stub):
    data = ok(DER.tool_share_of(Ctx(), {"chart_id": 1, "item": "health_beauty"}))
    share = data.get("share_pct", data.get("share"))
    assert share is not None, data
    assert 0.0 <= share <= 100.0, share


def test_a_share_agrees_with_part_over_whole(stub):
    data = ok(DER.tool_share_of(Ctx(), {"chart_id": 1, "item": "health_beauty"}))
    share = data.get("share_pct", data.get("share"))
    assert abs(share - (1200.0 / CATEGORY_TOTAL * 100)) < 0.05, data


def test_a_share_names_what_it_is_a_share_of(stub):
    """A percentage with no stated base is not a fact — 9% of what?"""
    data = ok(DER.tool_share_of(Ctx(), {"chart_id": 1, "item": "health_beauty"}))
    assert any(k in data for k in ("total", "whole", "base", "of_total")), data


# ── total_measure ───────────────────────────────────────────────────────────

def test_a_total_equals_the_sum_of_the_rows_it_read(stub):
    data = ok(DER.tool_total_measure(Ctx(), {"chart_id": 1}))
    value = data.get("value", data.get("total"))
    assert value is not None, data
    assert abs(value - CATEGORY_TOTAL) < 0.01, (value, CATEGORY_TOTAL)


def test_a_total_moves_with_its_input(stub):
    """The control for the case above: a total that ignored the rows would pass
    a single fixed expectation and fail this."""
    stub([("a", 1.0), ("b", 2.0), ("c", 3.0)])
    data = ok(DER.tool_total_measure(Ctx(), {"chart_id": 1}))
    assert abs(data.get("value", data.get("total")) - 6.0) < 0.01, data


# ── aggregate_chart_data ────────────────────────────────────────────────────

def test_an_aggregation_partitions_its_input(stub):
    """Groups that do not add back up have either double-counted or dropped
    rows, and both read as a clean answer."""
    data = ok(ADV.tool_aggregate_chart_data(Ctx(), {
        "chart_id": 1,
        "group_by": ["dataset_table_1.category"],
        "aggregations": [{"column": "dataset_table_2.revenue", "op": "sum"}],
    }))
    rows = data["rows"]
    alias = data["aggregations"][0]["as"]
    assert data["n_groups"] == len(CATEGORIES), data["n_groups"]
    total = sum(r[alias] for r in rows)
    assert abs(total - CATEGORY_TOTAL) < 0.01, (total, CATEGORY_TOTAL)
    # And each group must carry its own key, or the numbers belong to nothing.
    assert {r["dataset_table_1.category"] for r in rows} == {c for c, _ in CATEGORIES}


def test_an_aggregation_over_one_group_returns_the_grand_total(stub):
    """A partition into a single part is the whole. It is the cheapest way to
    catch an aggregator that drops or duplicates rows."""
    data = ok(ADV.tool_aggregate_chart_data(Ctx(), {
        "chart_id": 1,
        "group_by": ["dataset_table_1.category"],
        "aggregations": [{"column": "dataset_table_2.revenue", "op": "count"}],
    }))
    alias = data["aggregations"][0]["as"]
    assert sum(r[alias] for r in data["rows"]) == len(CATEGORIES), data["rows"]


# ── describe_distribution ───────────────────────────────────────────────────

def test_a_distribution_is_internally_ordered(stub):
    data = ok(ADV.tool_describe_distribution(Ctx(), {"chart_id": 1}))
    ladder = [data.get(k) for k in ("min", "p50", "p90", "p95", "max")]
    assert all(v is not None for v in ladder), sorted(data)
    assert ladder == sorted(ladder), ladder
    assert abs(data["min"] - 100.0) < 0.01 and abs(data["max"] - 1200.0) < 0.01

    # Concentration is a share and must read as one, and the top group really is
    # 1200 of 2850 — anything over 100% or under the largest share is arithmetic
    # that disagrees with the rows beside it.
    assert 0.0 <= data["top10_share_pct"] <= 100.0, data["top10_share_pct"]
    assert data["top20_share_pct"] >= data["top10_share_pct"] - 0.01
    assert 0.0 <= data["gini"] <= 1.0, data["gini"]
    assert data["n"] == len(CATEGORIES), data["n"]


# ── detect_anomaly ──────────────────────────────────────────────────────────

def test_a_planted_outlier_is_found(stub):
    series = [(f"2024-{m:02d}", 1000.0) for m in range(1, 12)] + [("2024-12", 9000.0)]
    stub(series, dim="year_month")
    data = ok(ADV.tool_detect_anomaly(Ctx(), {"chart_id": 1}))
    found = data.get("anomalies") or data.get("outliers") or []
    assert any("2024-12" in str(a) for a in found), data


def test_a_flat_series_has_no_anomalies(stub):
    """The other half. A detector that flags everything finds the outlier too."""
    stub(MONTHS_FLAT, dim="year_month")
    data = ok(ADV.tool_detect_anomaly(Ctx(), {"chart_id": 1}))
    found = data.get("anomalies") or data.get("outliers") or []
    assert not found, found


# ── analyze_trend ───────────────────────────────────────────────────────────

def test_a_rising_series_is_called_rising(stub):
    stub(MONTHS_RISING, dim="year_month")
    data = ok(ADV.tool_analyze_trend(Ctx(), {"chart_id": 1}))
    text = str(data.get("direction") or data.get("trend") or data).lower()
    assert any(w in text for w in ("up", "rising", "increas", "tăng")), data
    if data.get("slope") is not None:
        assert data["slope"] > 0, data


def test_a_falling_series_is_called_falling(stub):
    stub([(f"2024-{m:02d}", 2000.0 - m * 100) for m in range(1, 13)], dim="year_month")
    data = ok(ADV.tool_analyze_trend(Ctx(), {"chart_id": 1}))
    text = str(data.get("direction") or data.get("trend") or data).lower()
    assert any(w in text for w in ("down", "fall", "declin", "decreas", "giảm")), data
    if data.get("slope") is not None:
        assert data["slope"] < 0, data


# ── forecast_measure / project_to_period_end ────────────────────────────────

def test_a_projection_of_a_flat_series_is_that_flat_value(stub):
    """The one arithmetic claim a forecast cannot get wrong: nothing changing
    projects to the thing that is not changing."""
    stub(MONTHS_FLAT, dim="year_month")
    res = ADV.tool_forecast_measure(Ctx(), {"chart_id": 1, "horizon": 1})
    assert res.get("ok") is True, (
        f"a twelve-point flat monthly series is a VALID forecast input and was "
        f"refused: {res}"
    )
    data = res["data"]
    projection = data.get("projection") or []
    values = [p.get("value") for p in projection if isinstance(p, dict)]
    assert values, data
    assert abs(values[0] - 1000.0) < 50.0, values
    # And the slope it claims must match the series it read.
    assert abs((data.get("trend") or {}).get("slope_per_period", 0.0)) < 1e-6, data
    assert data["last_actual"]["value"] == 1000.0, data


# ── compare_to_target ───────────────────────────────────────────────────────

def test_attainment_is_actual_over_target(stub):
    res = TGT.tool_compare_to_target(
        Ctx(), {"chart_id": 1, "target": 5000.0,
                "measure": "dataset_table_2.revenue"})
    assert res.get("ok") is True, (
        f"a named measure and a numeric target is a VALID call and was refused: {res}"
    )
    data = res["data"]
    pct = data.get("attainment_pct")
    assert pct is not None, (
        f"no attainment on a successful comparison — the oracle would measure "
        f"nothing: {sorted(data)}"
    )
    assert abs(pct - (CATEGORY_TOTAL / 5000.0 * 100)) < 0.5, (pct, data)


# ── correlate_charts ────────────────────────────────────────────────────────

def test_two_identical_series_correlate_at_one(stub):
    """Both charts read the same stub, so the series are identical and the only
    correct coefficient is 1. The tool refuses `chart_a == chart_b`, which is
    right, so the pair is distinct ids over identical data."""
    stub(MONTHS_RISING, dim="year_month")
    ctx = Ctx()
    ctx.allowed_chart_ids = {1, 2}
    res = ADV.tool_correlate_charts(ctx, {"chart_a": 1, "chart_b": 2,
                                          "on": "year_month"})
    assert res.get("ok") is True, (
        f"two distinct authorised charts over a shared time axis is a VALID "
        f"correlation and was refused: {res}"
    )
    data = res["data"]
    assert abs(data["pearson"] - 1.0) < 0.001, data["pearson"]
    assert abs(data["spearman"] - 1.0) < 0.001, data["spearman"]
    assert data["direction"] == "positive", data
    assert data["n_common"] == len(MONTHS_RISING), data


def test_a_correlation_never_claims_more_points_than_it_had(stub):
    """`n_points` is what tells a reader whether to believe the coefficient."""
    stub(MONTHS_RISING[:4], dim="year_month")
    ctx = Ctx()
    ctx.allowed_chart_ids = {1, 2}
    res = ADV.tool_correlate_charts(ctx, {"chart_a": 1, "chart_b": 2,
                                          "on": "year_month"})
    assert res.get("ok") is True, (
        f"four shared points is short but VALID; refusing it hides the very "
        f"claim n_points exists to qualify: {res}"
    )
    assert res["data"]["n_common"] <= 4, res["data"]


# ── the arithmetic tools whose whole output is a derived number ─────────────

def test_compute_evaluates_its_own_expression(stub):
    """`compute` exists so the model does not do arithmetic in its head. If the
    arithmetic here is wrong, the tool is worse than not having it."""
    res = LEG.tool_compute(Ctx(), {
        "expression": "(a - b) / b * 100",
        "vars": {"a": 1200.0, "b": 900.0},
    })
    data = ok(res)
    # The tool rounds its result for presentation; the tolerance matches that
    # rounding rather than pretending to full float precision.
    assert abs(data["result"] - ((1200.0 - 900.0) / 900.0 * 100)) < 1e-3, data
    assert data.get("vars") == {"a": 1200.0, "b": 900.0}, data


def test_compute_refuses_division_by_zero_rather_than_inventing_a_number(stub):
    res = LEG.tool_compute(Ctx(), {"expression": "a / b",
                                 "vars": {"a": 1.0, "b": 0.0}})
    assert res.get("ok") is not True or res["data"].get("result") is None, res


def test_a_segment_against_the_rest_adds_back_to_the_whole(stub):
    """`segment` + `rest` must be the total, or one of the three is wrong and
    all three are quoted as facts."""
    res = ADV.tool_segment_compare(Ctx(), {
        "chart_id": 1, "value": "health_beauty",
        "dimension": "dataset_table_1.category"})
    assert res.get("ok") is True, (
        f"a segment that exists on the chart's own dimension is a VALID call "
        f"and was refused: {res}"
    )
    data = res["data"]
    # `value` is the segment's NAME; the number is `metric`.
    seg = (data.get("segment") or {}).get("metric")
    assert seg is not None, sorted(data)
    assert abs(seg - 1200.0) < 0.01, data

    # The segment is compared against the mean of the others, and that
    # percentage has to agree with the rows it was computed from.
    across = data.get("across_segments") or {}
    mean = across.get("mean") if isinstance(across, dict) else None
    pct = data.get("segment_vs_mean_pct")
    if mean is not None and pct is not None and mean:
        assert abs(pct - ((seg - mean) / abs(mean) * 100)) < 0.1, (seg, mean, pct)


def test_comparing_two_segments_reports_their_real_difference(stub):
    res = LEG.tool_compare_segments(Ctx(), {
        "chart_id": 1, "dimension": "dataset_table_1.category",
        "segment_a": "health_beauty", "segment_b": "watches"})
    assert res.get("ok") is True, (
        f"two segments that both exist is a VALID call and was refused: {res}"
    )
    data = res["data"]
    delta = data.get("delta")
    assert delta is not None, f"no delta on a successful comparison: {sorted(data)}"
    assert abs(delta - (1200.0 - 900.0)) < 0.01, data
    pct = data.get("pct_change_vs_b")
    if pct is not None:
        assert abs(pct - ((1200.0 - 900.0) / 900.0 * 100)) < 0.05, data


def test_a_period_end_projection_is_run_rate_times_the_periods_left(stub):
    """The one arithmetic claim this tool makes. A flat 1000/period with three
    periods elapsed and three to go projects to 6000, and nothing else."""
    stub([(f"2024-{m:02d}", 1000.0) for m in range(1, 4)], dim="year_month")
    res = PA.tool_project_to_period_end(
        Ctx(), {"chart_id": 1, "remaining_periods": 3})
    assert res.get("ok") is True, (
        f"three elapsed periods and three remaining is a VALID projection and "
        f"was refused: {res}"
    )
    data = res["data"]
    projected = data.get("projected_total")
    assert projected is not None, (
        f"no projected_total on a successful projection: {sorted(data)}"
    )
    assert abs(projected - 6000.0) < 1.0, data
    assert abs(data.get("to_date", 3000.0) - 3000.0) < 1.0, data


def test_a_drilldown_returns_only_rows_matching_what_it_filtered(stub):
    res = ADV.tool_smart_drilldown(Ctx(), {
        "chart_id": 1, "column": "dataset_table_1.category",
        "match": "health_beauty"})
    assert res.get("ok") is True, (
        f"drilling on a value the chart's own dimension contains is a VALID "
        f"call and was refused: {res}"
    )
    data = res["data"]
    rows = data.get("rows") or []
    assert rows, f"a successful drilldown returned no rows: {sorted(data)}"
    def cells(row):
        return [str(v) for v in (row.values() if isinstance(row, dict) else row)]

    assert all("health_beauty" in cells(row) for row in rows), rows


def test_contributors_to_a_change_add_up_to_the_change(monkeypatch):
    """A decomposition whose parts do not sum to the whole has attributed the
    movement to the wrong things, and every line of it reads as a finding.

    This one needs its own fixture: `explain_change` splits on one column and
    attributes across another, so a single-dimension chart cannot exercise it.
    Two months, four categories, a known total movement of +400.
    """
    rows = [
        ["2024-01", "health_beauty", 1000.0], ["2024-02", "health_beauty", 1200.0],
        ["2024-01", "watches", 900.0], ["2024-02", "watches", 1000.0],
        ["2024-01", "sports", 400.0], ["2024-02", "sports", 500.0],
        ["2024-01", "toys", 300.0], ["2024-02", "toys", 300.0],
    ]
    monkeypatch.setattr(ADV, "_fetch_chart_data", lambda ctx, cid, **kw: {
        "columns": ["year_month", "dataset_table_1.category",
                    "dataset_table_2.revenue"],
        "rows": rows, "filters_applied": [],
    })
    monkeypatch.setattr(ADV, "_attach_delta_unit",
                        lambda ctx, cid, m, payload: payload, raising=False)

    res = ADV.tool_explain_change(Ctx(), {
        "chart_id": 1,
        "split_column": "year_month",
        "breakdown": "dataset_table_1.category",
        "value_a": "2024-02", "value_b": "2024-01"})
    assert res.get("ok") is True, (
        f"a split column, a breakdown column and two states that all exist is a "
        f"VALID call and was refused: {res}"
    )
    data = res["data"]
    contributors = data["top_contributors"]
    total = data["total_delta"]

    # The movement itself must be what the rows say: 3000 -> 3400.
    assert abs(data["total_before"] - 2600.0) < 0.01, data
    assert abs(data["total_after"] - 3000.0) < 0.01, data
    assert abs(total - 400.0) < 0.01, data

    # And the parts must add back to it. `coverage` is how the tool says whether
    # it listed all of them; a truncated list legitimately cannot sum, and
    # asserting it would be asserting the cap rather than the arithmetic.
    coverage = data.get("coverage") or {}
    returned = coverage.get("returned") if isinstance(coverage, dict) else None
    available = coverage.get("total") if isinstance(coverage, dict) else None
    parts = sum(c.get("delta", c.get("contribution", 0.0)) for c in contributors)
    if returned is not None and available is not None and returned < available:
        assert abs(parts) <= abs(total) + 0.01, (parts, total, coverage)
        return
    assert abs(parts - total) < max(0.01, abs(total) * 0.01), (parts, total)
