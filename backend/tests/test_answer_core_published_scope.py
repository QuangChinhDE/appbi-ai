"""The Answer Core's scope for a public link reads the link's PUBLISHED charts only,
through the governed public chart path, and never returns a number the chart
cannot support (services/answer_core/published_report.py).

The chart read (`_fetch_chart_data`) is replaced by a recorder: what reaches it is
exactly what the governed public path would be asked for. The real path - layered
filters, locks, page bounds, exposed fields - is exercised on the live stack.
"""
from __future__ import annotations

import json

import pytest

from app.services.answer_core.published_report import PublishedReportScope, _Chart
from app.services.data_core.catalog import CatalogExplore, CatalogField
from app.services.data_core.planner import Plan
from app.services.data_core.scope import Refusal

P, R, D, Q, A = "v.product", "v.revenue", "v.order_date", "v.region", "v.avg_price"
ROWS = [  # what the chart shows: revenue and average price by product and region
    {P: "Laptop", Q: "North", R: 100.0, A: 10.0},
    {P: "Laptop", Q: "South", R: 50.0, A: 30.0},
    {P: "Tablet", Q: "North", R: 70.0, A: 7.0},
]


class _Ctx:
    def __init__(self):
        self.calls = []

    def disclosed_filters(self):
        return [{"field": "v.channel", "operator": "eq", "value": "Online"}], 1


@pytest.fixture()
def scope(monkeypatch):
    from app.services.agent_flows.tools import context

    ctx = _Ctx()

    def fake_fetch(c, chart_id, *, extra_filters=None):
        c.calls.append((chart_id, extra_filters))
        cols = [P, Q, R, A]
        # the chart read's own report of what it ran with, as `_fetch_chart_data` gives it:
        # the disclosable filters it applied, and how many hidden ones it applied
        shown, withheld = c.disclosed_filters()
        return {"columns": cols, "rows": [[r[k] for k in cols] for r in ROWS], "filters_applied": shown,
                "restricted_by_author": withheld}

    monkeypatch.setattr(context, "_fetch_chart_data", fake_fetch)
    s = PublishedReportScope(db=None, ctx=ctx, link_id=7, turn_id="t" * 32)
    s._charts = {11: _Chart(11, "Doanh thu theo sản phẩm", ["Tổng quan"], 90, "bigquery", [P, Q],
                            {R: "sum", A: "avg"})}
    fields = [CatalogField(P, "dimension", "string", "Sản phẩm"), CatalogField(Q, "dimension", "string", "Vùng"),
              CatalogField(R, "measure", "sum", "Doanh thu"), CatalogField(A, "measure", "avg", "Giá TB")]
    s._entries = [CatalogExplore(11, None, 90, "Doanh thu theo sản phẩm", None, "v", "bigquery", "x", fields)]
    return s


def _plan(scope, dims, measures, filters=None):
    return Plan(explore=scope._entries[0], dimensions=dims, measures=measures, filters=filters or {})


def _read(scope, p):
    return scope.read(p, p.dimensions, p.measures, p.filters, p.sorts, p.time_grains, 500)


def test_the_charts_own_grouping_is_returned_as_the_chart_shows_it(scope):
    res = _read(scope, _plan(scope, [P, Q], [R]))
    assert [(r[P], r[Q], r[R]) for r in res.rows] == [("Laptop", "North", 100.0), ("Laptop", "South", 50.0),
                                                      ("Tablet", "North", 70.0)]
    assert scope.ctx.calls == [(11, None)]


def test_an_additive_measure_is_regrouped_and_a_filter_on_a_shown_dimension_stays_local(scope):
    res = _read(scope, _plan(scope, [P], [R], {Q: {"operator": "eq", "value": "north"}}))
    assert {r[P]: r[R] for r in res.rows} == {"Laptop": 100.0, "Tablet": 70.0}
    assert scope.ctx.calls == [(11, None)], "a filter on a dimension the chart shows narrows its own rows"
    total = _read(scope, _plan(scope, [], [R]))
    assert total.rows == [{R: 220.0}]


def test_an_average_is_never_regrouped_into_a_wrong_number(scope):
    with pytest.raises(Refusal) as ex:
        _read(scope, _plan(scope, [P], [A]))
    assert ex.value.code == "not_additive"
    # at the chart's own grouping it is the chart's own number
    one = _read(scope, _plan(scope, [P, Q], [A], {P: {"operator": "eq", "value": "Laptop"},
                                                  Q: {"operator": "eq", "value": "South"}}))
    assert one.rows == [{P: "Laptop", Q: "South", A: 30.0}]


def test_a_filter_on_a_field_the_chart_does_not_show_goes_to_the_governed_engine(scope):
    _read(scope, _plan(scope, [P], [R], {D: {"operator": "date_range", "value": {"from": "2024-04-01",
                                                                                 "to": "2024-07-01"}}}))
    chart_id, extra = scope.ctx.calls[-1]
    assert chart_id == 11
    assert extra == [{"field": D, "semanticField": D, "operator": "gte", "value": "2024-04-01"},
                     {"field": D, "semanticField": D, "operator": "lt", "value": "2024-07-01"}]


def test_a_field_or_chart_outside_the_published_report_is_refused(scope):
    with pytest.raises(Refusal) as ex:
        _read(scope, _plan(scope, ["v.customer_email"], [R]))
    assert ex.value.code == "outside_published_scope"
    other = CatalogExplore(99, None, 90, "Không công khai", None, "v", "bigquery", "x",
                           [CatalogField(R, "measure", "sum", "Doanh thu")])
    with pytest.raises(Refusal):
        scope.read(Plan(explore=other, dimensions=[], measures=[R]), [], [R], {}, [], {}, 500)
    assert all(c[0] == 11 for c in scope.ctx.calls)


def test_the_evidence_names_the_chart_and_only_disclosed_filters(scope):
    p = _plan(scope, [P], [R])
    ev = scope.evidence(p, _read(scope, p))
    assert ev["source"] == "Doanh thu theo sản phẩm" and ev["chart_id"] == 11 and ev["scope"] == "published_report"
    assert ev["filters_applied"] == ["channel eq Online"] and ev["filters_withheld"] == 1
    assert scope.can_save(p) is False and scope.exhausted() is None


