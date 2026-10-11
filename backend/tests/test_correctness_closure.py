# -*- coding: utf-8 -*-
"""Closure of the four reported ways a run said `ok` while the answer was wrong.

  P0-1  GMV attributed a product-revenue figure. The question named BOTH GMV and
        product revenue, and the claim check only asked "is this figure's measure
        one the QUESTION asked for?" — revenue was, so "GMV toàn kỳ là
        13,591,643.70" passed in every architecture (committed live eval).
  P0-2  An undeclared ARR series could be summed across periods: `across_periods`
        switched the guard off, `period="2026"` skipped it, a chart's own `agg:
        sum` counted as a declaration, and `aggregate_chart_data` summed it
        through another door.
  P0-3  A deterministic writer quoted a KPI that sums a monthly balance (ARR
        5,244 over all months) beside a comparison it could not make.

Each case is the shape that was published, run through the real check/tool code.
"""
from __future__ import annotations

import copy
import os
import sys

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_correctness_closure.db")
os.environ.setdefault("DATA_DIR", ".testdata")
sys.path.insert(0, os.path.dirname(__file__))

import pytest  # noqa: E402

from test_claims_mean_what_was_asked import KPI, _rec, _why, world  # noqa: E402,F401
from test_requested_dimension_is_not_substituted import undeclared  # noqa: E402,F401
from app.services.agent_flows.tools.context import extract_chart_field_semantics  # noqa: E402
from app.services.agent_flows.tools.packs import derived as DER  # noqa: E402
from app.services.agent_flows.tools.packs import measure_meta  # noqa: E402
from app.services.dashboard_ai_bot.thinking import advanced_tools as ADV  # noqa: E402

Q3 = "Theo tài liệu, GMV khác doanh thu sản phẩm ở điểm nào, và trên báo cáo GMV toàn kỳ là bao nhiêu?"


