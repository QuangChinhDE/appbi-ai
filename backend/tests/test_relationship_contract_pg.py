"""Model authoring ↔ join resolver, executed on Postgres.

The unit tier (test_relationship_contract.py) proves the contract and the
write paths on SQLite. This tier proves what only a real database can:

  values    a composite relationship walked backwards (cross filter "both")
            filters on BOTH keys; a calendar relationship walked backwards
            keeps its CAST — the pre-fix engine returned a wrong set / no rows
            for these, successfully and silently.
  key guard a relationship declared N:1 whose one-side key has duplicates is
            refused before the query runs (pre-fix: every SUM through it grew);
            a unique key gives the right value; a probe that cannot run refuses.
  races     two editors of one model, a PK edit racing a relationship edit, a
            removal racing a regeneration — serialized by the model write lock:
            no lost update, no partial PK/relationship state, no resurrection.

Needs Postgres (DATABASE_URL); CI runs it in `integration-golden`. Physical
tables live in a scratch schema that is COMMITTED (the key probe runs on its own
connection, like production) and dropped afterwards; metadata rows of the race
tests are committed (the race needs two sessions) and deleted afterwards.
"""
from __future__ import annotations

import os
import threading
import uuid

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

from app.models.dataset import Dataset, DatasetTable
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.services.semantic_join_resolver import read_join_contract
from app.services.semantic_query_engine import SemanticQueryEngine

SCHEMA = "relpair_pg"

PHYSICAL = [
    "CREATE TABLE {s}.shops(region_code text, store_code text, name text)",
    "INSERT INTO {s}.shops VALUES ('N','1','N-one'),('N','2','N-two'),('S','1','S-one')",
    "CREATE TABLE {s}.shop_sales(region_code text, store_code text, amt int)",
    "INSERT INTO {s}.shop_sales VALUES ('N','1',10),('S','1',25),('N','2',5)",
    "CREATE TABLE {s}.events(ts timestamp, amt int)",
    "INSERT INTO {s}.events VALUES ('2024-03-01 10:00',7),('2024-03-02 00:00',1),('2024-03-03 15:30',9)",
    "CREATE TABLE {s}.cal(date date, year int)",
    "INSERT INTO {s}.cal SELECT d::date, 2024 FROM generate_series(DATE '2024-03-01', DATE '2024-03-05', "
    "INTERVAL '1 day') d",
    "CREATE TABLE {s}.orders(id int, customer_id int, amount int)",
    "INSERT INTO {s}.orders VALUES (1,1,100),(2,1,50),(3,2,30)",
    "CREATE TABLE {s}.customers_ok(id int, region text)",
    "INSERT INTO {s}.customers_ok VALUES (1,'N'),(2,'S')",
    # id 1 twice: an N:1 declaration the data does not honour
    "CREATE TABLE {s}.customers_dup(id int, region text)",
    "INSERT INTO {s}.customers_dup VALUES (1,'N'),(1,'N'),(2,'S')",
]


def _dims(*names):
    return [{"name": n, "type": "string", "sql": f"${{TABLE}}.{n}"} for n in names]


def _sum(name, col):
    return {"name": name, "type": "sum", "sql": f"${{TABLE}}.{col}"}


VIEWS = {
    "rp_shops": ("shops", _dims("region_code", "store_code", "name"), [{"name": "n", "type": "count", "sql": "*"}]),
    "rp_shop_sales": ("shop_sales", _dims("region_code", "store_code"), [_sum("amt_sum", "amt")]),
    "rp_events": ("events", _dims("ts") + [{"name": "amt", "type": "number", "sql": "${TABLE}.amt"}],
                  [_sum("amt_sum", "amt")]),
    "rp_cal": ("cal", _dims("date", "year"), [{"name": "days", "type": "count", "sql": "*"}]),
    "rp_orders": ("orders", _dims("id", "customer_id"), [_sum("revenue", "amount")]),
    "rp_customers_ok": ("customers_ok", _dims("id", "region"), []),
    "rp_customers_dup": ("customers_dup", _dims("id", "region"), []),
}


def _rel(view, fc, tc, *, sql_on, cross="single"):
    return {"name": view, "view": view, "type": "left", "from_column": fc, "to_column": tc,
            "from_columns": [fc], "to_columns": [tc], "sql_on": sql_on,
            "relationship": "many_to_one", "cardinality": "many_to_one", "is_active": True, "cross_filter": cross}


