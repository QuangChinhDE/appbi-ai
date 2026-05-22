"""Advanced analytical tools for the Dashboard AI Bot.

These extend the basic CRUD-style tools in ``tools.py`` with the kind of
operations a senior DA reaches for:

  - compare_periods       : MoM / QoQ / YoY style comparisons within one
                            time-series chart
  - describe_distribution : P50/P90/P95, skewness, Gini coefficient, top-K
                            concentration — exposes "Pareto-style" structure
  - correlate_charts      : Pearson + Spearman across two charts that share
                            a dimension (e.g. same department, same week)
  - detect_anomaly        : per-row z-score / IQR for static charts; rolling
                            z-score / change-point detection for time-series
  - get_chart_image       : produce a tiny ASCII-art or SVG sketch of a
                            chart. Used by the multimodal path so the LLM
                            can SEE the curve, not just numbers.
    - get_dashboard_overview_image
                                                    : render a single visual overview of the current
                                                        dashboard/report surface for screenshot-style
                                                        analysis without a user-visible export button.

All tools share the ``ToolContext`` defined in ``tools.py`` and reuse
``_fetch_chart_data`` for filter-aware reads.
"""
from __future__ import annotations

import logging
import math
import statistics
from collections.abc import Sequence
from typing import Any

from app.services.dashboard_ai_bot.tools import (
    MAX_TOP_N,
    ToolContext,
    ToolError,
    _fetch_chart_data,
    _ok,
    _err,
    _round,
)

logger = logging.getLogger(__name__)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _to_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
        if not math.isfinite(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


_DATETIME_HINTS = ("date", "time", "month", "week", "year", "day", "ngay", "thang", "tuan", "quy")


def _looks_like_datetime(name: str) -> bool:
    n = (name or "").lower()
    return any(h in n for h in _DATETIME_HINTS)


def _detect_measure_idx(columns: Sequence[str], rows: Sequence[Sequence[Any]]) -> int | None:
    """Pick the LAST all-numeric column."""
    numeric_indices: list[int] = []
    for i in range(len(columns)):
        nums = [_to_number(r[i]) for r in rows if i < len(r)]
        nums = [n for n in nums if n is not None]
        if nums and len(nums) >= max(1, int(0.6 * len(rows))):
            numeric_indices.append(i)
    return numeric_indices[-1] if numeric_indices else None


def _detect_dim_idx(
    columns: Sequence[str],
    rows: Sequence[Sequence[Any]],
    measure_idx: int | None,
    *,
    prefer_datetime: bool = False,
) -> int | None:
    candidates = [i for i in range(len(columns)) if i != measure_idx]
    if not candidates:
        return None
    if prefer_datetime:
        for i in candidates:
            if _looks_like_datetime(columns[i]):
                return i
    for i in candidates:
        sample = next((r[i] for r in rows if i < len(r) and r[i] is not None), None)
        if isinstance(sample, str):
            return i
    return candidates[0]


# ── Tool: compare_periods ────────────────────────────────────────────────────
#
# Input:
#   - chart_id  (required)
#   - mode      "auto" | "mom" | "qoq" | "yoy" | "custom"  (default: "auto")
#   - period_a  (optional, "custom" only) — string label that exists in dim
#   - period_b  (optional, "custom" only)
#
# Output: deltas, % change, recent run-rate, classification (improving /
# worsening / flat) and a one-line narrative the LLM can lift verbatim.


def tool_compare_periods(ctx: ToolContext, args: dict) -> dict:
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    mode = str(args.get("mode") or "auto").lower()
    if mode not in ("auto", "mom", "qoq", "yoy", "custom"):
        return _err("mode must be one of: auto, mom, qoq, yoy, custom")

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}")

    columns: list[str] = data["columns"]
    rows: list[list] = data["rows"]
    if not rows or not columns:
        return _err("chart has no data to compare")

    measure_idx = _detect_measure_idx(columns, rows)
    dim_idx = _detect_dim_idx(columns, rows, measure_idx, prefer_datetime=True)
    if measure_idx is None or dim_idx is None:
        return _err("need at least one dimension and one numeric column")
    if not _looks_like_datetime(columns[dim_idx]) and mode != "custom":
        return _err(
            f"chart's dimension '{columns[dim_idx]}' does not look like a "
            "time series; use mode='custom' with explicit period_a/period_b"
        )

    # Sort by dim ascending (assumes ISO-ish labels)
    sorted_rows = sorted(
        rows,
        key=lambda r: ("" if dim_idx >= len(r) or r[dim_idx] is None else str(r[dim_idx])),
    )
    points: list[tuple[str, float]] = []
    for r in sorted_rows:
        x = r[dim_idx] if dim_idx < len(r) else None
        y = _to_number(r[measure_idx]) if measure_idx < len(r) else None
        if x is None or y is None:
            continue
        points.append((str(x), y))
    if len(points) < 2:
        return _err("need at least 2 time points to compare")

    if mode == "custom":
        period_a = str(args.get("period_a") or "")
        period_b = str(args.get("period_b") or "")
        if not period_a or not period_b:
            return _err("mode=custom requires period_a and period_b")
        a_val = next((y for x, y in points if x == period_a), None)
        b_val = next((y for x, y in points if x == period_b), None)
        if a_val is None or b_val is None:
            return _err(
                f"period not found in chart: a={period_a!r}, b={period_b!r}"
            )
        return _ok(_compare_pair(a_val, b_val, period_a, period_b, columns[measure_idx]))

    # AUTO / MoM / QoQ / YoY all reduce to "compare last with N steps back".
    if mode in ("auto", "mom"):
        offset = 1
    elif mode == "qoq":
        offset = 3   # assume monthly granularity; 3 months = 1 quarter
    else:  # yoy
        offset = 12

    if len(points) <= offset:
        # Not enough history — fall back to comparing first vs last
        a = points[-1]
        b = points[0]
        offset = len(points) - 1
        narrative_label = f"{b[0]} → {a[0]} (chuỗi dữ liệu chỉ có {len(points)} điểm, không đủ {mode.upper()})"
    else:
        a = points[-1]
        b = points[-1 - offset]
        narrative_label = f"{b[0]} → {a[0]} ({mode.upper()})"

    base_payload = _compare_pair(a[1], b[1], a[0], b[0], columns[measure_idx])
    base_payload["mode"] = mode
    base_payload["narrative_label"] = narrative_label
    base_payload["chart_id"] = chart_id
    # Recent run-rate: average of last min(3, n) points
    recent_n = min(3, len(points))
    recent_avg = statistics.fmean(y for _, y in points[-recent_n:])
    base_payload["recent_avg_last_3"] = _round(recent_avg)
    base_payload["points_used"] = len(points)
    return _ok(base_payload)


