"""The two forward-looking questions the group could not answer.

WHY THESE, AND WHY THIS GROUP WAS THIN
--------------------------------------
Group 5 had two tools: describe the trend, extrapolate the trend. That covers
"what has been happening" and "if nothing changes, roughly what next" — and it is
the smallest group in a catalogue whose forward-looking answers are the ones a
business actually pays for.

Two things were missing, and they are missing in different ways.

`detect_seasonality` is a CORRECTNESS gap first and a feature second.
`forecast_measure` extrapolates a straight line or a growth rate. Over a seasonal
series that is wrong in a specific, confident way: it projects December's peak
into January, or reads a summer dip as a downturn. The existing caveat says "no
seasonality is modelled", which is honest and useless — the reader cannot tell
whether that matters for THIS series. Measuring whether a repeating pattern exists
turns a disclaimer into a decision.

`project_to_period_end` is the question. "Will we hit the target?" is what a trend
is usually being read FOR, and answering it meant reading the run rate from one
tool, the target from another, and doing the arithmetic in a model — three places
for a division to go wrong, and no way to check it afterwards. `compare_to_target`
answers it in the present tense; this answers it in the future tense, which is the
tense the question is normally asked in.

WHAT THEY REFUSE TO DO
----------------------
Promise. Both return a projection with the history it stood on and the assumption
it made, and both say plainly that the number is conditional. The catalogue's
whole discipline is that a result must not read more certain than it is, and this
is the group where that is hardest and matters most.
"""
from __future__ import annotations

import re
import statistics
from typing import Any

from app.services.agent_flows.tools import result as R
from app.services.agent_flows.tools.packs import measure_meta
from app.services.dashboard_ai_bot.tool_context import (
    ToolContext, ToolError, _fetch_chart_data,
)

#: Column names that mark a time axis. Same vocabulary the coverage tool uses, so
#: a report readable by one is readable by the other.
_DATE_NAME = re.compile(
    r"(date|ngay|ngày|thang|tháng|nam|năm|time|timestamp|_at|_dt|period|ky|kỳ|"
    r"month|quarter|week|year)", re.IGNORECASE)

#: Seasonal cycle lengths worth testing, by what a period usually is. Testing
#: every lag up to n/2 finds a "pattern" in noise; these are the cycles a business
#: series actually has.
_CANDIDATE_LAGS = (4, 7, 12)

#: Below this, autocorrelation is not evidence of a cycle. A lag-12 test needs at
#: least two full cycles to distinguish a season from a coincidence.
_MIN_CYCLES = 2


def _numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        try:
            return float(text) if text else None
        except ValueError:
            return None
    return None


def _series(ctx: ToolContext, chart_id: int) -> tuple[list[tuple[str, float]], str, str] | dict:
    """The chart's time series as (label, value) in label order, or an error."""
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return R.err(str(exc), code="chart_out_of_scope")
    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception:  # noqa: BLE001 — the message is for the log, not the prompt
        return R.err(
            f"failed to load chart {chart_id}", code="query_failed", retryable=True,
        )
    columns, rows = data["columns"], data["rows"]
    if not rows:
        return R.err(f"chart {chart_id} has no rows", code="no_data")

    fields = (ctx.chart_meta.get(chart_id) or {}).get("fields") or {}
    lower = {c.lower(): i for i, c in enumerate(columns)}

    t_idx = next(
        (i for i, c in enumerate(columns) if _DATE_NAME.search(c or "")), None)
    if t_idx is None:
        return R.err(
            f"chart {chart_id} has no time axis — this tool needs one",
            code="not_applicable", detail={"columns": columns},
        )
    m_idx: int | None = None
    for entry in fields.get("measures") or []:
        for candidate in (entry.get("field"), entry.get("label")):
            if candidate and candidate.lower() in lower and lower[candidate.lower()] != t_idx:
                m_idx = lower[candidate.lower()]
                break
        if m_idx is not None:
            break
    if m_idx is None:
        for i in range(len(columns) - 1, -1, -1):
            if i != t_idx and any(
                    _numeric(row[i]) is not None for row in rows[:50] if i < len(row)):
                m_idx = i
                break
    if m_idx is None:
        return R.err(
            f"chart {chart_id} has no numeric column to project",
            code="not_applicable", detail={"columns": columns},
        )

    pairs: list[tuple[str, float]] = []
    for row in rows:
        if t_idx >= len(row) or m_idx >= len(row):
            continue
        value = _numeric(row[m_idx])
        if value is None or row[t_idx] is None:
            continue
        pairs.append((str(row[t_idx]), value))
    pairs.sort(key=lambda p: p[0])
    return pairs, columns[t_idx], columns[m_idx]