MODELS = {
    "composite_both": {"rp_shop_sales": [{
        **_rel("rp_shops", "region_code", "region_code", cross="both",
               sql_on="${TABLE}.region_code = ${rp_shops}.region_code AND ${TABLE}.store_code = ${rp_shops}.store_code"),
        "from_columns": ["region_code", "store_code"], "to_columns": ["region_code", "store_code"],
    }], "rp_shops": []},
    "calendar_both": {"rp_events": [_rel("rp_cal", "ts", "date", cross="both",
                                         sql_on="CAST(${TABLE}.ts AS DATE) = ${rp_cal}.date")], "rp_cal": []},
    "dup_key": {"rp_orders": [_rel("rp_customers_dup", "customer_id", "id", cross="both",
                                   sql_on="${TABLE}.customer_id = ${rp_customers_dup}.id")],
                "rp_customers_dup": []},
    "ok_key": {"rp_orders": [_rel("rp_customers_ok", "customer_id", "id",
                                  sql_on="${TABLE}.customer_id = ${rp_customers_ok}.id")]},
}


def _url():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail(
            "test_relationship_contract_pg executes SQL and races two sessions; it needs Postgres "
            f"(DATABASE_URL={url.split('@')[-1] or '<unset>'}). It is not a unit test."
        )
    return url


