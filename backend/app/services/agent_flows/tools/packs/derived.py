"""Tools that compute the answer instead of handing over the data.

WHY THESE EXIST
---------------
Every reading tool inherited from the first-generation bot returns rows for a
model to reason over, and that shape carries a cap: a result has to fit in a
prompt, so `get_chart_data` stops at fifty rows. The cap is reasonable for its
purpose and fatal for a whole class of question.

A viewer asked which category earned the most. The chart had seventy-two. The bot
received rows 1–50 in the warehouse's own order — alphabetical, as it happened —
and answered `agro_industry_and_commerce, 72,530`. The true answer was
`health_beauty, 1,258,681`: seventeen times larger and not in the fifty rows sent.
Nothing in the tool result was false. It was simply silent about being a fragment,
and a fragment of a ranking is not a small ranking, it is a wrong one.

Sorting the read fixes that one question. It does not fix the shape: "what is the
total" over seventy-two rows still cannot be answered from fifty of them, and no
ordering makes it possible.

So these three do the arithmetic where the data already is — over EVERY row, in
Python, before anything reaches a prompt — and return a few hundred bytes. Three
consequences, in ascending order of importance:

  * the answer is right regardless of how many groups exist;
  * the payload is ~40× smaller than the rows it was computed from;
  * no model is needed to produce it. A flow node can call these directly and
    reach a correct figure with zero tokens spent. That is the property that
    decides whether a tool catalogue can grow — twenty-four tools already cost
    ~4,400 tokens of schema on every model round, so tools that only work by
    being shown to a model cannot be added indefinitely.

WHAT THEY DO NOT DO
-------------------
Interpret. `rank_values` reports that health_beauty leads with 12.6% of the total;
whether that is good, expected, or worth acting on is a judgement, and judgement is
what the model in the answer node is for. Keeping the split at "arithmetic here,
meaning there" is what stops these from becoming a second, worse analyst.

FIELD RESOLUTION
----------------
None of them require the caller to name the measure or dimension. They resolve it
from the chart's own semantics, falling back to the data's shape — because a tool
that must be told which column holds revenue is a tool that only works on reports
somebody has already configured it for, and the whole point is that it works on
reports nobody anticipated.
"""
from __future__ import annotations

from typing import Any

from app.services.agent_flows.tools import result as R
from app.services.agent_flows.tools.packs import measure_meta
from app.services.dashboard_ai_bot.tool_context import (
    ToolContext, ToolError, _fetch_chart_data,
)

#: How many ranked items a caller may ask for. Generous — the payload is one line
#: per item, so even the maximum is cheaper than a single page of raw rows — but
#: bounded, because "rank all 50,000 customers" is a report, not an answer.
MAX_ITEMS = 100


# ── shared plumbing ──────────────────────────────────────────────────────────


def _numeric(v: Any) -> float | None:
    """A number if this cell holds one, else None.

    Strings are accepted because a warehouse column typed STRING can still hold
    `"1234.56"` — an Airbyte-loaded source does this routinely, and refusing to
    add them up would make these tools work on some sources and not others for a
    reason no author could see.
    """
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace(",", "")
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _column_is_numeric(rows: list[list], idx: int) -> bool:
    """True when most non-empty cells in this column parse as numbers.

    "Most" rather than "all": one `"N/A"` in a revenue column should not
    disqualify it, and a text column with a stray `"2024"` should not qualify.
    """
    seen = hits = 0
    for row in rows[:200]:
        if idx >= len(row) or row[idx] is None:
            continue
        seen += 1
        if _numeric(row[idx]) is not None:
            hits += 1
    return seen > 0 and hits >= seen * 0.8