def test_the_core_answers_a_published_report_turn_end_to_end_without_core_deps(scope, monkeypatch):
    """The public turn calls the Core with no GQS deps (deps=None): the planner, the
    grounding and the narrative run over the published scope alone. Found on the
    live stack: `deps.complete` on None failed every public turn."""
    from app.services.data_core import planner
    from app.services.data_core.service import ask

    raw = {"status": "plan", "explore_id": 11, "dimensions": [P], "measures": [R], "time_grains": {},
           "filters": {}, "sorts": [], "covered": {"doanh thu": R, "san pham": P},
           "interpretation": "Doanh thu theo sản phẩm"}
    monkeypatch.setattr(planner, "plan", lambda *a, **k: planner.validate(raw, scope.catalog()))
    from app.services.data_core import service

    monkeypatch.setattr(service, "make_plan", lambda *a, **k: planner.validate(raw, scope.catalog()))
    out = ask(None, None, "Doanh thu theo sản phẩm", None, scope=scope, turn_id="t" * 32)
    assert out["status"] == "answered", out
    assert {r[P]: r[R] for r in out["rows"]} == {"Laptop": 150.0, "Tablet": 70.0}
    assert out["evidence"]["source"] == "Doanh thu theo sản phẩm" and out["can_save"] is False


def test_a_filter_only_field_filters_but_never_groups():
    """A link-exposed slicer field on a chart that does not show it: the planner may
    FILTER by it (a period on the order date), never group by it - the breakdown
    must come from a chart that shows the field."""
    from app.services.data_core.planner import Unsupported, validate

    explore = CatalogExplore(11, None, 90, "Doanh thu theo khu vực", None, "v", "bigquery", "x", [
        CatalogField(Q, "dimension", "string", "Khu vực"), CatalogField(R, "measure", "sum", "Doanh thu"),
        CatalogField(D, "filter", "date", "Ngày đặt hàng", "Chỉ dùng để lọc")])
    assert "filter_fields" in explore.as_prompt() and all(
        f["ref"] != D for f in explore.as_prompt()["dimensions"])
    ok = validate({"status": "plan", "explore_id": 11, "dimensions": [Q], "measures": [R],
                   "filters": {D: {"operator": "date_range", "value": {"from": "2024-04-01", "to": "2024-07-01"}}}},
                  [explore])
    assert not isinstance(ok, Unsupported) and D in ok.filters and ok.dimensions == [Q]
    grouped = validate({"status": "plan", "explore_id": 11, "dimensions": [D], "measures": [R]}, [explore])
    assert isinstance(grouped, Unsupported)


def test_a_plan_grouping_by_a_filter_only_field_moves_to_the_chart_that_shows_it():
    """Live run: "Doanh thu theo khu vực" was planned on the KPI (region only filters
    it); the Core moves the plan to the one chart of the same dataset that SHOWS the
    region. Two such charts would be ambiguous: no move, the plan is refused."""
    from app.services.data_core.planner import Unsupported, validate

    kpi = CatalogExplore(10, None, 90, "Tổng doanh thu", None, "v", "bigquery", "x", [
        CatalogField(R, "measure", "sum", "Doanh thu"), CatalogField(Q, "filter", "string", "Khu vực")])
    by_region = CatalogExplore(11, None, 90, "Theo khu vực", None, "v", "bigquery", "x", [
        CatalogField(Q, "dimension", "string", "Khu vực"), CatalogField(R, "measure", "sum", "Doanh thu")])
    raw = {"status": "plan", "explore_id": 10, "dimensions": [Q], "measures": [R]}
    moved = validate(raw, [kpi, by_region])
    assert not isinstance(moved, Unsupported) and moved.explore.explore_id == 11
    twin = CatalogExplore(12, None, 90, "Theo khu vực (2)", None, "v", "bigquery", "x", list(by_region.fields))
    assert isinstance(validate(raw, [kpi, by_region, twin]), Unsupported)


def test_every_published_chart_reaches_the_model_even_when_they_share_a_dataset():
    """Live run P2: the GQS prompt keeps ONE explore per dataset (look-alikes). Every
    chart of a published report is a different reading of one dataset; collapsed,
    the model saw only the KPI and answered "Khu vực không phải là một trường" to
    "Doanh thu theo khu vực" although the region chart was published."""
    from app.services.data_core.planner import build_prompt
    import json

    kpi = CatalogExplore(10, None, 90, "Tổng doanh thu", None, "v", "bigquery", "x", [
        CatalogField(R, "measure", "sum", "Doanh thu"), CatalogField(Q, "filter", "string", "Khu vực"),
        CatalogField(D, "filter", "date", "Ngày")], published=True)
    by_region = CatalogExplore(11, None, 90, "Theo khu vực", None, "v", "bigquery", "x", [
        CatalogField(Q, "dimension", "string", "Khu vực"), CatalogField(R, "measure", "sum", "Doanh thu")],
        published=True)
    sent = json.loads(build_prompt("Doanh thu theo khu vực", [kpi, by_region], None))
    assert [c["explore_id"] for c in sent["catalog"]] == [10, 11]


