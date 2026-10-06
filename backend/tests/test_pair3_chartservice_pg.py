"""Pair #3 — SemanticQueryEngine ↔ ChartService, executed.

The engine decides a request's business meaning (Pair #2). ChartService routes,
filters, plans, caches, executes and reshapes it. This module asks the Pair #2
golden requests THROUGH ChartService — as saved charts, previews and charts
whose stored binding is stale / minimal / empty — on a real Postgres datasource,
and compares the returned rows (by field identity, order where it is
contractual) with the Pair #2 oracles, computed by hand from the physical rows.

Metadata lives in Postgres (DATABASE_URL) in one rolled-back transaction per
world; the datasource of every world is the same Postgres (schema p2g).
"""
from __future__ import annotations

import os

import pytest
import sqlalchemy as sa

from tests import pair2_topology as T
from tests.pair3_world import chart_config, chart_world, own_with_datasource, runtime_filters, save_chart
from tests.test_pair2_golden_topology_pg import _norm, canon


def _url():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_pair3_chartservice_pg executes SQL through ChartService; it needs Postgres "
                    f"(DATABASE_URL={url.split('@')[-1] or '<unset>'}).")
    return url


def _pg_config():
    u = sa.engine.make_url(_url())
    return {"host": u.host, "port": u.port or 5432, "database": u.database, "username": u.username,
            "password": u.password, "schema_name": T.S}


@pytest.fixture(scope="module")
def pg():
    engine = sa.create_engine(_url())
    with engine.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA IF EXISTS {T.S} CASCADE"))
        c.execute(sa.text(f"CREATE SCHEMA {T.S}"))
        for stmt in T.physical_sql("postgresql"):
            c.execute(sa.text(stmt))
    try:
        yield engine
    finally:
        with engine.begin() as c:
            c.execute(sa.text(f"DROP SCHEMA IF EXISTS {T.S} CASCADE"))
        engine.dispose()


@pytest.fixture()
def real_cache():
    """Opt-in: the REAL result cache (cleared before and after)."""
    from app.services import query_cache

    query_cache.clear_all()
    yield
    query_cache.clear_all()


@pytest.fixture(autouse=True)
def no_result_cache(monkeypatch, request):
    """Compare computations, not cache hits (a test asking for `real_cache` opts out)."""
    if "real_cache" in request.fixturenames:
        yield
        return
    from app.services import query_cache

    monkeypatch.setattr(query_cache, "get_cached", lambda *_a, **_k: None)
    monkeypatch.setattr(query_cache, "begin_coalesced_compute", lambda *_a, **_k: (None, False))
    monkeypatch.setattr(query_cache, "set_cached", lambda *_a, **_k: None)
    yield


def classify(exc):
    category = getattr(exc, "category", None)
    if category:
        return str(category)
    if isinstance(exc, ValueError):
        return T.REFUSED
    raise exc


def ask_saved(world, base, req, *, config=None, chart_type="TABLE"):
    """("rows", rows, debug) | ("error", category, exc) through GET /charts/{id}/data's service call."""
    from app.services.chart_service import ChartService

    chart = save_chart(world, base, req, chart_type=chart_type, config=config)
    try:
        out = ChartService.get_chart_data(world.db, chart.id, extra_filters=runtime_filters(req) or None)
    except Exception as exc:  # noqa: BLE001 — classified
        return "error", classify(exc), exc
    return "rows", out["data"], out.get("debug")


def ask_preview(world, base, req, *, config=None):
    from app.services.chart_service import ChartService

    try:
        out = ChartService.preview_chart_data(world.db, world.tables[base].id, "TABLE",
                                              config if config is not None else chart_config(req),
                                              extra_filters=runtime_filters(req) or None)
    except Exception as exc:  # noqa: BLE001
        return "error", classify(exc), exc
    return "rows", out["data"], out.get("debug")


def shape(req, rows):
    refs = list(req.get("dims") or []) + list(req.get("measures") or [])
    return [{ref: _norm(r.get(ref)) for ref in refs} for r in rows]


def expect(outcome, req, expected, *, ordered=False):
    kind, payload, extra = outcome
    if isinstance(expected, str):
        assert kind == "error", f"expected refusal {expected}, got rows {payload}"
        assert payload == expected or expected == T.REFUSED, f"expected {expected}, got {payload}: {extra}"
        return
    exp_rows = expected["rows"] if isinstance(expected, dict) else expected
    exp_rows = [{k: _norm(v) for k, v in r.items()} for r in exp_rows]
    assert kind == "rows", f"expected rows {exp_rows}, got refusal {payload}: {extra}"
    got = shape(req, payload)
    if ordered:
        assert got == exp_rows, f"order: {got} != {exp_rows}"
    else:
        assert canon(got) == canon(exp_rows), f"{got} != {exp_rows}"
    if isinstance(expected, dict) and "dropped" in expected:
        dropped = {d.get("semantic_field") or d.get("field") for d in (extra or {}).get("dropped_filters") or []}
        assert set(expected["dropped"]) <= dropped, f"dropped {dropped}, expected {expected['dropped']}"


# ── C-matrix: every Pair #2 golden request, through a saved chart ─────────────


