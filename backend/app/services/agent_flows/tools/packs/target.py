"""Actual against plan — the comparison the group was missing.

WHY
---
Group 3 could compare two periods, two segments, and a segment against the rest.
It could not compare anything against a TARGET, which in a business report is
often the only comparison that decides anything: a number is not good or bad on
its own, it is good or bad against what was promised.

Not a hypothetical gap. A survey of this deployment's semantic layer turned up
`target_revenue`, `target_orders`, `total_goal`, `quota_units`, `budget_revenue`
and an `attainment_pct` measure defined as `total_revenue / target` — so the
question is already being asked, and the only way to answer it was to read both
figures separately and have a model do the arithmetic, which costs a round trip
and puts the division somewhere it cannot be checked.

WHERE THE TARGET COMES FROM
---------------------------
Four places, in order of how explicit they are:

  1  a number the caller passes            — a decision, not a hint
  2  a column the caller names             — same
  3  a column of the chart that looks like a target
  4  a measure of the chart that looks like one

Steps 3 and 4 match on a name, which is the kind of guess the additivity work
deliberately avoided. It is acceptable here for a reason that does not apply
there: naming a column `target_revenue` is a DECLARATION by whoever built the
dataset, and the worst case is comparing against the wrong column — visible in
the result, which names what it used. Guessing that a measure is a ratio, by
contrast, produces a number that is silently meaningless.

ADDITIVITY STILL APPLIES
------------------------
Attainment is `actual / target`, and both sides have to be real totals for that
to mean anything. A rate cannot be totalled, so a rate has no attainment against
a plan in the general case — the tool refuses rather than dividing two numbers
that should never have been added.
"""
from __future__ import annotations

import re
from typing import Any

from app.services.agent_flows.tools import result as R
from app.services.agent_flows.tools.packs import measure_meta
from app.services.dashboard_ai_bot.tool_context import (
    ToolContext, ToolError, _fetch_chart_data,
)

#: Column and measure names that DECLARE a target. Matched on word boundaries so
#: `plant` does not read as `plan` — a survey of this deployment turned up
#: exactly that column, which is how the trap became visible before it bit.
_TARGET_NAME = re.compile(
    r"(?:^|[^a-z])(target|plan|goal|budget|quota|forecast|"
    r"ke_hoach|muc_tieu|chi_tieu|dinh_muc)(?:$|[^a-z])",
    re.IGNORECASE,
)


def _numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    return None


def _column_total(rows: list[list], idx: int) -> tuple[float | None, int]:
    values = [
        n for row in rows
        if idx < len(row) and (n := _numeric(row[idx])) is not None
    ]
    return (sum(values) if values else None), len(values)


def _find_target_column(columns: list[str], exclude: int) -> int | None:
    for i, name in enumerate(columns):
        if i != exclude and _TARGET_NAME.search(name or ""):
            return i
    return None


