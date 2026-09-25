"""A chart's rows carry numbers for measures and an ordered, honest time axis.

Found on the Olist report: every revenue-by-month line drew an empty axis
because Postgres NUMERIC arrived as `Decimal`, which serialises as a JSON
string; the delivery-days series came back in hash-aggregate order; and the
launch/cut-off months (1–3 orders) were drawn like real months.
"""
import datetime as dt
from decimal import Decimal

from app.services.chart_value_normalization import (
    decimal_to_number,
    default_time_axis_sort,
    normalize_measure_values,
    time_completeness,
)


def test_decimal_measures_become_numbers_without_losing_integers():
    assert decimal_to_number(Decimal("267.36")) == 267.36
    assert isinstance(decimal_to_number(Decimal("267.36")), float)
    big = Decimal("123456789012345678")
    assert decimal_to_number(big) == 123456789012345678  # exact int, every digit kept
    assert isinstance(decimal_to_number(big), int)
    assert decimal_to_number(Decimal("NaN")) is None
    assert decimal_to_number("267.36") == "267.36"  # only Decimal is touched


def test_only_measure_columns_are_converted():
    rows = [{"orders.order_id": Decimal("900719925474099312"), "items.revenue": Decimal("10.5")}]
    normalize_measure_values(rows, ["items.revenue"])
    assert rows[0]["items.revenue"] == 10.5
    # A NUMERIC identifier is a dimension here: left exactly as the driver gave it.
    assert rows[0]["orders.order_id"] == Decimal("900719925474099312")


def test_time_axis_is_sorted_when_nothing_else_sorts_it():
    assert default_time_axis_sort({"o.purchase": "month"}, None, ["o.purchase"]) == [
        {"field": "o.purchase", "direction": "asc"}]
    assert default_time_axis_sort({}, "o.purchase", ["o.purchase", "c.state"]) == [
        {"field": "o.purchase", "direction": "asc"}]
    # timeField that is not a query dimension (filter context only) → no sort
    assert default_time_axis_sort({}, "o.purchase", ["c.state"]) == []
    assert default_time_axis_sort(None, None, ["c.state"]) == []


def _series(values):
    start = dt.datetime(2016, 9, 1)
    rows, d = [], start
    for v in values:
        rows.append({"t": d.isoformat(), "rev": v})
        d = (d + dt.timedelta(days=32)).replace(day=1)
    return rows


def test_thin_launch_and_cutoff_months_are_flagged_not_dropped():
    # Olist shape: 267 / 49.5K / 10.9 at launch, ~1M plateau, two near-empty cut-off months.
    values = [267.36, 49507.66, 10.9] + [120000, 250000, 370000, 500000, 610000, 700000, 750000,
                                          1000000, 850000, 960000, 900000, 990000, 1000000, 1000000,
                                          990000, 870000, 900000, 850000] + [145.0, 89.0]
    rows = _series(values)
    out = time_completeness(rows, "t", "month", "rev", now=dt.datetime(2026, 1, 1))
    flagged = [p["bucket"][:7] for p in out["partial"]]
    assert flagged[:3] == ["2016-09", "2016-10", "2016-11"]
    assert set(flagged[3:]) == {rows[-1]["t"][:7], rows[-2]["t"][:7]}
    assert all(p["reason"] == "edge_low_volume" for p in out["partial"])
    assert len(rows) == len(values), "no row is removed"


def test_a_dip_in_the_middle_is_not_called_partial():
    values = [100, 110, 105, 5, 108, 112, 109]
    out = time_completeness(_series(values), "t", "month", "rev", now=dt.datetime(2026, 1, 1))
    assert out["partial"] == []


def test_the_current_period_is_in_progress():
    rows = [{"t": "2026-07-01T00:00:00", "rev": 10}, {"t": "2026-08-01T00:00:00", "rev": 12},
            {"t": "2026-09-01T00:00:00", "rev": 4}]
    out = time_completeness(rows, "t", "month", "rev", now=dt.datetime(2026, 9, 25))
    assert {"bucket": "2026-09-01T00:00:00", "reason": "in_progress"} in out["partial"]


def test_no_time_grain_no_claim():
    assert time_completeness([{"x": 1}], None, None, "rev") is None
