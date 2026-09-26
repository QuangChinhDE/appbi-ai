"""What a chart's rows must look like before a renderer sees them.

Two facts every renderer relies on, enforced where the rows are produced:

* A measure is a NUMBER. Postgres NUMERIC and BigQuery NUMERIC/BIGNUMERIC come
  back from the drivers as `Decimal`, and Pydantic serialises `Decimal` as a JSON
  string. Bar and pie renderers happened to coerce strings; the line renderer did
  not, so every revenue-by-month line on a Postgres source drew an empty axis.
  Only MEASURE columns are converted — a NUMERIC identifier or dimension stays
  what it was, so an order number is never turned into 1.2e+15.

* A time axis is ORDERED by time (see `default_time_axis_sort`).
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional


def decimal_to_number(value: Any) -> Any:
    """`Decimal` → `int` when integral, else `float`; anything else unchanged.

    An integral Decimal becomes an exact Python int, so counts and large totals
    keep every digit. A fractional one becomes a float: 15–17 significant digits,
    far beyond what an aggregate shown on a chart carries. NaN/Infinity and
    non-Decimal values are returned as they are.
    """
    if not isinstance(value, Decimal):
        return value
    if not value.is_finite():
        return None
    if value == value.to_integral_value():
        return int(value)
    return float(value)


def normalize_measure_values(rows: List[Dict[str, Any]], measure_keys: Iterable[str]) -> List[Dict[str, Any]]:
    """Convert Decimal measure cells to numbers, in place, and return the rows."""
    keys = [k for k in measure_keys if k]
    if not rows or not keys:
        return rows
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in keys:
            if key in row:
                row[key] = decimal_to_number(row[key])
    return rows


def default_time_axis_sort(
    time_grains: Optional[Dict[str, str]],
    time_field: Optional[str],
    dimension_refs: List[str],
) -> List[Dict[str, str]]:
    """The ORDER BY a chart gets when it has a time axis and no explicit sort.

    The time axis is the first grained dimension, else the chart's `timeField`
    when it is one of the query's dimensions. No time axis → no sort (a
    category chart keeps whatever order its own rules give it).
    """
    axis = next(iter(time_grains), None) if time_grains else None
    if axis is None and time_field and time_field in (dimension_refs or []):
        axis = time_field
    return [{"field": axis, "direction": "asc"}] if axis else []


# ── Partial periods ─────────────────────────────────────────────────────────

#: An edge bucket this far below the typical bucket is flagged as probably
#: incomplete (a launch month with 3 orders, a cut-off month with 1).
EDGE_PARTIAL_RATIO = 0.10


def _period_end(start, grain: str):
    """Exclusive end of the calendar period that starts at `start`."""
    import datetime as _dt

    if grain == "day":
        return start + _dt.timedelta(days=1)
    if grain == "week":
        return start + _dt.timedelta(days=7)
    if grain == "month":
        return (start.replace(day=1) + _dt.timedelta(days=32)).replace(day=1)
    if grain == "quarter":
        m = ((start.month - 1) // 3) * 3 + 1
        first = start.replace(month=m, day=1)
        return (first + _dt.timedelta(days=95)).replace(day=1)
    if grain == "year":
        return start.replace(year=start.year + 1, month=1, day=1)
    return None


def _as_datetime(value):
    import datetime as _dt

    if isinstance(value, _dt.datetime):
        return value.replace(tzinfo=None)
    if isinstance(value, _dt.date):
        return _dt.datetime(value.year, value.month, value.day)
    if isinstance(value, str) and value:
        try:
            return _dt.datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            return None
    return None


def time_completeness(
    rows: List[Dict[str, Any]],
    time_key: Optional[str],
    grain: Optional[str],
    measure_key: Optional[str],
    now=None,
) -> Optional[Dict[str, Any]]:
    """Which buckets of a time series are not complete periods, and why.

    Nothing is removed: the rows are returned as they are and this only says
    which of them a reader should not compare like-for-like. Two rules, each
    named in the output so the UI can explain itself:

    * ``in_progress`` — the period has not ended yet (calendar fact).
    * ``edge_low_volume`` — the FIRST or LAST bucket is below
      ``EDGE_PARTIAL_RATIO`` of the median of the interior buckets. A data
      heuristic, reported as "probably incomplete", never as a certainty.
    """
    import datetime as _dt
    import statistics

    if not rows or not time_key or not grain:
        return None
    points = []
    for row in rows:
        start = _as_datetime(row.get(time_key)) if isinstance(row, dict) else None
        if start is None:
            continue
        v = row.get(measure_key) if measure_key else None
        v = decimal_to_number(v)
        try:
            v = float(v) if v is not None and v != "" else None
        except (TypeError, ValueError):
            v = None
        points.append((start, v, row.get(time_key)))
    if not points:
        return None
    points.sort(key=lambda p: p[0])
    now = now or _dt.datetime.utcnow()
    partial: List[Dict[str, Any]] = []
    for start, _v, raw in points:
        end = _period_end(start, grain)
        if end is not None and end > now >= start:
            partial.append({"bucket": raw, "reason": "in_progress"})
    values = [v for _s, v, _r in points if v is not None and v > 0]
    if len(values) >= 5:
        med = statistics.median(values)
        flagged = {p["bucket"] for p in partial}
        # Walk in from each end while the bucket is far below typical: a data
        # set can open with several thin launch months and end with a couple
        # of cut-off months. The walk stops at the first normal bucket, so a
        # genuine dip in the middle of the series is never called "partial".
        for order in (range(len(points)), range(len(points) - 1, -1, -1)):
            for idx in order:
                _s, v, raw = points[idx]
                if raw in flagged:
                    continue
                if v is None or v >= EDGE_PARTIAL_RATIO * med:
                    break
                flagged.add(raw)
                partial.append({"bucket": raw, "reason": "edge_low_volume",
                                "value": v, "median": med})
    return {"field": time_key, "grain": grain, "partial": partial,
            "rule": {"edge_low_volume_ratio": EDGE_PARTIAL_RATIO}}
