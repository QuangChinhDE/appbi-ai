"""What a measure IS, before anyone does arithmetic on it.

WHY THIS EXISTS
---------------
The computing tools were built and verified against one report whose measures are
all plain sums. Run across every dashboard in this deployment, they produced three
numbers that were arithmetically executed and semantically meaningless:

    total_measure summed 'pct_kh'          (agg=avg)            → 7.20
    total_measure summed 'pct_kh'          (agg=avg)            → 35.99
    total_measure summed 'transaction_id'  (agg=count_distinct)  → 250

A total of percentages is not a percentage. A total of distinct counts double
counts everything that appears in more than one row. Neither returns an error,
neither is caught by a coverage note, and a viewer reading "35.99" has no way to
know the operation was invalid — which makes this the worst failure mode in the
catalogue and the one that only appears on data the author never saw.

The information needed to prevent it was already in the system. The semantic
layer stores a `format` on every measure — `{kind: number|currency|percent,
currency: "USD"|"VND"|…, decimals, prefix, suffix}` — and a `type` (the
aggregation). Nothing read it: `knowledge_context._semantic_fields` extracts only
name, label and description, so `describe_semantic_model` advertised a "unit" it
never populated, and the measuring tools had no idea what they were adding up.

So this module reads it, and answers two questions:

  ADDITIVE?   may these values be summed at all
  UNIT?       what the number is denominated in

The second one closes a separate defect with the same root: asked for a total, the
assistant labelled the same figure "13,591,643.70 USD" on one turn and
"1,258,681.34 VNĐ" on another, over Brazilian data. No unit was declared and none
was returned, so the model supplied one. A tool that returns a bare number must
say that the unit is unknown, not leave the gap for a guess to fill.
"""
from __future__ import annotations

import time as _time
from typing import Any

#: Aggregations whose results cannot be added across rows.
#:
#: `avg`, `median` and the ratio family are averages of averages — meaningless.
#: `count_distinct` double counts any entity appearing in two groups. `min`/`max`
#: of parts is not the min/max of the whole. Everything else (`sum`, `count`) adds
#: up, which is why they are the only two this list leaves out.
NON_ADDITIVE_AGGS = frozenset({
    "avg", "average", "mean", "median", "count_distinct", "distinct",
    "min", "max", "ratio", "rate", "percent", "percentage", "pct",
    "stddev", "variance", "p50", "p90", "p95", "p99",
})

#: Format kinds whose values cannot be added, whatever the aggregation says.
#: A measure typed `count` but formatted `percent` — the semantic layer has real
#: examples — is a percentage, and the FORMAT is a stronger signal than the type
#: because it is what the report shows the viewer.
NON_ADDITIVE_KINDS = frozenset({"percent", "percentage", "ratio"})

#: A division by something that is not a plain number.
#:
#: THE STRONGEST SIGNAL, and the one that reads the definition rather than
#: guessing from it. A measure whose expression divides one quantity by another
#: is a rate, and rates do not add: the sum of twelve monthly completion rates is
#: not a completion rate.
#:
#: This was reached after proposing — and then disproving — "require every
#: formula measure to declare a format". The declared formats in this deployment
#: show why that would have been wrong in both directions:
#:
#:   avg_tasks_per_user   task_count / NULLIF(distinct_users, 0)   format=number
#:       A ratio the format calls a plain number. Format alone MISSES it.
#:   discounted_revenue   revenue * 0.9                            format=(none)
#:       Additive, and undeclared. Requiring a format would REFUSE it wrongly.
#:
#: Dividing by a CONSTANT is excluded, because scaling preserves additivity:
#: `revenue / 1000` is revenue in thousands and still adds up. So the pattern
#: matches a `/` followed by anything that is not a bare numeric literal.
import re as _re  # noqa: E402 — local to this constant

#: The whitespace sits INSIDE the lookahead deliberately. Written as
#: `/\s*(?!\d+…)` the engine backtracks `\s*` to zero, tests the lookahead at the
#: space, finds no digit there and "succeeds" — so `revenue / 1000` was flagged
#: as a ratio. With nothing outside the lookahead to backtrack, the test is on
#: what actually follows the slash.
_RATIO_DIVISION = _re.compile(r"/(?!\s*\d+(?:\.\d+)?\s*(?:$|[),]))")


#: Measured: `describe_measure` costs ~2.5 app-database queries and ~3.4ms, and
#: it was being paid on EVERY measuring call — a turn with four tool calls issued
#: ten queries to re-read definitions that had not changed. Semantic definitions
#: are edited by a person in a builder, not by the data, so within one turn they
#: are constant by construction.
#:
#: The TTL matches the tool-result cache in `registry.py`: long enough that a
#: conversation never re-reads, short enough that an author editing a measure
#: sees the change without restarting anything.
_META_CACHE: dict[tuple[int, str], tuple[float, dict[str, Any]]] = {}
_META_TTL = 300.0
_META_MAX = 512


