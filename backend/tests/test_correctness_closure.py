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
import json
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


# ── found in live round 5 ───────────────────────────────────────────────────
def test_the_measure_named_earlier_in_the_sentence_owns_the_figure(world):
    """"Về giá trị GMV toàn kỳ, theo báo cáo, nó là 13,591,643.70" — the clause
    around the number is "nó là …"; GMV is named earlier in the sentence."""
    ctx, state = world(Q3, asked=("total_revenue", "gmv"))
    _rec(state, "total_measure", DER.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    text = "Về giá trị GMV toàn kỳ, theo báo cáo, nó là 13,591,643.70."
    assert (13591643.7, "other_measure") in _why(state, ctx, text)


def test_a_whole_given_to_a_named_member_is_flagged():
    """"ARR của phân khúc enterprise là 6500" — the segments' total, while the same
    read holds enterprise's own 5000 (deterministic hybrid, round 5)."""
    from types import SimpleNamespace
    from app.services.agent_flows.runtime import claim_check as CC
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    state.claim_ledger = [
        {"value": 6500.0, "measure": "arr_active", "dimension": None, "member": None, "ref": "e1", "chart_id": 1221},
        {"value": 5000.0, "measure": "arr_active", "dimension": "segment", "member": "enterprise", "ref": "e1"},
        {"value": 1200.0, "measure": "arr_active", "dimension": "segment", "member": "smb", "ref": "e1"},
    ]
    state.evidence = [6500.0, 5000.0, 1200.0]
    ctx = SimpleNamespace(question="ARR của phân khúc enterprise là bao nhiêu?", chart_meta={},
                          allowed_chart_ids=set(), db=None)
    got = CC.check(state, ctx, "ARR của phân khúc enterprise là 6500.0.")
    assert any(f["why"] == "whole_as_member" and f["value"] == 6500.0 for f in got["flagged"]), got
    ok = CC.check(state, ctx, "ARR của phân khúc enterprise là 5000.")
    assert not ok.get("flagged"), ok
    framed = CC.check(state, ctx, "Không có số riêng của enterprise; tổng ARR mọi phân khúc là 6500.")
    assert not any(f["value"] == 6500.0 for f in framed.get("flagged") or []), framed


@pytest.mark.parametrize("text, value", [("ARR là 6500.0.", 6500.0), ("Tổng là 5244.0 (đơn vị)", 5244.0),
                                         ("giá 1234.56", 1234.56)])
def test_a_four_digit_figure_with_decimals_is_a_figure_not_a_period(text, value):
    """The period-label strip read every `dddd.d` as year.month: "6500.0" was never
    extracted, so the whole-as-member ARR answer went unchecked (live round 5)."""
    from app.services.dashboard_ai_bot.verifier import extract_answer_claims

    assert (value, False) in extract_answer_claims(text)


@pytest.mark.parametrize("text", ["so với 2026-07 và 2026/08", "tháng 2018-08", "năm 2017"])
def test_a_real_period_label_is_still_not_a_figure(text):
    from app.services.dashboard_ai_bot.verifier import extract_answer_claims

    assert extract_answer_claims(text) == []


# ── found in live round 6: a share of a balance summed over months ──────────
def test_no_share_of_a_balance_summed_across_months(saas):
    """"MRR tháng 6/2026 là 70 và chiếm 16.02% tổng MRR" — 70 / (MRR summed over
    eight months). Grouped by period, a non-time-additive measure has no total and
    no share; the value and rank still stand."""
    got = DER.tool_share_of(saas, {"chart_id": 1, "measure": "arr_active", "dimension": "year_month",
                                   "item": "2026-08-01"})
    assert got["ok"] is True and got["data"]["value"] == 72
    assert got["data"]["share_pct"] is None and "periods" in got["data"]["share_note"]
    ranked = DER.tool_rank_values(saas, {"chart_id": 1, "measure": "arr_active", "dimension": "year_month"})
    assert ranked["data"]["total"] is None and all("share_pct" not in i for i in ranked["data"]["items"])


def test_a_semantic_sum_keeps_its_share_across_months(saas, monkeypatch):
    _declare(monkeypatch, cus_churned={"type": "sum"})
    got = DER.tool_share_of(saas, {"chart_id": 1, "measure": "cus_churned", "dimension": "year_month",
                                   "item": "2026-08-01"})
    assert got["data"]["share_pct"] == round(40 / 60 * 100, 2)


# ── found in live round 7: the hybrid read nothing for "ARR tháng 8 năm 2026" ──
from app.services.agent_flows import resolver as RS


def _resolver_call(assets, candidates_by_args):
    seen: list[dict] = []

    def call(name, args):
        seen.append({"name": name, "args": dict(args or {})})
        if name == "list_charts":
            return {"ok": True, "data": {"selection": {"status": "ambiguous",
                                                       "selected_ids": [1218, 1219, 1220, 1221]}}}
        if name == "search_business_assets":
            return {"ok": True, "data": {"results": assets}}
        if name == "resolve_chart_candidates":
            key = (args.get("measure") or args.get("metric") or "", args.get("dimension") or "")
            return {"ok": True, "data": {"candidates": candidates_by_args.get(key, [])}}
        return {"ok": False}

    call.seen = seen                                          # type: ignore[attr-defined]
    return call


ARR_ASSETS = [{"type": "field", "field_kind": "measure", "id": "arr_active", "name": "ARR",
               "detail": "arr"}]
ARR_BY_MEASURE = [{"chart_id": c, "match": "measure"} for c in (1219, 1220, 1221)]


def test_a_measure_named_in_one_word_beside_a_period_is_not_dropped():
    """Live round 7: every SaaS chart shares the word ARR, so the name match is
    ambiguous, and the vocabulary pass dropped `arr_active` as weak — one of seven
    terms, six of them "tháng 8 năm 2026 là bao nhiêu". The hybrid writer then got
    no chart and said the data did not exist."""
    call = _resolver_call(ARR_ASSETS, {("arr_active", "thang"): [{"chart_id": 1219, "match": "both"}],
                                       ("arr_active", ""): ARR_BY_MEASURE})
    got = RS.resolve_charts("ARR tháng 8 năm 2026 là bao nhiêu?", [1218, 1219, 1220, 1221], call=call)
    assert got["status"] == "semantic" and got["chart_ids"] == [1219], got


def test_a_named_grain_without_a_time_chart_falls_back_to_the_measure():
    call = _resolver_call(ARR_ASSETS, {("arr_active", ""): ARR_BY_MEASURE})
    got = RS.resolve_charts("ARR tháng 8 năm 2026 là bao nhiêu?", [1219, 1220, 1221], call=call)
    assert got["status"] == "semantic" and got["chart_ids"] == [1219, 1220, 1221], got


def test_a_period_word_alone_is_not_a_match():
    """The weather guard holds: an asset sharing only a period word ("tháng") with
    an unrelated question is still not a match."""
    assets = [{"type": "field", "field_kind": "measure", "id": "revenue_month",
               "name": "Doanh thu tháng", "detail": "doanh thu thang"}]
    call = _resolver_call(assets, {("revenue_month", ""): [{"chart_id": 1219, "match": "measure"}],
                                   ("revenue_month", "thang"): [{"chart_id": 1219, "match": "both"}]})
    got = RS.resolve_charts("thời tiết tháng 8", [1219], call=call)
    assert got["chart_ids"] == [], got


SAAS_LABELS = {1218: ["Mrr active", "Arr active", "Cus churned"], 1219: ["Arr active"],
               1220: ["Arr active"], 1221: ["Arr active"]}


def _unvocabularied_call(candidates_by_args, ids=(1218, 1219, 1220, 1221)):
    """A report with NO declared vocabulary — the live SaaS fixture: search finds
    only charts, and `list_charts` is ambiguous on a shared word."""
    seen: list[dict] = []

    def call(name, args):
        seen.append({"name": name, "args": dict(args or {})})
        if name == "list_charts":
            return {"ok": True, "data": {
                "charts": [{"chart_id": c, "measures": SAAS_LABELS[c]} for c in ids],
                "selection": {"status": "ambiguous", "selected_ids": list(ids)}}}
        if name == "search_business_assets":
            return {"ok": True, "data": {"results": [{"type": "chart", "id": c} for c in ids]}}
        if name == "resolve_chart_candidates":
            key = (args.get("measure") or "", args.get("dimension") or "")
            return {"ok": True, "data": {"candidates": candidates_by_args.get(key, [])}}
        return {"ok": False}

    call.seen = seen                                          # type: ignore[attr-defined]
    return call


ARR_LABEL_CANDS = {("Arr active", "thang"): [{"chart_id": 1218, "match": "both"},
                                             {"chart_id": 1219, "match": "both"},
                                             {"chart_id": 1220, "match": "measure"}],
                   ("Arr active", ""): [{"chart_id": c, "match": "measure"} for c in (1218, 1219, 1220, 1221)]}


def test_without_vocabulary_the_on_screen_measure_label_narrows_the_read():
    got = RS.resolve_charts("ARR tháng 8 năm 2026 là bao nhiêu?", [1218, 1219, 1220, 1221],
                            call=_unvocabularied_call(ARR_LABEL_CANDS))
    assert got["status"] == "semantic" and got["chart_ids"] == [1218, 1219], got


def test_two_named_measures_stay_ambiguous():
    got = RS.resolve_charts("ARR và MRR tháng 8", [1218, 1219, 1220, 1221],
                            call=_unvocabularied_call(ARR_LABEL_CANDS))
    assert got["status"] == "ambiguous" and got["chart_ids"] == [], got


def test_no_translation_without_vocabulary():
    """"khách hàng rời bỏ" never reaches "Cus churned" without governed
    vocabulary — the resolver does not guess across languages."""
    got = RS.resolve_charts("Có bao nhiêu khách hàng rời bỏ trong tháng 8/2026?", [1218, 1219],
                            call=_unvocabularied_call({}, ids=(1218, 1219)))
    assert got["status"] == "ambiguous" and got["chart_ids"] == [], got


# ── found in live round 7: the writer's handoff kept the 5244 total, not the rows ──
def _read_entry(cid, rows, columns, measure):
    from app.services.agent_flows.runtime.handlers import data as D

    stats = [{"name": "arr_active", "kind": "number", "total": 5244.0, "min": 72.0, "max": 864.0,
              "avg": 655.5, "distinct": 8, "top_values": [[864, 1]] * 8},
             {"name": "year_month", "kind": "datetime", "distinct": 8, "top_values": [["2026-01-01", 1]] * 8}]
    e = {"chart_id": cid, "title": f"chart {cid}",
         "summary": {"ok": True, "data": {"chart_name": f"chart {cid}", "chart_type": "LINE",
                                          "total_rows": len(rows), "columns": stats}},
         "data": {"ok": True, "data": {"chart_id": cid, "columns": columns, "rows": rows,
                                       "row_count": len(rows),
                                       "coverage": {"returned": len(rows), "total": len(rows),
                                                    "truncated": False}}},
         "rows_ordered_by": measure}
    D._compact(e)
    return e


ARR_ROWS = [["2026-07-01", 864], ["2026-06-01", 840], ["2026-05-01", 792], ["2026-04-01", 720],
            ["2026-03-01", 696], ["2026-02-01", 660], ["2026-01-01", 600], ["2026-08-01", 72]]


def test_a_complete_read_hands_over_its_rows_not_a_cross_period_total():
    e = _read_entry(1219, ARR_ROWS, ["year_month", "arr_active"], "arr_active")
    assert "summary" not in e and e["data"]["data"]["rows"] == ARR_ROWS
    assert e["read_status"] == "ok"
    assert "5244" not in json.dumps(e)


def test_a_partial_read_keeps_the_stats_the_rows_cannot_give():
    e = _read_entry(686, ARR_ROWS[:5], ["year_month", "arr_active"], "arr_active")
    e2 = _read_entry(686, ARR_ROWS, ["year_month", "arr_active"], "arr_active")
    from app.services.agent_flows.runtime.handlers import data as D
    raw = {"chart_id": 686, "summary": {"ok": True, "data": {"chart_name": "c", "total_rows": 72,
           "columns": [{"name": "revenue", "kind": "number", "total": 13591643.7}]}},
           "data": {"ok": True, "data": {"rows": [["a", 1]] * 50, "coverage": {"returned": 50, "total": 72,
                                                                              "truncated": True}}}}
    D._compact(raw)
    assert raw["summary"]["columns"][0]["total"] == 13591643.7
    assert e and e2


def test_a_refused_chart_states_its_reason_once():
    from app.services.agent_flows.runtime.handlers import data as D

    for err in ({"ok": False, "error": "biểu đồ 1220 cho số của TOÀN BỘ thời gian", "error_code": "period_not_in_chart"},
                {"ok": False, "error": "failed to load chart 1220: DataError"}):
        before = {"chart_id": 1220, "summary": dict(err), "data": dict(err)}
        e = copy.deepcopy(before)
        D._compact(e)
        assert "summary" not in e and e["data"] == err
        # The verdict and its reason are unchanged by saying it once.
        assert D._failure_reasons([e]) == D._failure_reasons([before])
        assert not D._entry_has_data(e)


def test_the_s2_handoff_carries_july_and_august():
    """The live shape: two readable monthly charts, two refused all-period charts,
    and a long knowledge step sharing the 8,000-character handoff."""
    from app.services.agent_flows.runtime.context import StepView, compile_context
    from app.services.agent_flows.runtime.handlers import data as D
    from app.services.agent_flows.runtime.state import render_value

    err = {"ok": False, "error": "biểu đồ cho số của TOÀN BỘ thời gian, còn câu hỏi hỏi về một kỳ cụ thể — "
                                 "con số này không phải số của kỳ được hỏi.",
           "error_code": "period_not_in_chart", "retryable": False,
           "recovery": "Các biểu đồ trong phạm vi cho cùng số đo theo từng kỳ: 1218; 1219. Gọi lại với một trong các biểu đồ đó."}
    refused = []
    for cid in (1220, 1221):
        r = {"chart_id": cid, "summary": dict(err), "data": dict(err)}
        D._compact(r)
        refused.append(r)
    doc = {"scope": {"read": 4, "available": 4},
           "charts": [_read_entry(1218, [[r[1], r[0], 104] for r in ARR_ROWS], ["arr_active", "year_month", "plan_code"], "arr_active"),
                      _read_entry(1219, ARR_ROWS, ["year_month", "arr_active"], "arr_active"), *refused],
           "read_ok": True}
    knowledge = json.dumps({"results": [{"content": "x " * 2500}]})
    p = compile_context([StepView("doc", "doc", render_value(doc)), StepView("k", "k", knowledge)], 8000)
    assert "doc" in p.included, p.coverage
    assert '"2026-08-01", 72' in p.text and '"2026-07-01", 864' in p.text
    assert "5244" not in p.text


def test_the_reducer_drops_whole_rows_never_cells_or_header_names():
    """Live round 7 handed the writer `[864, "… (4 mục nữa đã lược)"]` under a
    header cut to `["arr_active", "…"]`: values that no longer say which column
    they are. At every budget, a row and a header stay whole; whole rows go."""
    from app.services.agent_flows.runtime.context import _reduce

    header = ["arr_active", "cus_churned", "mrr_active", "plan_code", "year_month"]
    rows = [[800 + i, i, 60 + i, 101, f"2026-{i + 1:02d}-01"] for i in range(40)]
    doc = {"charts": [
        {"chart_id": 1218, "title": "SaaS theo thang",
         "summary": {"columns": [{"name": h, "kind": "number"} for h in header]},
         "data": {"ok": True, "data": {"columns": header, "rows": rows}}},
        {"chart_id": 1219, "data": {"ok": True, "data": {"columns": header[:2], "rows": [r[:2] for r in rows]}}}]}
    for budget in range(300, 2600, 50):
        text, _ = _reduce(json.dumps(doc), budget)
        for chart in json.loads(text).get("charts", []):
            inner = (chart.get("data") or {}).get("data") if isinstance(chart, dict) and isinstance(chart.get("data"), dict) else None
            if not isinstance(inner, dict):
                continue
            cols = inner.get("columns")
            assert not (isinstance(cols, list) and any(str(c).startswith("…") for c in cols)), (budget, cols)
            for row in inner.get("rows") if isinstance(inner.get("rows"), list) else []:
                assert not (isinstance(row, list) and any(str(c).startswith("… (") for c in row)), (budget, row)


def test_read_bookkeeping_goes_figures_and_coverage_stay():
    from app.services.agent_flows.runtime.handlers import data as D

    cov = {"returned": 3, "total": 3, "truncated": False, "capped_by_policy": {"asked_for": 200, "allowed": 50}}
    part = {"ok": True, "data": {"columns": ["segment", "arr_active"], "rows": [["enterprise", 5000]],
                                 "coverage": dict(cov), "filters_applied": []},
            "coverage": dict(cov)}
    D._drop_read_bookkeeping(part)
    assert part["data"]["rows"] == [["enterprise", 5000]]
    assert part["data"]["coverage"] == {"returned": 3, "total": 3, "truncated": False}
    assert "coverage" not in part and "filters_applied" not in part["data"]


def test_the_h3_handoff_keeps_the_top_categories():
    """Live round 7 (H3): a 72-category chart read top-50, three one-row KPIs and
    the filter block, beside a long knowledge step. Every category row was pruned
    and the writer could not name the second-highest category."""
    from app.services.agent_flows.runtime.context import StepView, compile_context
    from app.services.agent_flows.runtime.handlers import data as D
    from app.services.agent_flows.runtime.state import render_value

    cats = [[1258681.34 - i * 20000, f"category_{i:02d}"] for i in range(50)]
    cat = {"chart_id": 686, "title": "Olist · Doanh thu theo danh mục · page-1",
           "summary": {"ok": True, "data": {"chart_name": "c", "total_rows": 72, "columns": [
               {"name": "dataset_table_438.total_revenue", "kind": "number", "total": 13591643.7}]}},
           "data": {"ok": True, "data": {"chart_id": 686, "columns": ["revenue", "category"], "rows": cats,
                                         "row_count": 50, "coverage": {"returned": 50, "total": 72, "truncated": True,
                                                                      "capped_by_policy": {"asked_for": 200, "allowed": 50}}}},
           "rows_ordered_by": "dataset_table_438.total_revenue",
           "coverage": {"rows_read": 50, "rows_total": 72, "complete": False, "note": "ONLY 50/72 ROWS WERE READ"}}
    D._compact(cat)
    kpis = []
    for cid in (679, 688, 682):
        k = {"chart_id": cid, "title": f"Olist KPI {cid}",
             "summary": {"ok": True, "data": {"chart_name": "k", "chart_type": "KPI", "total_rows": 1,
                                              "columns": [{"name": "dataset_table_438.total_revenue", "kind": "number",
                                                           "total": 13591643.7}]}},
             "data": {"ok": True, "data": {"chart_id": cid, "columns": ["dataset_table_438.total_revenue"],
                                           "rows": [[13591643.7]], "row_count": 1,
                                           "coverage": {"returned": 1, "total": 1, "truncated": False}}}}
        D._compact(k)
        kpis.append(k)
    filters = D._compact_filters({"ok": True, "data": {"filter_count": 0, "has_filters": False, "active_filters": [],
                                                       "note": "These filters are merged from " * 10}})
    assert "note" not in filters["data"]
    doc = {"scope": {"read": 4, "available": 12}, "charts": [cat, *kpis], "filters": filters, "read_ok": True}
    knowledge = json.dumps({"results": [{"content": "x " * 5500}]})
    p = compile_context([StepView("doc", "doc", render_value(doc)), StepView("k", "k", knowledge)], 8000)
    assert '"category_00"' in p.text and '"category_01"' in p.text, p.text[:1500]


def test_active_filters_are_never_compacted():
    from app.services.agent_flows.runtime.handlers import data as D

    active = {"ok": True, "data": {"filter_count": 1, "has_filters": True,
                                   "active_filters": [{"field": "segment", "value": "enterprise"}], "note": "n"}}
    assert D._compact_filters(active) is active


OLIST_NAMES = {681: "Olist · Giá trị đơn trung bình · page-1", 679: "Olist · Doanh thu sản phẩm · page-1",
               686: "Olist · Doanh thu theo danh mục · page-1", 688: "Olist · Doanh thu sản phẩm · page-2",
               682: "Olist · Điểm đánh giá TB · page-1"}


def _named_call(names):
    def call(name, args):
        if name == "list_charts":
            return {"ok": True, "data": {
                "charts": [{"chart_id": c, "chart_name": n, "measures": ["Total revenue"]} for c, n in names.items()],
                "selection": {"status": "ambiguous", "selected_ids": list(names)}}}
        if name == "search_business_assets":
            return {"ok": True, "data": {"results": []}}
        return {"ok": False}
    return call


def test_a_chart_whose_name_fits_clearly_best_is_not_ambiguous():
    """Live round 7 (Q2): the hybrid read nothing and said the report had no
    category revenue, beside a chart named "Doanh thu theo danh mục"."""
    got = RS.resolve_charts("Danh mục nào có doanh thu cao nhất và chiếm bao nhiêu % tổng doanh thu?",
                            list(OLIST_NAMES), call=_named_call(OLIST_NAMES))
    assert got["status"] == "semantic" and got["chart_ids"] == [686], got


def test_a_tie_by_name_stays_ambiguous():
    got = RS.resolve_charts("doanh thu sản phẩm bao nhiêu", list(OLIST_NAMES), call=_named_call(OLIST_NAMES))
    assert got["status"] == "ambiguous" and got["chart_ids"] == [], got


def test_one_shared_content_word_is_not_a_winner():
    names = {1: "Doanh thu theo tháng", 2: "Số đơn theo bang"}
    got = RS.resolve_charts("thời tiết doanh nghiệp hôm nay", list(names), call=_named_call(names))
    assert got["chart_ids"] == [], got


def test_an_unrecognised_filter_payload_is_kept_as_it_came():
    """Caught by the replay snapshot: a payload without the filter shape was
    compacted to `{}`, dropping data the compactor never read."""
    from app.services.agent_flows.runtime.handlers import data as D

    other = {"ok": True, "kind": "table", "data": {"columns": ["category"], "rows": [["moveis"]]}}
    assert D._compact_filters(other) is other