def _compare_pair(a_val: float, b_val: float, a_label: str, b_label: str, measure: str) -> dict:
    delta = a_val - b_val
    pct = None if b_val == 0 else (delta / abs(b_val)) * 100.0
    if pct is None:
        verdict = "no_baseline"
    elif pct > 5:
        verdict = "improving"
    elif pct < -5:
        verdict = "worsening"
    else:
        verdict = "flat"
    return {
        "measure": measure,
        "current": {"label": a_label, "value": _round(a_val)},
        "baseline": {"label": b_label, "value": _round(b_val)},
        "delta": _round(delta),
        "pct_change": _round(pct),
        "verdict": verdict,
    }


# ── Tool: describe_distribution ─────────────────────────────────────────────
#
# For a chart's primary measure, return:
#   - P50 / P90 / P95 / max
#   - skewness  (Pearson median skew, simple)
#   - gini      (Gini coefficient — concentration index)
#   - top_k_share[10/20] : fraction held by top 10% / 20% of segments
#   - pareto_threshold   : "X% segments hold 80% of measure"


def tool_describe_distribution(ctx: ToolContext, args: dict) -> dict:
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}")

    columns = data["columns"]
    rows = data["rows"]
    if not rows or not columns:
        return _err("chart has no data")

    measure_idx = _detect_measure_idx(columns, rows)
    if measure_idx is None:
        return _err("no numeric measure column found")

    nums: list[float] = []
    for r in rows:
        if measure_idx >= len(r):
            continue
        v = _to_number(r[measure_idx])
        if v is None:
            continue
        nums.append(v)
    if len(nums) < 2:
        return _err("need at least 2 numeric data points")

    nums_sorted = sorted(nums)
    total = sum(nums_sorted)
    n = len(nums_sorted)

    p50 = _percentile(nums_sorted, 50)
    p90 = _percentile(nums_sorted, 90)
    p95 = _percentile(nums_sorted, 95)
    max_v = nums_sorted[-1]
    min_v = nums_sorted[0]
    mean = statistics.fmean(nums_sorted)
    try:
        sd = statistics.pstdev(nums_sorted)
    except statistics.StatisticsError:
        sd = 0.0

    skew = 0.0
    if sd > 0 and p50 is not None:
        skew = 3 * (mean - p50) / sd

    gini = _gini(nums_sorted) if total > 0 else 0.0

    # Top-K share
    top10 = max(1, int(round(n * 0.1)))
    top20 = max(1, int(round(n * 0.2)))
    top10_share = (sum(nums_sorted[-top10:]) / total * 100) if total > 0 else None
    top20_share = (sum(nums_sorted[-top20:]) / total * 100) if total > 0 else None

    # Pareto threshold: how many segments make up 80%?
    pareto_threshold_pct = None
    if total > 0:
        running = 0.0
        for i, v in enumerate(reversed(nums_sorted), 1):
            running += v
            if running / total >= 0.8:
                pareto_threshold_pct = round(i / n * 100, 1)
                break

    verdict = "balanced"
    if gini > 0.6:
        verdict = "highly_concentrated"
    elif gini > 0.4:
        verdict = "concentrated"
    elif gini < 0.2:
        verdict = "very_balanced"

    return _ok({
        "chart_id": chart_id,
        "measure": columns[measure_idx],
        "n": n,
        "min": _round(min_v),
        "max": _round(max_v),
        "mean": _round(mean),
        "std": _round(sd),
        "p50": _round(p50),
        "p90": _round(p90),
        "p95": _round(p95),
        "skewness": _round(skew),
        "gini": _round(gini),
        "top10_share_pct": _round(top10_share),
        "top20_share_pct": _round(top20_share),
        "pareto_segments_for_80pct": pareto_threshold_pct,
        "verdict": verdict,
    })


def _percentile(sorted_values: list[float], pct: float) -> float | None:
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return sorted_values[0]
    rank = (pct / 100) * (len(sorted_values) - 1)
    lo = int(math.floor(rank))
    hi = int(math.ceil(rank))
    if lo == hi:
        return sorted_values[lo]
    frac = rank - lo
    return sorted_values[lo] * (1 - frac) + sorted_values[hi] * frac


def _gini(sorted_values: list[float]) -> float:
    """Gini coefficient on a non-decreasing list of non-negative values."""
    if not sorted_values:
        return 0.0
    # Clamp negatives — Gini is undefined for them
    vals = [max(0.0, v) for v in sorted_values]
    n = len(vals)
    s = sum(vals)
    if s == 0:
        return 0.0
    cum = 0.0
    weighted = 0.0
    for i, v in enumerate(vals, 1):
        cum += v
        weighted += i * v
    return (2 * weighted) / (n * s) - (n + 1) / n


# ── Tool: correlate_charts ──────────────────────────────────────────────────
#
# Given chart_a and chart_b that share a common dimension column (by name),
# join on that dimension and compute Pearson + Spearman correlation between
# the two measure columns. Useful to test "does X drive Y?" kind of questions.


def tool_correlate_charts(ctx: ToolContext, args: dict) -> dict:
    chart_a = args.get("chart_a")
    chart_b = args.get("chart_b")
    on = args.get("on")  # column name expected to exist in both
    if not isinstance(chart_a, int) or not isinstance(chart_b, int):
        return _err("chart_a and chart_b (int) are required")
    if chart_a == chart_b:
        return _err("chart_a and chart_b must be different")
    if not isinstance(on, str) or not on:
        return _err("on (column name shared by both charts) is required")
    try:
        ctx.assert_chart_in_scope(chart_a)
        ctx.assert_chart_in_scope(chart_b)
    except ToolError as exc:
        return _err(str(exc))

    try:
        data_a = _fetch_chart_data(ctx, chart_a)
        data_b = _fetch_chart_data(ctx, chart_b)
    except Exception as exc:
        return _err(f"failed to load charts: {type(exc).__name__}")

    cols_a = data_a["columns"]
    cols_b = data_b["columns"]
    if on not in cols_a or on not in cols_b:
        return _err(
            f"column '{on}' missing in one of the charts. "
            f"chart_a cols={cols_a}, chart_b cols={cols_b}"
        )
    dim_a = cols_a.index(on)
    dim_b = cols_b.index(on)
    measure_a = _detect_measure_idx(cols_a, data_a["rows"])
    measure_b = _detect_measure_idx(cols_b, data_b["rows"])
    if measure_a is None or measure_b is None:
        return _err("could not detect a numeric measure in one of the charts")

    map_a: dict[str, float] = {}
    for r in data_a["rows"]:
        if dim_a >= len(r) or measure_a >= len(r):
            continue
        key = str(r[dim_a]) if r[dim_a] is not None else None
        val = _to_number(r[measure_a])
        if key is None or val is None:
            continue
        map_a[key] = val
    map_b: dict[str, float] = {}
    for r in data_b["rows"]:
        if dim_b >= len(r) or measure_b >= len(r):
            continue
        key = str(r[dim_b]) if r[dim_b] is not None else None
        val = _to_number(r[measure_b])
        if key is None or val is None:
            continue
        map_b[key] = val

    common = sorted(set(map_a.keys()) & set(map_b.keys()))
    if len(common) < 3:
        return _err(f"need ≥3 common values of '{on}', found {len(common)}")

    xs = [map_a[k] for k in common]
    ys = [map_b[k] for k in common]
    pearson = _pearson(xs, ys)
    spearman = _spearman(xs, ys)

    strength = "weak"
    if pearson is not None:
        ap = abs(pearson)
        if ap >= 0.7:
            strength = "strong"
        elif ap >= 0.4:
            strength = "moderate"

    direction = "none"
    if pearson is not None:
        if pearson > 0.1:
            direction = "positive"
        elif pearson < -0.1:
            direction = "negative"

    sample = [
        {"key": k, "value_a": _round(map_a[k]), "value_b": _round(map_b[k])}
        for k in common[:10]
    ]

    return _ok({
        "chart_a": chart_a,
        "chart_b": chart_b,
        "joined_on": on,
        "n_common": len(common),
        "measure_a": cols_a[measure_a],
        "measure_b": cols_b[measure_b],
        "pearson": _round(pearson),
        "spearman": _round(spearman),
        "direction": direction,
        "strength": strength,
        "sample": sample,
    })


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 2 or n != len(ys):
        return None
    mx = statistics.fmean(xs)
    my = statistics.fmean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def _spearman(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) != len(ys) or len(xs) < 2:
        return None
    rx = _ranks(xs)
    ry = _ranks(ys)
    return _pearson(rx, ry)


