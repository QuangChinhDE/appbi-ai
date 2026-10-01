"""Pair #2 — SemanticJoinResolver ↔ SemanticQueryEngine, executed.

ONE semantic request has ONE business interpretation. Every topology in
tests/pair2_topology.py (star, snowflake, role diamond, chasm, galaxy, three
facts, role-playing dates, composite key, M:N bridge, NULL keys, ties) is
queried through the engine and EXECUTED — on Postgres and on DuckDB (the engine
of Google Sheets / manual tables); rows are compared by field identity with
oracles computed by hand from the physical rows — never with generated SQL.

Then the same requests are re-asked under permutations that must not change
the answer (metamorphic): relationship storage order, explore order, measure /
dimension / filter order, a fresh resolver graph and the resolver's node-set
iteration order (what a process restart does to a set). A request that is
ambiguous is refused in every permutation; one that is determined gives the
same rows in every one. Refusals carry a category (SemanticRefusal.category).

Metadata lives in Postgres (DATABASE_URL), in one rolled-back transaction per
test; CI runs this module in `integration-golden`.
"""
from __future__ import annotations

import contextlib
import datetime
import decimal
import os
import types
import uuid

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.services.semantic_join_resolver import AmbiguousJoinPathError
from app.services.semantic_query_engine import SemanticQueryEngine
from tests import pair2_topology as T


def _url():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_pair2_golden_topology_pg executes SQL; it needs Postgres "
                    f"(DATABASE_URL={url.split('@')[-1] or '<unset>'}). It is not a unit test.")
    return url


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


@pytest.fixture(scope="module")
def duck():
    import duckdb

    con = duckdb.connect(":memory:")
    con.execute(f"CREATE SCHEMA {T.S}")
    for stmt in T.physical_sql("duckdb"):
        con.execute(stmt)
    try:
        yield con
    finally:
        con.close()


def _build_models(db, models: dict, views: dict, *, reverse: bool) -> dict:
    """Persist each model; `reverse` stores explores AND every join list in the
    opposite order (same graph, different storage / discovery order)."""
    out = {}
    for key, explores in models.items():
        m = SemanticModel(name=f"p2_{key}_{'rev' if reverse else 'fwd'}_{uuid.uuid4().hex[:6]}")
        if key.startswith("TZ_"):
            from app.models.dataset import Dataset

            ds = Dataset(name=f"p2_tz_{uuid.uuid4().hex[:6]}",
                         settings={"calendar_dimension": {"timezone": "Asia/Ho_Chi_Minh"}})
            db.add(ds)
            db.flush()
            m.dataset_id = ds.id
        db.add(m)
        db.flush()
        items = list(explores.items())
        for base, joins in (reversed(items) if reverse else items):
            db.add(SemanticExplore(name=base, model_id=m.id, base_view_id=views[base].id, base_view_name=base,
                                   joins=list(reversed(joins)) if reverse else list(joins)))
            db.flush()
        out[key] = m.id
    return out


def _pg_execute(conn, sql):
    with conn.begin_nested():
        result = conn.execute(sa.text(sql))
        return list(result.keys()), result.fetchall()


@contextlib.contextmanager
def make_world(pg_engine, dialect: str, execute=None):
    """Metadata (views with `dialect` relations, every model stored forward and
    reversed) in one rolled-back Postgres transaction. `execute(sql)` runs the
    generated SQL on the dialect's database → (column names, rows)."""
    conn = pg_engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        views = {}
        for name, (spec, dims, measures) in T.VIEWS.items():
            v = SemanticView(name=name, sql_table_name=T.view_relation(spec, dialect), dataset_table_id=None,
                             dimensions=dims, measures=measures)
            db.add(v)
            views[name] = v
        db.flush()

        class _Models(dict):
            """Each model persisted the first time a test asks for it."""

            def __init__(self, reverse):
                super().__init__()
                self.reverse = reverse

            def __missing__(self, key):
                self[key] = _build_models(db, {key: T.MODELS[key]}, views, reverse=self.reverse)[key]
                return self[key]

        fwd, rev = _Models(False), _Models(True)
        yield types.SimpleNamespace(db=db, conn=conn, fwd=fwd, rev=rev, dialect=dialect, last_plan=None,
                                    execute=execute or (lambda sql: _pg_execute(conn, sql)))
    finally:
        db.close()
        outer.rollback()
        conn.close()


