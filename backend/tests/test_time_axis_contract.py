# -*- coding: utf-8 -*-
"""A tool that reports over time must first agree that it HAS a time axis.

WRITTEN DURING RELEASE CERTIFICATION, AND IT FAILS ON PURPOSE.

Three of the four time-series tools already enforce this. Asked to work on chart
686 — revenue by `product_category_name_english`, a categorical column — they
refuse and say why:

    analyze_trend        query_failed  "... is not a time axis"
    forecast_measure     query_failed  "chart's dimension ... is not a time axis"
    compare_periods      query_failed  "chart's dimension ... is categorical"

`detect_seasonality` accepts it, calls the product-category column its
`time_dimension`, and reports autocorrelation at cycles of 4, 7 and 12 "periods"
over what is really alphabetical order:

    {"time_dimension": "dataset_table_445.product_category_name_english",
     "history_points": 71, "cycles_tested": [{"cycle_periods": 4, ...}], ...}

That is not a borderline judgement about a tool's scope. The contract is already
written by its three siblings, and the tool's own payload field is named
`time_dimension`: it is claiming a property the column does not have. A reader
handed "no repeating cycle" about categories has been told something meaningless
in the voice of a diagnosis.

THE REMEDY IS NOT ASSUMED HERE. Whether the tool should refuse (like its
siblings) or accept a caller-named time column is a product decision; this test
asserts only the part that is not a decision — it must not present a categorical
column as a time dimension.

Companion finding, deliberately NOT locked here: `compare_periods` treats a
PARTIAL final period as a real latest period (2018-09 = 166.46 vs 2018-08 =
1,003,308.47 -> "-99.98%, worsening") in every mode, while `analyze_trend` on the
same chart excludes edge periods. That one has two defensible remedies — exclude
the partial period, or annotate it — and choosing between them is a product
decision, so it is recorded as evidence in the certification document rather than
frozen by a test written by the same pass that found it.
"""
from __future__ import annotations

import pytest

pytest.importorskip("sqlalchemy")


CATEGORICAL_CHART = 686        # Olist: revenue by product category, dashboard 67
TIME_CHART = 684               # Olist: GMV by month


def _ctx(db, dashboard):
    from app.services.agent_flows.tools.context import ToolContext

    return ToolContext.from_dashboard(
        db=db, dashboard=dashboard, public_filters=[],
        actor_type="user", actor_ref="certification",
    )


@pytest.fixture()
def live(request):
    """The real report, or a skip that says why.

    This case is about a REAL chart's real dimension; a mock would be asserting
    that the mock is categorical. On a machine with no seeded Olist dashboard the
    honest answer is "not run here", not a synthetic pass.
    """
    sa = pytest.importorskip("sqlalchemy")
    del sa
    try:
        from app.core.database import SessionLocal
        from app.models.models import Dashboard
    except Exception as exc:                                    # noqa: BLE001
        pytest.skip(f"backend app not importable here: {exc}")

    db = SessionLocal()
    request.addfinalizer(db.close)

    # ABSENT COMES IN TWO SHAPES, AND THE FIRST VERSION ONLY KNEW ONE.
    #
    # `db.get(Dashboard, 67) is None` is the "no such ROW" answer, and it can
    # only be given by a database that HAS the table. CI's unit tier runs on
    # `sqlite:///./ci_contract.db` — an empty file with no schema, deliberately,
    # because that tier runs no migrations — so the SELECT raised
    # `OperationalError: no such table: dashboards` before `pytest.skip` was
    # reached, and three setup ERRORS turned the whole tier red on a commit that
    # changed no product code.
    #
    # The table check goes first, because "no schema" is the shape CI actually
    # presents and a guard that cannot see it is not a guard.
    try:
        from sqlalchemy import inspect as sa_inspect

        if not sa_inspect(db.bind).has_table("dashboards"):
            pytest.skip("no `dashboards` table here — this tier runs no migrations")
    except pytest.skip.Exception:
        raise
    except Exception as exc:                                    # noqa: BLE001
        pytest.skip(f"cannot inspect the database here: {exc}")

    try:
        dash = db.get(Dashboard, 67)
    except Exception as exc:                                    # noqa: BLE001
        pytest.skip(f"dashboard lookup is not possible here: {exc}")
    if dash is None:
        pytest.skip("dashboard 67 (the Olist certification fixture) is not seeded here")
    return db, dash