def _ranks(values: list[float]) -> list[float]:
    indexed = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(indexed):
        j = i
        while j + 1 < len(indexed) and values[indexed[j + 1]] == values[indexed[i]]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[indexed[k]] = avg_rank
        i = j + 1
    return ranks


# ── Tool: detect_anomaly ────────────────────────────────────────────────────
#
# Modes:
#   - "zscore"    : default. flag rows whose measure has |z| ≥ threshold (2)
#   - "iqr"       : flag rows outside Q1-1.5*IQR or Q3+1.5*IQR
#   - "rolling"   : rolling z over a time-series chart (window=3)
#   - "changepoint": simple CUSUM-style change-point detection on a time-series


def tool_detect_anomaly(ctx: ToolContext, args: dict) -> dict:
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    method = str(args.get("method") or "zscore").lower()
    if method not in ("zscore", "iqr", "rolling", "changepoint"):
        return _err("method must be one of: zscore, iqr, rolling, changepoint")

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}")

    columns = data["columns"]
    rows = data["rows"]
    if not rows:
        return _err("chart has no data")

    measure_idx = _detect_measure_idx(columns, rows)
    if measure_idx is None:
        return _err("no numeric measure detected")

    if method in ("rolling", "changepoint"):
        dim_idx = _detect_dim_idx(columns, rows, measure_idx, prefer_datetime=True)
        if dim_idx is None or not _looks_like_datetime(columns[dim_idx]):
            return _err(f"{method} requires a time dimension")
        sorted_rows = sorted(rows, key=lambda r: str(r[dim_idx]) if dim_idx < len(r) and r[dim_idx] is not None else "")
        points = [
            (str(r[dim_idx]), _to_number(r[measure_idx]))
            for r in sorted_rows if dim_idx < len(r) and measure_idx < len(r)
        ]
        points = [(x, y) for x, y in points if y is not None]
        if len(points) < 5:
            return _err("need ≥5 time points for rolling/changepoint")
        if method == "rolling":
            return _ok(_rolling_z(points, columns[measure_idx], chart_id))
        return _ok(_changepoint(points, columns[measure_idx], chart_id))

    # Static methods (zscore / iqr)
    indexed: list[tuple[int, float]] = []
    for ri, r in enumerate(rows):
        if measure_idx >= len(r):
            continue
        v = _to_number(r[measure_idx])
        if v is None:
            continue
        indexed.append((ri, v))
    if len(indexed) < 5:
        return _err("need ≥5 numeric points for zscore/iqr")
    values = [v for _, v in indexed]

    flagged: list[dict] = []
    if method == "zscore":
        threshold = float(args.get("threshold") or 2.0)
        try:
            mean = statistics.fmean(values)
            sd = statistics.pstdev(values)
        except statistics.StatisticsError:
            return _err("could not compute z-score (sd=0)")
        if sd == 0:
            return _ok({"chart_id": chart_id, "method": "zscore", "anomalies": []})
        for ri, v in indexed:
            z = (v - mean) / sd
            if abs(z) >= threshold:
                row = rows[ri]
                flagged.append({
                    "row_index": ri,
                    "row": {col: row[i] if i < len(row) else None for i, col in enumerate(columns)},
                    "z_score": _round(z),
                    "value": _round(v),
                })
    else:  # iqr
        sv = sorted(values)
        q1 = _percentile(sv, 25) or 0
        q3 = _percentile(sv, 75) or 0
        iqr = q3 - q1
        lo = q1 - 1.5 * iqr
        hi = q3 + 1.5 * iqr
        for ri, v in indexed:
            if v < lo or v > hi:
                row = rows[ri]
                flagged.append({
                    "row_index": ri,
                    "row": {col: row[i] if i < len(row) else None for i, col in enumerate(columns)},
                    "value": _round(v),
                    "boundary": "low" if v < lo else "high",
                })

    flagged.sort(key=lambda d: -abs(d.get("z_score") or d.get("value") or 0))
    return _ok({
        "chart_id": chart_id,
        "method": method,
        "measure": columns[measure_idx],
        "n_total": len(indexed),
        "n_anomalies": len(flagged),
        "anomalies": flagged[:10],
    })


def _rolling_z(points: list[tuple[str, float]], measure: str, chart_id: int) -> dict:
    """Window=3 rolling z-score: z = (current - mean(prev3)) / sd(prev3)."""
    flagged = []
    window = 3
    for i in range(window, len(points)):
        prev = [p[1] for p in points[i - window:i]]
        try:
            m = statistics.fmean(prev)
            sd = statistics.pstdev(prev)
        except statistics.StatisticsError:
            continue
        if sd == 0:
            continue
        z = (points[i][1] - m) / sd
        if abs(z) >= 2:
            flagged.append({
                "x": points[i][0],
                "value": _round(points[i][1]),
                "rolling_mean": _round(m),
                "rolling_sd": _round(sd),
                "z_score": _round(z),
            })
    return {
        "chart_id": chart_id,
        "method": "rolling",
        "measure": measure,
        "window": window,
        "n_total": len(points),
        "n_anomalies": len(flagged),
        "anomalies": flagged[:10],
    }


