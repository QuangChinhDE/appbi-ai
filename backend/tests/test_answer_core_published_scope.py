"""The Answer Core's scope for a public link reads the link's PUBLISHED charts only,
through the governed public chart path, and never returns a number the chart
cannot support (services/answer_core/published_report.py).

The chart read (`_fetch_chart_data`) is replaced by a recorder: what reaches it is
exactly what the governed public path would be asked for. The real path - layered
filters, locks, page bounds, exposed fields - is exercised on the live stack.
"""
from __future__ import annotations

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
        return {"columns": cols, "rows": [[r[k] for k in cols] for r in ROWS], "filters_applied": []}

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