# ── P0-1: a figure belongs to the measure its clause names ──────────────────
def test_product_revenue_published_as_gmv_is_flagged_even_when_both_are_asked(world):
    ctx, state = world(Q3, asked=("total_revenue", "gmv"))
    _rec(state, "total_measure", DER.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    assert (13591643.7, "other_measure") in _why(state, ctx, "Theo báo cáo, GMV toàn kỳ là 13,591,643.70.")


@pytest.mark.parametrize("text", [
    "Doanh thu sản phẩm toàn kỳ là 13,591,643.70.",
    "Doanh thu toàn kỳ là 13,591,643.70.",
])
def test_the_same_figure_given_to_its_own_measure_passes(world, text):
    ctx, state = world(Q3, asked=("total_revenue", "gmv"))
    _rec(state, "total_measure", DER.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    assert _why(state, ctx, text) == []


def test_a_clause_naming_no_measure_is_not_judged_by_this_rule(world):
    ctx, state = world("Tổng doanh thu là bao nhiêu?")
    _rec(state, "total_measure", DER.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    assert _why(state, ctx, "Con số là 13,591,643.70.") == []


# ── P0-2: no supported argument sums an undeclared series over time ─────────
MONTHS = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01",
          "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"]
ARR = [600, 660, 696, 720, 792, 840, 864, 72]
CHURN = [3, 2, 4, 1, 5, 2, 3, 40]
PLAN = [101, 101, 102, 102, 103, 103, 104, 104]
TYPES = {"year_month": "date", "arr_active": "numeric", "cus_churned": "integer", "plan_code": "integer"}


class Ctx:
    allowed_chart_ids = {1}
    db = None

    def __init__(self, fields):
        self.chart_meta = {1: {"name": "SaaS", "fields": fields}}

    def assert_chart_in_scope(self, chart_id):
        return None


@pytest.fixture()
def saas(monkeypatch):
    data = {"columns": ["year_month", "arr_active", "cus_churned", "plan_code"],
            "rows": [list(r) for r in zip(MONTHS, ARR, CHURN, PLAN)], "filters_applied": []}
    for module in (DER, ADV):
        monkeypatch.setattr(module, "_fetch_chart_data", lambda ctx, cid, **kw: copy.deepcopy(data),
                            raising=False)
    monkeypatch.setattr(ADV, "_attach_delta_unit", lambda ctx, cid, m, p: p, raising=False)
    measure_meta.clear_cache()
    cfg = {"chartType": "TABLE", "roleConfig": {"metrics": [], "selectedColumns": list(TYPES)}}
    return Ctx(extract_chart_field_semantics(cfg, TYPES))


def _declare(monkeypatch, **by_measure):
    """The semantic model's measure definitions (what `describe_measure` reads)."""
    def describe(ctx, cid, m):
        leaf = str(m).split(".")[-1]
        d = by_measure.get(leaf)
        if d is None:
            return {"measure": m, "agg": None, "unit": None, "unit_known": False, "additive": True,
                    "declared": False, "format_kind": None}
        return {"measure": m, "agg": d.get("type", "sum"), "unit": None, "unit_known": False,
                "additive": True, "declared": True, "format_kind": None,
                "semantic_measure": True, "time_aggregation": d.get("time_aggregation")}
    monkeypatch.setattr(measure_meta, "describe_measure", describe)


@pytest.mark.parametrize("args", [
    {"measure": "arr_active", "across_periods": True},                                  # the old switch
    {"measure": "arr_active", "across_periods": True, "period_from": "2026-01", "period_to": "2026-08"},
    {"measure": "arr_active", "period": "2026"},                                         # coarser period
    {"measure": "arr_active", "period_from": "2026-07", "period_to": "2026-08"},
])
def test_an_undeclared_series_is_never_summed_across_periods(saas, args):
    got = DER.tool_total_measure(saas, {"chart_id": 1, **args})
    assert got["ok"] is False and got["error_code"] == "time_aggregation_ambiguous", got


def test_a_charts_own_sum_is_not_a_declaration_of_additivity_over_time(saas, monkeypatch):
    """`agg: sum` on a monthly ARR line is how each month adds up, not a claim
    that ARR adds across months."""
    saas.chart_meta[1]["fields"]["measures"] = [{"field": "arr_active", "agg": "sum"}]
    got = DER.tool_total_measure(saas, {"chart_id": 1, "measure": "arr_active", "period": "2026"})
    assert got["ok"] is False and got["error_code"] == "time_aggregation_ambiguous", got


def test_a_semantic_sum_is_summed_over_the_range_and_says_how_many_periods(saas, monkeypatch):
    _declare(monkeypatch, cus_churned={"type": "sum"})
    got = DER.tool_total_measure(saas, {"chart_id": 1, "measure": "cus_churned",
                                        "period_from": "2026-01", "period_to": "2026-08"})
    assert got["ok"] is True, got
    assert got["data"]["value"] == 60 and got["data"]["summed_across_periods"] == 8
    year = DER.tool_total_measure(saas, {"chart_id": 1, "measure": "cus_churned", "period": "2026"})
    assert year["data"]["value"] == 60


def test_a_balance_declared_as_such_is_never_summed(saas, monkeypatch):
    _declare(monkeypatch, arr_active={"type": "sum", "time_aggregation": "last"})
    got = DER.tool_total_measure(saas, {"chart_id": 1, "measure": "arr_active", "period": "2026"})
    assert got["ok"] is False and got["error_code"] == "time_aggregation_ambiguous", got
    one = DER.tool_total_measure(saas, {"chart_id": 1, "measure": "arr_active", "period": "2026-08"})
    assert one["data"]["value"] == 72, "one period is still answered"


def test_aggregate_chart_data_cannot_sum_a_balance_across_months(saas):
    got = ADV.tool_aggregate_chart_data(saas, {"chart_id": 1, "group_by": ["plan_code"],
                                               "aggregations": [{"column": "arr_active", "op": "sum"}]})
    assert got["ok"] is False and got.get("error_code") == "time_aggregation_ambiguous", got


def test_aggregate_by_month_keeps_each_month_and_withholds_the_cross_month_total(saas):
    got = ADV.tool_aggregate_chart_data(saas, {"chart_id": 1, "group_by": ["year_month"],
                                               "aggregations": [{"column": "arr_active", "op": "sum"}]})
    assert got["ok"] is True, got
    by_month = {r["year_month"]: r["sum_arr_active"] for r in got["data"]["rows"]}
    assert by_month["2026-08-01"] == 72 and by_month["2026-07-01"] == 864
    assert got["data"]["totals"]["sum_arr_active"] is None
    assert "sum_arr_active" in got["data"]["totals"]["withheld"]


def test_aggregate_of_a_semantic_sum_still_totals(saas, monkeypatch):
    _declare(monkeypatch, cus_churned={"type": "sum"})
    got = ADV.tool_aggregate_chart_data(saas, {"chart_id": 1, "group_by": ["plan_code"],
                                               "aggregations": [{"column": "cus_churned", "op": "sum"}]})
    assert got["ok"] is True and got["data"]["totals"]["sum_cus_churned"] == 60


def test_the_contract_no_longer_offers_a_caller_side_switch():
    props = DER.TOTAL_MEASURE_DEF["input_schema"]["properties"]
    assert "across_periods" not in props and {"period", "period_from", "period_to"} <= set(props)


# ── P0-3: a whole-range sum of a balance is not a figure ────────────────────
def test_a_kpi_that_sums_a_balance_over_all_months_is_flagged_however_framed(world, monkeypatch):
    ctx, state = world("So sánh ARR tháng 8/2026 với tháng 7/2026.", asked=("arr_active",))
    ctx.chart_meta[KPI] = {"name": "ARR (cộng dồn mọi kỳ)",
                           "fields": {"measures": [{"field": "arr_active", "agg": "sum"}], "dimensions": []}}
    monkeypatch.setattr(DER, "_fetch_chart_data", lambda c, cid, **kw: {
        "columns": ["arr_active"], "rows": [[5244]], "filters_applied": []})
    _declare(monkeypatch, arr_active={"type": "sum", "time_aggregation": "last"})
    _rec(state, "total_measure", DER.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    text = ("Dữ liệu không cho ARR riêng tháng 7 và 8, nên không so sánh được. "
            "Tổng ARR từ tất cả các tháng là 5244.")
    assert (5244.0, "aggregation_unsafe") in _why(state, ctx, text)


def test_an_all_time_revenue_total_framed_as_such_stays_allowed(world):
    """The existing contract is kept: an additive measure's overall total, honestly
    framed, is not a period claim (test_claims_mean_what_was_asked)."""
    ctx, state = world("Doanh thu quý 4/2017 là bao nhiêu?")
    _rec(state, "total_measure", DER.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    text = "Báo cáo không tách theo quý; tổng doanh thu toàn bộ báo cáo là 13,591,643.7."
    assert _why(state, ctx, text) == []


# ── P1: the false "no monthly data" (H1) ────────────────────────────────────
@pytest.mark.parametrize("word", ["month", "tháng", "monthly"])
def test_a_time_grain_word_names_the_time_axis(word):
    """Live H1: after reading the Jan-Aug churn total (60) from chart 1218, the agent
    asked resolve_chart_candidates for churn by "month"; `year_month` did not match
    "month" and the tool said no chart breaks churn down by month."""
    from app.services.agent_flows.tools.packs.discover import _field_matches

    assert _field_matches(word, [{"field": "year_month", "time": True}])
    assert _field_matches(word, ["dataset_table_687.year_month"])
    assert not _field_matches(word, [{"field": "plan_code"}])


def test_a_range_total_over_exactly_the_asked_months_is_not_a_wrong_period():
    from app.services.agent_flows.runtime import claim_check as CC

    asked = {("m", 2026, 1), ("m", 2026, 8)}
    exact = [{"value": 60.0, "measure": "cus_churned", "period_range": ["2026-01-01", "2026-08-01"]}]
    narrower = [{"value": 43.0, "measure": "cus_churned", "period_range": ["2026-07-01", "2026-08-01"]}]
    wider = [{"value": 61.0, "measure": "cus_churned", "period_range": ["2025-12-01", "2026-08-01"]}]
    q = "Tổng số khách hàng rời bỏ từ tháng 1 đến tháng 8 năm 2026 là bao nhiêu?"
    assert CC._wrong_period(exact, asked, "tong so khach roi bo la 60", q) is False
    assert CC._wrong_period(narrower, asked, "tong so khach roi bo la 43", q) is True
    assert CC._wrong_period(wider, asked, "tong so khach roi bo la 61", q) is True


def test_a_range_read_carries_its_span_into_the_claim_ledger():
    from app.services.agent_flows.runtime import claim_scope

    res = {"ok": True, "data": {"chart_id": 1218, "measure": "cus_churned", "value": 60.0,
                                "periods_covered": {"selected": [f"2026-0{m}-01" for m in range(1, 9)]}}}
    out = claim_scope.describe("total_measure", res)
    assert out and out[0]["period_range"] == ["2026-01-01", "2026-08-01"] and out[0]["chart_id"] == 1218


# ── P0 (found in the live re-run): one period is not a total, and "latest" means the data's last
def _timed(value, member, last="2026-08-01"):
    return [{"value": value, "measure": "arr_active", "dimension": "__time__", "member": member,
             "series_last": last}]


def test_one_month_is_not_the_total_the_question_asks_for():
    """Live (specialist chain): the tool refused the cross-month ARR sum, and the
    writer published August's 72 as "Tổng ARR cộng dồn của 8 tháng đầu năm 2026"."""
    from app.services.agent_flows.runtime import claim_check as CC

    q = "Tổng ARR cộng dồn của 8 tháng đầu năm 2026 là bao nhiêu?"
    assert CC._wrong_period(_timed(72.0, "2026-08"), CC._periods(q), "tong arr cong don la 72", q) is True
    # Without a total word, a month inside the year stays allowed (the lowest month of 2017).
    q2 = "ARR thấp nhất trong năm 2026 là tháng nào?"
    assert CC._wrong_period(_timed(72.0, "2026-08"), CC._periods(q2), "thap nhat la 72", q2) is False


def test_the_latest_month_must_be_the_series_last(world):
    """Live H2: "ARR ở tháng gần nhất ... là 864 (2026-07)" while the data runs to 2026-08."""
    from app.services.agent_flows.runtime import claim_check as CC

    assert CC._asks_latest("ARR ở tháng gần nhất có dữ liệu là bao nhiêu?")
    assert CC._not_the_latest(_timed(864.0, "2026-07")[0]) is True
    assert CC._not_the_latest(_timed(72.0, "2026-08")[0]) is False


def test_a_one_period_read_carries_the_series_last_into_the_ledger():
    from app.services.agent_flows.runtime import claim_scope

    res = {"ok": True, "data": {"chart_id": 1218, "measure": "arr_active", "value": 864.0, "period": "2026-07",
                                "periods_covered": {"first": "2026-01-01", "last": "2026-08-01", "count": 8,
                                                    "selected": ["2026-07-01"]}}}
    out = claim_scope.describe("total_measure", res)
    assert out[0]["member"] == "2026-07" and out[0]["series_last"] == "2026-08-01"


def test_one_month_as_a_total_is_caught_even_when_the_read_is_described_twice():
    """Live: the same total_measure(period=2026-08) result was ALSO described as a
    `year_month` figure with no member; that mixed reading took the early exit
    and the 72-as-8-month-total was published."""
    from app.services.agent_flows.runtime import claim_check as CC

    q = "Tổng ARR cộng dồn của 8 tháng đầu năm 2026 là bao nhiêu?"
    support = [{"value": 72.0, "measure": "arr_active", "dimension": "__time__", "member": "2026-08", "ref": "e1"},
               {"value": 72.0, "measure": "arr_active", "dimension": "year_month", "member": None, "ref": "e1"}]
    assert CC._wrong_period(support, CC._periods(q), "tong arr cong don la 72", q) is True