def _changepoint(points: list[tuple[str, float]], measure: str, chart_id: int) -> dict:
    """Naive change-point: split the series at every internal index, compute
    abs diff in means, return the split with the largest gap if it's
    statistically meaningful (>1 SD of overall series).
    """
    values = [v for _, v in points]
    overall_sd = statistics.pstdev(values)
    if overall_sd == 0:
        return {
            "chart_id": chart_id, "method": "changepoint",
            "measure": measure, "changepoint": None,
        }
    best_idx = -1
    best_gap = 0.0
    for i in range(2, len(points) - 1):
        left = values[:i]
        right = values[i:]
        gap = abs(statistics.fmean(left) - statistics.fmean(right))
        if gap > best_gap:
            best_gap = gap
            best_idx = i
    if best_idx == -1 or best_gap < overall_sd:
        return {
            "chart_id": chart_id, "method": "changepoint",
            "measure": measure, "changepoint": None,
        }
    return {
        "chart_id": chart_id,
        "method": "changepoint",
        "measure": measure,
        "n_total": len(points),
        "changepoint": {
            "at_index": best_idx,
            "at_x": points[best_idx][0],
            "before_mean": _round(statistics.fmean(values[:best_idx])),
            "after_mean": _round(statistics.fmean(values[best_idx:])),
            "gap": _round(best_gap),
            "sd_overall": _round(overall_sd),
        },
    }


# ── Tool: smart_drilldown ──────────────────────────────────────────────────
#
# Goal: "show me ONLY the rows of chart X where column Y matches value Z, then
# rank by primary measure". This is what users mean by "đào sâu vào phòng IT"
# or "chỉ xem khách hàng nhóm A". It uses get_chart_data + an ad-hoc filter
# layered on top of the existing chart filters.


def tool_smart_drilldown(ctx: ToolContext, args: dict) -> dict:
    chart_id = args.get("chart_id")
    column = args.get("column")
    match = args.get("match")
    op = str(args.get("op") or "eq").lower()
    top_n = args.get("top_n") or 10

    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    if not isinstance(column, str) or not column:
        return _err("column (str) is required")
    if match is None:
        return _err("match (value to filter on) is required")
    # Accept both canonical ("ne", "starts_with") and legacy alias names.
    _OP_ALIAS = {"neq": "ne", "startswith": "starts_with"}
    op = _OP_ALIAS.get(op, op)
    if op not in ("eq", "ne", "contains", "starts_with", "gt", "lt", "gte", "lte"):
        return _err(f"unsupported op: {op}")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    if not isinstance(top_n, int) or top_n <= 0:
        top_n = 10
    top_n = min(top_n, MAX_TOP_N)

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}")

    columns = data["columns"]
    rows = data["rows"]
    if column not in columns:
        return _err(f"column '{column}' not in chart columns {columns}")
    col_idx = columns.index(column)

    def _matches(v: Any) -> bool:
        if v is None:
            return False
        if op in ("eq", "ne"):
            same = str(v) == str(match)
            return same if op == "eq" else not same
        if op == "contains":
            return str(match).lower() in str(v).lower()
        if op == "starts_with":
            return str(v).lower().startswith(str(match).lower())
        # numeric ops
        nv = _to_number(v)
        nm = _to_number(match)
        if nv is None or nm is None:
            return False
        if op == "gt":  return nv > nm
        if op == "lt":  return nv < nm
        if op == "gte": return nv >= nm
        if op == "lte": return nv <= nm
        return False

    filtered = [r for r in rows if col_idx < len(r) and _matches(r[col_idx])]
    if not filtered:
        return _ok({
            "chart_id": chart_id,
            "filter": {"column": column, "op": op, "match": match},
            "n_rows_total": len(rows),
            "n_rows_matching": 0,
            "rows": [],
            "totals": None,
        })

    measure_idx = _detect_measure_idx(columns, filtered)
    totals: dict[str, Any] | None = None
    if measure_idx is not None:
        nums = [_to_number(r[measure_idx]) for r in filtered if measure_idx < len(r)]
        nums = [n for n in nums if n is not None]
        if nums:
            totals = {
                "measure": columns[measure_idx],
                "sum": _round(sum(nums)),
                "avg": _round(sum(nums) / len(nums)),
                "min": _round(min(nums)),
                "max": _round(max(nums)),
                "n": len(nums),
            }
        # Sort filtered desc by measure for ranking
        filtered = sorted(
            filtered,
            key=lambda r: -(_to_number(r[measure_idx]) or 0)
            if measure_idx < len(r) else 0,
        )

    rows_out = [
        {col: r[i] if i < len(r) else None for i, col in enumerate(columns)}
        for r in filtered[:top_n]
    ]
    return _ok({
        "chart_id": chart_id,
        "filter": {"column": column, "op": op, "match": match},
        "n_rows_total": len(rows),
        "n_rows_matching": len(filtered),
        "rows": rows_out,
        "totals": totals,
    })


# ── Tool: aggregate_chart_data ──────────────────────────────────────────────
#
# Group-by + aggregate over a chart's already-fetched rows. This is the
# missing primitive that lets the bot pivot a raw row-level chart (e.g. a
# Priority Task List with one row per task carrying ``department_name`` and
# ``is_overdue``) into the analytical view a DA would write in SQL:
#
#   SELECT department_name,
#          COUNT(*)                          AS total,
#          SUM(CASE WHEN is_overdue THEN 1 ELSE 0 END) AS overdue,
#          AVG(CASE WHEN is_overdue THEN 1 ELSE 0 END) AS overdue_rate
#   FROM <chart>
#   GROUP BY department_name
#   ORDER BY overdue_rate DESC
#   LIMIT 10;
#
# Inputs:
#   chart_id       (int, required)
#   group_by       list[str]  — categorical column(s) to GROUP BY (1-3)
#   aggregations   list[dict] — each with:
#                     column   : source column name (use "*" for COUNT all rows)
#                     op       : "count" | "count_truthy" | "count_distinct"
#                                | "sum" | "avg" | "min" | "max"
#                                | "ratio_truthy"          (= count_truthy / count)
#                                | "ratio_truthy_pct"      (= * 100)
#                     as       : output column name (defaults to "{op}_{column}")
#   filters        list[dict] (optional) — row-level pre-filter, same shape
#                  as the public_filters list:
#                     {column: str, op: "eq"|"neq"|"contains"|"truthy", value: any}
#   sort_by        str (optional) — output column name
#   order          "asc" | "desc" (default "desc" if sort_by given)
#   top_n          int (optional, capped at MAX_TOP_N)
#
# Output: aggregated rows + the SQL-equivalent expression (for traceability)
# and totals across the whole result so the agent can frame "X chiếm Y% of
# the population" without an extra compute call.