@pytest.fixture()
def world(pg):
    with make_world(pg, "postgresql") as w:
        yield w


@pytest.fixture()
def world_duck(pg, duck):
    def _execute(sql):
        cur = duck.execute(sql)
        return [d[0] for d in cur.description], cur.fetchall()

    with make_world(pg, "duckdb", _execute) as w:
        yield w


def _norm(v):
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()[:10]
    if isinstance(v, decimal.Decimal):
        v = int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, float):
        return int(v) if v.is_integer() else round(v, 6)
    return v


def classify(exc: Exception) -> str:
    if isinstance(exc, AmbiguousJoinPathError):
        return T.AMBIGUOUS
    category = getattr(exc, "category", None)
    if category:
        return str(category)
    if isinstance(exc, ValueError):
        return T.REFUSED
    raise exc


def generate(world, model_key, base, req, *, reverse=False):
    """(engine, sql) or (engine, exception)."""
    eng = SemanticQueryEngine(world.db, database_type=world.dialect)
    try:
        sql, _cols, _ = eng.generate_sql(
            explore_name=base, dimensions=list(req.get("dims") or []), measures=list(req.get("measures") or []),
            filters=dict(req.get("filters") or {}), sorts=req.get("sorts") or [], top_n=req.get("top_n"),
            limit=req.get("limit") or 10_000_000, time_grains=dict(req.get("time_grains") or {}),
            model_id=(world.rev if reverse else world.fwd)[model_key],
        )
    except Exception as exc:  # noqa: BLE001 — classified by the caller
        return eng, exc
    return eng, sql


def shape(eng, req, names, raw):
    """Rows keyed by field ref (by column IDENTITY, not position)."""
    raw = [dict(zip(names, r)) for r in raw]
    refs = list(req.get("dims") or []) + list(req.get("measures") or [])
    rows = [{ref: _norm(r.get(eng._safe_alias(ref))) for ref in refs} for r in raw]
    dropped = tuple(sorted({d.get("field") for d in (getattr(eng, "_propagation_drops", None) or [])}))
    return rows, dropped


def run(world, model_key, base, req, *, reverse=False):
    """("rows", rows by field ref, dropped filter fields) or ("error", category, ())."""
    eng, sql = generate(world, model_key, base, req, reverse=reverse)
    world.last_plan = getattr(eng, "query_plan", None)
    if isinstance(sql, Exception):
        return "error", classify(sql), ()
    names, raw = world.execute(sql)
    rows, dropped = shape(eng, req, names, raw)
    return "rows", rows, dropped


def canon(rows):
    return sorted((tuple(sorted(r.items(), key=lambda kv: kv[0])) for r in rows),
                  key=lambda t: tuple((k, (v is None, str(v))) for k, v in t))


def expect(outcome, expected, *, ordered=False):
    kind, payload, dropped = outcome
    if isinstance(expected, str):
        assert kind == "error", f"expected refusal {expected}, got rows {payload}"
        assert payload == expected or expected == T.REFUSED, f"expected {expected}, got {payload}"
        return
    exp_rows = expected["rows"] if isinstance(expected, dict) else expected
    exp_rows = [{k: _norm(v) for k, v in r.items()} for r in exp_rows]
    assert kind == "rows", f"expected rows {exp_rows}, got refusal {payload}"
    if ordered:
        assert payload == exp_rows, f"order: {payload} != {exp_rows}"
    else:
        assert canon(payload) == canon(exp_rows), f"{payload} != {exp_rows}"
    if isinstance(expected, dict) and "dropped" in expected:
        assert set(expected["dropped"]) <= set(dropped), f"dropped {dropped}, expected {expected['dropped']}"


ALL = T.CASES + [(i, m, b[0], r, e) for i, m, b, r, e in T.BASE_INVARIANCE]