def _cached(key: tuple[int, str]) -> dict[str, Any] | None:
    hit = _META_CACHE.get(key)
    if hit is None:
        return None
    stored_at, value = hit
    if _time.monotonic() - stored_at > _META_TTL:
        _META_CACHE.pop(key, None)
        return None
    return value


def _remember(key: tuple[int, str], value: dict[str, Any]) -> dict[str, Any]:
    if len(_META_CACHE) >= _META_MAX:
        _META_CACHE.clear()
    _META_CACHE[key] = (_time.monotonic(), value)
    return value


def clear_cache() -> None:
    """Drop memoised definitions. For tests, and after a semantic-layer edit."""
    _META_CACHE.clear()


def _view_measures(db: Any, dataset_table_id: int) -> list[dict]:
    """The measure definitions of one dataset table, or an empty list."""
    try:
        from app.models.semantic import SemanticView

        views = (
            db.query(SemanticView)
            .filter(SemanticView.dataset_table_id == dataset_table_id)
            .all()
        )
    except Exception:  # noqa: BLE001 — never let metadata break a measurement
        return []
    out: list[dict] = []
    for v in views:
        coll = getattr(v, "measures", None)
        if isinstance(coll, list):
            out.extend(m for m in coll if isinstance(m, dict))
    return out


def describe_measure(ctx: Any, chart_id: int, measure_name: str) -> dict[str, Any]:
    """What is known about this measure: aggregation, format, unit, additivity.

    Matches on the semantic name, its label, or the trailing segment of a
    qualified column (`dataset_table_438.total_revenue` → `total_revenue`),
    because the three appear interchangeably depending on which layer named the
    column.

    Returns `additive=True` when nothing is known. Refusing to compute on every
    undocumented measure would break the majority of reports to protect a
    minority — so an undeclared measure is trusted and the UNIT is reported as
    unknown, which is the part a model must not fill in on its own.
    """
    unknown = {
        "measure": measure_name, "agg": None, "format_kind": None,
        "unit": None, "unit_known": False, "additive": True, "declared": False,
    }
    leaf = (measure_name or "").split(".")[-1].strip().lower()
    if not leaf:
        return unknown

    key = (int(chart_id), leaf)
    hit = _cached(key)
    if hit is not None:
        return hit

    # THE CHART'S OWN CONFIG COMES FIRST.
    #
    # There are two places an aggregation is declared and only one of them is
    # always populated. The semantic layer holds it for a modelled dataset; for
    # everything else the chart config holds it, and `ctx.chart_meta` already
    # carries that — free, no query. Reading only the semantic layer found
    # nothing for the two charts that were actually being summed wrongly
    # (`pct_kh` agg=avg, `transaction_id` agg=count_distinct): both live on
    # dataset tables whose SemanticView declares no measures at all.
    #
    # `auto` means the chart deferred the choice, so it is not an answer — fall
    # through to the semantic layer in that case.
    chart_agg = None
    for m in ((ctx.chart_meta.get(chart_id) or {}).get("fields") or {}).get("measures") or []:
        if not isinstance(m, dict):
            continue
        candidates = {
            str(m.get("field") or "").strip().lower(),
            str(m.get("field") or "").split(".")[-1].strip().lower(),
            str(m.get("label") or "").strip().lower(),
        }
        if leaf in candidates or (measure_name or "").strip().lower() in candidates:
            declared_agg = str(m.get("agg") or "").strip().lower()
            if declared_agg and declared_agg != "auto":
                chart_agg = declared_agg
            break

    db = getattr(ctx, "db", None)
    if db is None:
        if chart_agg:
            return _remember(key, {
                **unknown, "agg": chart_agg, "declared": True,
                "additive": chart_agg not in NON_ADDITIVE_AGGS,
            })
        return _remember(key, unknown)

    # WHICH table owns the measure.
    #
    # A measure arrives qualified — `dataset_table_219.transaction_id` — and in a
    # snowflake model that table is NOT the chart's base table: the measure lives
    # on a joined fact while the chart is anchored elsewhere. Looking the
    # definition up on the chart's table found nothing, so every non-additive
    # measure read as undeclared and the guard below never fired. Prefer the
    # table named IN the measure, fall back to the chart's.
    candidates: list[int] = []
    qualifier = (measure_name or "").rsplit(".", 1)[0] if "." in (measure_name or "") else ""
    if qualifier.startswith("dataset_table_"):
        tail = qualifier[len("dataset_table_"):].split("__")[0]
        if tail.isdigit():
            candidates.append(int(tail))
    try:
        from app.models.models import Chart

        chart = db.query(Chart).filter(Chart.id == chart_id).first()
        own = getattr(chart, "dataset_table_id", None)
        if own and own not in candidates:
            candidates.append(int(own))
    except Exception:  # noqa: BLE001
        pass
    if not candidates:
        return _remember(key, unknown)

    measures: list[dict] = []
    for table_id in candidates:
        measures.extend(_view_measures(db, table_id))

    for m in measures:
        names = {
            str(m.get("name") or "").strip().lower(),
            str(m.get("label") or "").strip().lower(),
            str(m.get("name") or "").split(".")[-1].strip().lower(),
        }
        if leaf not in names and measure_name.strip().lower() not in names:
            continue

        # The chart's explicit aggregation wins: the semantic `type` describes
        # the measure's default, the chart config describes what THIS chart did
        # with it, and it is the latter that produced the values in hand.
        agg = chart_agg or (str(m.get("type") or "").strip().lower() or None)
        fmt = m.get("format") if isinstance(m.get("format"), dict) else {}
        kind = str(fmt.get("kind") or "").strip().lower() or None
        currency = (fmt.get("currency") or "").strip() or None
        suffix = (fmt.get("suffix") or "").strip() or None

        # The unit, in the order of least ambiguity.
        if kind == "currency" and currency:
            unit, known = currency, True
        elif kind in NON_ADDITIVE_KINDS:
            unit, known = "%", True
        elif suffix:
            unit, known = suffix, True
        else:
            unit, known = None, False

        # Three independent signals, any one of which disqualifies a sum. The
        # expression matters MOST: it is the only one derived from what the
        # measure actually computes rather than from how somebody labelled it,
        # and it is the one that catches `avg_tasks_per_user` — a ratio whose
        # declared format says "number".
        expression = str(m.get("expression") or "")
        divides = bool(_RATIO_DIVISION.search(expression))
        additive = not (
            (agg in NON_ADDITIVE_AGGS)
            or (kind in NON_ADDITIVE_KINDS)
            or divides
        )
        return _remember(key, {
            "measure": m.get("label") or m.get("name") or measure_name,
            "agg": agg,
            "format_kind": kind,
            "unit": unit,
            "unit_known": known,
            "additive": additive,
            "is_ratio_expression": divides,
            "declared": True,
        })
    if chart_agg:
        return _remember(key, {
            **unknown, "agg": chart_agg, "declared": True,
            "additive": chart_agg not in NON_ADDITIVE_AGGS,
        })
    return _remember(key, unknown)