def test_a_regional_breakdown_reads_the_regional_chart_never_the_kpi_or_a_value_list(monkeypatch):
    """Live run P2, after the prompt fix: the plan moved to the region chart, then
    `retarget` (a GQS step) moved it back to the KPI - whose fields include the region
    as a filter-only field - and the KPI read answered with the list of regions (a
    value lookup) instead of revenue per region."""
    from app.services.agent_flows.tools import context
    from app.services.data_core.planner import retarget, validate

    ctx = _Ctx()
    kpi_rows = {10: ([R], [[220.0]]), 11: ([Q, R], [["North", 170.0], ["South", 50.0]])}

    def fake_fetch(c, chart_id, *, extra_filters=None):
        c.calls.append((chart_id, extra_filters))
        cols, rows = kpi_rows[chart_id]
        return {"columns": cols, "rows": rows, "filters_applied": []}

    monkeypatch.setattr(context, "_fetch_chart_data", fake_fetch)
    s = PublishedReportScope(db=None, ctx=ctx, link_id=7, turn_id="t" * 32)
    s._charts = {10: _Chart(10, "Tổng doanh thu", ["Tổng quan"], 90, "bigquery", [], {R: "sum"}),
                 11: _Chart(11, "Theo khu vực", ["Tổng quan"], 90, "bigquery", [Q], {R: "sum"})}
    kpi = CatalogExplore(10, None, 90, "Tổng doanh thu", None, "v", "bigquery", "x", [
        CatalogField(R, "measure", "sum", "Doanh thu"), CatalogField(Q, "filter", "string", "Khu vực")],
        published=True)
    by_region = CatalogExplore(11, None, 90, "Theo khu vực", None, "v", "bigquery", "x", [
        CatalogField(Q, "dimension", "string", "Khu vực"), CatalogField(R, "measure", "sum", "Doanh thu")],
        published=True)
    s._entries = [kpi, by_region]
    p = retarget(validate({"status": "plan", "explore_id": 10, "dimensions": [Q], "measures": [R]}, s._entries),
                 s._entries)
    assert p.explore.explore_id == 11
    assert {r[Q]: r[R] for r in _read(s, p).rows} == {"North": 170.0, "South": 50.0}
    # a measure read on a chart that does not show the field is refused, never a value list
    with pytest.raises(Refusal):
        s.read(Plan(explore=kpi, dimensions=[Q], measures=[R]), [Q], [R], {}, [], {}, 500)


def test_a_charts_title_names_its_one_metric_in_the_viewers_words():
    """Live run P3: "Top 3 sản phẩm có doanh thu cao nhất" over a model whose measure
    is labelled "Total revenue" was refused (no metric named) although the published
    chart is titled "Doanh thu theo sản phẩm". The title's metric phrase grounds the
    chart's one measure - never its breakdown words."""
    from app.services.answer_core.published_report import _title_parts
    from app.services.data_core.grounding import ground

    assert _title_parts("QA Bot · Doanh thu theo sản phẩm") == ("Doanh thu", "sản phẩm")
    assert _title_parts("Tổng doanh thu") == ("Tổng doanh thu", "")
    assert _title_parts("Revenue by region") == ("Revenue", "region")
    explore = CatalogExplore(11, None, 90, "Doanh thu theo sản phẩm", None, "v", "bigquery", "x", [
        CatalogField(P, "dimension", "string", "Product name", "", ("Sản phẩm",)),
        CatalogField(R, "measure", "sum", "Total revenue", "", ("Doanh thu",))], published=True)
    p = Plan(explore=explore, dimensions=[P], measures=[R], sorts=[{"field": R, "direction": "desc"}])
    ok, why = ground(p, "Top 3 sản phẩm có doanh thu cao nhất", covered={"sản phẩm có doanh thu cao nhất": P})
    assert why is None and ok.measures == [R]
    no, why = ground(p, "Số lượng sản phẩm bán ra", covered={"sản phẩm": P})
    assert no is None and why


def test_a_link_exposed_measure_is_never_a_second_filter_only_copy_of_the_charts_metric(monkeypatch):
    """Live run P3: the link exposes the revenue measure in its filter pane; the
    catalog added it again as a filter-only field and that copy (no synonyms)
    shadowed the chart's metric, so "doanh thu" named nothing and the turn was refused."""
    from types import SimpleNamespace as NS

    from app.models.dataset import DatasetTable
    from app.models.models import Chart
    from app.services.answer_core import published_report as pr

    objs = {Chart: NS(name="Doanh thu theo sản phẩm", dataset_table_id=5),
            DatasetTable: NS(dataset_id=90, datasource_id=None)}
    db = NS(get=lambda model, _id: objs.get(model))
    monkeypatch.setattr(pr._Vocabulary, "_view", lambda self, ds, v: (object(), {}))
    monkeypatch.setattr(pr._Vocabulary, "dimension", lambda self, ds, ref: ("string", "", ()))
    monkeypatch.setattr(pr._Vocabulary, "measure", lambda self, ds, ref, agg: ("sum", "", ()))
    ctx = NS(pages=[], allowed_chart_ids=[11], exposed_fields=({R, D, P}, set()), dashboard=NS(slicers_config=[]),
             excluded_columns=set(), chart_meta={11: {"name": "Doanh thu theo sản phẩm", "fields": {
                 "dimensions": [{"field": P, "label": "Product name"}],
                 "measures": [{"field": R, "label": "Total revenue", "agg": "sum"}]}}})
    s = PublishedReportScope(db=db, ctx=ctx, link_id=7, turn_id="t" * 32)
    fields = s.catalog()[0].fields
    assert [(f.ref, f.kind) for f in fields if f.ref == R] == [(R, "measure")]
    assert [(f.ref, f.kind) for f in fields if f.ref == D] == [(D, "filter")]
    assert next(f for f in fields if f.ref == R).synonyms == ("Doanh thu",)
    assert next(f for f in fields if f.ref == P).synonyms == ("sản phẩm",)