def test_detect_seasonality_does_not_call_a_category_a_time_dimension(live):
    from app.services.agent_flows.tools import registry as R

    db, dash = live
    res = R.execute(_ctx(db, dash), "detect_seasonality",
                    {"chart_id": CATEGORICAL_CHART}, allowed=None)

    if res.get("ok") is not True:
        return                     # refusing is one of the two acceptable answers

    dim = str(((res.get("data") or {}).get("time_dimension") or ""))
    assert "product_category" not in dim, (
        "detect_seasonality reported a CATEGORICAL column as its `time_dimension` "
        f"({dim!r}) and tested cycles over it. analyze_trend, forecast_measure and "
        "compare_periods all refuse this same chart, so the contract is already "
        "settled elsewhere in the pack."
    )


def test_the_three_siblings_still_refuse_the_same_chart(live):
    """The control. Without it the assertion above could be satisfied by a change
    that loosened the whole pack instead of tightening one tool."""
    from app.services.agent_flows.tools import registry as R

    db, dash = live
    ctx = _ctx(db, dash)
    for tool in ("analyze_trend", "forecast_measure", "compare_periods"):
        res = R.execute(ctx, tool, {"chart_id": CATEGORICAL_CHART}, allowed=None)
        assert res.get("ok") is False, (
            f"{tool} accepted a categorical chart — the contract this file relies "
            "on has moved, and the finding needs re-stating rather than re-running"
        )


def test_seasonality_still_works_on_a_real_time_axis(live):
    """And the tightening must not cost the tool its actual job."""
    from app.services.agent_flows.tools import registry as R

    db, dash = live
    res = R.execute(_ctx(db, dash), "detect_seasonality",
                    {"chart_id": TIME_CHART}, allowed=None)
    assert res.get("ok") is True, res
    assert "year_month" in str(((res.get("data") or {}).get("time_dimension") or ""))


# ── the deterministic half, which runs in CI ────────────────────────────────
#
# The cases above need the real Olist report and skip where it is absent, which
# made the whole contract skippable. These do not: they stub the warehouse and
# exercise the axis decision itself, so the rule is enforced on every push.
#
# THE DEFECT, once it was traced: `_DATE_NAME` matched a SUBSTRING.
# `product_category_name_english` contains "nam" — the Vietnamese for year —
# inside the word "name". So a product-category column was read as a time axis,
# and `detect_seasonality` reported cycles over alphabetical order. Two more
# columns fail the same way: `product_name_lenght` ("nam" in "name") and
# `ky_thuat` ("ky" in "kythuat"). A whitelist of one Olist column would have
# fixed none of them.

DETERMINISTIC_TIME = [
    "order_date", "created_at", "year_month", "purchase_month",
    "date_dim.year_quarter", "thang_ban_hang", "nam_tai_chinh", "week_start",
]

#: NOT in the list below, and the reason is worth writing down: `ky_thuat`
#: (technique) really does carry `ky` as a whole segment, and `kỳ` means period.
#: A name-only rule cannot separate it from `ky_bao_cao` (reporting period)
#: without semantics it does not have. Asserting either answer would be asserting
#: a guess, so it is left out rather than used to bend the rule.
DETERMINISTIC_NOT_TIME = [
    "product_category_name_english",   # "nam" inside "name"
    "product_name_lenght",             # same
    "customer_state", "seller_city", "payment_type", "review_score",
    "order_status", "thanh_pho",
]


@pytest.mark.parametrize("column", DETERMINISTIC_TIME)
def test_a_real_time_column_is_recognised(column):
    from app.services.agent_flows.tools.packs.project_ahead import _DATE_NAME

    assert _DATE_NAME.search(column), (
        f"{column!r} is a time column and the axis detector no longer sees it — "
        "tightening the rule must not cost the tool its actual job"
    )


@pytest.mark.parametrize("column", DETERMINISTIC_NOT_TIME)
def test_a_column_that_merely_contains_a_time_word_is_not_a_time_axis(column):
    from app.services.agent_flows.tools.packs.project_ahead import _DATE_NAME

    assert not _DATE_NAME.search(column), (
        f"{column!r} was read as a time axis. This is the substring bug: 'nam' "
        "lives inside 'name' and 'ky' inside 'kythuat', so a product-category "
        "column became a `time_dimension` and seasonality was reported over "
        "alphabetical order."
    )


def test_seasonality_refuses_a_categorical_chart_end_to_end(monkeypatch):
    """The axis rule is necessary; this proves it is also sufficient — the tool
    refuses rather than inventing a `time_dimension`."""
    from app.services.agent_flows.tools.packs import project_ahead as P

    monkeypatch.setattr(P, "_fetch_chart_data", lambda ctx, cid, **kw: {
        "columns": ["product_category_name_english", "revenue"],
        "rows": [[f"cat_{i}", 100.0 + i] for i in range(30)],
    })

    class Ctx:
        chart_meta: dict = {}

        def assert_chart_in_scope(self, chart_id):
            return None

    res = P.tool_detect_seasonality(Ctx(), {"chart_id": 1})
    assert res.get("ok") is False, (
        f"a categorical chart produced a seasonality result: {res}"
    )
    assert "time axis" in str(res.get("error", "")).lower()