@pytest.mark.parametrize("case", T.CASES, ids=[c[0] for c in T.CASES])
def test_golden_topology_values(world, case):
    _id, model, base, req, expected = case
    expect(run(world, model, base, req), expected)


@pytest.mark.parametrize("case", T.CASES + T.TOP_N, ids=[c[0] for c in T.CASES + T.TOP_N])
def test_golden_topology_values_on_duckdb(world_duck, case):
    """The same oracles on DuckDB — the engine of Google Sheets / manual tables."""
    _id, model, base, req, expected = case
    expect(run(world_duck, model, base, req), expected, ordered=case in T.TOP_N)


@pytest.mark.parametrize("case", T.BASE_INVARIANCE, ids=[c[0] for c in T.BASE_INVARIANCE])
def test_a_model_wide_measure_has_the_same_value_from_every_base(world, case):
    _id, model, bases, req, expected = case
    for base in bases:
        expect(run(world, model, base, req), expected)


@pytest.mark.parametrize("case", T.TOP_N, ids=[c[0] for c in T.TOP_N])
def test_top_n_operates_on_the_final_result(world, case):
    _id, model, base, req, expected = case
    expect(run(world, model, base, req), expected, ordered=True)


# ── metamorphic: permutations that must not change the answer ──────────────


def _variants(req):
    """Equivalent requests: measures, dimensions and filter insertion reversed."""
    out = [("as_written", req)]
    if len(req.get("measures") or []) > 1:
        out.append(("measures_reversed", {**req, "measures": list(reversed(req["measures"]))}))
    if len(req.get("dims") or []) > 1:
        out.append(("dims_reversed", {**req, "dims": list(reversed(req["dims"]))}))
    if len(req.get("filters") or {}) > 1:
        out.append(("filters_reversed", {**req, "filters": dict(reversed(list(req["filters"].items())))}))
    return out


@contextlib.contextmanager
def node_order(order):
    """The resolver's reachable-node set iterated in a DIFFERENT order (what a
    different PYTHONHASHSEED — a process restart — does to a set of names).
    An ordered, set-like view: membership and set operations still work."""
    from app.services import semantic_join_resolver as sjr

    if order is None:
        yield
        return
    orig = sjr.SemanticJoinResolver.reachable_nodes

    def ordered(self):
        return dict.fromkeys(sorted(orig(self), reverse=order)).keys()

    sjr.SemanticJoinResolver.reachable_nodes = ordered
    try:
        yield
    finally:
        sjr.SemanticJoinResolver.reachable_nodes = orig


@pytest.mark.parametrize("case", ALL, ids=[c[0] for c in ALL])
def test_order_permutations_do_not_change_the_business_answer(world, case):
    from app.services import semantic_join_resolver as sjr

    _id, model, base, req, expected = case
    for label, variant in _variants(req):
        for reverse in (False, True):
            for order in (None, False, True):
                sjr._GRAPH_CACHE.clear()  # a fresh graph, as after a restart
                with node_order(order):
                    outcome = run(world, model, base, variant, reverse=reverse)
                try:
                    expect(outcome, expected)
                except AssertionError as err:
                    raise AssertionError(f"[{label} | storage {'reversed' if reverse else 'as-is'} | "
                                         f"node order {order}] {err}") from None


# ── the observable plan: decided before any SQL runs ────────────────────────


@pytest.mark.parametrize("case_id, strategy, fact_grains", [
    ("G1.by_product", "single", ["p2_sales"]),
    ("G7.reanchor_foreign_date_filter", "reanchor", None),
    ("G6.kpi_three_facts", "isolate", None),
    ("G6.by_year_three_facts", "stitch", None),
])
def test_the_query_plan_names_the_strategy_before_execution(world, case_id, strategy, fact_grains):
    by_id = {c[0]: c for c in T.CASES}
    _id, model, base, req, _e = by_id[case_id]
    eng, sql = generate(world, model, base, req)
    assert not isinstance(sql, Exception), sql
    assert eng.query_plan.get("strategy") == strategy, eng.query_plan
    if fact_grains:
        assert eng.query_plan.get("fact_grains") == fact_grains