def _resolve(
    ctx: ToolContext,
    chart_id: int,
    columns: list[str],
    rows: list[list],
    *,
    measure: str | None,
    dimension: str | None,
) -> tuple[int, int, str, str] | dict:
    """Decide which column is the figure and which is the label.

    Order of preference, and the reason for each:

      1. what the caller named — an explicit argument is a decision, not a hint;
      2. what the CHART says it measures — this is the number the viewer is
         looking at, so it is the number they mean;
      3. what the data looks like — a last resort that lets these tools work on a
         chart whose config could not be parsed, rather than refusing.

    Returns `(measure_idx, dimension_idx, measure_name, dimension_name)`, or an
    error result if the chart has no usable pair.
    """
    lower = {c.lower(): i for i, c in enumerate(columns)}
    fields = (ctx.chart_meta.get(chart_id) or {}).get("fields") or {}

    def pick(explicit: str | None, declared: list[dict], want_numeric: bool) -> int | None:
        if explicit:
            idx = lower.get(explicit.lower())
            if idx is None:
                return None
            return idx
        for entry in declared:
            for candidate in (entry.get("field"), entry.get("label")):
                if candidate and candidate.lower() in lower:
                    return lower[candidate.lower()]
        # Nothing declared matched a column name. Fall back to shape: the
        # right-most numeric column is the figure by convention in every chart
        # the query engine builds; the left-most non-numeric is the label.
        order = range(len(columns) - 1, -1, -1) if want_numeric else range(len(columns))
        for i in order:
            if _column_is_numeric(rows, i) is want_numeric:
                return i
        return None

    m_idx = pick(measure, fields.get("measures") or [], True)
    if m_idx is None:
        return R.err(
            f"no numeric column to compute on for chart {chart_id}"
            + (f" (tried '{measure}')" if measure else ""),
            code="bad_argument" if measure else "not_applicable",
            detail={"columns": columns},
        )
    d_idx = pick(dimension, fields.get("dimensions") or [], False)
    if d_idx is None or d_idx == m_idx:
        # A single-value chart (a KPI tile) genuinely has no grouping column.
        # Reported as not_applicable so a flow can branch to a different tool
        # rather than treating it as a failure.
        return R.err(
            f"chart {chart_id} has no grouping column to rank by",
            code="not_applicable",
            detail={"columns": columns, "measure": columns[m_idx]},
        )
    return m_idx, d_idx, columns[m_idx], columns[d_idx]


def _load(ctx: ToolContext, args: dict) -> tuple[list[str], list[list], list] | dict:
    """Fetch a chart's FULL result set, or an error result."""
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return R.err("chart_id (int) is required", code="bad_argument")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return R.err(str(exc), code="chart_out_of_scope")
    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:  # noqa: BLE001
        # Type only. The message from the chart service is written for a person
        # reading the app in their own language, and repeating it here would put
        # a second language inside a machine contract — the same leak the group-2
        # audit found in `get_chart_data`.
        return R.err(
            f"failed to load chart {chart_id}: {type(exc).__name__}",
            code="query_failed", retryable=True,
            detail={"chart_id": chart_id},
        )
    return data["columns"], data["rows"], data["filters_applied"]


def _group(rows: list[list], d_idx: int, m_idx: int) -> tuple[dict[str, float], int]:
    """Sum the measure per label over EVERY row. Returns the sums and how many
    rows carried a usable number."""
    sums: dict[str, float] = {}
    counted = 0
    for row in rows:
        if d_idx >= len(row) or m_idx >= len(row):
            continue
        value = _numeric(row[m_idx])
        if value is None:
            continue
        label = "(blank)" if row[d_idx] is None else str(row[d_idx])
        sums[label] = sums.get(label, 0.0) + value
        counted += 1
    return sums, counted


def _fmt(v: float) -> str:
    """Group thousands, drop a meaningless decimal tail.

    Matches how the dashboard's own KPI tiles render, so a viewer comparing the
    bot's sentence against the tile above it sees the same string.
    """
    if abs(v - round(v)) < 0.005:
        return f"{round(v):,}"
    return f"{v:,.2f}"


# ── the tools ────────────────────────────────────────────────────────────────