def test_a_grain_on_a_charts_period_column_is_its_own_bucket_or_refused(monkeypatch):
    """Live run P3: "Doanh thu tăng trưởng theo tháng" on the chart grouped by the
    calendar view's year_month ("2024-03", a string) planned a month grain and was
    refused as "not a date field". The scope buckets a period it shows: its own grain
    as is, a coarser one derived, a finer one refused - never an invented split."""
    from app.services.agent_flows.tools import context
    from app.services.data_core.planner import validate

    M = "v__order_date__date_dim.year_month"
    ctx = _Ctx()
    monkeypatch.setattr(context, "_fetch_chart_data", lambda c, cid, *, extra_filters=None: {
        "columns": [M, R], "rows": [["2024-03", 10.0], ["2024-04", 5.0], ["2024-05", 1.0], [None, 2.0]],
        "filters_applied": []})
    s = PublishedReportScope(db=None, ctx=ctx, link_id=7, turn_id="t" * 32)
    s._charts = {12: _Chart(12, "Doanh thu theo tháng", ["Tổng quan"], 90, "bigquery", [M], {R: "sum"})}
    month = CatalogExplore(12, None, 90, "Doanh thu theo tháng", None, "v", "bigquery", "x", [
        CatalogField(M, "dimension", "string", "Year month"), CatalogField(R, "measure", "sum", "Doanh thu")],
        published=True)
    s._entries = [month]

    def plan_with(grain):
        return validate({"status": "plan", "explore_id": 12, "dimensions": [M], "measures": [R],
                         "time_grains": {M: grain}}, [month])
    assert {r[M]: r[R] for r in _read(s, plan_with("month")).rows} == {"2024-03": 10.0, "2024-04": 5.0,
                                                                       "2024-05": 1.0, None: 2.0}
    assert {r[M]: r[R] for r in _read(s, plan_with("quarter")).rows} == {"2024-Q1": 10.0, "2024-Q2": 6.0,
                                                                         None: 2.0}
    with pytest.raises(Refusal) as ex:
        _read(s, plan_with("day"))
    assert ex.value.code == "grain_not_shown"
    # outside a published chart the planner still refuses a grain on a non-date field
    governed = CatalogExplore(12, None, 90, "x", None, "v", "bigquery", "x", list(month.fields))
    from app.services.data_core.planner import Unsupported
    assert isinstance(validate({"status": "plan", "explore_id": 12, "dimensions": [M], "measures": [R],
                                "time_grains": {M: "month"}}, [governed]), Unsupported)


def test_a_breakdown_on_a_field_the_plan_filters_to_a_value_is_the_filter_not_the_grouping():
    """Live run P4: "Doanh thu theo sản phẩm ở khu vực Central" was planned on the
    product chart BY region AND region = Central (region only filters that chart),
    while the model's own `covered` mapped "sản phẩm" to the product. The Core keeps
    the filter and groups by the one dimension the model named - never moving to the
    region chart, where "sản phẩm" has no field."""
    from app.services.data_core.planner import Unsupported, validate

    products = CatalogExplore(11, None, 90, "Doanh thu theo sản phẩm", None, "v", "bigquery", "x", [
        CatalogField(P, "dimension", "string", "Product name"), CatalogField(R, "measure", "sum", "Doanh thu"),
        CatalogField(Q, "filter", "string", "Khu vực")], published=True)
    regions = CatalogExplore(12, None, 90, "Doanh thu theo khu vực", None, "v", "bigquery", "x", [
        CatalogField(Q, "dimension", "string", "Khu vực"), CatalogField(R, "measure", "sum", "Doanh thu")],
        published=True)
    raw = {"status": "plan", "explore_id": 11, "dimensions": [Q], "measures": [R],
           "filters": {Q: {"operator": "eq", "value": "Central"}},
           "covered": {"doanh thu": R, "sản phẩm": P, "khu vực": Q}}
    p = validate(raw, [products, regions])
    assert not isinstance(p, Unsupported)
    assert p.explore.explore_id == 11 and p.dimensions == [P] and p.filters[Q]["value"] == "Central"
    # nothing named: the misplaced breakdown is dropped, the filter stays (a total in Central)
    p = validate({**raw, "covered": {"doanh thu": R}}, [products, regions])
    assert p.explore.explore_id == 11 and p.dimensions == [] and Q in p.filters


def test_a_refusal_that_only_repeats_the_question_says_why_instead():
    """Live run P15: the model refused "Quy định đổi trả hàng của cửa hàng ra sao?" with
    the question itself as the reason; the viewer saw their own question as the answer."""
    from app.services.data_core.planner import Unsupported, plan

    q = "Quy định đổi trả hàng của cửa hàng ra sao?"
    out = plan(q, [CatalogExplore(11, None, 90, "x", None, "v", "bigquery", "x",
                                  [CatalogField(R, "measure", "sum", "Doanh thu")])],
               complete=lambda *a, **k: {"status": "unsupported", "reason": q})
    assert isinstance(out, Unsupported) and out.reason != q and "không" in out.reason
    kept = plan(q, [CatalogExplore(11, None, 90, "x", None, "v", "bigquery", "x",
                                   [CatalogField(R, "measure", "sum", "Doanh thu")])],
                complete=lambda *a, **k: {"status": "unsupported", "reason": "Không có dữ liệu đổi trả."})
    assert kept.reason == "Không có dữ liệu đổi trả."


def test_a_follow_up_that_lifts_a_filter_is_answered_without_it():
    """Live run P12: after "Doanh thu theo sản phẩm ở khu vực Central", "Bỏ lọc khu
    vực, tính tất cả khu vực" was planned right (no region filter) but refused because
    the model mapped "tất cả khu vực" to null. Asking for ALL of a field is answered by
    not filtering it - and refused when the plan still filters it."""
    from app.services.data_core.grounding import ground
    from app.services.data_core.planner import Unsupported, validate

    products = CatalogExplore(11, None, 90, "Doanh thu theo sản phẩm", None, "v", "bigquery", "x", [
        CatalogField(P, "dimension", "string", "Product name", "", ("sản phẩm",)),
        CatalogField(R, "measure", "sum", "Total revenue", "", ("Doanh thu",)),
        CatalogField(Q, "filter", "string", "Khu vực")], published=True)
    q = "Bỏ lọc khu vực, tính tất cả khu vực"
    raw = {"status": "plan", "explore_id": 11, "dimensions": [P], "measures": [R], "filters": {},
           "covered": {"tất cả khu vực": None}}
    p = validate(raw, [products])
    assert not isinstance(p, Unsupported), p
    previous = {"explore_id": 11, "dimensions": [P], "measures": [R],
                "filters": {Q: {"operator": "eq", "value": "Central"}}}
    ok, why = ground(p, q, carried=[P, R, Q], covered=p.covered, previous=previous)
    assert why is None and ok.filters == {}, why
    still = validate({**raw, "filters": {Q: {"operator": "eq", "value": "Central"}}}, [products])
    assert isinstance(still, Unsupported)
    # the second live run: the model's phrase began with a function word
    p = validate({**raw, "covered": {"tính tất cả khu vực": None}}, [products])
    assert not isinstance(p, Unsupported), p
    # a real field word before it is not a lift ("doanh thu tất cả khu vực" names a metric)
    assert isinstance(validate({**raw, "covered": {"lợi nhuận tất cả khu vực": None}}, [products]), Unsupported)


