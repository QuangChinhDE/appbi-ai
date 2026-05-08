"""Insight Pack — deterministic, pre-computed summary statistics for a chart.

The agent calls into here instead of stuffing raw rows into the LLM context.
Numbers returned here are authoritative; the agent is instructed to cite
them rather than computing its own.

Pure functions, no DB access — accepts the dict shape returned by
``ChartService.get_chart_data()['data']`` (i.e. ``{columns, rows, ...}``).

This makes the module trivial to unit-test without a database.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

# Public types ────────────────────────────────────────────────────────────────


@dataclass
class ColumnSummary:
    name: str
    kind: str  # "number" | "string" | "datetime" | "mixed" | "empty"
    non_null: int
    null: int
    distinct: int
    # numeric only
    total: float | None = None
    minimum: float | None = None
    maximum: float | None = None
    average: float | None = None
    median: float | None = None
    # string/categorical only
    top_values: list[tuple[str, int]] = field(default_factory=list)


@dataclass
class InsightPack:
    chart_id: int
    chart_name: str
    chart_type: str
    description: str
    total_rows: int
    sample_rows: int
    truncated: bool
    columns: list[ColumnSummary]
    primary_measure: str | None
    primary_dimension: str | None
    top_5: list[dict[str, Any]]
    bottom_5: list[dict[str, Any]]
    trend: dict[str, Any] | None  # {direction, pct_change, first, last, points}
    outliers: list[dict[str, Any]]
    filters_applied: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "chart_id": self.chart_id,
            "chart_name": self.chart_name,
            "chart_type": self.chart_type,
            "description": self.description,
            "total_rows": self.total_rows,
            "sample_rows": self.sample_rows,
            "truncated": self.truncated,
            "columns": [
                {
                    "name": c.name,
                    "kind": c.kind,
                    "non_null": c.non_null,
                    "null": c.null,
                    "distinct": c.distinct,
                    "total": _round(c.total),
                    "min": _round(c.minimum),
                    "max": _round(c.maximum),
                    "avg": _round(c.average),
                    "median": _round(c.median),
                    "top_values": c.top_values,
                }
                for c in self.columns
            ],
            "primary_measure": self.primary_measure,
            "primary_dimension": self.primary_dimension,
            "top_5": self.top_5,
            "bottom_5": self.bottom_5,
            "trend": self.trend,
            "outliers": self.outliers,
            "filters_applied": self.filters_applied,
        }


# Helpers ─────────────────────────────────────────────────────────────────────


def _round(value: float | None) -> float | None:
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    # Round generously to keep small ints intact and avoid noise on floats
    return round(float(value), 4)


def _is_number(value: Any) -> bool:
    if value is None or isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return math.isfinite(float(value))
    if isinstance(value, str):
        try:
            float(value)
            return True
        except (TypeError, ValueError):
            return False
    return False


def _to_number(value: Any) -> float | None:
    try:
        if value is None or isinstance(value, bool):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


_DATETIME_HINTS = ("date", "time", "month", "week", "year", "day", "ngay", "thang")


def _looks_like_datetime_name(name: str) -> bool:
    lower = (name or "").lower()
    return any(hint in lower for hint in _DATETIME_HINTS)


def _classify_column(values: Sequence[Any], name: str) -> str:
    non_null = [v for v in values if v is not None and v != ""]
    if not non_null:
        return "empty"

    numeric_count = sum(1 for v in non_null if _is_number(v))
    if numeric_count == len(non_null):
        return "number"
    if _looks_like_datetime_name(name) and numeric_count == 0:
        return "datetime"
    if numeric_count == 0:
        return "string"
    return "mixed"


def _summarise_column(name: str, values: Sequence[Any]) -> ColumnSummary:
    kind = _classify_column(values, name)
    non_null_values = [v for v in values if v is not None and v != ""]
    non_null = len(non_null_values)
    null = len(values) - non_null

    distinct_repr = {repr(v) for v in non_null_values}
    distinct = len(distinct_repr)

    summary = ColumnSummary(
        name=name,
        kind=kind,
        non_null=non_null,
        null=null,
        distinct=distinct,
    )

    if kind == "number":
        nums = [n for n in (_to_number(v) for v in non_null_values) if n is not None]
        if nums:
            summary.total = float(sum(nums))
            summary.minimum = float(min(nums))
            summary.maximum = float(max(nums))
            summary.average = float(statistics.fmean(nums))
            summary.median = float(statistics.median(nums))
    elif kind in ("string", "datetime", "mixed"):
        # Top-5 by frequency
        counts: dict[str, int] = {}
        for v in non_null_values:
            key = str(v)
            counts[key] = counts.get(key, 0) + 1
        summary.top_values = sorted(
            counts.items(), key=lambda kv: (-kv[1], kv[0])
        )[:5]

    return summary


def _detect_primary_measure_index(
    columns: Sequence[str], values_by_col: Sequence[Sequence[Any]]
) -> int | None:
    """Pick the column most likely to be the chart's main measure.

    Heuristic: the last all-numeric column wins. If none, fall back to any
    numeric column. None if no numeric column exists.
    """
    numeric_indices: list[int] = []
    for idx, name in enumerate(columns):
        kind = _classify_column(values_by_col[idx], name)
        if kind == "number":
            numeric_indices.append(idx)
    if not numeric_indices:
        return None
    return numeric_indices[-1]


def _detect_primary_dimension_index(
    columns: Sequence[str],
    values_by_col: Sequence[Sequence[Any]],
    measure_idx: int | None,
) -> int | None:
    """Pick the chart's main dimension (datetime first, then any non-numeric).

    Excludes the primary measure column.
    """
    candidates = [
        i for i in range(len(columns)) if i != measure_idx
    ]
    if not candidates:
        return None
    # Prefer datetime
    for i in candidates:
        kind = _classify_column(values_by_col[i], columns[i])
        if kind == "datetime":
            return i
    # Otherwise first non-numeric
    for i in candidates:
        kind = _classify_column(values_by_col[i], columns[i])
        if kind in ("string", "mixed"):
            return i
    return candidates[0]


def _top_n_rows(
    rows: Sequence[Sequence[Any]],
    columns: Sequence[str],
    measure_idx: int,
    n: int,
    *,
    largest: bool,
) -> list[dict[str, Any]]:
    indexed: list[tuple[float, int]] = []
    for ri, row in enumerate(rows):
        if measure_idx >= len(row):
            continue
        num = _to_number(row[measure_idx])
        if num is None:
            continue
        indexed.append((num, ri))
    indexed.sort(reverse=largest)
    picked = indexed[:n]
    return [
        {col: rows[ri][ci] if ci < len(rows[ri]) else None for ci, col in enumerate(columns)}
        for _, ri in picked
    ]


def _detect_trend(
    rows: Sequence[Sequence[Any]],
    columns: Sequence[str],
    dim_idx: int | None,
    measure_idx: int | None,
) -> dict[str, Any] | None:
    if dim_idx is None or measure_idx is None:
        return None
    name = columns[dim_idx]
    if not _looks_like_datetime_name(name):
        return None

    points: list[tuple[Any, float]] = []
    for row in rows:
        if dim_idx >= len(row) or measure_idx >= len(row):
            continue
        x = row[dim_idx]
        y = _to_number(row[measure_idx])
        if x is None or y is None:
            continue
        points.append((x, y))

    if len(points) < 2:
        return None

    # Sort by string ordering of x — works for ISO dates / sortable labels
    try:
        points.sort(key=lambda p: str(p[0]))
    except Exception:
        return None

    first_y = points[0][1]
    last_y = points[-1][1]
    if first_y == 0:
        pct = None
    else:
        pct = (last_y - first_y) / abs(first_y) * 100.0

    if pct is None:
        direction = "flat"
    elif pct > 5:
        direction = "up"
    elif pct < -5:
        direction = "down"
    else:
        direction = "flat"

    return {
        "direction": direction,
        "pct_change": _round(pct),
        "first": {"x": str(points[0][0]), "y": _round(first_y)},
        "last": {"x": str(points[-1][0]), "y": _round(last_y)},
        "points": len(points),
    }


def _detect_outliers(
    rows: Sequence[Sequence[Any]],
    columns: Sequence[str],
    measure_idx: int | None,
) -> list[dict[str, Any]]:
    if measure_idx is None:
        return []
    nums: list[tuple[int, float]] = []
    for ri, row in enumerate(rows):
        if measure_idx >= len(row):
            continue
        v = _to_number(row[measure_idx])
        if v is None:
            continue
        nums.append((ri, v))
    if len(nums) < 5:
        return []

    values = [v for _, v in nums]
    try:
        mean = statistics.fmean(values)
        sd = statistics.pstdev(values)
    except statistics.StatisticsError:
        return []
    if sd == 0:
        return []

    out = []
    for ri, v in nums:
        z = (v - mean) / sd
        if abs(z) >= 2.0:
            out.append({
                "row": {col: rows[ri][ci] if ci < len(rows[ri]) else None for ci, col in enumerate(columns)},
                "z_score": _round(z),
            })
    out.sort(key=lambda o: -abs(o["z_score"] or 0))
    return out[:5]


# Public API ──────────────────────────────────────────────────────────────────


def build_chart_manifest(
    chart_id: int,
    chart_name: str,
    chart_type: str,
    description: str,
    columns: Sequence[str],
    total_rows: int,
    filters_applied: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """Lightweight manifest entry — no rows, no stats. For ``list_charts`` tool."""
    return {
        "chart_id": chart_id,
        "chart_name": chart_name,
        "chart_type": chart_type,
        "description": description or "",
        "columns": list(columns),
        "total_rows": int(total_rows),
        "filters_applied": list(filters_applied),
    }


def build_insight_pack(
    *,
    chart_id: int,
    chart_name: str,
    chart_type: str,
    description: str,
    columns: Sequence[str],
    rows: Sequence[Sequence[Any]],
    total_rows: int | None = None,
    filters_applied: Sequence[dict[str, Any]] = (),
) -> InsightPack:
    """Compute the Insight Pack from a chart's already-aggregated data.

    ``rows`` is the (possibly truncated) sample. ``total_rows`` is the full
    cardinality if known — we surface this so the LLM does not assume the
    sample is exhaustive.
    """
    columns = list(columns)
    rows = [list(r) for r in rows]
    total = int(total_rows if total_rows is not None else len(rows))
    truncated = total > len(rows)

    if not columns:
        return InsightPack(
            chart_id=chart_id,
            chart_name=chart_name,
            chart_type=chart_type,
            description=description or "",
            total_rows=total,
            sample_rows=len(rows),
            truncated=truncated,
            columns=[],
            primary_measure=None,
            primary_dimension=None,
            top_5=[],
            bottom_5=[],
            trend=None,
            outliers=[],
            filters_applied=list(filters_applied),
        )

    # Transpose for column-wise summaries
    values_by_col: list[list[Any]] = [[] for _ in columns]
    for row in rows:
        for ci in range(len(columns)):
            values_by_col[ci].append(row[ci] if ci < len(row) else None)

    col_summaries = [
        _summarise_column(name, values_by_col[i]) for i, name in enumerate(columns)
    ]

    measure_idx = _detect_primary_measure_index(columns, values_by_col)
    dim_idx = _detect_primary_dimension_index(columns, values_by_col, measure_idx)

    if measure_idx is not None:
        top5 = _top_n_rows(rows, columns, measure_idx, 5, largest=True)
        bot5 = _top_n_rows(rows, columns, measure_idx, 5, largest=False)
    else:
        top5 = [
            {col: rows[ri][ci] if ci < len(rows[ri]) else None for ci, col in enumerate(columns)}
            for ri in range(min(5, len(rows)))
        ]
        bot5 = []

    trend = _detect_trend(rows, columns, dim_idx, measure_idx)
    outliers = _detect_outliers(rows, columns, measure_idx)

    return InsightPack(
        chart_id=chart_id,
        chart_name=chart_name,
        chart_type=chart_type,
        description=description or "",
        total_rows=total,
        sample_rows=len(rows),
        truncated=truncated,
        columns=col_summaries,
        primary_measure=columns[measure_idx] if measure_idx is not None else None,
        primary_dimension=columns[dim_idx] if dim_idx is not None else None,
        top_5=top5,
        bottom_5=bot5,
        trend=trend,
        outliers=outliers,
        filters_applied=list(filters_applied),
    )
