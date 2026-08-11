"""What period the report's data actually covers, and how old it is.

WHY THIS EXISTS
---------------
Group 1 answers "what am I looking at" before anything reads a number, and it was
missing the half of that question that concerns time.

Measured on the demo report: the Olist data runs 2016-09-04 to 2018-10-17. The
date this was written is 2026-08-10 — nearly eight years later. Nothing in the
catalogue could tell an agent that. So a viewer asking "doanh thu tháng này", "quý
gần nhất thế nào" or "so với năm ngoái" got an answer that was either invented or
computed over a period the data does not reach, and neither the agent nor the
viewer had any way to notice.

That is not a quirk of one demo dataset. Every report covers a period, every
report goes stale, and a large share of real questions carry a time word. A tool
group that claims to explain the report and cannot say when the data stops is
incomplete in the way that produces confident wrong answers.

HOW IT FINDS THE DATES
----------------------
Without being told, and without new SQL. The chart configurations already declare
which dimensions are dates, and the dataset tables already record column types, so
the search is: find charts whose dimension is a date, read those charts through
the SAME permission-checked path every other tool uses, and take the extremes of
the date column.

No new query path means no new way to reach data a link did not grant. It also
means this works on any warehouse the report already works on, rather than on the
subset whose dialect a hand-written MIN/MAX would have compiled for.

LANGUAGE
--------
Everything this tool RETURNS is English, because the only reader of a tool result
is a model, and a machine contract written in two languages is a contract in
neither. The answer's language is decided at the edge from the viewer's own
question — see the LANGUAGE rule in the base prompt — not by strings baked into
the middle of the pipeline. What stays Vietnamese is what a Vietnamese-speaking
AUTHOR reads in the builder: `label_vi`, `description_vi`, `answers_vi`.

WHY IT IS NOT CACHED
--------------------
The range itself is a fact about the data and would cache happily. The useful part
is the comparison with today — "the data stops 2,853 days ago, so there is nothing
for this month" — and a cached comparison drifts from the clock it was computed
against. Since the whole value of the tool is that one sentence being right, the
tool declares itself non-deterministic and pays for a fresh read.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

from app.services.agent_flows.tools import result as R
from app.services.dashboard_ai_bot.tool_context import ToolContext, _fetch_chart_data

#: How many charts to read looking for dates. The scan stops as soon as it has a
#: range from this many, because a report's charts share a calendar far more often
#: than not — reading twenty to confirm what three already agreed on is a cost
#: with no answer attached.
MAX_CHARTS_SCANNED = 4

#: Column names that mark a date even when the type does not. Warehouse loaders
#: routinely land a date as STRING, and a report that shows a month axis should
#: not be unreadable here because Airbyte chose a text column.
_DATE_NAME = re.compile(
    r"(date|ngay|ngày|thang|tháng|nam|năm|time|timestamp|_at|_dt|period|ky|kỳ)",
    re.IGNORECASE,
)

#: Accepted written forms, widest first. Year-only is last because "2016" also
#: parses as an integer measure, and treating a revenue column as a date would be
#: a worse failure than not finding a date at all.
_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%Y-%m", "%Y/%m", "%Y")


def _as_date(value: Any) -> date | None:
    """A date if this cell holds one, else None."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # A bare year, and only a plausible one. Anything else is a measure.
        year = int(value)
        if 1900 <= year <= 2200 and float(value) == year:
            return date(year, 1, 1)
        return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    # An ISO timestamp with a time part: keep the date half.
    head = text.split("T")[0].split(" ")[0]
    for fmt in _FORMATS:
        try:
            return datetime.strptime(head, fmt).date()
        except ValueError:
            continue
    return None


def _date_column(columns: list[str], rows: list[list]) -> int | None:
    """Which column holds the dates.

    Names first — a column called `order_purchase_timestamp` is a date whatever
    its values look like — then the values themselves, so a column named `key`
    holding `2018-03` is still found. A column qualifies on values only when MOST
    of them parse, which keeps a stray year inside a text column from winning.
    """
    named = [i for i, c in enumerate(columns) if _DATE_NAME.search(c or "")]
    for idx in named + [i for i in range(len(columns)) if i not in named]:
        seen = hits = 0
        for row in rows[:120]:
            if idx >= len(row) or row[idx] is None:
                continue
            seen += 1
            if _as_date(row[idx]) is not None:
                hits += 1
        if seen and hits >= max(2, seen * 0.8):
            return idx
    return None


def _describe_gap(latest: date, today: date) -> tuple[int, str]:
    """How far behind the data is, and what that means for a time-word question."""
    days = (today - latest).days
    if days <= 2:
        return days, "Data is current as of today."
    if days <= 45:
        return days, f"Data stops {days} days ago."
    months = days // 30
    if months < 24:
        return days, (
            f"Data stops about {months} months ago. Read 'this month' and "
            "'recently' against the data's LAST period, not against today's date."
        )
    return days, (
        f"Data stops about {days // 365} years ago. Do NOT answer 'this month', "
        "'this quarter' or 'this year' using the current calendar — the report has "
        "no rows for those periods. State the latest period the data actually "
        "covers and answer for that instead."
    )