_TRUTHY_TRUE_TOKENS = {"true", "t", "yes", "y", "1", "có", "co", "đúng", "dung"}
_TRUTHY_FALSE_TOKENS = {"false", "f", "no", "n", "0", "không", "khong", "sai"}


def _is_truthy(v: Any) -> bool | None:
    """Three-valued truthiness for boolean-ish column values.

    Returns True / False for clearly boolean-like values (Python bool, 0/1,
    common string tokens). Returns None for NULL / empty string / values we
    cannot map — caller decides whether to count or skip.
    """
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        if math.isnan(v) if isinstance(v, float) else False:
            return None
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if not s:
            return None
        if s in _TRUTHY_TRUE_TOKENS:
            return True
        if s in _TRUTHY_FALSE_TOKENS:
            return False
        return None
    return bool(v)


def _row_passes_filter(row: list, columns: list[str], flt: dict) -> bool:
    col = flt.get("column")
    if not isinstance(col, str) or col not in columns:
        return True  # unknown column → no-op, do not silently drop rows
    idx = columns.index(col)
    val = row[idx] if idx < len(row) else None
    op = str(flt.get("op") or "eq").lower()
    target = flt.get("value")
    if op == "eq":
        return str(val) == str(target)
    if op == "neq":
        return str(val) != str(target)
    if op == "contains":
        return target is not None and str(target).lower() in (str(val) if val is not None else "").lower()
    if op == "truthy":
        return _is_truthy(val) is True
    if op == "falsy":
        return _is_truthy(val) is False
    if op == "not_null":
        return val is not None and str(val).strip() != ""
    return True


_AGG_OPS = (
    "count",
    "count_truthy",
    "count_distinct",
    "sum",
    "avg",
    "min",
    "max",
    "ratio_truthy",
    "ratio_truthy_pct",
)


def _apply_agg(op: str, col_idx: int | None, group_rows: list[list]) -> float | int | None:
    """Apply a single aggregation over a group's rows. ``col_idx`` is None for
    op='count' over all rows ("*").
    """
    if op == "count":
        if col_idx is None:
            return len(group_rows)
        return sum(
            1
            for r in group_rows
            if col_idx < len(r) and r[col_idx] is not None and str(r[col_idx]).strip() != ""
        )
    if op == "count_truthy":
        if col_idx is None:
            return None
        return sum(1 for r in group_rows if col_idx < len(r) and _is_truthy(r[col_idx]) is True)
    if op == "count_distinct":
        if col_idx is None:
            return None
        seen = set()
        for r in group_rows:
            if col_idx < len(r) and r[col_idx] is not None:
                seen.add(str(r[col_idx]))
        return len(seen)
    if op in ("sum", "avg", "min", "max"):
        if col_idx is None:
            return None
        nums = [
            _to_number(r[col_idx])
            for r in group_rows
            if col_idx < len(r)
        ]
        nums = [n for n in nums if n is not None]
        if not nums:
            return None
        if op == "sum":
            return sum(nums)
        if op == "avg":
            return sum(nums) / len(nums)
        if op == "min":
            return min(nums)
        return max(nums)
    if op in ("ratio_truthy", "ratio_truthy_pct"):
        if col_idx is None:
            return None
        denom = 0
        truthy = 0
        for r in group_rows:
            if col_idx >= len(r):
                continue
            t = _is_truthy(r[col_idx])
            if t is None:
                continue
            denom += 1
            if t:
                truthy += 1
        if denom == 0:
            return None
        ratio = truthy / denom
        return ratio * 100.0 if op == "ratio_truthy_pct" else ratio
    return None


def tool_aggregate_chart_data(ctx: ToolContext, args: dict) -> dict:
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    group_by = args.get("group_by") or []
    if not isinstance(group_by, list) or not group_by:
        return _err("group_by (list[str]) with 1-3 columns is required")
    if len(group_by) > 3:
        return _err("group_by supports at most 3 columns")
    group_by = [str(g) for g in group_by]

    aggregations = args.get("aggregations") or []
    if not isinstance(aggregations, list) or not aggregations:
        return _err(
            "aggregations (list[dict]) is required; each entry needs `column` and `op`"
        )
    if len(aggregations) > 6:
        return _err("aggregations supports at most 6 entries")

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}")

    columns: list[str] = data["columns"]
    rows: list[list] = data["rows"]

    # Validate group_by columns exist
    for g in group_by:
        if g not in columns:
            return _err(f"group_by column {g!r} not in chart columns {columns}")
    group_indices = [columns.index(g) for g in group_by]

    # Validate aggregations
    parsed_aggs: list[dict] = []
    for a in aggregations:
        if not isinstance(a, dict):
            return _err("each aggregation must be a dict")
        col = a.get("column")
        op = str(a.get("op") or "").lower()
        if op not in _AGG_OPS:
            return _err(f"agg op {op!r} not supported; use one of {_AGG_OPS}")
        if col == "*" or col is None:
            col_idx: int | None = None
            if op != "count":
                return _err(f"column='*' only valid with op='count' (got {op!r})")
        elif not isinstance(col, str):
            return _err("aggregation.column must be a string")
        elif col not in columns:
            return _err(f"aggregation column {col!r} not in chart columns {columns}")
        else:
            col_idx = columns.index(col)
        out_name = str(a.get("as") or "").strip() or (
            f"{op}_*" if col_idx is None else f"{op}_{columns[col_idx]}"
        )
        parsed_aggs.append({"op": op, "col_idx": col_idx, "out": out_name, "src": col})

    # Apply pre-filters (the agent can reuse the same filter dict shape)
    pre_filters = args.get("filters") or []
    if not isinstance(pre_filters, list):
        return _err("filters must be a list of {column, op, value} dicts")
    if pre_filters:
        rows = [
            r for r in rows
            if all(_row_passes_filter(r, columns, f) for f in pre_filters if isinstance(f, dict))
        ]

    if not rows:
        return _ok({
            "chart_id": chart_id,
            "group_by": group_by,
            "aggregations": [{"op": a["op"], "column": a["src"], "as": a["out"]} for a in parsed_aggs],
            "filters_applied": pre_filters,
            "n_groups": 0,
            "n_rows_total": 0,
            "rows": [],
            "totals": {},
            "narrative_label": "Không có dòng nào sau bộ lọc",
        })

    # Bucket rows by composite key
    buckets: dict[tuple, list[list]] = {}
    for r in rows:
        key = tuple(
            ("" if gi >= len(r) or r[gi] is None else str(r[gi]))
            for gi in group_indices
        )
        buckets.setdefault(key, []).append(r)

    # Compute aggregations per group
    out_rows: list[dict] = []
    for key, group_rows in buckets.items():
        out: dict[str, Any] = {}
        for gname, kval in zip(group_by, key):
            out[gname] = kval if kval != "" else None
        for agg in parsed_aggs:
            v = _apply_agg(agg["op"], agg["col_idx"], group_rows)
            out[agg["out"]] = _round(v) if isinstance(v, float) else v
        out_rows.append(out)

    # Sort + top_n
    sort_by = args.get("sort_by")
    if isinstance(sort_by, str) and sort_by:
        order = str(args.get("order") or "desc").lower()
        rev = order != "asc"
        out_rows.sort(
            key=lambda d: (d.get(sort_by) is None, d.get(sort_by) if d.get(sort_by) is not None else 0),
            reverse=rev,
        )

    n_groups = len(out_rows)
    top_n = args.get("top_n")
    if isinstance(top_n, int) and top_n > 0:
        out_rows = out_rows[: min(top_n, MAX_TOP_N)]

    # Population-level totals so the agent can express "group X covers Y% of all"
    totals: dict[str, Any] = {"n_rows": len(rows)}
    # Per agg, compute the total over ALL filtered rows (single bucket = all)
    for agg in parsed_aggs:
        v = _apply_agg(agg["op"], agg["col_idx"], rows)
        if isinstance(v, float):
            v = _round(v)
        totals[agg["out"]] = v

    return _ok({
        "chart_id": chart_id,
        "group_by": group_by,
        "aggregations": [{"op": a["op"], "column": a["src"], "as": a["out"]} for a in parsed_aggs],
        "filters_applied": pre_filters,
        "n_groups": n_groups,
        "n_rows_total": len(rows),
        "rows": out_rows,
        "totals": totals,
    })