def test_the_guided_analysis_reads_only_the_published_charts_and_flags_figures_it_did_not_read(scope):
    """Owner decision 2026-10-28: when the Core cannot plan a question ("phân tích hơn
    về con số đó"), the bot analyses the PUBLISHED charts, guided by the publisher's
    prompt. What the model is given is those charts' rows only (through the governed
    chart path); a figure in its answer that is not in them is listed as NOT verified."""
    from app.services.answer_core import guided_analysis as g

    sent = {}

    def model(prompt, system=None, max_tokens=None):
        sent["payload"], sent["system"] = json.loads(prompt), system
        return {"answer": "Laptop dẫn đầu với 150 (100 ở North, 50 ở South); tổng là 1.234 và tăng 12%.", "charts_used":
                ["Doanh thu theo sản phẩm", "Biểu đồ không tồn tại"]}

    out = g.analyse(scope, question="Phân tích doanh thu theo sản phẩm", instructions="Nhấn mạnh sản phẩm chủ lực.",
                    complete=model)
    assert sent["payload"]["publisher_instructions"] == "Nhấn mạnh sản phẩm chủ lực."
    assert [c["chart"] for c in sent["payload"]["charts"]] == ["Doanh thu theo sản phẩm"]
    assert {"Sản phẩm": "Laptop", "Vùng": "North", "Doanh thu": 100.0, "Giá TB": 10.0} in sent["payload"]["charts"][0]["rows"]
    assert "không" in sent["system"].lower() and "bịa" in sent["system"]
    assert out["charts"] == ["Doanh thu theo sản phẩm"]
    assert "1.234" in out["unverified_figures"] and "12%" in out["unverified_figures"]
    assert scope.ctx.calls == [(11, None)]                        # the governed chart read, nothing else


def test_the_guided_analysis_answers_only_could_not_plan_refusals():
    from app.services.answer_core.guided_analysis import eligible

    assert eligible({"status": "refused", "code": "unsupported"})
    for code in ("ai_budget_exceeded", "model_unavailable", "link_unavailable", "outside_published_scope", None):
        assert not eligible({"status": "refused", "code": code}), code
    assert not eligible({"status": "answered", "code": None})
    # review 2026-10-28: the Core's refusals that guard against a wrong figure stand as they are
    for code in ("not_additive", "grain_not_shown"):
        assert not eligible({"status": "refused", "code": code}), code
    ran = {"status": "refused", "code": "unsupported", "data": {"status": "unsupported", "plan": {"measures": []},
                                                                 "message": "Kết quả vượt giới hạn dòng"}}
    assert not eligible(ran)                                    # 0 rows / top N cut by the row bound
    # a document question: answered from the publisher's prompt, else refused honestly
    unsupported = {"status": "refused", "code": "unsupported"}
    policy = "Chính sách giao hàng trễ được hoàn phí thế nào?"
    assert eligible(unsupported, "Doanh thu tăng vì sao?")
    assert not eligible(unsupported, policy)
    assert eligible(unsupported, policy, has_notes=True)
    # a link with a document add-on: the Core's refusal is the add-on's, as before
    assert not eligible(unsupported, "Doanh thu tăng vì sao?", has_notes=True, has_addon=True)


def test_an_evaluation_of_the_cores_figure_reads_the_prompt_beside_the_answer():
    """Owner 2026-10-28: "có đạt mục tiêu không?" - the Core answers the figure; the
    analysis reads it against the publisher's prompt, beside the answer, not in its place."""
    from app.services.answer_core.guided_analysis import wants_evaluation
    from app.services.chat.envelope import with_analysis

    answered = {"status": "answered", "code": None, "message": None, "data": {"answer": {"headline": "10"}}}
    assert wants_evaluation(answered, "Doanh thu có đạt mục tiêu không?", has_notes=True)
    assert not wants_evaluation(answered, "Doanh thu có đạt mục tiêu không?", has_notes=False)
    assert not wants_evaluation(answered, "Tổng doanh thu là bao nhiêu?", has_notes=True)
    out = with_analysis(answered, {"text": "Đạt 80% mục tiêu"})
    assert out["status"] == "answered" and out["code"] is None
    assert out["data"]["answer"] == {"headline": "10"} and out["data"]["analysis"]["text"] == "Đạt 80% mục tiêu"


def test_the_publishers_prompt_is_knowledge_its_figures_are_its_own_and_it_is_not_cut(scope):
    """Owner 2026-10-28: the prompt can carry what no chart holds (a policy, a target) -
    the analysis answers from it, says so, and a figure the prompt states is the
    publisher's, not "unverified". No length cap on the prompt."""
    from app.services.answer_core import guided_analysis as g

    sent = {}
    notes = "Mục tiêu doanh thu năm: 15.000.000. Đổi trả trong 7 ngày. " + "Bối cảnh. " * 400

    def model(prompt, system=None, max_tokens=None):
        sent["payload"] = json.loads(prompt)
        return {"answer": "Theo thông tin của người xuất bản, mục tiêu là 15.000.000; tổng 150 mới đạt 37,5%.",
                "charts_used": [], "used_publisher_notes": True}

    out = g.analyse(scope, question="Có đạt mục tiêu không?", instructions=notes,
                    core_answer={"question": "q", "headline": "150", "rows": [{"Doanh thu": 150.0}]}, complete=model)
    assert sent["payload"]["publisher_instructions"] == notes          # whole, however long
    assert sent["payload"]["core_answer"]["headline"] == "150"
    assert out["used_notes"] is True
    assert "15.000.000" not in out["unverified_figures"]               # the publisher's own figure
    assert "37,5%" in out["unverified_figures"]                       # worked out by the model: flagged
    # no prompt: the model's claim to have used one is not believed
    out = g.analyse(scope, question="x", instructions=None,
                    complete=lambda *a, **k: {"answer": "Laptop 150", "used_publisher_notes": True})
    assert out["used_notes"] is False