def test_seasonality_still_runs_on_a_stubbed_time_series(monkeypatch):
    from app.services.agent_flows.tools.packs import project_ahead as P

    monkeypatch.setattr(P, "_fetch_chart_data", lambda ctx, cid, **kw: {
        "columns": ["year_month", "revenue"],
        "rows": [[f"2024-{m:02d}", 1000.0 + (m % 4) * 300] for m in range(1, 13)]
              + [[f"2025-{m:02d}", 1100.0 + (m % 4) * 300] for m in range(1, 13)],
    })

    class Ctx:
        chart_meta: dict = {}

        def assert_chart_in_scope(self, chart_id):
            return None

    res = P.tool_detect_seasonality(Ctx(), {"chart_id": 1})
    assert res.get("ok") is True, res
    assert res["data"]["time_dimension"] == "year_month"


# ── one definition, not three ───────────────────────────────────────────────
#
# THE SECOND HALF OF THE SAME DEFECT, found by review after the fix above landed.
#
# The segment rule was applied to `project_ahead` alone. `coverage` — which
# decides which column a report's date range is read from, and which charts to
# try first — kept its own substring copy. Measured side by side, the two had
# drifted apart in BOTH directions at once:
#
#     product_category_name_english   coverage=MATCH   project_ahead=-
#     year_month                      coverage=-       project_ahead=MATCH
#     product_name_lenght             coverage=MATCH   project_ahead=-
#
# `coverage` still had the "nam"-inside-"name" bug AND had never learned
# `month|quarter|week|year`, so it did not recognise the commonest month column
# in the reports it scans. Two answers to one question is the defect; these cases
# hold them to one.

ALL_CORPUS = DETERMINISTIC_TIME + DETERMINISTIC_NOT_TIME


@pytest.mark.parametrize("column", ALL_CORPUS)
def test_coverage_and_seasonality_classify_a_name_identically(column):
    from app.services.agent_flows.tools.packs.coverage import _DATE_NAME as COV
    from app.services.agent_flows.tools.packs.project_ahead import _DATE_NAME as SEA

    assert bool(COV.search(column)) == bool(SEA.search(column)), (
        f"{column!r}: the date-range tool and the seasonality tool disagree about "
        "whether this is a time field. A report readable by one would not be "
        "readable by the other."
    )


def test_they_are_the_same_definition_and_not_two_that_happen_to_agree():
    """Agreement reached by coincidence drifts again on the next edit."""
    from app.services.agent_flows.tools.packs import coverage, project_ahead
    from app.services.time_semantics import TIME_NAME_RX

    assert coverage._DATE_NAME is TIME_NAME_RX
    assert project_ahead._DATE_NAME is TIME_NAME_RX


def test_coverage_no_longer_reads_a_product_category_as_its_date_column():
    """The name half of the regression, at the function that uses it."""
    from app.services.agent_flows.tools.packs.coverage import _date_column

    columns = ["product_category_name_english", "revenue"]
    rows = [[f"cat_{i}", 100.0 + i] for i in range(20)]
    assert _date_column(columns, rows) is None


def test_coverage_now_recognises_year_month_which_its_old_rule_missed():
    from app.services.agent_flows.tools.packs.coverage import _date_column

    columns = ["year_month", "revenue"]
    rows = [[f"2018-{m:02d}", 100.0 + m] for m in range(1, 11)]
    assert _date_column(columns, rows) == 0


def test_the_stronger_value_parsing_is_untouched():
    """The name rule is a hint; coverage's own date parsing still has the final
    say, and tightening the hint must not have cost it."""
    from datetime import date

    from app.services.agent_flows.tools.packs.coverage import _as_date, _date_column

    assert _as_date("2018-10-17") == date(2018, 10, 17)
    assert _as_date("2018-10-17T03:22:00") == date(2018, 10, 17)
    assert _as_date("2018-10") == date(2018, 10, 1)
    assert _as_date("17/10/2018") == date(2018, 10, 17)
    assert _as_date(2016) == date(2016, 1, 1)
    assert _as_date("health_beauty") is None

    # A column whose NAME says nothing but whose values are dates is still found.
    columns = ["key", "revenue"]
    rows = [[f"2018-{m:02d}", 100.0 + m] for m in range(1, 11)]
    assert _date_column(columns, rows) == 0
