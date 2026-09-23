# -*- coding: utf-8 -*-
"""The refusal has to happen in the TOOL, not in a helper a test can reach.

WHY THIS FILE EXISTS ALONGSIDE THE OTHERS.

`test_canonical_time_semantics.py` pins the name rule and
`test_time_axis_needs_more_than_a_name.py` pins the three tiers. Both assert on
helpers, and one of them reached for `inspect.getsource` to check that a tool had
gained a value fallback. Source inspection proves a line exists; it does not
prove the tool refuses. A guard can be present and unreachable — placed after an
early return, or behind a condition that is never true — and every helper test
still passes.

So these call `tool_compare_periods`, `tool_analyze_trend`,
`tool_forecast_measure` and `tool_detect_anomaly` with real chart payloads and
assert on what comes back.

THE TWO FAILURES BEING PINNED.

    ky_thuat over ["engineering", "sales", "support"]   must be REFUSED
    ky_bao_cao over ["2024-01", "2024-02", ...]         must be ACCEPTED

and, the one the first round of this work missed:

    ky_bao_cao over ["engineering", "2024", "support"]  must be REFUSED

One category that happens to be a bare year is not evidence of a time axis. The
value rule used to return True on the first recognisable label, so a single
accidental `2024` bought a time-series calculation over a categorical column.

TOOLS DIFFER, DELIBERATELY, and that is asserted rather than smoothed over.
`compare_periods`, `forecast_measure` and `analyze_trend` accept an axis proven
by its VALUES whatever the column is called, which is how a column named `key`
full of dates stays usable. `detect_anomaly` in `rolling`/`changepoint` mode does
the same.

A STRONG name, by contrast, short-circuits the value check in all of them, and
that is pinned as the contract rather than treated as a gap: requiring proof
there would refuse `Tháng 1`, `Jan 2024` and fiscal labels this module cannot
parse, which are far commoner than an `order_date` column full of departments.
"""
from __future__ import annotations

import os

import pytest

if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.dashboard_ai_bot.thinking import advanced_tools as ADV  # noqa: E402


class Ctx:
    chart_meta: dict = {}
    allowed_chart_ids = {1}

    def assert_chart_in_scope(self, chart_id):
        return None


#: Enough points that no tool refuses for want of data — the refusal under test
#: must be about the AXIS, not about series length.
CATEGORICAL = ["engineering", "sales", "support", "finance", "legal", "ops",
               "hr", "marketing", "design", "research", "qa", "security"]
SIZES = ["nho", "vua", "lon", "rat lon", "sieu lon", "nho hon",
         "vua hon", "lon hon", "khac", "chua ro", "tong", "trung binh"]
MONTHS = [f"2024-{m:02d}" for m in range(1, 13)]
QUARTERS = ["Q1 2023", "Q2 2023", "Q3 2023", "Q4 2023",
            "Q1 2024", "Q2 2024", "Q3 2024", "Q4 2024"]
DATES = [f"2024-{m:02d}-15" for m in range(1, 13)]
#: One accidental year among ordinary categories — 1 hit in 12.
CATEGORICAL_WITH_ONE_YEAR = ["engineering", "2024", "support", "finance", "legal",
                             "ops", "hr", "marketing", "design", "research",
                             "qa", "security"]


def _chart(labels, dim):
    return {
        "columns": [dim, "dataset_table_2.revenue"],
        "rows": [[label, 1000.0 + i * 37] for i, label in enumerate(labels)],
        "filters_applied": [],
    }


@pytest.fixture()
def serve(monkeypatch):
    """Hand every tool the same chart. Returns a setter."""
    holder = {"data": _chart(MONTHS, "order_month")}

    monkeypatch.setattr(ADV, "_fetch_chart_data",
                        lambda ctx, chart_id, **kw: holder["data"], raising=False)
    monkeypatch.setattr(ADV, "_attach_delta_unit",
                        lambda ctx, cid, measure, payload: payload, raising=False)

    def set_chart(labels, dim):
        holder["data"] = _chart(labels, dim)

    return set_chart