def test_the_guided_analysis_never_sums_what_does_not_add_up_nor_reads_an_unfiltered_chart(monkeypatch):
    """Review 2026-10-28: an average or a distinct count summed over rows, a share of a
    Top-N chart's rows, a chart that could not apply the viewer's filter - each a wrong
    figure the model was told was exact. None of them is computed or read."""
    from app.services.agent_flows.tools import context
    from app.services.answer_core.guided_analysis import _facts, published_data

    rows = [{"Vùng": v, "Giá TB": a, "Doanh thu": s} for v, a, s in [("North", 10.0, 100.0), ("South", 30.0, 50.0)]]
    _, facts = _facts(rows, frozenset({"Doanh thu"}))
    assert facts["total_of_rows"] == {"Doanh thu": 150.0}               # the sum, never the averages added
    _, facts = _facts([{k: r[k] for k in ("Vùng", "Giá TB")} for r in rows], frozenset({"Doanh thu"}))
    assert "total_of_rows" not in facts and all("share_percent" not in t for t in facts["top"])
    assert [t["name"] for t in facts["top"]] == ["South", "North"]      # ranking an average is still true
    _, facts = _facts([{"Vùng": None, "Doanh thu": 5.0}, {"Vùng": "West", "Doanh thu": 9.0}], frozenset({"Doanh thu"}))
    assert facts["lowest"]["name"] == "(trống)"                         # a blank member, never "None"
    _, facts = _facts(rows, frozenset({"Doanh thu"}), top_n=2)
    assert facts["rows_are_top_n"] == 2 and "total_of_rows" not in facts
    assert all("share_percent" not in t for t in facts["top"])

    calls = []

    def fetch(c, chart_id, *, extra_filters=None):
        calls.append(chart_id)
        out = {"columns": [P, R, A], "rows": [["Laptop", 100.0, 10.0], ["Phone", 50.0, 30.0]], "filters_applied": []}
        if chart_id == 12:
            out["filters_not_applied"] = [{"field": "Bang", "value": "SP"}]
        return out

    monkeypatch.setattr(context, "_fetch_chart_data", fetch)
    s = PublishedReportScope(db=None, ctx=_Ctx(), link_id=7, turn_id="t" * 32)
    s._charts = {11: _Chart(11, "Theo sản phẩm", ["Tổng quan"], 90, "bigquery", [P], {R: "sum", A: "avg"}),
                 12: _Chart(12, "Toàn quốc", ["Tổng quan"], 91, "bigquery", [P], {R: "sum", A: "avg"})}
    fields = [CatalogField(P, "dimension", "string", "Sản phẩm"), CatalogField(R, "measure", "sum", "Doanh thu"),
              CatalogField(A, "measure", "avg", "Giá TB")]
    s._entries = [CatalogExplore(11, None, 90, "Theo sản phẩm", None, "v", "bigquery", "x", fields),
                  CatalogExplore(12, None, 91, "Toàn quốc", None, "v", "bigquery", "x", fields)]
    charts = published_data(s)
    assert [c["chart"] for c in charts] == ["Theo sản phẩm"] and calls == [11, 12]
    assert charts[0]["facts"]["total_of_rows"] == {"Doanh thu": 150.0}  # "Giá TB" (avg) is never summed


def test_the_publishers_prompt_reaches_the_planner_as_report_notes():
    from app.services.data_core.planner import SYSTEM, build_prompt

    body = json.loads(build_prompt("GMV là bao nhiêu?", [], None, notes="GMV = Total revenue"))
    assert body["report_notes"] == "GMV = Total revenue" and "report_notes" in SYSTEM
    assert "report_notes" not in json.loads(build_prompt("x", [], None))


def test_the_guided_analysis_ranks_and_finds_peaks_itself_rather_than_trusting_the_model():
    """Live demo 2026-10-28: asked "Top 5 bang", the model listed BA (511k) above PR
    (683k) and dropped SC; asked about months it named the wrong peak and called R$
    "USD". The ranking, peak, trough and change are computed here, over every row, and
    the model is told to take them from `facts` and add no currency of its own."""
    from app.services.answer_core.guided_analysis import SYSTEM, _facts

    states = [{"Bang": s, "Doanh thu": v} for s, v in
              [("RJ", 1824092.67), ("BA", 511349.99), ("SP", 5202955.05), ("PR", 683083.76),
               ("MG", 1585308.03), ("SC", 520553.34), ("AC", 1000.0)]]
    rows, facts = _facts(states, frozenset({"Doanh thu"}))
    assert [t["name"] for t in facts["top"]] == ["SP", "RJ", "MG", "PR", "SC"]
    assert [t["rank"] for t in facts["top"]] == [1, 2, 3, 4, 5]
    assert facts["lowest"] == {"name": "AC", "Doanh thu": 1000.0}
    assert rows[0]["Bang"] == "SP" and rows[-1]["Bang"] == "AC"
    assert facts["top"][0]["share_percent"] == round(5202955.05 / sum(r["Doanh thu"] for r in states) * 100, 2)

    months = [{"Tháng": m, "Doanh thu": v} for m, v in
              [("2017-03-01", 400.0), ("2017-01-01", 120.0), ("2017-11-01", 1010.0), ("2018-08-01", 900.0)]]
    rows, facts = _facts(months, frozenset({"Doanh thu"}))
    assert [r["Tháng"] for r in rows] == ["2017-01-01", "2017-03-01", "2017-11-01", "2018-08-01"]
    assert facts["peak"] == {"period": "2017-11-01", "Doanh thu": 1010.0}
    assert facts["trough"] == {"period": "2017-01-01", "Doanh thu": 120.0}
    assert facts["total_by_year"] == {"2017": 1530.0, "2018": 900.0}
    assert facts["periods_by_year"] == {"2017": 3, "2018": 1}
    assert "change_first_to_last" not in facts      # edge periods are partial: no first-vs-last trend
    assert "facts" in SYSTEM and "USD" in SYSTEM                  # rank from facts; no currency added