@pytest.fixture(scope="module")
def pg():
    engine = sa.create_engine(_url())
    with engine.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        c.execute(sa.text(f"CREATE SCHEMA {SCHEMA}"))
        for stmt in PHYSICAL:
            c.execute(sa.text(stmt.format(s=SCHEMA)))
    try:
        yield engine
    finally:
        with engine.begin() as c:
            c.execute(sa.text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        engine.dispose()


@pytest.fixture()
def world(pg):
    """Metadata in one rolled-back transaction (the physical tables are committed)."""
    conn = pg.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        views = {}
        for name, (table, dims, measures) in VIEWS.items():
            v = SemanticView(name=name, sql_table_name=f"{SCHEMA}.{table}", dataset_table_id=None,
                             dimensions=dims, measures=measures)
            db.add(v)
            views[name] = v
        db.flush()
        models = {}
        for key, explores in MODELS.items():
            m = SemanticModel(name=f"relpair_{key}_{uuid.uuid4().hex[:6]}")
            db.add(m)
            db.flush()
            for base, joins in explores.items():
                db.add(SemanticExplore(name=base, model_id=m.id, base_view_id=views[base].id,
                                       base_view_name=base, joins=joins))
            models[key] = m.id
        db.flush()
        yield db, conn, models
    finally:
        db.close()
        outer.rollback()
        conn.close()


def _engine_run(world, model, base, dims, measures, filters=None):
    db, conn, models = world
    eng = SemanticQueryEngine(db, database_type="postgresql")
    sql, _cols, _ = eng.generate_sql(explore_name=base, dimensions=dims, measures=measures,
                                     filters=filters or {}, model_id=models[model])
    return eng, sql, [tuple(r) for r in conn.execute(sa.text(sql))]


def _guarded_run(world, model, base, dims, measures):
    """Generate; the statement itself must refuse (in-statement key guard), and
    the SAME statement without the guard is what would have run unguarded."""
    from app.services.relationship_key_guard import statement_key_guard

    db, conn, models = world
    eng = SemanticQueryEngine(db, database_type="postgresql")
    sql, _cols, _ = eng.generate_sql(explore_name=base, dimensions=dims, measures=measures, filters={},
                                     model_id=models[model])
    guard = statement_key_guard(eng.key_probes)
    assert guard and guard in sql, sql
    with pytest.raises(sa.exc.DBAPIError, match="more than one row returned by a subquery"):
        with conn.begin_nested():
            conn.execute(sa.text(sql))
    unguarded = sql.replace("\nWHERE\n  " + guard, "")
    assert unguarded != sql
    return eng, unguarded, [tuple(r) for r in conn.execute(sa.text(unguarded))]


def _pg_config():
    url = sa.engine.make_url(_url())
    return {"host": url.host, "port": url.port or 5432, "database": url.database,
            "username": url.username, "password": url.password}


# ── values through reverse edges ─────────────────────────────────────────────


def test_a_composite_relationship_walked_backwards_filters_on_both_keys(world):
    """Shops whose sales include store_code '1'. N-two (N, 2) has only a store-2
    sale; matched on region alone it was wrongly included."""
    _eng, sql, rows = _engine_run(world, "composite_both", "rp_shops", ["rp_shops.name"], ["rp_shops.n"],
                                  {"rp_shop_sales.store_code": {"operator": "eq", "value": "1"}})
    assert sorted(r[0] for r in rows) == ["N-one", "S-one"], sql


def test_a_calendar_relationship_walked_backwards_keeps_its_cast(world):
    """Days with an event of amt >= 5: 03-01 (10:00) and 03-03 (15:30). Without
    the CAST, `date = timestamp` matched only midnight and returned no day."""
    _eng, sql, rows = _engine_run(world, "calendar_both", "rp_cal", ["rp_cal.date"], ["rp_cal.days"],
                                  {"rp_events.amt": {"operator": "gte", "value": 5}})
    assert sorted(r[0].isoformat() for r in rows) == ["2024-03-01", "2024-03-03"], sql


# ── the runtime key guard ────────────────────────────────────────────────────


def test_a_declared_n1_with_duplicate_keys_is_refused_before_it_inflates(world):
    from app.services.relationship_key_guard import verify_key_probes

    eng, _sql, rows = _guarded_run(world, "dup_key", "rp_orders", ["rp_customers_dup.region"],
                                   ["rp_orders.revenue"])
    assert dict(rows) == {"N": 300, "S": 30}, "the unguarded SQL doubles N (truth: 150)"
    assert [p["view"] for p in eng.key_probes] == ["rp_customers_dup"]
    with pytest.raises(ValueError, match="bị lặp"):
        verify_key_probes(eng.key_probes, ds_type="postgresql", config=_pg_config(),
                          namespace=f"test:{uuid.uuid4().hex}")


def test_the_same_duplicate_key_is_refused_when_the_chart_is_based_on_the_dimension(world):
    """FROM customers LEFT JOIN orders — the relationship walked from its one
    side. The duplicate customer id repeats each of its orders all the same;
    the pre-fix guard probed only edges walked to-one and let this through."""
    from app.services.relationship_key_guard import verify_key_probes

    eng, sql, rows = _guarded_run(world, "dup_key", "rp_customers_dup", ["rp_customers_dup.region"],
                                  ["rp_orders.revenue"])
    assert dict(rows).get("N") == 300, ("the unguarded SQL doubles N (truth: 150)", sql, rows)
    assert any(p["view"] == "rp_customers_dup" for p in eng.key_probes), eng.key_probes
    with pytest.raises(ValueError, match="bị lặp"):
        verify_key_probes(eng.key_probes, ds_type="postgresql", config=_pg_config(),
                          namespace=f"test:{uuid.uuid4().hex}")


def test_a_unique_key_passes_the_guard_and_gives_the_right_value(world):
    from app.services.relationship_key_guard import verify_key_probes

    eng, _sql, rows = _engine_run(world, "ok_key", "rp_orders", ["rp_customers_ok.region"], ["rp_orders.revenue"])
    verify_key_probes(eng.key_probes, ds_type="postgresql", config=_pg_config(),
                      namespace=f"test:{uuid.uuid4().hex}")
    assert dict(rows) == {"N": 150, "S": 30}


def test_a_key_that_cannot_be_verified_is_refused_not_assumed(world):
    from app.services.relationship_key_guard import verify_key_probes

    eng, _sql, _rows = _engine_run(world, "ok_key", "rp_orders", ["rp_customers_ok.region"], ["rp_orders.revenue"])
    broken = {**_pg_config(), "database": "relpair_no_such_database"}
    with pytest.raises(ValueError, match="Không xác minh được"):
        verify_key_probes(eng.key_probes, ds_type="postgresql", config=broken,
                          namespace=f"test:{uuid.uuid4().hex}")


# ── races: two sessions on one model ─────────────────────────────────────────


@pytest.fixture()
def model_world(pg):
    """A generated model (auto FK join orders → customers), COMMITTED so two
    sessions can race on it; every row is deleted afterwards."""
    from app.services.dataset_model_service import generate_dataset_model

    with Session(pg) as s:
        ds = Dataset(name=f"relpair_race_{uuid.uuid4().hex[:8]}")
        s.add(ds)
        s.flush()
        tables = {}
        for name, cols in [
            ("orders", [("id", "integer"), ("customer_id", "integer"), ("ship_key", "integer")]),
            ("customers", [("id", "integer"), ("alt_id", "integer"), ("region", "string")]),
            ("periods", [("pkey", "integer"), ("year", "integer")]),
        ]:
            t = DatasetTable(dataset_id=ds.id, display_name=name, source_table_name=name,
                             columns_cache=[{"name": c, "type": ty} for c, ty in cols])
            s.add(t)
            s.flush()
            tables[name] = t.id
        s.commit()
        generate_dataset_model(s, ds.id)
        s.commit()
        dataset_id = ds.id
    try:
        yield pg, dataset_id, tables
    finally:
        with Session(pg) as s:
            model_ids = [m.id for m in s.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id)]
            if model_ids:
                s.query(SemanticExplore).filter(SemanticExplore.model_id.in_(model_ids)).delete(
                    synchronize_session=False)
                s.query(SemanticModel).filter(SemanticModel.id.in_(model_ids)).delete(synchronize_session=False)
            s.query(SemanticView).filter(SemanticView.dataset_table_id.in_(list(tables.values()))).delete(
                synchronize_session=False)
            s.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).delete(synchronize_session=False)
            s.query(Dataset).filter(Dataset.id == dataset_id).delete(synchronize_session=False)
            s.commit()