#: (tool, args) — the four that do calendar mathematics.
TIME_TOOLS = [
    ("tool_compare_periods", {"chart_id": 1, "mode": "auto"}),
    ("tool_analyze_trend", {"chart_id": 1}),
    ("tool_forecast_measure", {"chart_id": 1, "periods": 2}),
    ("tool_detect_anomaly", {"chart_id": 1, "method": "rolling"}),
    ("tool_detect_anomaly", {"chart_id": 1, "method": "changepoint"}),
]


def _call(tool_name: str, args: dict) -> dict:
    return getattr(ADV, tool_name)(Ctx(), dict(args))


def _refused(result: dict) -> bool:
    return isinstance(result, dict) and result.get("ok") is False


#: Readable ids, precomputed: pytest hands `ids=` each value separately, not
#: the tuple, so a callable receives the tool name alone.
TOOL_IDS = [f"{t}:{a.get('method', a.get('mode', 'default'))}"
            for t, a in TIME_TOOLS]

#: `compare_periods` applies STRONGER validation than the other three and is
#: excluded from the value-proven cases below. Its automatic modes (mom/qoq/yoy)
#: need the GRAIN of the axis, which values alone do not give: `2024-01 …` could
#: be months or a monthly snapshot of something else. So it requires a
#: name-settled axis for automatic comparison and routes a value-proven one to
#: explicit `mode=custom` instead. That is a legitimate per-tool difference and
#: is asserted below rather than flattened away.
VALUE_PROVEN_TOOLS = [(t, a) for t, a in TIME_TOOLS if t != "tool_compare_periods"]
VALUE_PROVEN_IDS = [f"{t}:{a.get('method', a.get('mode', 'default'))}"
                    for t, a in VALUE_PROVEN_TOOLS]


# ── A, B, C — an ambiguous name over categorical values is refused ──────────

@pytest.mark.parametrize("tool,args", TIME_TOOLS, ids=TOOL_IDS)
@pytest.mark.parametrize("dim,labels", [
    ("ky_thuat", CATEGORICAL),
    ("quy_dinh", CATEGORICAL),
    ("quy_mo_doanh_nghiep", SIZES),
])
def test_an_ambiguous_name_over_categories_is_refused_by_every_time_tool(
        serve, tool, args, dim, labels):
    serve(labels, dim)
    result = _call(tool, args)
    assert _refused(result), (
        f"{tool} ran calendar mathematics over {dim!r} = {labels[:3]}…; "
        f"got {str(result)[:200]}"
    )


# ── F — the case the first round missed ────────────────────────────────────

@pytest.mark.parametrize("tool,args", TIME_TOOLS, ids=TOOL_IDS)
def test_one_accidental_year_among_categories_is_not_a_time_axis(serve, tool, args):
    """`["engineering", "2024", "support", …]` — 1 period-shaped value in 12."""
    serve(CATEGORICAL_WITH_ONE_YEAR, "ky_bao_cao")
    result = _call(tool, args)
    assert _refused(result), (
        f"{tool} accepted a categorical axis because one label was a bare year; "
        f"got {str(result)[:200]}"
    )


# ── D, E — an ambiguous name PROVEN by its values is accepted ──────────────

@pytest.mark.parametrize("tool,args", VALUE_PROVEN_TOOLS, ids=VALUE_PROVEN_IDS)
@pytest.mark.parametrize("dim,labels", [
    ("ky_bao_cao", MONTHS),
    ("quy", QUARTERS),
])
def test_an_ambiguous_name_proven_by_its_values_is_accepted(
        serve, tool, args, dim, labels):
    serve(labels, dim)
    result = _call(tool, args)
    assert not _refused(result), (
        f"{tool} refused {dim!r} even though its values are periods: "
        f"{str(result)[:200]}"
    )


# ── G — a strong name still works ──────────────────────────────────────────

@pytest.mark.parametrize("tool,args", TIME_TOOLS, ids=TOOL_IDS)
@pytest.mark.parametrize("dim", ["created_at", "year_month", "order_date"])
def test_a_strong_name_over_real_periods_still_works(serve, tool, args, dim):
    serve(MONTHS, dim)
    assert not _refused(_call(tool, args))


# ── H — value discovery, where the tool supports it ────────────────────────