def tool_rank_values(ctx: ToolContext, args: dict) -> dict:
    """Top or bottom N groups by a measure, over every row of the chart."""
    loaded = _load(ctx, args)
    if isinstance(loaded, dict):
        return loaded
    columns, rows, filters_applied = loaded
    chart_id = args["chart_id"]

    resolved = _resolve(
        ctx, chart_id, columns, rows,
        measure=args.get("measure"), dimension=args.get("dimension"),
    )
    if isinstance(resolved, dict):
        return resolved
    m_idx, d_idx, measure_name, dimension_name = resolved

    order = str(args.get("order") or "desc").lower()
    if order not in ("desc", "asc"):
        return R.err("order must be 'desc' or 'asc'", code="bad_argument")
    top_n = args.get("top_n", 5)
    if not isinstance(top_n, int) or top_n <= 0:
        return R.err("top_n must be a positive integer", code="bad_argument")
    top_n = min(top_n, MAX_ITEMS)

    sums, counted = _group(rows, d_idx, m_idx)
    if not sums:
        return R.err(
            f"chart {chart_id} has no numeric values in column '{measure_name}'",
            code="no_data",
        )

    # RANKING is valid for any measure — comparing two rates is a fair
    # comparison. A TOTAL and a SHARE-OF-TOTAL are not: they require the values
    # to add up, which a percentage or a distinct count does not. So the ranking
    # survives and only the aggregate parts are withheld, rather than refusing a
    # question the tool can legitimately answer.
    info = measure_meta.describe_measure(ctx, chart_id, measure_name)
    # One group is not an aggregation either — see `total_measure`.
    additive = info["additive"] or len(sums) <= 1
    total = sum(sums.values())
    ranked = sorted(sums.items(), key=lambda kv: kv[1], reverse=(order == "desc"))
    items = [
        {
            "rank": i + 1,
            "label": label,
            "value": round(value, 4),
            "formatted": _fmt(value),
            # Share of the WHOLE, not of the slice returned — the distinction
            # that makes a truncated ranking still honest about proportion.
            # Absent for a non-additive measure: "this rate is 9% of all rates"
            # is not a sentence about anything.
            **({"share_pct": round(value / total * 100, 2) if total else None}
               if additive else {}),
        }
        for i, (label, value) in enumerate(ranked[:top_n])
    ]
    payload: dict[str, Any] = {
        "chart_id": chart_id,
        "measure": measure_name,
        "dimension": dimension_name,
        "items": items,
        "group_count": len(sums),
        "aggregation": info["agg"],
        "unit": info["unit"],
        "unit_note": measure_meta.unit_note(info),
        "filters_applied": filters_applied,
    }
    if additive:
        payload["total"] = round(total, 4)
        payload["total_formatted"] = _fmt(total)
    else:
        payload["total"] = None
        payload["total_note"] = (
            f"No total and no share-of-total: {measure_meta.additivity_error(info)} "
            "The ranking itself is valid — compare the values, do not add them."
        )
    return R.ok(
        payload,
        kind="ranking",
        coverage=R.Coverage(
            returned=len(items),
            total=len(sums),
            ordered_by=f"{measure_name} {order}",
            # Listing the top N of M is the request, not a shortfall: the sums,
            # the ranks and the shares all came from every row.
            computed_over_all=True,
        ),
    )