def _view_ids(s, tables):
    by_table = {v.dataset_table_id: v.id for v in s.query(SemanticView).filter(
        SemanticView.dataset_table_id.in_(list(tables.values())))}
    return {name: by_table[tid] for name, tid in tables.items()}


def _race(engine, first, second, *, first_fails=False):
    """Run `first` in session A, held just before its commit, and `second` in
    session B meanwhile. Returns (second_finished_while_first_held, errors)."""
    a_ready, release, b_done = threading.Event(), threading.Event(), threading.Event()
    errors: dict = {}

    def run_a():
        s = Session(engine)
        real_commit = s.commit

        def held_commit():
            a_ready.set()
            release.wait(20)
            if first_fails:
                raise RuntimeError("injected failure at A's commit")
            real_commit()

        s.commit = held_commit
        try:
            first(s)
        except Exception as exc:  # noqa: BLE001
            errors["a"] = exc
            s.rollback()
        finally:
            a_ready.set()
            s.close()

    def run_b():
        s = Session(engine)
        try:
            second(s)
        except Exception as exc:  # noqa: BLE001
            errors["b"] = exc
            s.rollback()
        finally:
            b_done.set()
            s.close()

    ta = threading.Thread(target=run_a)
    ta.start()
    assert a_ready.wait(20), "A never reached its commit"
    tb = threading.Thread(target=run_b)
    tb.start()
    finished_early = b_done.wait(1.5)
    release.set()
    ta.join(30)
    tb.join(30)
    return finished_early, errors


def _joins(engine, dataset_id, base_table_id):
    with Session(engine) as s:
        view = s.query(SemanticView).filter(SemanticView.dataset_table_id == base_table_id).one()
        model = s.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).one()
        e = s.query(SemanticExplore).filter(SemanticExplore.model_id == model.id,
                                            SemanticExplore.base_view_name == view.name).one()
        return view.name, list(e.joins or [])


def test_two_editors_of_one_model_both_keep_their_relationship(model_world):
    from app.services.dataset_model_service import add_join

    engine, dataset_id, tables = model_world
    with Session(engine) as s:
        ids = _view_ids(s, tables)

    def editor(alias, col):
        return lambda s: add_join(s, dataset_id=dataset_id, from_view_id=ids["orders"], to_view_id=ids["periods"],
                                  from_column=col, to_column="pkey", relationship="many_to_one", alias=alias)

    finished_early, errors = _race(engine, editor("ship_period", "ship_key"), editor("cust_period", "customer_id"))
    assert not errors, errors
    base, joins = _joins(engine, dataset_id, tables["orders"])
    assert {j.get("alias") for j in joins} == {None, "ship_period", "cust_period"}, "a lost update"
    assert all(read_join_contract(base, j).valid for j in joins)
    assert not finished_early, "B must wait for A's lock, not merge onto a stale read"