def test_the_guided_analysis_drops_the_wrapper_and_headings_the_model_adds(scope):
    """The live answers began with a literal "<markdown>" and "# heading"."""
    from app.services.answer_core import guided_analysis as g

    out = g.analyse(scope, question="Top sản phẩm", instructions=None,
                    complete=lambda *a, **k: {"answer": "<markdown># Top sản phẩm\n- Laptop: 150</markdown>"})
    assert out["text"] == "**Top sản phẩm**\n- Laptop: 150"


def test_the_guided_analysis_writes_figures_the_way_the_answers_language_does():
    """Live demo 2026-10-28: the analysis printed "13591643.7" beside the Core's
    "13.591.643,7". A year stays a year; an id is not a number."""
    from app.services.answer_core.guided_analysis import _format_numbers

    vi = _format_numbers("Tổng doanh thu đạt 13591643.7, năm 2017 cao nhất; SP chiếm 38.28%; tháng cuối 145.0; "
                         "98666 đơn; người bán 6560211a19b4")
    assert vi == ("Tổng doanh thu đạt 13.591.643,7, năm 2017 cao nhất; SP chiếm 38,28%; tháng cuối 145; "
                  "98.666 đơn; người bán 6560211a19b4")
    assert _format_numbers("tổng là 1.234 và 5.202.955,05") == "tổng là 1.234 và 5.202.955,05"   # already vi
    # the model grouped it the English way itself: the Vietnamese answer still reads one way
    assert (_format_numbers("Tổng doanh thu là 13,591,643.70; 98,666 đơn; SP chiếm 38.28%")
            == "Tổng doanh thu là 13.591.643,7; 98.666 đơn; SP chiếm 38,28%")
    assert _format_numbers("có 2,017 đơn trong năm 2017") == "có 2.017 đơn trong năm 2017"
    assert _format_numbers("Revenue was 13591643.7 in 2017 (38.28%)") == "Revenue was 13,591,643.7 in 2017 (38.28%)"


def _report(names):
    """A large published report: one entry per chart title (English field refs, as
    the Olist report's are), the charts all on page 1 unless named otherwise."""
    from app.services.answer_core.published_report import _Chart

    entries, charts = [], {}
    for i, (name, dim, page) in enumerate(names, start=100):
        fields = [CatalogField(f"v.{dim}", "dimension", "string", dim),
                  CatalogField("v.amount", "measure", "sum", "amount")]
        entries.append(CatalogExplore(i, None, 90, name, None, "v", "postgresql", name, fields, published=True))
        charts[i] = _Chart(i, name, [page], 90, "postgresql", [f"v.{dim}"], {"v.amount": "sum"})
    return entries, charts


_OLIST = [("Olist · Đơn theo trạng thái · page-1", "order_status", "Tổng quan"),
          ("Olist · GMV theo tháng · page-1", "year_month", "Tổng quan"),
          ("Olist · Doanh thu theo danh mục · page-2", "category", "Doanh thu & Sản phẩm"),
          ("Olist · Khách hàng theo bang · page-3", "customer_state", "Khách hàng & Địa lý"),
          ("Olist · Doanh thu theo bang · page-3", "customer_state", "Khách hàng & Địa lý"),
          ("Olist · Thời gian giao hàng TB theo bang · page-4", "customer_state", "Giao hàng & Vận hành"),
          ("Olist · Điểm đánh giá TB theo bang · page-5", "customer_state", "Đánh giá & Thanh toán"),
          ("Olist · Phương thức thanh toán · page-5", "payment_type", "Đánh giá & Thanh toán"),
          ("Olist · Số kỳ trả góp · page-5", "payment_installments", "Đánh giá & Thanh toán")]


def test_a_large_report_shows_the_planner_the_charts_the_question_is_about():
    """Live 2026-10-28, an 85-chart report: every question sent the whole catalog
    (~60k tokens), and the analysis read the first eight charts - "phương thức thanh
    toán" was answered from the order-status chart. The charts are ranked by the
    question, deterministically."""
    from app.services.answer_core.published_report import rank_entries

    entries, charts = _report(_OLIST)
    top = (lambda q, **k: charts[rank_entries(q, entries, charts, **k)[0].explore_id].name)
    assert top("Phương thức thanh toán nào phổ biến nhất?") == "Olist · Phương thức thanh toán · page-5"
    assert top("Điểm đánh giá trung bình theo bang thế nào?") == "Olist · Điểm đánh giá TB theo bang · page-5"
    assert top("Top 5 bang có doanh thu cao nhất") == "Olist · Doanh thu theo bang · page-3"
    # the publisher's glossary lends its words: "vùng" means the customer's state here
    assert "theo bang" in top("Doanh thu theo vùng", notes="vùng là bang của khách hàng (customer_state)")
    # nothing in common: the catalog's own order (the viewer's page first) stands
    assert rank_entries("xin chào", entries, charts) == entries


def test_the_planner_sees_a_shortlist_of_a_large_report_and_the_whole_of_a_small_one(monkeypatch):
    from app.services.answer_core import published_report as pr
    from app.services.data_core import service
    from app.services.data_core.planner import Unsupported

    many = [(f"Olist · Chỉ số phụ {i} · page-2", f"dim_{i}", "Phụ") for i in range(20)] + _OLIST
    entries, charts = _report(many)
    s = PublishedReportScope(db=None, ctx=_Ctx(), link_id=7, turn_id="t" * 32)
    s._entries, s._charts = entries, charts
    shown = {}

    def plan(question, catalog, **k):
        shown["ids"] = [c.explore_id for c in catalog]
        return Unsupported("x")

    monkeypatch.setattr(service, "make_plan", plan)
    service.ask(None, None, "Phương thức thanh toán nào phổ biến nhất?", None, scope=s, turn_id="t" * 32)
    assert len(shown["ids"]) == pr.SHORTLIST
    assert charts[shown["ids"][0]].name == "Olist · Phương thức thanh toán · page-5"
    # a follow-up keeps the previous answer's chart in view
    prev = {"explore_id": entries[0].explore_id}
    kept = s.shortlist("Còn theo bang thì sao?", entries, prev)
    assert entries[0] in kept and len(kept) <= pr.SHORTLIST + 1
    # a small report is shown whole
    assert s.shortlist("Phương thức thanh toán?", entries[:5], None) == entries[:5]