def unit_note(info: dict[str, Any]) -> str:
    """What to tell a model about the unit of the number it is about to quote."""
    if info.get("unit_known"):
        return f"Unit: {info['unit']}. Quote it exactly; do not convert."
    return (
        "Unit is NOT declared for this measure. State the number bare — do NOT "
        "attach a currency, a percent sign, or any unit that is not in the data."
    )


def additivity_error(info: dict[str, Any]) -> str:
    """Why this measure must not be summed, in words a model will act on."""
    what = info.get("format_kind") if info.get("format_kind") in NON_ADDITIVE_KINDS \
        else info.get("agg")
    return (
        f"'{info.get('measure')}' is a {what} measure and CANNOT be summed — a "
        "total of averages, percentages or distinct counts is arithmetically "
        "valid and semantically meaningless. Ask for the average, the weighted "
        "figure, or the underlying additive measure instead."
    )


def delta_note(info: dict[str, Any]) -> str | None:
    """What the DIFFERENCE between two of these values is measured in.

    40% → 44% is +4 percentage POINTS and +10 percent, and both numbers are
    correct answers to different questions. A comparison that reports `delta: 4`
    beside `pct_change: 10` without naming either unit invites the reader to
    write "up 4%", which is neither.

    Observed on real data: `pct_five_star` 55.56 vs 47.58 returned delta 7.971
    and pct_change 16.75, with nothing in the result distinguishing them.

    Returns None for an ordinary additive measure, where a difference is simply
    in the measure's own unit and needs no explanation.
    """
    if not (info.get("is_ratio_expression")
            or info.get("format_kind") in NON_ADDITIVE_KINDS):
        return None
    return (
        "This measure is a rate. `delta` is therefore in PERCENTAGE POINTS, not "
        "percent, while `pct_change` is the relative change in percent. Say which "
        "one you mean — 'up 4 points' and 'up 10%' can both be true of the same "
        "pair and mean different things."
    )