def tool_compare_to_target(ctx: ToolContext, args: dict) -> dict:
    """How the actual figure stands against its target."""
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return R.err("chart_id (int) is required", code="bad_argument")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return R.err(str(exc), code="chart_out_of_scope")
    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception:  # noqa: BLE001 — the message belongs in the log, not the prompt
        return R.err(
            f"failed to load chart {chart_id}", code="query_failed", retryable=True,
        )
    columns, rows = data["columns"], data["rows"]
    if not rows:
        return R.err(f"chart {chart_id} has no rows", code="no_data")

    lower = {c.lower(): i for i, c in enumerate(columns)}

    # ── which column holds the ACTUAL ────────────────────────────────────────
    measure = args.get("measure")
    m_idx: int | None = None
    if measure:
        m_idx = lower.get(str(measure).lower())
        if m_idx is None:
            return R.err(
                f"'{measure}' is not a column of chart {chart_id}",
                code="bad_argument", detail={"columns": columns},
            )
    else:
        fields = (ctx.chart_meta.get(chart_id) or {}).get("fields") or {}
        for entry in fields.get("measures") or []:
            for candidate in (entry.get("field"), entry.get("label")):
                if candidate and candidate.lower() in lower:
                    # The chart's own measure must not BE the target column.
                    idx = lower[candidate.lower()]
                    if not _TARGET_NAME.search(columns[idx] or ""):
                        m_idx = idx
                        break
            if m_idx is not None:
                break
    if m_idx is None:
        return R.err(
            f"could not tell which column of chart {chart_id} holds the actual "
            "figure — pass `measure`",
            code="not_applicable", detail={"columns": columns},
        )

    info = measure_meta.describe_measure(ctx, chart_id, columns[m_idx])
    actual, counted = _column_total(rows, m_idx)
    if actual is None:
        return R.err(
            f"column '{columns[m_idx]}' has no numeric values", code="no_data",
        )
    # A rate has no total, so it has no attainment against a plan either.
    if not info["additive"] and counted > 1:
        return R.err(
            f"'{columns[m_idx]}' is "
            f"{info['agg'] or info['format_kind'] or 'non-additive'}, so it cannot "
            f"be totalled across {counted} rows and has no attainment against a "
            "target. Compare the values directly, or use the additive measure the "
            "rate is built from.",
            code="not_applicable",
            detail={"rows_counted": counted, "aggregation": info["agg"]},
        )

    # ── which number is the TARGET ───────────────────────────────────────────
    explicit = args.get("target")
    target_column = args.get("target_column")
    target: float | None = None
    source = ""
    if explicit is not None:
        target = _numeric(explicit)
        if target is None:
            return R.err("target must be a number", code="bad_argument")
        source = "caller"
    else:
        t_idx: int | None = None
        if target_column:
            t_idx = lower.get(str(target_column).lower())
            if t_idx is None:
                return R.err(
                    f"'{target_column}' is not a column of chart {chart_id}",
                    code="bad_argument", detail={"columns": columns},
                )
            source = f"column '{columns[t_idx]}' (named by caller)"
        else:
            t_idx = _find_target_column(columns, exclude=m_idx)
            if t_idx is not None:
                source = f"column '{columns[t_idx]}' (matched by name)"
        if t_idx is None:
            return R.err(
                f"chart {chart_id} has no target to compare against. Pass `target` "
                "as a number, or `target_column` naming the column that holds it.",
                code="not_applicable", detail={"columns": columns},
            )
        target, _ = _column_total(rows, t_idx)
        if target is None:
            return R.err(
                f"target column '{columns[t_idx]}' has no numeric values",
                code="no_data",
            )

    if target == 0:
        return R.err(
            "the target is zero, so attainment is undefined",
            code="not_applicable", detail={"actual": round(actual, 4)},
        )

    gap = actual - target
    attainment = actual / target * 100.0
    payload: dict[str, Any] = {
        "chart_id": chart_id,
        "measure": columns[m_idx],
        "actual": round(actual, 4),
        "target": round(target, 4),
        "target_source": source,
        "gap": round(gap, 4),
        # Attainment is a percentage OF the target; the gap is in the measure's
        # own unit. Naming both stops one being read as the other, the mistake
        # the percentage-points work in this group was about.
        "attainment_pct": round(attainment, 2),
        "status": "on_or_above_target" if gap >= 0 else "below_target",
        "shortfall_pct": None if gap >= 0 else round(-gap / target * 100.0, 2),
        "rows_counted": counted,
        "unit": info["unit"],
        "unit_note": measure_meta.unit_note(info),
        "note": (
            f"`gap` is in the measure's own unit ({info['unit'] or 'undeclared'}); "
            "`attainment_pct` is actual as a percentage of target. They are not "
            "the same number and must not be described interchangeably."
        ),
        # AN IMPLAUSIBLE ATTAINMENT IS USUALLY A JOIN, NOT A TRIUMPH.
        #
        # A live chart here reports 1,718% attainment, and the arithmetic is
        # exactly right: the actual is summed over rows fanned out by a join to
        # the target table, so the same revenue is counted once per target row.
        # Nothing about the number is wrong and everything about "we beat plan by
        # seventeen times" is. This is the third variant of the same failure the
        # review keeps finding — a correct calculation over the wrong population —
        # and the only defence is for the result to say when it looks like one.
        **(
            {"plausibility_warning": (
                f"Attainment of {attainment:,.0f}% is far outside a normal range. "
                "The usual cause is a fan-out: the chart joins actuals to targets, "
                "so each actual row repeats per target row and the total is "
                "inflated. Check the chart's grain before reporting this — do not "
                "present it as performance without saying it looks wrong."
            )}
            if attainment > 500 or attainment < 5 else {}
        ),
        "filters_applied": data["filters_applied"],
    }
    return R.ok(
        payload,
        kind="comparison",
        coverage=R.Coverage(
            returned=counted, total=len(rows), truncated=False,
            computed_over_all=True,
        ),
    )


COMPARE_TO_TARGET_DEF = {
    "name": "compare_to_target",
    "description": (
        "Compare a chart's actual figure against its target, plan, goal, budget "
        "or quota. Returns the actual, the target, the gap in the measure's own "
        "unit, and attainment as a percentage of target. Use for 'are we hitting "
        "target', 'how far behind plan are we', 'what is attainment'. The target "
        "is taken from an explicit number, a named column, or a column of the "
        "chart whose name declares it (target_/plan_/goal_/budget_/quota_)."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "chart_id": {
                "type": "integer",
                "description": "Chart holding the actual figure.",
            },
            "target": {
                "type": "number",
                "description": (
                    "The target as a number, when the viewer states one. Overrides "
                    "any target column."
                ),
            },
            "target_column": {
                "type": "string",
                "description": (
                    "Column holding the target. Omit to let the tool find a column "
                    "whose name declares it."
                ),
            },
            "measure": {
                "type": "string",
                "description": "Column holding the actual. Omit to use the chart's measure.",
            },
        },
        "required": ["chart_id"],
    },
}