def test_a_new_question_is_not_read_as_a_refinement_of_the_last_answer():
    """Live 2026-10-28: "Top 5 bang có doanh thu cao nhất" after "Doanh thu theo tháng"
    was answered with the months ranked - the client sends every message as a
    follow-up and the planner keeps a follow-up's breakdown."""
    from app.services.data_core.intent import is_followup

    for q in ("Chỉ tính quý 2 năm 2024", "Còn quý 1 thì sao?", "Bỏ lọc khu vực, tính tất cả khu vực",
              "phân tích hơn về con số đó như nào tạo nên ?", "Top 2 thôi", "theo quý?", "What about Q1?"):
        assert is_followup(q), q
    for q in ("Top 5 bang có doanh thu cao nhất", "Phương thức thanh toán nào phổ biến nhất?",
              "Doanh thu theo tháng thay đổi thế nào?", "Tỷ lệ giao đúng hẹn là bao nhiêu?"):
        assert not is_followup(q), q


def test_an_edge_period_far_below_a_typical_one_is_never_the_trough_or_compared():
    """Live 2026-10-28: the analysis named 12/2016 (10.9) the lowest month; the data set
    opens and ends with a few orders. The chart footnote's rule names them."""
    from app.services.answer_core.guided_analysis import _facts

    months = [{"Tháng": f"2017-{m:02d}-01", "Doanh thu": v}
              for m, v in [(1, 3.0), (2, 400.0), (3, 500.0), (4, 450.0), (5, 600.0), (6, 520.0), (7, 9.0)]]
    _, facts = _facts(months, frozenset({"Doanh thu"}))
    assert facts["partial_periods"] == ["2017-01-01", "2017-07-01"]
    assert facts["trough"] == {"period": "2017-02-01", "Doanh thu": 400.0}   # not 2017-01 (3.0)
    assert facts["first"]["period"] == "2017-02-01" and facts["last"]["period"] == "2017-06-01"


def test_an_average_over_time_has_no_peak_or_trough_and_a_stray_bold_marker_is_dropped():
    """Live 2026-10-28: "đỉnh điểm đánh giá trung bình là 5 vào tháng 12/2016" - a month
    of two reviews. An average per period has no volume to tell a thin period by, so no
    peak or trough is computed. And "- **1. SP:** 5.202.955,05**" showed a stray "**"."""
    from app.services.answer_core.guided_analysis import SYSTEM, _facts, _tidy

    months = [{"Tháng": f"2017-{m:02d}-01", "Điểm TB": v} for m, v in [(1, 5.0), (2, 4.1), (3, 4.0), (4, 1.0)]]
    _, facts = _facts(months, frozenset())
    assert "peak" not in facts and "trough" not in facts and facts["no_peak_reason"]
    assert "no_peak_reason" in SYSTEM and "tỷ lệ 5 sao" in SYSTEM
    assert _tidy("- **1. SP:** 5.202.955,05**\n- **RJ**: 1") == "- **1. SP:** 5.202.955,05\n- **RJ**: 1"


def test_a_chart_that_cannot_apply_a_filter_in_force_refuses_and_names_it(scope, monkeypatch):
    """Live 2026-10-28 (customer demo): asked about a shortfall while the report showed
    period T08, the bot summed every period (224 tỷ, not ~30 tỷ) - the chart it read could
    not apply the period filter, and the evidence still listed it as applied. A chart read
    that reports a filter in force as not applied is refused, naming it (PO: refuse)."""
    from app.services.agent_flows.tools import context
    from app.services.data_core import planner, service

    def fetch(c, chart_id, *, extra_filters=None):
        return {"columns": [P, Q, R, A], "rows": [[r[k] for k in (P, Q, R, A)] for r in ROWS],
                "filters_applied": [], "filters_not_applied": [{"field": "Kỳ", "operator": "eq", "value": "T08"}]}

    monkeypatch.setattr(context, "_fetch_chart_data", fetch)
    raw = {"status": "plan", "explore_id": 11, "dimensions": [P], "measures": [R], "time_grains": {},
           "filters": {}, "sorts": [], "covered": {"doanh thu": R, "san pham": P}, "interpretation": "x"}
    monkeypatch.setattr(service, "make_plan", lambda *a, **k: planner.validate(raw, scope.catalog()))
    out = service.ask(None, None, "Doanh thu theo sản phẩm", None, scope=scope, turn_id="t" * 32)
    assert out["status"] == "refused" and out["code"] == "filter_not_applied", out
    assert "Kỳ" in out["message"] and "T08" in out["message"] and "Doanh thu theo sản phẩm" in out["message"]
    assert "rows" not in out and "answer" not in out


def test_the_evidence_lists_the_filters_the_chart_ran_with_not_the_links_list(scope, monkeypatch):
    """The evidence named the link's global filters - a filter the chart had not applied
    read as applied. It now names what THIS chart's read applied."""
    from app.services.agent_flows.tools import context

    def fetch(c, chart_id, *, extra_filters=None):
        return {"columns": [P, Q, R, A], "rows": [[r[k] for k in (P, Q, R, A)] for r in ROWS],
                "filters_applied": [{"field": "v.region", "operator": "in", "value": ["North"]}],
                "restricted_by_author": 0}

    monkeypatch.setattr(context, "_fetch_chart_data", fetch)
    result = scope.read(_plan(scope, [P], [R]), [P], [R], {}, [], {}, 500)
    ev = scope.evidence(_plan(scope, [P], [R]), result)
    assert ev["filters_applied"] == ["region in North"]           # not the link's "channel eq Online"
    assert ev["filters_withheld"] == 0 and ev["filters_dropped"] == []