# ── Tool: get_chart_image ───────────────────────────────────────────────────
#
# Produces a tiny ASCII sketch of the chart so the LLM can "see" the shape
# (rising / falling / spiking). For a real-image multimodal upgrade later we
# can swap the implementation to render PNG via matplotlib + return base64.


def tool_get_chart_image(ctx: ToolContext, args: dict) -> dict:
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}")

    columns = data["columns"]
    rows = data["rows"]
    if not rows:
        return _err("chart has no data")

    # Take a generous sample to keep PNG render fast but still representative.
    rows_for_render = list(rows[:200])

    measure_idx = _detect_measure_idx(columns, rows_for_render)
    dim_idx = _detect_dim_idx(columns, rows_for_render, measure_idx, prefer_datetime=True)

    # Always emit ASCII (cheap, useful even when PNG fails).
    ascii_block = "(không đủ dữ liệu để vẽ)"
    summary_line = ""
    points: list[tuple[str, float]] = []
    if measure_idx is not None and dim_idx is not None:
        sorted_rows = sorted(
            rows_for_render,
            key=lambda r: str(r[dim_idx]) if dim_idx < len(r) and r[dim_idx] is not None else "",
        )
        points = [
            (str(r[dim_idx]), _to_number(r[measure_idx]))
            for r in sorted_rows if dim_idx < len(r) and measure_idx < len(r)
        ]
        points = [(x, y) for x, y in points if y is not None]
        if points:
            ascii_block = _ascii_sparkline(points)
            summary_line = _shape_summary(points)

    # Render real PNG in a separate try so a renderer failure doesn't lose ASCII.
    png_payload: dict | None = None
    try:
        from app.services.dashboard_ai_bot.chart_renderer import render_chart_png
        meta = ctx.chart_meta.get(chart_id, {})
        chart_role = "kpi" if (meta.get("chart_type") or "").lower() in (
            "kpi", "metric", "card", "number"
        ) else ""
        # Honour caller hint (caller often knows the role from the manifest)
        chart_role = str(args.get("chart_role") or chart_role or "")
        rendered = render_chart_png(
            chart_id=chart_id,
            chart_name=meta.get("name", f"Chart {chart_id}"),
            chart_type=meta.get("chart_type", ""),
            chart_role=chart_role,
            columns=columns,
            rows=rows_for_render,
            dim_idx=dim_idx,
            measure_idx=measure_idx,
        )
        if rendered.get("ok"):
            png_payload = rendered
    except Exception as exc:
        logger.warning("chart_image png render failed chart_id=%s err=%s", chart_id, type(exc).__name__)

    payload: dict = {
        "chart_id": chart_id,
        "kind": (png_payload or {}).get("kind", "ascii_sparkline"),
        "dimension": columns[dim_idx] if dim_idx is not None else None,
        "measure": columns[measure_idx] if measure_idx is not None else None,
        "ascii": ascii_block,
        "shape_summary": summary_line,
        "n_points": len(points),
    }
    if png_payload:
        # The agent loop strips this large payload before logging — see
        # ``_strip_image_payload`` in agent.py — but the LLM still gets it via
        # the multimodal block injection in the next round.
        payload["png_base64"] = png_payload["png_base64"]
        payload["png_kb"] = png_payload["approx_kb"]
        payload["png_kind"] = png_payload["kind"]
        payload["_multimodal"] = True  # marker for the agent loop
    return _ok(payload)


def tool_get_dashboard_overview_image(ctx: ToolContext, args: dict) -> dict:
    max_charts_raw = args.get("max_charts", 12)
    try:
        max_charts = int(max_charts_raw)
    except (TypeError, ValueError):
        max_charts = 12
    max_charts = max(1, min(max_charts, 20))

    page_id = args.get("page_id")
    if page_id is not None and not isinstance(page_id, str):
        page_id = str(page_id)

    chart_payloads: list[dict] = []
    for chart_id in sorted(ctx.allowed_chart_ids):
        meta = ctx.chart_meta.get(chart_id, {})
        try:
            data = _fetch_chart_data(ctx, chart_id)
        except Exception:
            logger.warning("dashboard overview: failed to load chart_id=%s", chart_id)
            continue
        columns = data.get("columns") or []
        rows = list((data.get("rows") or [])[:200])
        measure_idx = _detect_measure_idx(columns, rows)
        dim_idx = _detect_dim_idx(columns, rows, measure_idx, prefer_datetime=True)
        chart_payloads.append({
            "chart_id": chart_id,
            "chart_name": meta.get("name", f"Chart {chart_id}"),
            "chart_type": meta.get("chart_type", ""),
            "chart_role": _chart_role_from_meta(meta),
            "columns": columns,
            "rows": rows,
            "dim_idx": dim_idx,
            "measure_idx": measure_idx,
            "layout": meta.get("layout") if isinstance(meta.get("layout"), dict) else {},
        })
        # Don't truncate here when page_id is set — the renderer filters by
        # page first, so we need ALL candidate payloads available.
        if page_id is None and len(chart_payloads) >= max_charts:
            break

    if not chart_payloads:
        return _err("dashboard has no chart data to render")

    try:
        from app.services.dashboard_ai_bot.chart_renderer import render_dashboard_overview_png
        rendered = render_dashboard_overview_png(
            dashboard_name=getattr(ctx.dashboard, "name", None) or "Dashboard",
            chart_payloads=chart_payloads,
            max_charts=max_charts,
            filters_applied=ctx.public_filters,
            page_id=page_id,
        )
    except Exception as exc:
        logger.warning("dashboard overview render failed err=%s", type(exc).__name__)
        return _err("failed to render dashboard overview image")

    if not rendered.get("ok") or not rendered.get("png_base64"):
        return _err(str(rendered.get("reason") or "failed to render dashboard overview image"))

    return _ok({
        "kind": rendered.get("kind", "dashboard_overview"),
        "charts_rendered": rendered.get("charts_rendered", len(chart_payloads)),
        "chart_ids": [payload["chart_id"] for payload in chart_payloads],
        "filters_applied": list(ctx.public_filters or []),
        "page_id": page_id,
        "png_kb": rendered.get("approx_kb"),
        "png_kind": rendered.get("kind", "dashboard_overview"),
        "png_base64": rendered["png_base64"],
        "_multimodal": True,
    })