# ── seasonality ──────────────────────────────────────────────────────────────


def _autocorr(values: list[float], lag: int) -> float | None:
    """Correlation of the series with itself, `lag` periods back."""
    if lag <= 0 or len(values) <= lag + 1:
        return None
    a, b = values[lag:], values[:-lag]
    if len(a) < 3:
        return None
    ma, mb = statistics.fmean(a), statistics.fmean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = sum((x - ma) ** 2 for x in a) ** 0.5
    dbb = sum((y - mb) ** 2 for y in b) ** 0.5
    if da == 0 or dbb == 0:
        return None
    return num / (da * dbb)


def tool_detect_seasonality(ctx: ToolContext, args: dict) -> dict:
    """Does this series repeat, at what cycle, and how strongly?"""
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return R.err("chart_id (int) is required", code="bad_argument")
    got = _series(ctx, chart_id)
    if isinstance(got, dict):
        return got
    pairs, time_col, measure_col = got
    values = [v for _, v in pairs]
    n = len(values)

    tested: list[dict[str, Any]] = []
    for lag in _CANDIDATE_LAGS:
        if n < lag * _MIN_CYCLES:
            tested.append({
                "cycle_periods": lag, "testable": False,
                "why": (
                    f"needs at least {lag * _MIN_CYCLES} periods "
                    f"({_MIN_CYCLES} full cycles), have {n}"
                ),
            })
            continue
        coefficient = _autocorr(values, lag)
        tested.append({
            "cycle_periods": lag, "testable": True,
            "autocorrelation": None if coefficient is None else round(coefficient, 3),
        })

    scored = [
        t for t in tested
        if t.get("testable") and isinstance(t.get("autocorrelation"), float)
    ]
    best = max(scored, key=lambda t: t["autocorrelation"], default=None)
    # 0.5 is the threshold at which a repeat is worth acting on. Below it a
    # coefficient is a hint, and a hint presented as a finding is the failure mode
    # this whole catalogue is built against.
    seasonal = bool(best and best["autocorrelation"] >= 0.5)

    payload: dict[str, Any] = {
        "chart_id": chart_id,
        "time_dimension": time_col,
        "measure": measure_col,
        "history_points": n,
        "seasonal": seasonal,
        "cycles_tested": tested,
        "strongest_cycle": best["cycle_periods"] if best else None,
        "strongest_autocorrelation": best["autocorrelation"] if best else None,
        "note": (
            (
                f"The series repeats about every {best['cycle_periods']} periods "
                f"(autocorrelation {best['autocorrelation']}). A straight-line or "
                "growth-rate projection will be WRONG on this series — it carries "
                "whichever part of the cycle it starts from forward. Compare like "
                "period with like period instead."
            )
            if seasonal else
            (
                "No repeating cycle strong enough to act on was found in the "
                "cycles that could be tested. That is not proof there is none — "
                f"with {n} periods, only the cycles marked testable above were "
                "checked."
            )
        ),
    }
    if not scored:
        payload["note"] = (
            f"Not enough history to test for a cycle at all: {n} periods, and the "
            f"shortest cycle tested ({_CANDIDATE_LAGS[0]}) needs "
            f"{_CANDIDATE_LAGS[0] * _MIN_CYCLES}. Nothing can be said about "
            "seasonality either way."
        )
    return R.ok(
        payload, kind="diagnosis",
        coverage=R.Coverage(returned=n, total=n, truncated=False,
                            computed_over_all=True),
    )


# ── run rate against a target ────────────────────────────────────────────────