@pytest.mark.parametrize("case", T.CASES + T.TOP_N, ids=[c[0] for c in T.CASES + T.TOP_N])
def test_engine_meaning_survives_the_saved_chart_path(pg, case):
    _id, model, base, req, expected = case
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        expect(ask_saved(w, base, req), req, expected, ordered=case in T.TOP_N)


@pytest.mark.parametrize("case", T.CASES + T.TOP_N, ids=[c[0] for c in T.CASES + T.TOP_N])
def test_engine_meaning_survives_the_preview_path(pg, case):
    """Explore preview (design-time) of the same request — same rows / refusal."""
    _id, model, base, req, expected = case
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        expect(ask_preview(w, base, req), req, expected, ordered=case in T.TOP_N)


# A stored binding is never the source of semantic truth: whatever the saved
# config carries (nothing, the minimal MCP shape, or a stale copy pointing at a
# model / explore / reachability that no longer exist), the chart is answered
# from the CURRENT model.
_BINDINGS = {
    "empty": lambda w, base: {},
    "minimal": lambda w, base: {"baseViewName": base, "modelId": w.model.id},
    "stale": lambda w, base: {"status": "resolved", "baseViewName": base, "exploreName": base,
                              "modelId": 999999, "exploreId": 999999, "datasetId": w.dataset.id,
                              "reachableViews": [base], "dimensionFields": [], "measureFields": []},
}
_BINDING_CASES = [c for c in T.CASES if c[0] in {
    "G1.by_product", "G2.by_region", "G3.by_region", "G5.by_owner_won_deals_both", "G6.by_year_three_facts",
    "G7.by_order_year", "G9.kpi_vip", "G12.direct_inactive.regions_base_by_region", "G2.nested_cte_filter",
    "G1.measure_filter_related_unreachable"}]


@pytest.mark.parametrize("variant", sorted(_BINDINGS))
@pytest.mark.parametrize("case", _BINDING_CASES, ids=[c[0] for c in _BINDING_CASES])
def test_a_stored_binding_never_decides_the_answer(pg, case, variant):
    _id, model, base, req, expected = case
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        cfg = chart_config(req, binding=_BINDINGS[variant](w, base))
        expect(ask_saved(w, base, req, config=cfg), req, expected)


@pytest.mark.parametrize("variant", sorted(_BINDINGS))
@pytest.mark.parametrize("case", _BINDING_CASES, ids=[c[0] for c in _BINDING_CASES])
def test_a_legacy_source_chart_is_answered_from_the_current_model(pg, case, variant):
    """A chart saved before dataset_table_id (config.source = the table): the
    binding is re-derived from that table too, never taken from the config."""
    from app.models.models import Chart, ChartType
    from app.services.chart_service import ChartService

    _id, model, base, req, expected = case
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        cfg = chart_config(req, binding=_BINDINGS[variant](w, base))
        cfg["source"] = {"kind": "dataset_table", "datasetId": w.dataset.id, "tableId": w.tables[base].id}
        c = Chart(name=f"p3 legacy {variant} {_id}", dataset_table_id=None, chart_type=ChartType("TABLE"), config=cfg)
        w.db.add(c)
        w.db.flush()
        try:
            out = ChartService.get_chart_data(w.db, c.id, extra_filters=runtime_filters(req) or None)
            outcome = ("rows", out["data"], out.get("debug"))
        except Exception as exc:  # noqa: BLE001
            outcome = ("error", classify(exc), exc)
        expect(outcome, req, expected)


# ── H3-03: a physical fallback runs the SAME meaning on the engine it compiles for ─


def _snapshot_plan(w, base, **kw):
    from app.services.execution_plan import ExecutionPlan, SnapshotState

    fields = dict(mode="snapshot", dialect="bigquery", ds_type="bigquery", exec_config={"project_id": "host"},
                  cred="host_service_account", snapshot_state=SnapshotState.FRESH,
                  overrides={w.tables[base].id: "`host.snap.t_gen7`"}, generation=7, host_id=4242,
                  dataset_id=w.dataset.id, reason="test: snapshot-backed")
    fields.update(kw)
    return ExecutionPlan(**fields)


@pytest.fixture()
def snapshot_missing(monkeypatch):
    """The snapshot table of the plan was expired by the warehouse: the FIRST
    execution (on the host) fails with a missing-relation error; every later
    one runs for real on the test Postgres, and is recorded."""
    from app.services import chart_service as cs
    from app.services import relationship_key_guard as kg
    from app.services import snapshot_service as ss
    from app.services import live_query_service as lqs
    from app.services.datasource_service import DataSourceConnectionService as DSC

    calls = []
    real = DSC.execute_query

    def _execute(ds_type, config, sql, *a, **k):
        calls.append({"ds_type": ds_type, "sql": sql, "config": config})
        if len(calls) == 1:
            raise RuntimeError("404 Not found: Table host:snap.t_gen7 was not found in location US")
        return real(ds_type, config, sql, *a, **k)

    monkeypatch.setattr(DSC, "execute_query", staticmethod(_execute))
    monkeypatch.setattr(kg, "verify_key_probes", lambda *_a, **_k: None)
    monkeypatch.setattr(ss, "trigger_async_refresh", lambda *_a, **_k: None)
    monkeypatch.setattr(lqs, "_estimate_bigquery_bytes", lambda *_a, **_k: 0)
    return calls, cs


