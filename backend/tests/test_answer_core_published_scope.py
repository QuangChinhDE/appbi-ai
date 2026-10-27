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