@pytest.mark.parametrize("tool,args", VALUE_PROVEN_TOOLS, ids=VALUE_PROVEN_IDS)
def test_a_strange_name_with_real_dates_is_accepted_by_value_discovery(
        serve, tool, args):
    """A column named `key` full of dates.

    Trend, forecast and both anomaly methods accept it: each reads the labels
    when the name does not settle the question, which is what makes the name a
    hint rather than a gate. `compare_periods` is excluded and covered
    separately — it needs the grain, not just the shape.
    """
    serve(DATES, "key")
    result = _call(tool, args)
    assert not _refused(result), (
        f"{tool} refused a column whose values are unambiguously dates: "
        f"{str(result)[:200]}"
    )


# ── what a STRONG name does, stated rather than assumed ────────────────────

@pytest.mark.parametrize("tool,args", TIME_TOOLS, ids=TOOL_IDS)
def test_a_strong_name_short_circuits_the_value_check_by_design(serve, tool, args):
    """A strong name is accepted WITHOUT reading the values, and that is the
    contract — not an oversight this session should close.

    The tempting assertion is the opposite: that `order_date` holding department
    names should be refused. It is tempting because such a chart is broken. But
    requiring value proof on a strong name would refuse legitimate axes whose
    labels this module cannot parse — `Tháng 1`, `Jan 2024`, a fiscal label like
    `FY24 P3` — and those are far more common than a column called `order_date`
    full of departments. The name rule would stop being a hint and become a
    second, weaker gate in front of the real one.

    So the value check exists for the case where the name does NOT settle it,
    which is exactly where the original bug lived. This test pins that boundary
    so a future change cannot quietly move it in either direction.
    """
    serve(CATEGORICAL, "order_date")
    result = _call(tool, args)
    assert not _refused(result), (
        f"{tool} now refuses a STRONG name over categorical values. That may be "
        "an improvement, but it is a contract change: localized and fiscal period "
        "labels would be refused with it. Decide deliberately, do not let this "
        "test be edited to match."
    )


def test_the_value_rule_is_what_refuses_an_ambiguous_name(serve):
    """The same tool, the same values, two names — only the name differs.

    This is the cleanest statement of the tier: `analyze_trend` accepts
    categorical values under a STRONG name and refuses them under an AMBIGUOUS
    one, because only the second consults the values at all.
    """
    serve(CATEGORICAL, "order_date")
    assert not _refused(_call("tool_analyze_trend", {"chart_id": 1}))
    serve(CATEGORICAL, "ky_thuat")
    assert _refused(_call("tool_analyze_trend", {"chart_id": 1}))


# ── the tool that is deliberately stricter ─────────────────────────────────

@pytest.mark.parametrize("dim,labels", [
    ("ky_bao_cao", MONTHS),
    ("quy", QUARTERS),
    ("key", DATES),
])
def test_compare_periods_needs_the_grain_and_says_how_to_supply_it(serve, dim, labels):
    """Value evidence proves the axis is temporal; it does not prove its GRAIN.

    `mom`, `qoq` and `yoy` are arithmetic over a known cadence. `["2024-01",
    "2024-02", ...]` is period-shaped but could be months, or a monthly snapshot
    of something that is not a month. So this tool refuses the automatic modes
    on an axis the NAME did not settle — and hands back the route that does
    work, with the labels to choose from, rather than a dead end.

    Asserted as a contract, not tolerated as a gap: the refusal must stay
    actionable. A flat "not a time axis" here would send the model into the
    guess-the-period loop this message exists to prevent.
    """
    serve(labels, dim)
    result = _call("tool_compare_periods", {"chart_id": 1, "mode": "auto"})
    assert _refused(result)
    message = str(result.get("error") or "")
    assert "custom" in message, (
        "the refusal stopped naming the mode that would work: " + message
    )
    assert "Do not retry" not in message, (
        "a value-proven axis was given the dead-end refusal meant for a "
        "categorical one: " + message
    )


def test_compare_periods_still_dead_ends_a_genuinely_categorical_axis(serve):
    """The other half: no grain AND no shape gets the hard refusal."""
    serve(CATEGORICAL, "ky_thuat")
    result = _call("tool_compare_periods", {"chart_id": 1, "mode": "auto"})
    assert _refused(result)
    assert "Do not retry" in str(result.get("error") or "")