def tool_project_to_period_end(ctx: ToolContext, args: dict) -> dict:
    """At this rate, where does the measure land — and does that clear the target?"""
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return R.err("chart_id (int) is required", code="bad_argument")
    remaining = args.get("remaining_periods")
    if not isinstance(remaining, int) or remaining < 0:
        return R.err(
            "remaining_periods (non-negative int) is required — how many periods "
            "are left in the window you are projecting to",
            code="bad_argument",
        )
    got = _series(ctx, chart_id)
    if isinstance(got, dict):
        return got
    pairs, time_col, measure_col = got
    values = [v for _, v in pairs]
    n = len(values)
    if n < 2:
        return R.err(
            f"chart {chart_id} has {n} usable periods — a run rate needs at least 2",
            code="not_applicable",
        )

    # A run rate is a total per period, so it only means anything for a measure
    # that adds up. The same rule every measuring tool in this catalogue applies.
    info = measure_meta.describe_measure(ctx, chart_id, measure_col)
    if not info["additive"]:
        return R.err(
            f"'{measure_col}' is "
            f"{info['agg'] or info['format_kind'] or 'non-additive'}: it cannot be "
            "accumulated across periods, so a to-date total and a run rate have no "
            "meaning. Project the additive measure the rate is built from instead.",
            code="not_applicable",
            detail={"aggregation": info["agg"]},
        )

    # The last period is excluded from the RATE when it is obviously partial —
    # a half-finished period drags the average down and would understate the
    # projection, which is the direction that matters least to be wrong in but
    # still wrong.
    window = min(3, n)
    recent = values[-window:]
    partial_last = (
        n >= 4 and recent[-1] < 0.5 * statistics.fmean(values[-window - 1:-1])
    )
    if partial_last and n >= 3:
        recent = values[-window - 1:-1]

    run_rate = statistics.fmean(recent)
    to_date = sum(values)
    projected = to_date + run_rate * remaining

    payload: dict[str, Any] = {
        "chart_id": chart_id,
        "time_dimension": time_col,
        "measure": measure_col,
        "to_date": round(to_date, 4),
        "periods_so_far": n,
        "run_rate_per_period": round(run_rate, 4),
        "run_rate_basis": (
            f"mean of the last {len(recent)} periods"
            + (" (the final period looked partial and was excluded)"
               if partial_last else "")
        ),
        "remaining_periods": remaining,
        "projected_total": round(projected, 4),
        "unit": info["unit"],
        "unit_note": measure_meta.unit_note(info),
        "assumption": (
            "This assumes the recent run rate continues unchanged for the "
            f"remaining {remaining} periods. It models no seasonality, no "
            "pipeline and no known events — call detect_seasonality first if the "
            "series might repeat, because a run rate taken from a peak projects a "
            "peak."
        ),
    }

    target = args.get("target")
    if target is not None:
        t = _numeric(target)
        if t is None:
            return R.err("target must be a number", code="bad_argument")
        if t == 0:
            return R.err("the target is zero, so attainment is undefined",
                         code="not_applicable")
        gap = projected - t
        needed = (t - to_date) / remaining if remaining else None
        payload.update({
            "target": round(t, 4),
            "projected_vs_target": round(gap, 4),
            "projected_attainment_pct": round(projected / t * 100.0, 2),
            "verdict": "on_track" if gap >= 0 else "off_track",
            "required_run_rate": None if needed is None else round(needed, 4),
            "required_vs_current_pct": (
                None if not needed or run_rate == 0
                else round((needed - run_rate) / abs(run_rate) * 100.0, 1)
            ),
            # The most useful sentence in the result, and the one a model will
            # otherwise have to derive: what has to change for the answer to flip.
            "what_it_takes": (
                f"Hitting {t:,.0f} needs {needed:,.0f} per period for the "
                f"remaining {remaining}, against a current rate of "
                f"{run_rate:,.0f}."
                if needed is not None else
                "No periods remain, so the projection is the to-date total."
            ),
        })
    return R.ok(
        payload, kind="projection",
        coverage=R.Coverage(returned=n, total=n, truncated=False,
                            computed_over_all=True),
    )


DETECT_SEASONALITY_DEF = {
    "name": "detect_seasonality",
    "description": (
        "Does this time series repeat on a cycle, and how strongly? Tests "
        "autocorrelation at 4, 7 and 12 periods and reports which cycles there "
        "was enough history to test. CALL THIS BEFORE trusting forecast_measure "
        "or project_to_period_end on a series that might be seasonal: both "
        "extrapolate a straight line, which carries whichever part of a cycle it "
        "starts from forward and is confidently wrong."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "chart_id": {
                "type": "integer",
                "description": "Chart with a time axis.",
            },
        },
        "required": ["chart_id"],
    },
}

PROJECT_TO_PERIOD_END_DEF = {
    "name": "project_to_period_end",
    "description": (
        "Where the measure lands if the recent run rate holds, and whether that "
        "clears a target. Returns the to-date total, the run rate per period, the "
        "projected total, and — when a target is given — the projected attainment, "
        "an on/off-track verdict, and the run rate that WOULD be required. Use for "
        "'will we hit target', 'are we on track for the quarter', 'what do we need "
        "per month from here'. Pass `remaining_periods`: how many periods are left "
        "in the window."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "chart_id": {"type": "integer", "description": "Chart with a time axis."},
            "remaining_periods": {
                "type": "integer",
                "description": (
                    "Periods left in the window being projected to — 5 for "
                    "'rest of the year' when 7 months are done."
                ),
            },
            "target": {
                "type": "number",
                "description": (
                    "The target for the whole window. Omit for a projection with "
                    "no verdict."
                ),
            },
        },
        "required": ["chart_id", "remaining_periods"],
    },
}