def test_a_pk_edit_racing_a_relationship_edit_leaves_no_partial_state(model_world):
    from app.services.dataset_model_service import add_join

    engine, dataset_id, tables = model_world
    with Session(engine) as s:
        ids = _view_ids(s, tables)
    first = lambda s: add_join(s, dataset_id=dataset_id, from_view_id=ids["orders"],  # noqa: E731
                               to_view_id=ids["customers"], from_column="customer_id", to_column="id",
                               relationship="many_to_one", primary_key_on_to_view=["id"], is_active=False)
    second = lambda s: add_join(s, dataset_id=dataset_id, from_view_id=ids["orders"],  # noqa: E731
                                to_view_id=ids["periods"], from_column="ship_key", to_column="pkey",
                                relationship="many_to_one", alias="ship_period", primary_key_on_to_view=["pkey"])
    # A fails AFTER its PK change was flushed: neither its PK nor its edit survive; B's do.
    finished_early, errors = _race(engine, first, second, first_fails=True)
    assert isinstance(errors.get("a"), RuntimeError) and "b" not in errors, errors
    with Session(engine) as s:
        assert s.get(SemanticView, ids["customers"]).primary_key in (None, [])
        assert s.get(SemanticView, ids["periods"]).primary_key == ["pkey"]
    base, joins = _joins(engine, dataset_id, tables["orders"])
    by_alias = {j.get("alias"): read_join_contract(base, j) for j in joins}
    assert set(by_alias) == {None, "ship_period"}
    assert by_alias[None].is_active is True, "A's deactivation must not be half-applied"
    assert not finished_early


def test_a_removal_racing_a_regeneration_is_not_resurrected(model_world):
    from app.services.dataset_model_service import generate_dataset_model, remove_join

    engine, dataset_id, tables = model_world
    with Session(engine) as s:
        ids = _view_ids(s, tables)
        to_name = s.get(SemanticView, ids["customers"]).name
    first = lambda s: remove_join(s, dataset_id, ids["orders"], to_name,  # noqa: E731
                                  from_columns=["customer_id"], to_columns=["id"])

    def second(s):
        generate_dataset_model(s, dataset_id)
        s.commit()

    finished_early, errors = _race(engine, first, second)
    assert not errors, errors
    _base, joins = _joins(engine, dataset_id, tables["orders"])
    assert joins == [], "the regeneration re-created the relationship the user had just removed"
    assert not finished_early, "the regeneration must wait for the removal"


def test_a_stale_whole_list_write_never_overwrites_a_committed_relationship(model_world):
    """P1-03 — editor A adds a relationship (held at its commit); editor B
    replaces the WHOLE list quoting the version it read before A's edit. B
    waits for the model lock, then is refused as a conflict: A's relationship
    survives (it used to be silently dropped by B's stale list)."""
    from app.services.dataset_model_service import RelationshipWriteConflict, add_join, replace_explore_joins

    engine, dataset_id, tables = model_world
    with Session(engine) as s:
        ids = _view_ids(s, tables)
        orders_view = s.get(SemanticView, ids["orders"]).name
        stale = s.query(SemanticExplore).filter(SemanticExplore.base_view_name == orders_view).one().joins_version

    first = lambda s: add_join(s, dataset_id=dataset_id, from_view_id=ids["orders"],  # noqa: E731
                               to_view_id=ids["periods"], from_column="ship_key", to_column="pkey",
                               relationship="many_to_one", alias="ship_period")
    outcome: dict = {}

    def second(s):
        e = s.query(SemanticExplore).filter(SemanticExplore.base_view_name == orders_view).one()
        try:
            replace_explore_joins(s, e, dataset_id, [], expected_joins_version=stale)
        except RelationshipWriteConflict:
            outcome["conflict"] = True
            s.rollback()

    finished_early, errors = _race(engine, first, second)
    assert not errors, errors
    assert outcome.get("conflict") is True, "the stale whole-list write must be refused"
    _base, joins = _joins(engine, dataset_id, tables["orders"])
    assert {j.get("alias") for j in joins} == {None, "ship_period"}, "A's committed relationship was lost"
    assert not finished_early, "B must wait for the model write lock"