def tool_total_measure(ctx: ToolContext, args: dict) -> dict:
    """The sum of a measure across every row — the figure a row cap cannot give."""
    loaded = _load(ctx, args)
    if isinstance(loaded, dict):
        return loaded
    columns, rows, filters_applied = loaded
    chart_id = args["chart_id"]

    lower = {c.lower(): i for i, c in enumerate(columns)}
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
                    m_idx = lower[candidate.lower()]
                    break
            if m_idx is not None:
                break
        if m_idx is None:
            for i in range(len(columns) - 1, -1, -1):
                if _column_is_numeric(rows, i):
                    m_idx = i
                    break
    if m_idx is None:
        return R.err(
            f"chart {chart_id} has no numeric column to total",
            code="not_applicable", detail={"columns": columns},
        )

    values = [
        n for row in rows
        if m_idx < len(row) and (n := _numeric(row[m_idx])) is not None
    ]
    if not values:
        return R.err(
            f"column '{columns[m_idx]}' has no numeric values", code="no_data",
        )
    # CAN THIS BE SUMMED AT ALL?
    #
    # Found by running this tool over every dashboard in the deployment: it
    # happily summed a percentage (`pct_kh`, agg=avg → 35.99) and a distinct
    # count (`transaction_id`, agg=count_distinct → 250). Both ran, neither
    # errored, and both are meaningless. The demo report's measures are all
    # plain sums, so nothing here was ever exercised against the case.
    #
    # Refused rather than warned: a warning attached to a number still puts the
    # number in front of a model that will quote it.
    info = measure_meta.describe_measure(ctx, chart_id, columns[m_idx])
    average = sum(values) / len(values)
    # ONE ROW IS NOT AN AGGREGATION.
    #
    # The additivity guard was refusing KPI tiles: "Số đơn hàng" is a
    # count_distinct, so summing it is unsound in general — but the chart holds a
    # single row, and the "sum" of one value is that value. The first version
    # refused it and broke a question the assistant had been answering correctly
    # (99,441 orders, matching the tile on screen).
    #
    # The rule the guard actually encodes is "do not combine these ACROSS rows".
    # With nothing to combine, there is nothing to get wrong.
    if not info["additive"] and len(values) > 1:
        return R.err(
            measure_meta.additivity_error(info),
            code="not_applicable",
            detail={
                "measure": columns[m_idx],
                "aggregation": info["agg"],
                "format_kind": info["format_kind"],
                # The statistic that IS meaningful, so the refusal is useful
                # rather than merely correct.
                "average_across_rows": round(average, 4),
                "rows_counted": len(values),
                "unit": info["unit"],
            },
        )

    total = sum(values)
    return R.ok(
        {
            "chart_id": chart_id,
            "measure": columns[m_idx],
            "value": round(total, 4),
            "formatted": _fmt(total),
            "average": round(average, 4),
            "min": round(min(values), 4),
            "max": round(max(values), 4),
            "rows_counted": len(values),
            "aggregation": info["agg"],
            # The unit, or an explicit statement that there isn't one. The gap
            # used to be silent, and the model filled it — the same figure was
            # labelled USD on one turn and VND on the next, over Brazilian data.
            "unit": info["unit"],
            "unit_note": measure_meta.unit_note(info),
            # A single-row chart returns its value; calling that "the total" of a
            # percentage or a distinct count would be true of the arithmetic and
            # misleading about the meaning, so it says which it is.
            **(
                {"note": (
                    f"Single row: this is the VALUE of '{columns[m_idx]}', not a "
                    "sum across rows. Nothing was aggregated."
                )}
                if len(values) == 1 and not info["additive"] else {}
            ),
            "filters_applied": filters_applied,
        },
        kind="value",
        # Every row went in. Stated explicitly so a reader never has to wonder
        # whether this total is a total.
        coverage=R.Coverage(returned=len(values), total=len(rows), truncated=False,
                            computed_over_all=True),
    )