def _chart_role_from_meta(meta: dict) -> str:
    chart_type = str(meta.get("chart_type") or "").lower()
    if any(hint in chart_type for hint in ("kpi", "metric", "card", "number", "stat")):
        return "kpi"
    if any(hint in chart_type for hint in ("line", "area", "time", "trend")):
        return "trend"
    if any(hint in chart_type for hint in ("pie", "donut", "treemap", "funnel")):
        return "distribution"
    return "breakdown"


_SPARK_BLOCKS = "▁▂▃▄▅▆▇█"


def _ascii_sparkline(points: list[tuple[str, float]]) -> str:
    """Render up to 60 points as a 1-line unicode spark sequence + a 2-line
    block-bar chart for richer shape feedback."""
    sample = points
    if len(points) > 60:
        # Downsample by averaging buckets
        step = len(points) / 60
        sample = []
        for i in range(60):
            lo = int(round(i * step))
            hi = int(round((i + 1) * step))
            chunk = [y for _, y in points[lo:hi]] or [points[lo][1]]
            sample.append((points[lo][0], statistics.fmean(chunk)))
    ys = [y for _, y in sample]
    lo, hi = min(ys), max(ys)
    span = hi - lo or 1
    spark = "".join(
        _SPARK_BLOCKS[min(7, max(0, int((y - lo) / span * 7)))]
        for y in ys
    )
    first_label = sample[0][0]
    last_label = sample[-1][0]
    legend = f"min={lo:g} max={hi:g}  ({first_label} → {last_label})"
    return f"{spark}\n{legend}"


def _shape_summary(points: list[tuple[str, float]]) -> str:
    ys = [y for _, y in points]
    n = len(ys)
    if n < 2:
        return "Chỉ có 1 điểm dữ liệu."
    first, last = ys[0], ys[-1]
    pct = None if first == 0 else (last - first) / abs(first) * 100
    direction = "tăng" if pct and pct > 5 else "giảm" if pct and pct < -5 else "đi ngang"
    # Volatility: count direction flips
    flips = sum(1 for i in range(1, n - 1) if (ys[i] - ys[i - 1]) * (ys[i + 1] - ys[i]) < 0)
    vol = "biến động mạnh" if flips > n / 3 else ("ổn định" if flips < n / 6 else "biến động vừa")
    pct_str = f"{pct:+.1f}%" if pct is not None else "không đo được %"
    return f"Hình dạng: {direction} ({pct_str}), {vol} với {flips} lần đảo chiều."


# ── Phase 15.73 — Diagnostic & lookup tools ───────────────────────────────────
#
# These five tools give the bot the option-set the user asked for:
# instead of patching "no data" with retries, the bot can ACTIVELY
# inspect the situation. All five respect the dashboard's public_filters
# (no scope bypass) — they report what's in scope, not what's outside.


def tool_inspect_filters(ctx: ToolContext, args: dict) -> dict:
    """Surface the filter set the bot is currently operating under.

    When the bot reads a chart and gets 0 rows, the first question is
    "what filter am I applying?". This tool returns the exact set so the
    bot can NAME the filters in its answer (e.g. "Tôi đang đọc trong
    khoảng date >= 2024-01-01 …") and let the user decide whether to
    relax them. No data is read; no scope is bypassed.
    """
    filters = list(ctx.public_filters or [])
    formatted: list[dict] = []
    for f in filters:
        if not isinstance(f, dict):
            continue
        formatted.append({
            "field": f.get("field") or f.get("column") or "?",
            "operator": f.get("op") or f.get("operator") or "=",
            "value": f.get("value") if "value" in f else f.get("values"),
        })
    return _ok({
        "filter_count": len(formatted),
        "has_filters": bool(formatted),
        "active_filters": formatted,
        "note": (
            "These filters are merged from the dashboard public link's "
            "saved filters and any slicer values the viewer applied. "
            "Every data tool you call uses this same set — what the "
            "dashboard renders on screen is what you can read."
        ),
    })


def tool_search_charts(ctx: ToolContext, args: dict) -> dict:
    """Keyword search over chart names + descriptions in this dashboard.

    Useful when the user asks about a topic (e.g. "doanh thu", "lợi
    nhuận", "khách VIP") and you don't want to scan the manifest blindly.
    Returns matching chart_ids ordered by a simple token-overlap score.
    """
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        return _err("query (non-empty string) is required")
    limit = args.get("limit")
    if not isinstance(limit, int) or limit <= 0:
        limit = 10
    limit = min(limit, 30)

    q_tokens = {tok for tok in query.lower().split() if tok}
    if not q_tokens:
        return _err("query has no searchable tokens")

    matches: list[dict] = []
    for chart_id, meta in ctx.chart_meta.items():
        haystack = " ".join([
            str(meta.get("name") or ""),
            str(meta.get("description") or ""),
            str(meta.get("chart_type") or ""),
        ]).lower()
        # Token overlap + substring credit
        overlap = sum(1 for tok in q_tokens if tok in haystack)
        if overlap == 0:
            continue
        score = overlap / max(len(q_tokens), 1)
        matches.append({
            "chart_id": chart_id,
            "chart_name": meta.get("name"),
            "description": meta.get("description") or "",
            "chart_type": meta.get("chart_type") or "",
            "score": round(score, 3),
        })
    matches.sort(key=lambda m: (-m["score"], m["chart_id"]))
    matches = matches[:limit]

    return _ok({
        "query": query,
        "match_count": len(matches),
        "matches": matches,
        "note": (
            "Empty matches mean no chart in this dashboard mentions the "
            "query terms in name or description. Try a different keyword."
        ) if not matches else None,
    })