# ── P1-01: a live source that gains a duplicate key between two queries ─────

LIVE = "relpair_live"


@pytest.fixture()
def fixture_client():
    """Real HTTP routes on the seeded CI fixture (dataset 56, a LIVE Postgres
    datasource). The owner and revenue tables are COPIED (committed, no key
    constraints) into a scratch schema and, inside one rolled-back metadata
    transaction, the two dataset tables are pointed at the copies — so the
    test can give the live source a duplicate key without touching the
    fixture's own tables."""
    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.core.dependencies import get_current_user
    from app.main import app
    from app.models.models import Chart
    from app.services import query_cache

    engine = sa.create_engine(_url())
    with engine.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA IF EXISTS {LIVE} CASCADE"))
        c.execute(sa.text(f"CREATE SCHEMA {LIVE}"))
        c.execute(sa.text(f"CREATE TABLE {LIVE}.bc_owner AS SELECT * FROM bcfix.bc_owner"))
        c.execute(sa.text(f"CREATE TABLE {LIVE}.bc_revenue AS SELECT * FROM bcfix.bc_revenue"))
    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    for tid, name in ((188, "bc_owner"), (193, "bc_revenue")):
        db.get(DatasetTable, tid).source_table_name = f"{LIVE}.{name}"
    db.flush()
    chart = db.query(Chart).filter(Chart.name == "[snow] revenue by owner").first()
    if chart is None:
        pytest.fail("fixture chart missing — run scripts/seed_snowflake_ci_fixture.py first.")
    model_id = db.query(SemanticModel).filter(SemanticModel.dataset_id == 56).one().id
    admin = type("U", (), {"id": uuid.UUID(int=7), "email": "keyguard@x", "is_active": True,
                           "permissions": {"settings": "full"}})()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: admin
    saved = query_cache.get_cached
    query_cache._real_get_cached = saved
    query_cache.get_cached = lambda *_a, **_k: None  # a fresh computation every time
    try:
        yield TestClient(app), chart.id, model_id, engine
    finally:
        query_cache.get_cached = saved
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        db.close()
        outer.rollback()
        conn.close()
        with engine.begin() as c:
            c.execute(sa.text(f"DROP SCHEMA IF EXISTS {LIVE} CASCADE"))
        engine.dispose()


def test_a_live_source_that_gains_a_duplicate_key_is_refused_on_the_next_query(fixture_client):
    """Unique → query (probe clean) → the live owner table gains a second K1 →
    the NEXT query on the chart route and on /semantic/query is refused, not
    answered with K1's revenue doubled; repaired → answered again."""
    client, chart_id, model_id, engine = fixture_client
    direct = {"explore": "dataset_table_193", "model_id": model_id, "dimensions": ["dataset_table_188.crm_name"],
              "measures": ["dataset_table_193.total_revenue"], "filters": {}, "limit": 1000}

    ok_chart = client.get(f"/api/v1/charts/{chart_id}/data")
    ok_direct = client.post("/api/v1/semantic/query", json=direct)
    assert ok_chart.status_code == 200 and ok_direct.status_code == 200, (ok_chart.text, ok_direct.text)
    assert "relpair_live" in ok_direct.json()["sql"], "the test must read the copied live tables"
    with engine.begin() as c:
        c.execute(sa.text(f"INSERT INTO {LIVE}.bc_owner SELECT * FROM {LIVE}.bc_owner WHERE bc_key = 'K1'"))
    dup_chart = client.get(f"/api/v1/charts/{chart_id}/data")
    dup_direct = client.post("/api/v1/semantic/query", json=direct)
    assert dup_chart.status_code == 400 and "bị lặp" in dup_chart.text, dup_chart.text
    assert dup_direct.status_code == 400 and "bị lặp" in dup_direct.text, dup_direct.text
    with engine.begin() as c:
        c.execute(sa.text(
            f"DELETE FROM {LIVE}.bc_owner a USING (SELECT ctid FROM {LIVE}.bc_owner WHERE bc_key = 'K1' "
            "ORDER BY ctid DESC LIMIT 1) d WHERE a.ctid = d.ctid"))
    again = client.get(f"/api/v1/charts/{chart_id}/data")
    assert again.status_code == 200 and again.json().get("data") == ok_chart.json().get("data"),         "a repaired source is probed again — no stale verdict in either direction"