def tool_share_of(ctx: ToolContext, args: dict) -> dict:
    """One group's figure, its share of the whole, and where it ranks."""
    loaded = _load(ctx, args)
    if isinstance(loaded, dict):
        return loaded
    columns, rows, filters_applied = loaded
    chart_id = args["chart_id"]

    item = args.get("item")
    if not isinstance(item, str) or not item.strip():
        return R.err("item (string) is required", code="bad_argument")

    resolved = _resolve(
        ctx, chart_id, columns, rows,
        measure=args.get("measure"), dimension=args.get("dimension"),
    )
    if isinstance(resolved, dict):
        return resolved
    m_idx, d_idx, measure_name, dimension_name = resolved

    info = measure_meta.describe_measure(ctx, chart_id, measure_name)
    sums, _ = _group(rows, d_idx, m_idx)
    if not sums:
        return R.err(f"chart {chart_id} has no numeric values", code="no_data")

    wanted = item.strip().lower()
    matched = next((k for k in sums if k.lower() == wanted), None)
    if matched is None:
        # Substring, so a viewer asking about "health" finds "health_beauty" —
        # the labels are warehouse values and rarely what a person types.
        near = [k for k in sums if wanted in k.lower()]
        if len(near) == 1:
            matched = near[0]
        elif near:
            return R.err(
                f"'{item}' matches several values in '{dimension_name}'",
                code="bad_argument", detail={"candidates": sorted(near)[:10]},
            )
        else:
            return R.err(
                f"no '{item}' in '{dimension_name}'",
                code="no_data",
                detail={"sample": sorted(sums)[:10], "group_count": len(sums)},
            )

    total = sum(sums.values())
    ranked = sorted(sums.items(), key=lambda kv: kv[1], reverse=True)
    rank = next(i for i, (k, _) in enumerate(ranked) if k == matched) + 1
    value = sums[matched]
    return R.ok(
        {
            "chart_id": chart_id,
            "measure": measure_name,
            "dimension": dimension_name,
            "item": matched,
            "matched_exactly": matched.lower() == wanted,
            "value": round(value, 4),
            "formatted": _fmt(value),
            "rank": rank,
            "group_count": len(sums),
            "aggregation": info["agg"],
            "unit": info["unit"],
            "unit_note": measure_meta.unit_note(info),
            # The share is the whole point of this tool, and it is exactly the
            # part that a non-additive measure cannot supply: one group's rate
            # divided by the sum of all rates is not a share of anything. The
            # value and the rank still stand.
            **(
                {
                    "total": round(total, 4),
                    "total_formatted": _fmt(total),
                    "share_pct": round(value / total * 100, 2) if total else None,
                }
                if (info["additive"] or len(sums) <= 1)
                else {
                    "total": None,
                    "share_pct": None,
                    "share_note": (
                        "No share-of-total for this measure: "
                        + measure_meta.additivity_error(info)
                        + f" Its value is {_fmt(value)} and it ranks {rank} of "
                          f"{len(sums)} — report those, not a percentage."
                    ),
                }
            ),
            "filters_applied": filters_applied,
        },
        kind="value",
        # One group reported, share and rank computed against all of them.
        coverage=R.Coverage(returned=1, total=len(sums), truncated=False,
                            computed_over_all=True),
    )


# ── schemas ──────────────────────────────────────────────────────────────────
# Written beside the bodies, because there is no older copy to look one up from.
# Descriptions state the property that distinguishes these from `get_chart_data`
# — "over ALL rows" — since that is the only thing a model needs to know in order
# to choose correctly between them.

_CHART_ARG = {
    "type": "integer",
    "description": "Chart to read. Must belong to the report being viewed.",
}
_MEASURE_ARG = {
    "type": "string",
    "description": "Column to total. Omit to use the chart's own measure.",
}
_DIMENSION_ARG = {
    "type": "string",
    "description": "Column to group by. Omit to use the chart's own dimension.",
}

RANK_VALUES_DEF = {
    "name": "rank_values",
    "description": (
        "Rank the groups of a chart by a measure, computed over ALL rows — not a "
        "capped sample. Use this for any 'highest/lowest/top N/which is biggest' "
        "question: get_chart_data returns at most 50 rows and cannot answer them "
        "correctly when the chart has more groups. Returns each item's share of "
        "the true total and how many groups exist."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "chart_id": _CHART_ARG,
            "top_n": {
                "type": "integer",
                "description": f"How many to return (default 5, max {MAX_ITEMS}).",
            },
            "order": {
                "type": "string",
                "enum": ["desc", "asc"],
                "description": "desc = largest first (default), asc = smallest first.",
            },
            "measure": _MEASURE_ARG,
            "dimension": _DIMENSION_ARG,
        },
        "required": ["chart_id"],
    },
}

TOTAL_MEASURE_DEF = {
    "name": "total_measure",
    "description": (
        "Sum a chart's measure across ALL rows, with average/min/max and the row "
        "count. Use for 'what is the total' — a capped row read cannot produce a "
        "true total when the chart has more rows than the cap."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"chart_id": _CHART_ARG, "measure": _MEASURE_ARG},
        "required": ["chart_id"],
    },
}

SHARE_OF_DEF = {
    "name": "share_of",
    "description": (
        "One group's value, its percentage of the true total, and its rank among "
        "all groups. Use for 'how much is X' or 'what share is X'. Matches the "
        "name loosely, so a viewer's wording need not equal the stored value."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "chart_id": _CHART_ARG,
            "item": {
                "type": "string",
                "description": "The group to report on, e.g. a category or region name.",
            },
            "measure": _MEASURE_ARG,
            "dimension": _DIMENSION_ARG,
        },
        "required": ["chart_id", "item"],
    },
}