def test_a_live_fallback_runs_on_the_source_engine_with_the_source_dialect(pg, snapshot_missing, monkeypatch):
    """Legacy (unpublished) dataset served from a BigQuery materialization host:
    the snapshot table vanished → the documented fallback serves LIVE + rebuild.
    The live statement must be compiled for the SOURCE's dialect and executed
    as the source's engine — it used to reuse the host's BigQuery compilation
    and engine type with the source credential (a Postgres / Sheets / MySQL
    dataset then failed, or ran BigQuery SQL on a non-BigQuery connection)."""
    calls, cs = snapshot_missing
    case = next(c for c in T.CASES if c[0] == "G2.by_region")
    _id, model, base, req, expected = case
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        monkeypatch.setattr(cs, "plan_chart_execution", lambda *_a, **_k: _snapshot_plan(w, base))
        outcome = ask_saved(w, base, req)
        assert [c["ds_type"] for c in calls] == ["bigquery", "postgresql"], [c["ds_type"] for c in calls]
        assert "`" not in calls[1]["sql"], calls[1]["sql"]
        expect(outcome, req, expected)
        assert outcome[2]["execution_state"] == "live_fallback" if isinstance(outcome[2], dict) else True


def test_a_published_snapshot_never_falls_back(pg, snapshot_missing, monkeypatch):
    """Published generation N missing at execute → refused (re-sync), never
    live, never another generation."""
    calls, cs = snapshot_missing
    case = next(c for c in T.CASES if c[0] == "G2.by_region")
    _id, model, base, req, _expected = case
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        monkeypatch.setattr(cs, "plan_chart_execution", lambda *_a, **_k: _snapshot_plan(w, base, published=True))
        kind, payload, exc = ask_saved(w, base, req)
        assert kind == "error" and "Sync & Publish" in str(exc), (kind, payload)
        assert [c["ds_type"] for c in calls] == ["bigquery"], "no second (live / other generation) execution"


# ── H3-07: the result cache never outlives the meaning it was computed for ─────



def _rows(world, base, req, **kw):
    kind, payload, extra = ask_saved(world, base, req, **kw)
    return (kind, shape(req, payload) if kind == "rows" else payload)


