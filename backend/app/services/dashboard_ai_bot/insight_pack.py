"""Insight Pack — deterministic, pre-computed summary statistics for a chart.

The agent calls into here instead of stuffing raw rows into the LLM context.
Numbers returned here are authoritative; the agent is instructed to cite
them rather than computing its own.

Pure functions, no DB access — accepts the normalized ``{columns, rows}``
shape produced by ``dashboard_ai_bot.tools._fetch_chart_data`` after
flattening ``ChartService.get_chart_data()['data']`` (which is a list of
row dicts, NOT a ``{columns, rows}`` envelope).

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
    # Disambiguation flags. ``empty_state`` is None when the chart has data
    # with labelled rows. ``"no_rows"`` means total_rows == 0. 
    # ``"unlabelled_dimension"`` means rows exist but the primary dimension
    # column is entirely NULL/empty — the agent must NOT collapse this into
    # "no data" (the rows are real, the labels are missing).
    empty_state: str | None = None
    # Pre-computed share-of-total for the top row, so the LLM does not need
    # an extra `compute` call just to express "X chiếm Y% tổng". None when
    # primary measure is missing or total is zero.
    top_share_pct: float | None = None
    # Heuristic role of this chart for the dashboard: "kpi" (single number),
    # "trend" (time-series), "breakdown" (category × measure), or
    # "distribution" (long-tail share). Helps the LLM triage which charts
    # are most relevant to a question without inspecting every column.
    chart_role: str = "breakdown"
    # Pre-computed health signals for Phase-2 reasoning. Each is a short
    # token the LLM can lift directly into a bullet:
    #   - "concentration_high"   : top_share_pct > 50 (non-KPI charts only)
    #   - "trend_up_strong" / "trend_down_strong" : abs(pct_change) > 10
    #   - "completion_low"       : measure looks like a percentage and avg < 30
    #   - "completion_high"      : measure looks like a percentage and avg > 70
    #   - "outliers_present"     : >= 1 z>=2 rows
    #   - "single_segment"       : distinct primary_dimension == 1
    #   - "zero_value"           : KPI chart with total == 0 (possible data issue)
    health_signals: list[str] = field(default_factory=list)
    # Data-quality caveats the LLM MUST honour before stating conclusions —
    # e.g. partial/incomplete edge periods excluded from the trend. Surfaced
    # at top level so a skim doesn't miss them.
    caveats: list[str] = field(default_factory=list)

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
            "empty_state": self.empty_state,
            "top_share_pct": _round(self.top_share_pct),
            "chart_role": self.chart_role,
            "health_signals": list(self.health_signals),
            "caveats": list(self.caveats),
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

    ys_all = [y for _, y in points]
    xs_all = [str(x) for x, _ in points]
    n_all = len(ys_all)

    # ── Partial-period guard (Olist trend-bug fix). An edge bucket whose value
    # is a severe low outlier vs the median is almost certainly INCOMPLETE — a
    # launch month with 3 orders, or a data-cutoff month with 1 order. Two such
    # edge points fed to a naive last/first ratio invert the whole story
    # (Olist read as "-53%" when it actually grew). Trim contiguous partial
    # buckets off each end BEFORE judging direction/magnitude.
    try:
        med = statistics.median([abs(y) for y in ys_all])
    except statistics.StatisticsError:
        med = 0.0
    thresh = abs(med) * 0.15
    lo, hi = 0, n_all - 1
    partial_first = partial_last = False
    excluded: list[dict[str, Any]] = []
    while lo < hi and thresh > 0 and abs(ys_all[lo]) < thresh:
        partial_first = True
        excluded.append({"x": xs_all[lo], "y": _round(ys_all[lo]), "edge": "first"})
        lo += 1
    while hi > lo and thresh > 0 and abs(ys_all[hi]) < thresh:
        partial_last = True
        excluded.append({"x": xs_all[hi], "y": _round(ys_all[hi]), "edge": "last"})
        hi -= 1
    core = points[lo:hi + 1]
    ys = [y for _, y in core]
    n = len(ys)

    caveats: list[str] = []
    if partial_first:
        caveats.append("Kỳ đầu KHUYẾT (giá trị quá nhỏ so với trung vị) — đã loại khỏi tính xu hướng.")
    if partial_last:
        caveats.append("Kỳ cuối KHUYẾT (có thể dữ liệu bị cắt) — đã loại khỏi tính xu hướng.")

    if n < 2:
        return {
            "direction": "flat", "pct_change": None, "method": "insufficient_after_trim",
            "first": {"x": xs_all[0], "y": _round(ys_all[0])},
            "last": {"x": xs_all[-1], "y": _round(ys_all[-1])},
            "points": n_all, "points_used": n,
            "partial_first": partial_first, "partial_last": partial_last,
            "excluded_periods": excluded, "caveats": caveats,
        }

    # ── Direction from least-squares slope over the trimmed core (robust to a
    # single noisy point), not the raw endpoints.
    slope, r2 = _linreg(ys)
    mean_y = statistics.fmean(ys) or 0.0
    norm = (slope / abs(mean_y) * 100.0) if mean_y else 0.0  # %/period of the mean
    if norm > 1.0:
        direction = "up"
    elif norm < -1.0:
        direction = "down"
    else:
        direction = "flat"

    # ── Magnitude from avg(first 3) vs avg(last 3) of the trimmed core, not
    # single endpoints.
    k = min(3, n)
    base = statistics.fmean(ys[:k])
    head = statistics.fmean(ys[-k:])
    pct = None if base == 0 else (head - base) / abs(base) * 100.0

    return {
        "direction": direction,
        "pct_change": _round(pct),
        "method": "linreg+trim",
        "slope_per_period": _round(slope),
        "r_squared": _round(r2),
        "first": {"x": str(core[0][0]), "y": _round(core[0][1])},
        "last": {"x": str(core[-1][0]), "y": _round(core[-1][1])},
        "points": n_all,
        "points_used": n,
        "partial_first": partial_first,
        "partial_last": partial_last,
        "excluded_periods": excluded,
        "caveats": caveats,
    }


def _linreg(ys: Sequence[float]) -> tuple[float, float]:
    """Least-squares slope + R² of y indexed 0..n-1."""
    n = len(ys)
    if n < 2:
        return 0.0, 0.0
    xs = list(range(n))
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    if sxx == 0:
        return 0.0, 0.0
    slope = sxy / sxx
    syy = sum((y - my) ** 2 for y in ys)
    r2 = (sxy * sxy) / (sxx * syy) if syy else 0.0
    return slope, r2


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
    total_rows: int | None,
    filters_applied: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """Lightweight manifest entry — no rows, no stats. For ``list_charts`` tool.

    ``total_rows`` may be None when the caller used ``light=True`` (skipped
    the live SQL fetch) — distinct from total_rows=0 which means "we did
    fetch and the chart genuinely has 0 rows under current filters".
    The previous revision coerced unknown to 0, which silently
    misinformed the LLM that every chart was empty (Phase 15.74 fix).
    """
    # Cheap role hint without summary stats. Lets the agent triage in
    # Phase 1 from the manifest alone, before deciding which charts to
    # fetch full summaries for.
    t = (chart_type or "").lower()
    if any(h in t for h in _KPI_TYPE_HINTS):
        role = "kpi"
    elif any(h in t for h in _TREND_TYPE_HINTS):
        role = "trend"
    elif any(h in t for h in _DIST_TYPE_HINTS):
        role = "distribution"
    else:
        role = "breakdown"
    return {
        "chart_id": chart_id,
        "chart_name": chart_name,
        "chart_type": chart_type,
        "description": description or "",
        "columns": list(columns),
        "total_rows": int(total_rows) if total_rows is not None else None,
        "filters_applied": list(filters_applied),
        "role_hint": role,
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

    # Empty-state disambiguation: distinguish "no data" from "rows with
    # unlabelled dimension". If total is 0 → no_rows. If we have rows but
    # the chosen dimension is entirely NULL/empty → unlabelled_dimension.
    empty_state: str | None = None
    if total == 0:
        empty_state = "no_rows"
    elif dim_idx is not None:
        dim_values = values_by_col[dim_idx]
        non_null_labels = [v for v in dim_values if v is not None and str(v).strip() != ""]
        if not non_null_labels:
            empty_state = "unlabelled_dimension"

    # Pre-compute top-1 share of total so the agent can frame "X chiếm Y%"
    # without an extra compute call.
    top_share_pct: float | None = None
    if measure_idx is not None and top5:
        first = top5[0]
        first_val = _to_number(first.get(columns[measure_idx]))
        col_summary = col_summaries[measure_idx] if measure_idx < len(col_summaries) else None
        col_total = col_summary.total if col_summary else None
        if first_val is not None and col_total and col_total > 0:
            top_share_pct = (first_val / col_total) * 100.0

    # Heuristic chart_role classification.
    chart_role = _classify_chart_role(
        chart_type=chart_type,
        chart_name=chart_name,
        columns=columns,
        col_summaries=col_summaries,
        dim_idx=dim_idx,
        measure_idx=measure_idx,
        trend=trend,
        total=total,
    )

    # Health signal extraction. Cheap, deterministic — gives the LLM tokens
    # it can lift directly into a bullet. See InsightPack.health_signals.
    health_signals: list[str] = []
    # concentration_high only makes sense when there are multiple segments;
    # KPI charts always have total_rows==1 so top_share_pct is always 100% —
    # flagging that as "concentration" would be a false positive.
    if top_share_pct is not None and top_share_pct > 50 and chart_role != "kpi":
        health_signals.append("concentration_high")
    # Explicit zero on a KPI is a data-quality / business signal worth surfacing.
    if chart_role == "kpi" and measure_idx is not None:
        col_summary = col_summaries[measure_idx]
        if col_summary.total is not None and col_summary.total == 0:
            health_signals.append("zero_value")
    if trend and trend.get("pct_change") is not None:
        pct = abs(trend["pct_change"])
        if pct > 10:
            health_signals.append(
                "trend_up_strong" if trend.get("direction") == "up" else "trend_down_strong"
            )
    if measure_idx is not None:
        col_summary = col_summaries[measure_idx]
        if col_summary.average is not None and _looks_like_percentage(
            chart_name, col_summary.name, col_summary.maximum
        ):
            avg = col_summary.average
            if avg < 30:
                health_signals.append("completion_low")
            elif avg > 70:
                health_signals.append("completion_high")
    if outliers:
        health_signals.append("outliers_present")
    if dim_idx is not None and col_summaries[dim_idx].distinct == 1 and total > 1:
        health_signals.append("single_segment")
    if trend and (trend.get("partial_first") or trend.get("partial_last")):
        health_signals.append("partial_period")

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
        empty_state=empty_state,
        top_share_pct=top_share_pct,
        chart_role=chart_role,
        health_signals=health_signals,
        caveats=list(trend.get("caveats", [])) if isinstance(trend, dict) else [],
    )


_PERCENT_HINTS = (
    "%", "percent", "tỷ lệ", "ty le", "rate", "completion", "hoàn thành",
    "hoan thanh", "ratio",
)


def _looks_like_percentage(chart_name: str, col_name: str, maximum: float | None) -> bool:
    blob = f"{chart_name or ''} {col_name or ''}".lower()
    if any(h in blob for h in _PERCENT_HINTS):
        return True
    # Numbers all in [0, 100] → likely a percentage scale
    if maximum is not None and 0 <= maximum <= 100:
        return any(h in blob for h in ("rate", "%", "completion"))
    return False


_KPI_TYPE_HINTS = ("kpi", "metric", "card", "number", "stat", "single")
_TREND_TYPE_HINTS = ("line", "area", "trend", "time")
_DIST_TYPE_HINTS = ("pie", "donut", "treemap", "funnel")


def _classify_chart_role(
    *,
    chart_type: str,
    chart_name: str,
    columns: Sequence[str],
    col_summaries: Sequence[ColumnSummary],
    dim_idx: int | None,
    measure_idx: int | None,
    trend: dict[str, Any] | None,
    total: int,
) -> str:
    """Heuristic classification of the chart's analytic role.

    Cheap; uses chart_type, primary dimension kind, and trend availability.
    """
    t = (chart_type or "").lower()
    if any(h in t for h in _KPI_TYPE_HINTS) or total <= 1:
        return "kpi"
    if trend is not None or any(h in t for h in _TREND_TYPE_HINTS):
        return "trend"
    if any(h in t for h in _DIST_TYPE_HINTS):
        return "distribution"
    # Fall back: if the dimension is a short string and there are many rows
    # → breakdown. If just a few rows → distribution.
    if dim_idx is not None and measure_idx is not None and total >= 3:
        return "breakdown"
    return "kpi"