def test_the_plan_records_the_filter_routes_that_were_and_ed(world):
    by_id = {c[0]: c for c in T.CASES}
    _id, model, base, req, _e = by_id["G5.by_owner_won_deals_both"]
    eng, sql = generate(world, model, base, req)
    assert not isinstance(sql, Exception), sql
    # both shared dimensions carry the deals filter to revenue — grouped by owner too
    assert eng.query_plan["filter_routes"]["p2_deals"] == [
        "p2_revenue → p2_cal → p2_deals", "p2_revenue → p2_owners → p2_deals"], eng.query_plan


# ── H2-15: a relationship edit is seen by the very next query ───────────────


def test_a_relationship_edit_changes_the_route_of_the_next_query(world):
    """Same business request before and after editing the graph: the resolver
    graph, the non-fanning graph and every route memo follow the edit — no
    process-local cache keeps the old route."""
    from sqlalchemy.orm.attributes import flag_modified

    db, fwd = world.db, world.fwd
    req = {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]}
    assert run(world, "G3_diamond", "p2_sales", req)[:2] == ("error", T.AMBIGUOUS)
    stores = db.query(SemanticExplore).filter_by(model_id=fwd["G3_diamond"], base_view_name="p2_stores").one()
    customers = db.query(SemanticExplore).filter_by(model_id=fwd["G3_diamond"], base_view_name="p2_customers").one()

    def set_active(explore, active):
        explore.joins = [{**j, "is_active": active} for j in explore.joins]
        flag_modified(explore, "joins")
        db.flush()

    set_active(stores, False)   # only the customer's region is left
    expect(run(world, "G3_diamond", "p2_sales", req), [
        {"p2_regions.name": "North", "p2_sales.revenue": 130}, {"p2_regions.name": "South", "p2_sales.revenue": 61},
        {"p2_regions.name": None, "p2_sales.revenue": 7}])
    set_active(stores, True)
    set_active(customers, False)   # now only the store's region
    expect(run(world, "G3_diamond", "p2_sales", req), [
        {"p2_regions.name": "South", "p2_sales.revenue": 130}, {"p2_regions.name": "North", "p2_sales.revenue": 57},
        {"p2_regions.name": None, "p2_sales.revenue": 11}])
    set_active(customers, True)
    assert run(world, "G3_diamond", "p2_sales", req)[:2] == ("error", T.AMBIGUOUS)


# ── H2-07: grain classification ↔ engine behaviour ↔ grain graph ↔ FROM route ─


@pytest.mark.parametrize("row", T.GRAIN_MATRIX, ids=[f"{r[0]}:{r[3]}" for r in T.GRAIN_MATRIX])
def test_each_dimension_behaves_as_its_grain_class(world, row):
    model, base, measures, dim, cls = row
    req = {"dims": [dim], "measures": measures}
    kind, payload, _d = run(world, model, base, req)
    if cls == T.SAFE:
        assert kind == "rows" and world.last_plan.get("strategy") in ("single", "reanchor"), (payload, world.last_plan)
        # the grain guard's graph and the FROM route agree: the dimension's view
        # is non-fanning-reachable from the fact AND was joined on one route
        eng, _sql = generate(world, model, base, req)
        fact = eng._measure_fact_view(measures[0])
        node = dim.split(".")[0]
        assert node in eng._m1_reachable_views(fact), node
        assert node in (eng.query_plan.get("select_routes") or {}).get(base, {}), eng.query_plan
    elif cls == T.CONFORMED:
        assert kind == "rows" and world.last_plan.get("strategy") == "stitch", (payload, world.last_plan)
    elif cls == T.AMBIGUOUS_DIM:
        assert (kind, payload) == ("error", T.AMBIGUOUS)
    elif cls == T.UNRELATED_DIM:
        assert kind == "error" and payload in (T.UNRELATED, T.FANOUT), payload
    elif cls == T.FANNING:
        assert kind == "error" and payload in (T.UNRELATED, T.FANOUT), payload