def tool_sample_chart_rows(ctx: ToolContext, args: dict) -> dict:
    """Read N sample rows from a chart to get a feel for the shape.

    Wraps the standard chart fetch with public_filters applied. Useful
    when the chart's name / description / Insight Pack don't make the
    column layout obvious — peek at 5-10 actual rows. Always respects
    the link's public filters; sample_rows is just the first N rows
    of the chart's filtered output.
    """
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    n = args.get("n")
    if not isinstance(n, int) or n <= 0:
        n = 5
    n = min(n, 25)
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))
    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        logger.exception("dashboard_ai_bot sample_chart_rows failed chart_id=%s", chart_id)
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}: {exc}")

    columns = list(data.get("columns") or [])
    all_rows = data.get("rows") or []
    sample = [
        {col: row[i] if i < len(row) else None for i, col in enumerate(columns)}
        for row in all_rows[:n]
    ]
    return _ok({
        "chart_id": chart_id,
        "columns": columns,
        "total_rows": len(all_rows),
        "sample_count": len(sample),
        "sample_rows": sample,
        "note": (
            "0 rows means the chart returned nothing under the current "
            "public filters — not that the chart is empty everywhere. "
            "Use inspect_filters + probe_chart_data_range to diagnose."
        ) if not sample else None,
    })


def tool_probe_chart_data_range(ctx: ToolContext, args: dict) -> dict:
    """Report the data shape of one chart under current filters.

    Returns per-column counts + min/max + distinct sample values, plus
    a top-level row count and an `is_empty` flag. When the chart is
    empty, the diagnostic field names the likely cause so the bot can
    explain it instead of bailing with "không có dữ liệu".

    Respects public_filters (no scope bypass).
    """
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))
    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        logger.exception("dashboard_ai_bot probe_chart_data_range failed chart_id=%s", chart_id)
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}: {exc}")

    columns = list(data.get("columns") or [])
    rows = data.get("rows") or []
    meta = ctx.chart_meta.get(chart_id, {})

    column_stats: list[dict] = []
    for idx, col in enumerate(columns):
        values = [row[idx] for row in rows if idx < len(row)]
        non_null = [v for v in values if v is not None and v != ""]
        numerics = [_to_number(v) for v in non_null]
        numerics = [n for n in numerics if n is not None]
        distinct = {v for v in non_null}
        kind = "number" if (numerics and len(numerics) >= max(1, int(0.5 * len(non_null)))) else (
            "datetime" if non_null and all(isinstance(v, str) and len(v) >= 8 and v[:4].isdigit() for v in non_null[:10])
            else "string"
        )
        entry: dict = {
            "name": col,
            "kind": kind,
            "non_null_count": len(non_null),
            "null_count": len(values) - len(non_null),
            "distinct_count": len(distinct),
        }
        if kind == "number" and numerics:
            entry["min"] = min(numerics)
            entry["max"] = max(numerics)
            entry["total"] = sum(numerics)
            entry["avg"] = statistics.fmean(numerics)
        elif kind == "datetime" and non_null:
            entry["min"] = min(str(v) for v in non_null)
            entry["max"] = max(str(v) for v in non_null)
        else:
            sample_values = list(distinct)[:8]
            entry["sample_values"] = [str(v) for v in sample_values]
        column_stats.append(entry)

    diagnostic = None
    if not rows:
        diagnostic = (
            "Chart returned 0 rows under the current public filters. "
            "Probable cause: the filter set (especially date range or "
            "segment value) excludes all rows from this chart's data. "
            "Use inspect_filters to see the active set and suggest a "
            "specific filter to relax in your answer."
        )

    return _ok({
        "chart_id": chart_id,
        "chart_name": meta.get("name"),
        "chart_type": meta.get("chart_type"),
        "row_count": len(rows),
        "is_empty": not rows,
        "columns": column_stats,
        "filters_applied": data.get("filters_applied") or [],
        "diagnostic": diagnostic,
    })


def tool_get_chart_glossary(ctx: ToolContext, args: dict) -> dict:
    """Return business-glossary metadata for a chart's underlying dataset.

    Pulls the DatasetTable's column_descriptions, auto_description,
    common_questions, query_aliases — populated by the Knowledge System
    over time. This lets the bot answer "what does GP Margin mean?" or
    pick the right chart when the user uses a Vietnamese alias ("doanh
    thu thuần", "doanh thu") that maps to a specific column.

    No row data is exposed; this is purely about column meanings.
    """
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    from app.models.models import Chart
    from app.models.dataset import DatasetTable, Dataset

    chart = ctx.db.query(Chart).filter(Chart.id == chart_id).first()
    if chart is None:
        return _err(f"chart {chart_id} not found")
    if not chart.dataset_table_id:
        return _ok({
            "chart_id": chart_id,
            "chart_name": chart.name,
            "dataset_table": None,
            "note": "Chart has no dataset_table binding — likely an ad-hoc chart.",
        })

    table = (
        ctx.db.query(DatasetTable)
        .filter(DatasetTable.id == chart.dataset_table_id)
        .first()
    )
    if table is None:
        return _ok({
            "chart_id": chart_id,
            "chart_name": chart.name,
            "dataset_table": None,
            "note": "Bound dataset_table not found (may have been deleted).",
        })

    dataset = (
        ctx.db.query(Dataset).filter(Dataset.id == table.dataset_id).first()
        if table.dataset_id
        else None
    )

    column_descriptions = (
        table.column_descriptions if isinstance(table.column_descriptions, dict) else {}
    )
    common_questions = (
        list(table.common_questions) if isinstance(table.common_questions, list) else []
    )
    query_aliases = (
        list(table.query_aliases) if isinstance(table.query_aliases, list) else []
    )
    columns_meta = table.columns_cache if isinstance(table.columns_cache, list) else []

    columns_out: list[dict] = []
    for col in columns_meta or []:
        if not isinstance(col, dict):
            continue
        name = col.get("name") or col.get("column_name")
        if not name:
            continue
        columns_out.append({
            "name": name,
            "type": col.get("type") or col.get("data_type"),
            "description": column_descriptions.get(name) or col.get("description") or "",
            "is_measure": bool(col.get("is_measure")),
            "is_dimension": bool(col.get("is_dimension")),
        })

    return _ok({
        "chart_id": chart_id,
        "chart_name": chart.name,
        "dataset": {
            "id": dataset.id if dataset else None,
            "name": dataset.name if dataset else None,
            "description": (dataset.description or "") if dataset else "",
        },
        "dataset_table": {
            "id": table.id,
            "display_name": table.display_name,
            "auto_description": table.auto_description or "",
            "source_table_name": table.source_table_name,
        },
        "columns": columns_out[:60],
        "common_questions": common_questions[:10],
        "query_aliases": query_aliases[:20],
        "note": (
            "Use this glossary to (a) translate user-spoken aliases like "
            "'doanh thu' to the actual column name before searching/"
            "aggregating, (b) explain what a measure means when the "
            "user asks, (c) pick the right chart when the user names "
            "a concept rather than a chart."
        ),
    })