def test_a_duplicate_written_between_the_probe_and_the_query_is_refused(fixture_client, monkeypatch):
    """The probe runs as its OWN statement before the query. A writer that
    commits a duplicate one-side key after the probe passed and before the
    query reads the source is invisible to that probe; the in-statement guard
    (same snapshot as the JOIN) catches it. The race is reproduced exactly: the
    real probe runs and passes, then the writer commits, then the query runs —
    on the chart route and on /semantic/query. Neither answers with K1's
    revenue doubled."""
    from app.services import relationship_key_guard as kg

    client, chart_id, model_id, engine = fixture_client
    direct = {"explore": "dataset_table_193", "model_id": model_id, "dimensions": ["dataset_table_188.crm_name"],
              "measures": ["dataset_table_193.total_revenue"], "filters": {}, "limit": 1000}
    clean_chart = client.get(f"/api/v1/charts/{chart_id}/data")
    clean_direct = client.post("/api/v1/semantic/query", json=direct)
    assert clean_chart.status_code == 200 and clean_direct.status_code == 200, (clean_chart.text, clean_direct.text)
    real_probe = kg.verify_key_probes

    def probe_then_concurrent_writer(*a, **k):
        real_probe(*a, **k)  # the key is unique NOW: the probe passes
        with engine.begin() as c:  # … and a writer duplicates it before the query runs
            c.execute(sa.text(f"INSERT INTO {LIVE}.bc_owner SELECT * FROM {LIVE}.bc_owner WHERE bc_key = 'K1'"))

    def repair():
        with engine.begin() as c:
            c.execute(sa.text(
                f"DELETE FROM {LIVE}.bc_owner a USING (SELECT ctid FROM {LIVE}.bc_owner WHERE bc_key = 'K1' "
                "ORDER BY ctid DESC LIMIT 1) d WHERE a.ctid = d.ctid"))

    monkeypatch.setattr(kg, "verify_key_probes", probe_then_concurrent_writer)
    raced_chart = client.get(f"/api/v1/charts/{chart_id}/data")
    repair()
    raced_direct = client.post("/api/v1/semantic/query", json=direct)
    repair()
    for raced, clean in ((raced_chart, clean_chart), (raced_direct, clean_direct)):
        assert raced.status_code >= 400, f"answered over a duplicated key ({raced.status_code}): {raced.text[:300]}"
        assert "more than one row" in raced.text or "bị lặp" in raced.text, raced.text[:300]
    monkeypatch.setattr(kg, "verify_key_probes", real_probe)
    assert client.get(f"/api/v1/charts/{chart_id}/data").json().get("data") == clean_chart.json().get("data")


# ── P1-09: a cached result never outlives the relationship it was built on ──


def test_a_cached_chart_result_is_not_served_after_its_relationship_changes(fixture_client):
    """The result cache ON (shared store and local layer): the chart is computed
    and cached, then the relationship it joins through changes meaning (here:
    deactivated). The next request must be computed under the new relationship
    — the cache identity carries the relationship JSON — not the cached rows."""
    from sqlalchemy.orm.attributes import flag_modified

    from app.services import query_cache

    client, chart_id, _model_id, engine = fixture_client
    real_get = query_cache.__dict__.get("_real_get_cached", query_cache.get_cached)
    hits = []

    def counting_get(*a, **k):
        out = real_get(*a, **k)
        if out is not None:
            hits.append(1)
        return out

    query_cache.get_cached = counting_get
    first = client.get(f"/api/v1/charts/{chart_id}/data")
    again = client.get(f"/api/v1/charts/{chart_id}/data")
    assert first.status_code == 200 and again.json().get("data") == first.json().get("data")
    assert hits, "the second request must have been served from the result cache (else this proves nothing)"
    db = next(iter(client.app.dependency_overrides.values()))()
    rev = db.query(SemanticExplore).filter(SemanticExplore.base_view_name == "dataset_table_193").one()
    rev.joins = [{**j, "is_active": False} if j.get("view") == "dataset_table_188" else j for j in rev.joins]
    flag_modified(rev, "joins")
    db.flush()
    after = client.get(f"/api/v1/charts/{chart_id}/data")
    assert not (after.status_code == 200 and after.json().get("data") == first.json().get("data")),         "the cached result of the old relationship was served"