def test_a_relationship_edit_is_seen_by_the_next_identical_request(pg, real_cache):
    """Cached under the customer's-region meaning; the sale's own region
    relationship is switched on → two meanings: the next identical request is
    refused, not served the cached rows (and switched off again → rows)."""
    from sqlalchemy.orm.attributes import flag_modified
    from app.models.semantic import SemanticExplore

    req = {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G12_direct_inactive", ds_config=_pg_config()) as w:
        chart = save_chart(w, "p2_sales", req)
        from app.services.chart_service import ChartService

        first = shape(req, ChartService.get_chart_data(w.db, chart.id)["data"])
        assert canon(first) == canon([{"p2_regions.name": "North", "p2_sales.revenue": 130},
                                      {"p2_regions.name": "South", "p2_sales.revenue": 61},
                                      {"p2_regions.name": None, "p2_sales.revenue": 7}])
        ex = w.db.query(SemanticExplore).filter_by(model_id=w.model.id, base_view_name="p2_sales").one()
        ex.joins = [{**j, "is_active": True} for j in ex.joins]
        flag_modified(ex, "joins")
        w.db.flush()
        with pytest.raises(ValueError) as refused:
            ChartService.get_chart_data(w.db, chart.id)
        assert getattr(refused.value, "category", None) == T.AMBIGUOUS


def test_a_measure_edit_is_seen_by_the_next_identical_request(pg, real_cache):
    from sqlalchemy.orm.attributes import flag_modified
    from app.services.chart_service import ChartService

    req = {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        chart = save_chart(w, "p2_sales", req)
        before = shape(req, ChartService.get_chart_data(w.db, chart.id)["data"])
        assert canon(before) == canon([{"p2_products.name": "Pen", "p2_sales.revenue": 141},
                                       {"p2_products.name": "Ink", "p2_sales.revenue": 57}])
        v = w.views["p2_sales"]
        v.measures = [({**m, "type": "max"} if m["name"] == "revenue" else m) for m in v.measures]
        flag_modified(v, "measures")
        w.db.flush()
        after = shape(req, ChartService.get_chart_data(w.db, chart.id)["data"])
        assert canon(after) == canon([{"p2_products.name": "Pen", "p2_sales.revenue": 100},
                                      {"p2_products.name": "Ink", "p2_sales.revenue": 50}])


def test_a_changed_filter_is_never_served_the_other_filters_result(pg, real_cache):
    from app.services.chart_service import ChartService

    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    flt = lambda v: [{"field": "p2_products.name", "semanticField": "p2_products.name", "operator": "eq", "value": v}]  # noqa: E731
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        chart = save_chart(w, "p2_sales", req)
        got = [shape(req, ChartService.get_chart_data(w.db, chart.id, extra_filters=fl)["data"])
               for fl in (flt("Pen"), flt("Ink"), None, flt("Pen"))]
        assert got == [[{"p2_sales.revenue": 141}], [{"p2_sales.revenue": 57}], [{"p2_sales.revenue": 198}],
                       [{"p2_sales.revenue": 141}]]


@pytest.mark.parametrize("change", ["generation", "security_scope", "host"])
def test_a_new_generation_scope_or_host_never_reuses_the_cached_result(pg, real_cache, monkeypatch, change):
    """Generation N cached; N+1 published (or another security scope / host) →
    the same request is computed again, never served N's result."""
    from app.services import chart_service as cs
    from app.services import relationship_key_guard as kg
    from app.services import live_query_service as lqs
    from app.services.datasource_service import DataSourceConnectionService as DSC

    served = []

    def _execute(ds_type, config, sql, *a, **k):
        served.append(len(served) + 1)
        return ["p2_sales_revenue"], [{"p2_sales_revenue": 1000 * len(served)}], 1.0

    monkeypatch.setattr(DSC, "execute_query", staticmethod(_execute))
    monkeypatch.setattr(kg, "verify_key_probes", lambda *_a, **_k: None)
    monkeypatch.setattr(lqs, "_estimate_bigquery_bytes", lambda *_a, **_k: 0)
    req = {"dims": [], "measures": ["p2_sales.revenue"]}
    variants = {"generation": [dict(generation=7), dict(generation=8)],
                "security_scope": [dict(security_scope="shared"), dict(security_scope="tenant:a")],
                "host": [dict(host_id=4242), dict(host_id=4343)]}[change]
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        chart = save_chart(w, "p2_sales", req)
        out = []
        for kw in variants + variants[:1]:
            monkeypatch.setattr(cs, "plan_chart_execution", lambda *_a, _kw=kw, **_k: _snapshot_plan(w, "p2_sales", **_kw))
            out.append(cs.ChartService.get_chart_data(w.db, chart.id)["data"][0]["p2_sales.revenue"])
        # N computed (1000), N+1 computed (2000), N again → its own cached result (1000), not N+1's
        assert out == [1000, 2000, 1000], out
        assert served == [1, 2]


# ── H3-11: a chart's aggregation never reinterprets a semantic measure ─────────

_MEASURES = [
    {"name": "n_cust", "type": "count_distinct", "sql": "${TABLE}.customer_id"},
    {"name": "avg_amt", "type": "avg", "sql": "${TABLE}.amount"},
    {"name": "n_sales", "type": "count", "sql": "*"},
    {"name": "per_sale", "type": "sum", "expression": "${revenue} * 1.0 / NULLIF(${n_sales}, 0)",
     "depends_on": ["revenue", "n_sales"]},
]
# by product (Pen: sales 1, 3, 5 — customers 1, 3, 2; Ink: sales 2, 4 — customers 2, NULL)
_BY_PRODUCT = {
    "p2_sales.n_cust": {"Pen": 3, "Ink": 1},
    "p2_sales.avg_amt": {"Pen": 47, "Ink": 28.5},
    "p2_sales.per_sale": {"Pen": 47, "Ink": 28.5},
    "p2_sales.rev_pct": {"Pen": round(141 / 198 * 100, 6), "Ink": round(57 / 198 * 100, 6)},
    "p2_sales.pen_rev": {"Pen": 141, "Ink": None},
}


def _with_measures(w):
    from sqlalchemy.orm.attributes import flag_modified

    v = w.views["p2_sales"]
    v.measures = list(v.measures) + _MEASURES
    flag_modified(v, "measures")
    w.db.flush()


@pytest.mark.parametrize("measure", sorted(_BY_PRODUCT))
def test_agg_auto_renders_the_declared_measure(pg, measure):
    req = {"dims": ["p2_products.name"], "measures": [measure]}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        _with_measures(w)
        kind, payload, extra = ask_saved(w, "p2_sales", req)
        assert kind == "rows", extra
        got = {r["p2_products.name"]: _norm(r.get(measure)) for r in shape(req, payload)}
        assert got == {k: _norm(v) for k, v in _BY_PRODUCT[measure].items()}, got


@pytest.mark.parametrize("measure", sorted(_BY_PRODUCT))
def test_a_what_if_measure_swap_keeps_the_new_measures_own_aggregation(pg, measure):
    """A dashboard parameter swaps the chart's first measure (a plain SUM of a
    column) for a declared semantic measure: the swapped-in measure renders by
    ITS type — the old metric's "sum" is not carried onto it."""
    from app.services.chart_service import ChartService

    req = {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        _with_measures(w)
        cfg = chart_config(req)
        cfg["roleConfig"]["metrics"] = [{"field": "p2_sales.revenue", "agg": "sum"}]
        chart = save_chart(w, "p2_sales", req, config=cfg)
        out = ChartService.get_chart_data(w.db, chart.id, role_overrides={"metric": measure})
        got = {r["p2_products.name"]: _norm(r.get(measure)) for r in out["data"]}
        assert got == {k: _norm(v) for k, v in _BY_PRODUCT[measure].items()}, got


# ── H3-09: reshaping never swaps one field's values onto another ──────────────


def test_two_fields_whose_aliases_collide_never_share_values(pg):
    """`C name` (a Sheets-style header) and `C_name` sanitize to the same SQL
    alias. Each field must come back with ITS values — or the request refused —
    never one column's values under both names."""
    from sqlalchemy.orm.attributes import flag_modified

    req = {"dims": ["p2_customers.C name", "p2_customers.C_name"], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        v = w.views["p2_customers"]
        v.dimensions = list(v.dimensions) + [
            {"name": "C name", "type": "string", "sql": "${TABLE}.name"},
            {"name": "C_name", "type": "number", "sql": "${TABLE}.region_id"}]
        flag_modified(v, "dimensions")
        w.db.flush()
        kind, payload, extra = ask_saved(w, "p2_sales", req)
        if kind == "error":
            assert payload in (T.REFUSED, "UNSUPPORTED_CONTEXT"), (payload, extra)
            return
        assert canon(shape(req, payload)) == canon([
            {"p2_customers.C name": "C1", "p2_customers.C_name": 1, "p2_sales.revenue": 100},
            {"p2_customers.C name": "C2", "p2_customers.C_name": 2, "p2_sales.revenue": 61},
            {"p2_customers.C name": "C3", "p2_customers.C_name": 1, "p2_sales.revenue": 30},
            {"p2_customers.C name": None, "p2_customers.C_name": None, "p2_sales.revenue": 7}]), payload


def test_values_keep_their_field_identity_across_two_numeric_measures(pg):
    """revenue=141 / n=3 must not pass an oracle that would also accept the
    swapped pair: compared by field → value, per row."""
    req = {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue", "p2_customers.n"]}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        kind, payload, extra = ask_saved(w, "p2_sales", req)
        if kind == "error":   # a measure of another table under a product grouping: its own rule
            return
        for row in shape(req, payload):
            assert row["p2_sales.revenue"] in (141, 57), row


def test_a_field_named_with_capitals_keeps_its_values_on_postgres(pg):
    """Postgres folds an unquoted SQL alias to lower case: a dimension
    `Customer Name` / a measure `Revenue` came back under `..._customer_name` /
    `..._revenue` and the chart's own field was MISSING from every row."""
    from sqlalchemy.orm.attributes import flag_modified

    req = {"dims": ["p2_customers.Customer Name"], "measures": ["p2_sales.Revenue"]}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        c, s = w.views["p2_customers"], w.views["p2_sales"]
        c.dimensions = list(c.dimensions) + [{"name": "Customer Name", "type": "string", "sql": "${TABLE}.name"}]
        s.measures = list(s.measures) + [{"name": "Revenue", "type": "sum", "sql": "${TABLE}.amount"}]
        flag_modified(c, "dimensions")
        flag_modified(s, "measures")
        w.db.flush()
        expect(ask_saved(w, "p2_sales", req), req, [
            {"p2_customers.Customer Name": "C1", "p2_sales.Revenue": 100},
            {"p2_customers.Customer Name": "C2", "p2_sales.Revenue": 61},
            {"p2_customers.Customer Name": "C3", "p2_sales.Revenue": 30},
            {"p2_customers.Customer Name": None, "p2_sales.Revenue": 7}])


# ── H3-17: the refusal category survives the HTTP boundary ─────────────────────


@pytest.fixture()
def http(pg):
    import uuid as _uuid

    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.core.dependencies import get_current_user
    from app.main import app

    holder = {}
    admin = type("U", (), {"id": _uuid.UUID(int=7), "email": "p3@x", "is_active": True,
                           "permissions": {"settings": "full", "explore_charts": "full", "datasets": "full"}})()
    app.dependency_overrides[get_db] = lambda: holder["db"]
    app.dependency_overrides[get_current_user] = lambda: admin
    try:
        yield TestClient(app), holder
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.parametrize("case_id,category", [("G3.by_region", "AMBIGUOUS_ROUTE"),
                                               ("G14.lattice_select", "ROUTE_LIMIT"),
                                               ("G9.by_tag", None)])
def test_a_refused_chart_carries_its_category_over_http(pg, http, case_id, category):
    client, holder = http
    case = next((c for c in T.CASES if c[0] == case_id), None)
    if case is None:
        pytest.skip(f"{case_id} not in the topology")
    _id, model, base, req, expected = case
    if not isinstance(expected, str):
        pytest.skip("not a refusal case")
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, base, req)
        r = client.get(f"/api/v1/charts/{chart.id}/data")
        assert r.status_code == 400, r.text
        assert r.headers.get("X-AppBI-Refusal") == (category or expected), (r.headers, r.text)
        p = client.post("/api/v1/charts/preview-data", json={
            "dataset_table_id": w.tables[base].id, "chart_type": "TABLE", "config": chart_config(req)})
        assert p.status_code == 400 and p.headers.get("X-AppBI-Refusal") == (category or expected), p.text


def test_a_batch_tile_reports_its_refusal_category(pg, monkeypatch):
    from app.services.chart_service import ChartService

    case = next(c for c in T.CASES if c[0] == "G3.by_region")
    _id, model, base, req, _expected = case
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        chart = save_chart(w, base, req)
        monkeypatch.setattr("app.core.database.SessionLocal", lambda: _NoClose(w.db))
        [item] = ChartService.get_charts_data_batch([{"chart_id": chart.id}])
        assert item["ok"] is False and item["status"] == 400 and item["category"] == "AMBIGUOUS_ROUTE", item


class _NoClose:
    """The world's session for a batch worker thread (closed by the world)."""

    def __init__(self, db):
        self._db = db

    def __getattr__(self, name):
        return getattr(self._db, name)

    def close(self):
        pass


# ── H3-16: generated and custom query modes never stand in for each other ──────

_CUSTOM_SQL = (f"SELECT p.name AS product, s.amount AS amount FROM {T.S}.sales s "
               f"LEFT JOIN {T.S}.products p ON p.id = s.product_id")


def test_a_generated_chart_ignores_leftover_custom_sql(pg):
    """A chart switched back to generated mode still carries its old SQL: the
    SEMANTIC meaning answers (and a semantic refusal stays a refusal — the SQL
    lying in the config is never run instead)."""
    ok = next(c for c in T.CASES if c[0] == "G1.by_product")
    bad = next(c for c in T.CASES if c[0] == "G3.by_region")
    for (_id, model, base, req, expected) in (ok, bad):
        with chart_world(pg, model, ds_config=_pg_config()) as w:
            cfg = chart_config(req)
            cfg.update({"queryMode": "generated", "customSql": _CUSTOM_SQL,
                        "customRoleConfig": {"dimension": "product", "metrics": [{"field": "amount", "agg": "sum"}]}})
            outcome = ask_saved(w, base, req, config=cfg)
            expect(outcome, req, expected)
            if outcome[0] == "rows":
                assert outcome[2]["routing"] == "semantic_engine", outcome[2]


def test_a_custom_sql_chart_runs_its_own_sql_and_says_so(pg):
    from app.services.chart_service import ChartService

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        cfg = {"queryMode": "custom", "customSql": _CUSTOM_SQL,
               "customRoleConfig": {"dimension": "product", "metrics": [{"field": "amount", "agg": "sum"}]},
               "roleConfig": {"dimension": "p2_regions.name", "metrics": [{"field": "p2_sales.revenue", "agg": "auto"}]}}
        chart = save_chart(w, "p2_sales", {}, chart_type="BAR", config=cfg)
        own_with_datasource(w, chart)  # custom SQL runs under its owner's datasource right
        out = ChartService.get_chart_data(w.db, chart.id)
        rows = {r.get("product"): _norm(r.get("sum__amount")) for r in out["data"]}  # the live contract: agg__column
        assert rows == {"Pen": 141, "Ink": 57}, out["data"]
        assert (out.get("debug") or {}).get("routing") != "semantic_engine", out.get("debug")


# ── H3-04 / H3-05: filter layers merge by semantic scope; no complete filter
#    disappears without the policy saying so ─────────────────────────────────


def _f(ref, op, value, **kw):
    return {"field": ref, "semanticField": ref, "operator": op, "value": value, **kw}


def _kpi(w, runtime, *, base_filters=None, req=None):
    from app.services.chart_service import ChartService

    req = req or {"dims": [], "measures": ["p2_sales.revenue"]}
    cfg = chart_config(req)
    if base_filters is not None:
        cfg["filters"] = base_filters
    chart = save_chart(w, "p2_sales", req, config=cfg)
    out = ChartService.get_chart_data(w.db, chart.id, extra_filters=runtime)
    return shape(req, out["data"]), (out.get("debug") or {}).get("dropped_filters") or []


_MERGE = [
    # the chart's saved filter is the author's HARD constraint: AND-ed with the runtime one, never replaced
    ("base_and_runtime_same_field", [_f("p2_products.name", "eq", "Ink")], [_f("p2_products.name", "eq", "Pen")],
     [{"p2_sales.revenue": None}]),
    # the same BARE column name on two views: two filters, never one replacing the other
    ("same_bare_name_two_views", [_f("p2_customers.name", "eq", "C2"), _f("p2_products.name", "eq", "Pen")], None,
     [{"p2_sales.revenue": 11}]),
    ("base_and_runtime_same_bare_name", [_f("p2_products.name", "eq", "Pen")], [_f("p2_customers.name", "eq", "C2")],
     [{"p2_sales.revenue": 11}]),
    # two filters on one related view hold together
    ("two_filters_one_view", [_f("p2_products.name", "in", ["Pen", "Ink"]), _f("p2_products.id", "eq", 2)], None,
     [{"p2_sales.revenue": 57}]),
    # NULL contract: a sale with no customer passes no predicate on the customer — IS NULL included
    ("null_filter", [_f("p2_customers.name", "is_null", None)], None, [{"p2_sales.revenue": None}]),
    ("not_null_filter", [_f("p2_customers.name", "is_not_null", None)], None, [{"p2_sales.revenue": 191}]),
    # an incomplete filter (no value yet — a cleared slicer) is not a filter
    ("incomplete_is_no_filter", [_f("p2_products.name", "eq", "")], None, [{"p2_sales.revenue": 198}]),
]


@pytest.mark.parametrize("name,runtime,base,expected", _MERGE, ids=[m[0] for m in _MERGE])
def test_filter_layers_merge_by_semantic_scope(pg, name, runtime, base, expected):
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        rows, _dropped = _kpi(w, runtime, base_filters=base)
        assert rows == expected, rows


def test_a_measure_filter_restricts_the_groups_not_the_rows(pg):
    req = {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        rows, _d = _kpi(w, [_f("p2_sales.revenue", "gt", 100)], req=req)
        assert rows == [{"p2_products.name": "Pen", "p2_sales.revenue": 141}], rows


@pytest.mark.parametrize("filt,reason", [
    (_f("p2_products.nope", "eq", 1), "unknown"),
    (_f("p2_products.name", "eq", "Pen", datasetId=987654), "dataset_mismatch"),
    (_f("p2_products.name", "regex_like", "P.*"), "operator"),
])
def test_a_complete_filter_that_cannot_apply_is_refused(pg, filt, reason):
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        with pytest.raises(ValueError):
            _kpi(w, [filt])


def test_an_unrelated_filter_is_left_out_and_recorded(pg):
    """PowerBI parity: a filter on a table the chart's fact is not related to
    is ignored — and the response says so (`dropped_filters`); an
    authoritative one is refused."""
    from app.services.chart_contracts import AuthoritativeFilterNotApplied

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        rows, dropped = _kpi(w, [_f("p2_tags.label", "eq", "VIP")])
        assert rows == [{"p2_sales.revenue": 198}]
        assert [(d.get("semantic_field") or d.get("field"), d.get("reason")) for d in dropped] == [
            ("p2_tags.label", "unreachable_view")], dropped
        with pytest.raises(AuthoritativeFilterNotApplied):
            _kpi(w, [_f("p2_tags.label", "eq", "VIP", _authoritative=True)])


# ── H3-12: where both can answer, the live adapter and the engine keep the same rows

_ADAPTER_PARITY = [
    # (id, model, base, key column, filter)
    ("forward_dim", "G1_star", "p2_sales", "id", _f("p2_customers.name", "eq", "C2")),
    ("forward_two_hops", "G2_snowflake", "p2_sales", "id", _f("p2_regions.name", "eq", "North")),
    ("role_alias", "G3_diamond_alias", "p2_sales", "id", _f("store_region.name", "eq", "North")),
    ("reverse_both", "G1_star_both", "p2_customers", "id", _f("p2_sales.store_id", "eq", 2)),
    ("reverse_single_left_out", "G1_star", "p2_customers", "id", _f("p2_sales.store_id", "eq", 2)),
    ("galaxy_shared_dims", "G5_galaxy_both", "p2_revenue", "id", _f("p2_deals.stage", "eq", "Won")),
    ("composite_key", "G8_composite", "p2_c_sales", "store_code", _f("p2_c_regions.label", "eq", "North")),
]


@pytest.mark.parametrize("pid,model,base,key,flt", _ADAPTER_PARITY, ids=[p[0] for p in _ADAPTER_PARITY])
def test_the_live_adapter_and_the_engine_keep_the_same_rows(pg, pid, model, base, key, flt):
    from app.services import chart_service as cs
    from app.services.live_query_service import _build_where_clause

    with chart_world(pg, model, ds_config=_pg_config()) as w:
        # the engine (saved chart, dims-only: the base's key, one row per base row)
        req = {"dims": [f"{base}.{key}"], "measures": []}
        cfg = chart_config(req)
        if key not in {d["name"] for d in w.views[base].dimensions}:
            pytest.skip("no key dimension")
        chart = save_chart(w, base, req, config=cfg)
        diag_engine: list = []
        out = cs.ChartService.get_chart_data(w.db, chart.id, extra_filters=[flt])
        engine_keys = sorted(_norm(r.get(f"{base}.{key}")) for r in out["data"])
        diag_engine = [d.get("reason") for d in (out.get("debug") or {}).get("dropped_filters") or []]
        # the live adapter on the same base table
        binding = cs.with_chart_semantic_binding(w.db, w.tables[base].id, {}, auto_generate=False)["semanticBinding"]
        diag_live: list = []
        sql, eff = cs._adapt_live_sql_for_semantic_filters(
            w.db, w.ds, w.tables[base], {"semanticBinding": binding}, [flt], diagnostics=diag_live)
        relation = sql or f"SELECT * FROM {T.S}.{w.tables[base].source_table_name.split('.', 1)[1]}"
        where = _build_where_clause(eff, "postgresql")
        with pg.connect() as c:
            live_keys = sorted(_norm(r[0]) for r in c.execute(sa.text(
                f"SELECT DISTINCT t.{key} FROM ({relation}) AS t" + (f" WHERE {where}" if where else ""))).fetchall())
        assert live_keys == sorted(set(engine_keys)), (live_keys, engine_keys)
        assert ("unreachable_view" in diag_engine) == ("unreachable_view" in [d.get("reason") for d in diag_live]), (
            diag_engine, diag_live)


# ── metamorphic: equivalent representations give the same answer ──────────────

_PERMUTABLE = [c for c in T.CASES if len(c[3].get("dims") or []) + len(c[3].get("measures") or []) > 1
               or len(c[3].get("filters") or {}) > 1]


@pytest.mark.parametrize("case", _PERMUTABLE, ids=[c[0] for c in _PERMUTABLE])
def test_field_measure_and_filter_order_never_change_the_answer(pg, case):
    _id, model, base, req, expected = case
    rev = {**req, "dims": list(reversed(req.get("dims") or [])), "measures": list(reversed(req.get("measures") or [])),
           "filters": dict(reversed(list((req.get("filters") or {}).items())))}
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        expect(ask_saved(w, base, rev), req, expected)
        hydrated = __import__("app.services.chart_semantic_service", fromlist=["x"]).with_chart_semantic_binding(
            w.db, w.tables[base].id, chart_config(req), auto_generate=False)
        expect(ask_saved(w, base, req, config=hydrated), req, expected)   # saved WITH the hydrated binding


@pytest.mark.parametrize("case", [c for c in T.CASES if c[0] in {"G5.by_owner_won_deals_both", "G7.by_order_year",
                                                                  "G2.by_region"}], ids=lambda c: c[0])
def test_a_cache_hit_and_a_fresh_computation_agree(pg, real_cache, case):
    from app.services import query_cache

    _id, model, base, req, expected = case
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        expect(ask_saved(w, base, req), req, expected)     # computed, cached
        expect(ask_saved(w, base, req), req, expected)     # the same chart config again (hit)
        query_cache.clear_all()
        expect(ask_saved(w, base, req), req, expected)     # fresh after a clear


# ── the generated calendar on MySQL (executed in the manual MySQL matrix) ─────


@pytest.mark.parametrize("rng", [{}, {"start_date": "2024-01-01", "end_date": "2024-01-01"},
                                 {"start_date": "1900-01-01", "end_date": "2199-12-31"}])
def test_the_mysql_calendar_is_not_a_deep_recursion_and_quotes_its_reserved_alias(rng):
    """MySQL aborts a recursive CTE after cte_max_recursion_depth (1000)
    iterations — the default 2000-2100 calendar (36 890 days) failed every
    calendar query — and YEAR_MONTH is a reserved word."""
    import re as _re

    from app.services.dataset_calendar_service import build_calendar_live_sql, normalize_calendar_dimension_settings

    import datetime as _dt

    settings = normalize_calendar_dimension_settings(rng, enabled_default=True)
    days = (_dt.date.fromisoformat(settings["end_date"]) - _dt.date.fromisoformat(settings["start_date"])).days + 1
    sql = build_calendar_live_sql(settings, "mysql")
    assert "RECURSIVE" not in sql.upper(), sql[:200]
    assert "AS `year_month`" in sql
    digits = len(_re.findall(r"\) AS d\d+", sql))
    assert 10 ** digits >= days, (digits, days)       # enough digit tables for every day of the range
    assert f"<= {days - 1}" in sql                    # and no day past end_date


# ── independent-sweep regressions ──────────────────────────────────────────────


@pytest.mark.parametrize("model,ref,value", [
    # regions related ONLY under the alias `cust_region`: "p2_regions.name" is ambiguous, not unrelated
    ("G16_alias_only", "p2_regions.name", "South"),
    # a raw calendar ref the role rewrite cannot place is not an unrelated table
    ("G1_star", "p2_cal.year", 2024),
])
def test_an_alias_only_or_calendar_view_filter_is_refused_not_ignored(pg, model, ref, value):
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        with pytest.raises(ValueError):
            _kpi(w, [_f(ref, "eq", value)])


def test_is_null_on_a_computed_dimension_follows_the_null_contract(pg):
    """`COALESCE(name, 'Unassigned')` is never NULL; the sale with no customer
    passes no predicate (NULL contract)."""
    from sqlalchemy.orm.attributes import flag_modified

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        v = w.views["p2_customers"]
        v.dimensions = list(v.dimensions) + [{"name": "seg", "type": "string",
                                              "sql": "COALESCE(${TABLE}.name, 'Unassigned')"}]
        flag_modified(v, "dimensions")
        w.db.flush()
        rows, _d = _kpi(w, [_f("p2_customers.seg", "is_null", None)])
        assert rows == [{"p2_sales.revenue": None}], rows


def test_a_measure_level_is_null_filter_follows_the_null_contract(pg):
    """The same NULL contract inside a measure-level (CALCULATE-style) filter."""
    from sqlalchemy.orm.attributes import flag_modified

    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        v = w.views["p2_sales"]
        v.measures = list(v.measures) + [{"name": "orphan_rev", "type": "sum", "sql": "${TABLE}.amount",
                                          "filters": [{"field": "p2_customers.name", "operator": "is_null"}]}]
        flag_modified(v, "measures")
        w.db.flush()
        rows, _d = _kpi(w, None, req={"dims": [], "measures": ["p2_sales.orphan_rev"]})
        assert rows == [{"p2_sales.orphan_rev": None}], rows


def test_a_legacy_charts_what_if_swap_renders_the_declared_measure(pg):
    from app.models.models import Chart, ChartType
    from app.services.chart_service import ChartService

    req = {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]}
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        _with_measures(w)
        cfg = chart_config(req)
        cfg["roleConfig"]["metrics"] = [{"field": "p2_sales.revenue", "agg": "sum"}]
        cfg["source"] = {"kind": "dataset_table", "datasetId": w.dataset.id, "tableId": w.tables["p2_sales"].id}
        c = Chart(name="p3 legacy what-if", dataset_table_id=None, chart_type=ChartType("TABLE"), config=cfg)
        w.db.add(c)
        w.db.flush()
        out = ChartService.get_chart_data(w.db, c.id, role_overrides={"metric": "p2_sales.n_cust"})
        got = {r["p2_products.name"]: _norm(r.get("p2_sales.n_cust")) for r in out["data"]}
        assert got == {"Pen": 3, "Ink": 1}, got