def tool_describe_time_coverage(ctx: ToolContext, args: dict) -> dict:
    """The period this report's data covers, and how stale it is."""
    wanted = args.get("chart_id")
    if wanted is not None and not isinstance(wanted, int):
        return R.err("chart_id must be an integer", code="bad_argument")

    widened_from: int | None = None
    if isinstance(wanted, int):
        try:
            ctx.assert_chart_in_scope(wanted)
        except Exception as exc:  # noqa: BLE001
            return R.err(str(exc), code="chart_out_of_scope")
        # WIDEN RATHER THAN REFUSE.
        #
        # Observed live: asked "doanh thu tháng này", the model called this tool
        # with the id of the chart it was about to total — a KPI tile with no time
        # dimension. This returned `not_applicable`, the model lost the one fact
        # that would have saved the answer, fell back to `total_measure`, and
        # reported a 24-month total as "this month".
        #
        # The refusal was pedantically correct and practically wrong: "what period
        # does this data cover" has a report-level answer whenever it has any
        # answer at all, and the caller asking about one chart wants the period,
        # not a lecture about which chart carries it. So a chart with no dates
        # falls back to the whole report and the result SAYS it widened.
        candidates = [wanted] + [c for c in sorted(ctx.allowed_chart_ids) if c != wanted]
        widened_from = wanted
    else:
        # Charts the CONFIG says are time series come first: they are the ones
        # whose dimension is a date, so they answer in one read.
        timed, others = [], []
        for cid in sorted(ctx.allowed_chart_ids):
            fields = (ctx.chart_meta.get(cid) or {}).get("fields") or {}
            dims = fields.get("dimensions") or []
            if any(_DATE_NAME.search(str(d.get("field") or d.get("label") or ""))
                   for d in dims):
                timed.append(cid)
            elif dims:
                others.append(cid)
        candidates = timed + others

    if not candidates:
        return R.err(
            "This report has no charts to read a date range from.",
            code="not_applicable",
        )

    earliest: date | None = None
    latest: date | None = None
    read: list[dict[str, Any]] = []
    scanned = 0

    for cid in candidates:
        if scanned >= MAX_CHARTS_SCANNED:
            break
        if widened_from is not None and cid != widened_from and scanned == 0:
            # The named chart yielded nothing; from here the scan is report-wide.
            pass
        try:
            data = _fetch_chart_data(ctx, cid)
        except Exception:  # noqa: BLE001 — one unreadable chart must not end the scan
            continue
        columns, rows = data["columns"], data["rows"]
        if not rows:
            continue
        idx = _date_column(columns, rows)
        if idx is None:
            continue
        scanned += 1
        dates = [d for row in rows if idx < len(row)
                 and (d := _as_date(row[idx])) is not None]
        if not dates:
            continue
        lo, hi = min(dates), max(dates)
        earliest = lo if earliest is None else min(earliest, lo)
        latest = hi if latest is None else max(latest, hi)
        read.append({
            "chart_id": cid,
            "chart_name": (ctx.chart_meta.get(cid) or {}).get("name", ""),
            "column": columns[idx],
            "from": lo.isoformat(),
            "to": hi.isoformat(),
            "points": len(dates),
        })

    if earliest is None or latest is None:
        return R.err(
            "No dates could be read from this report's charts — it may have no "
            "time dimension at all.",
            code="not_applicable",
            detail={"charts_scanned": scanned},
        )

    today = date.today()
    days_behind, staleness = _describe_gap(latest, today)
    span_days = (latest - earliest).days
    covers_today = earliest <= today <= latest

    # AT WHAT GRAIN. The range is read from the charts the report draws, and a
    # chart plotted by month reports 2018-10-01 for a period whose last row is
    # 2018-10-17. Both are true of what was read and only one is true of the
    # data, so say which: "to 2018-10-01" invites a reader to treat the 1st as
    # the last day with numbers, and the whole point of this tool is that the
    # boundary is not guessed at.
    grain = "day"
    if all(d["from"].endswith("-01-01") and d["to"].endswith("-01-01") for d in read):
        grain = "year"
    elif all(d["from"][8:] == "01" and d["to"][8:] == "01" for d in read):
        grain = "month"

    return R.ok(
        {
            "from": earliest.isoformat(),
            "to": latest.isoformat(),
            "span_days": span_days,
            "span_months": round(span_days / 30.44, 1),
            "latest_period": latest.strftime("%Y-%m"),
            "grain": grain,
            "days_behind_today": days_behind,
            "today": today.isoformat(),
            "covers_today": covers_today,
            "staleness_note": staleness,
            # Provenance, capped at two: enough to show WHERE the range came
            # from, not a second listing of the report. A tool that declares
            # `payload="small"` has to live inside it, or the axis added to make
            # payload visible becomes another number nobody can trust.
            "read_from": [
                {"chart_id": e["chart_id"], "chart_name": e["chart_name"],
                 "from": e["from"], "to": e["to"]}
                for e in read[:2]
            ],
            "charts_scanned": len(read),
            **(
                {"widened_from_chart": widened_from,
                 "widened_note": (
                     f"Chart {widened_from} has no time dimension, so this is the "
                     "date range of the WHOLE report."
                 )}
                if widened_from is not None
                and not any(e["chart_id"] == widened_from for e in read)
                else {}
            ),
            "note": (
                f"The report's data runs {earliest.isoformat()} to "
                f"{latest.isoformat()}"
                + (f", read at {grain} grain (last period {latest.strftime('%Y-%m')})."
                   if grain != "day" else ".")
                + f" {staleness}"
            ),
        },
        kind="value",
        coverage=R.Coverage(
            returned=len(read), total=len(candidates),
            ordered_by="charts with a time dimension first",
            truncated=False, computed_over_all=True,
        ),
    )


DESCRIBE_TIME_COVERAGE_DEF = {
    "name": "describe_time_coverage",
    "description": (
        "The period this report's data actually covers, and how far behind today "
        "it is. CALL THIS BEFORE answering any question containing a time word "
        "('this month', 'recently', 'last year', 'latest quarter'): the data may "
        "stop years before today, in which case those phrases must be read "
        "against the data's own latest period, not the calendar."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "chart_id": {
                "type": "integer",
                "description": (
                    "Limit to one chart. Omit to cover the whole report, which is "
                    "the usual case."
                ),
            },
        },
        "required": [],
    },
}
