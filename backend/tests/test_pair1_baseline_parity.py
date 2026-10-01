"""Old-correct → new-correct: business numbers the pre-Pair-#1 engine produced
for semantically CORRECT queries are reproduced exactly by the current engine.

The baseline (tests/golden_sql/pair1_baseline.json) was captured by running
THIS file against the pre-Pair-#1 tree (22bac47f) with PAIR1_BASELINE_CAPTURE=1:

    git archive 22bac47f backend/app | tar -x -C /tmp/base
    cd /tmp/base/backend && DATABASE_URL=… PAIR1_BASELINE_CAPTURE=1 \\
        python -m pytest <repo>/backend/tests/test_pair1_baseline_parity.py

so a value here is what the OLD code returned, not what the new code returns.
A refusal is part of the baseline too (both trees must refuse). Cases where
the old engine was WRONG (silently) are not in this corpus — they are locked,
with their correct values, by test_relationship_contract_pg.py.

Two layers, both on Postgres:

  engine   the golden-matrix world (star, three date roles, diamond resolved by
           an inactive relationship, galaxy at two grains, chasm, M:N bridge,
           composite key, timezone, alias, sibling facts) plus a bidirectional
           star, a reverse filter, and a SNAPSHOT-backed star; each with
           filters, NULL members, time grains, sort and Top-N.
  routes   every fixture chart of dataset 56 on GET /charts/{id}/data (saved),
           ?context=dashboard (tile) and the anonymous public route, unfiltered
           and with a runtime filter; plus POST /semantic/query.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import uuid
from decimal import Decimal
from pathlib import Path

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

from app.models.dataset import Dataset, DatasetTable
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.services.semantic_query_engine import SemanticQueryEngine

from test_semantic_golden_matrix import CAL_SQL, J, MODELS, PHYSICAL, REGION, TO_CUSTOMERS, TO_PRODUCTS, VIEWS

GOLDEN = Path(__file__).parent / "golden_sql" / "pair1_baseline.json"
CAPTURE = os.environ.get("PAIR1_BASELINE_CAPTURE") == "1"
SCHEMA = "pair1_base"

EXTRA_MODELS = {
    # The star with its customer relationship walkable both ways: a chart based
    # on the DIM summing the fact, and a filter from the dim's side.
    "star_both": {"g_sales": [{**TO_CUSTOMERS, "cross_filter": "both"}, TO_PRODUCTS], "g_customers": [REGION],
                  "g_products": [], "g_regions": []},
    # A filter on the FACT from a chart based on the dim (reverse EXISTS).
    "reverse_filter": {"g_sales": [{**TO_PRODUCTS, "cross_filter": "both"}], "g_products": []},
}

ENGINE_CASES = [
    # id, model, base, dims, measures, filters, kwargs
    ("star_by_dim", "star", "g_sales", ["g_products.name"], ["g_sales.revenue"], {}, {}),
    ("star_two_hop_null_member", "star", "g_sales", ["g_regions.name"], ["g_sales.revenue"], {}, {}),
    ("star_total_base_sales", "star", "g_sales", [], ["g_sales.revenue"], {}, {}),
    ("star_total_base_products", "star", "g_products", [], ["g_sales.revenue"], {}, {}),
    ("star_filter_eq", "star", "g_sales", ["g_products.name"], ["g_sales.revenue"],
     {"g_regions.name": {"operator": "eq", "value": "North"}}, {}),
    ("star_filter_ne_null_contract", "star", "g_sales", [], ["g_sales.revenue"],
     {"g_regions.name": {"operator": "ne", "value": "North"}}, {}),
    ("star_filter_not_in", "star", "g_sales", [], ["g_sales.revenue"],
     {"g_products.name": {"operator": "not_in", "value": ["A"]}}, {}),
    ("star_filter_is_null", "star", "g_sales", [], ["g_sales.revenue"],
     {"g_regions.name": {"operator": "is_null"}}, {}),
    ("star_grain_month", "star", "g_sales", ["g_sales__order_date__date_dim.date"], ["g_sales.revenue"], {},
     {"time_grains": {"g_sales__order_date__date_dim.date": "month"}}),
    ("star_grain_week", "star", "g_sales", ["g_sales__order_date__date_dim.date"], ["g_sales.revenue"], {},
     {"time_grains": {"g_sales__order_date__date_dim.date": "week"}}),
    ("star_sort_desc", "star", "g_sales", ["g_products.name"], ["g_sales.revenue"], {},
     {"sorts": [{"field": "g_sales.revenue", "direction": "desc"}]}),
    ("star_top_1", "star", "g_sales", ["g_products.name"], ["g_sales.revenue"], {},
     {"top_n": {"field": "g_sales.revenue", "n": 1}}),
    ("star_measure_text_filters", "star", "g_sales", [],
     ["g_sales.revenue_not_pct", "g_sales.revenue_pct", "g_sales.revenue_wild"], {}, {}),
    ("roles_order_year", "roles", "g_sales", ["g_sales__order_date__date_dim.year"], ["g_sales.revenue"], {}, {}),
    ("roles_ship_year", "roles", "g_sales", ["g_sales__ship_date__date_dim.year"], ["g_sales.revenue"], {}, {}),
    ("roles_delivery_year", "roles", "g_sales", ["g_sales__delivery_date__date_dim.year"], ["g_sales.revenue"],
     {}, {}),
    ("roles_one_role_filtered", "roles", "g_sales", [], ["g_sales.revenue"],
     {"g_sales__ship_date__date_dim.year": {"operator": "eq", "value": 2025}}, {}),
    ("roles_main_fanned_date", "roles_main", "g_sales", [], ["g_sales.revenue"],
     {"g_calendar.year": {"operator": "eq", "value": 2024}}, {}),
    ("diamond_refused", "diamond", "g_sales", ["g_regions.name"], ["g_sales.revenue"], {}, {}),
    ("diamond_inactive_route", "diamond_resolved", "g_sales", ["g_regions.name"], ["g_sales.revenue"], {}, {}),
    ("diamond_inactive_route_filter", "diamond_resolved", "g_sales", [], ["g_sales.revenue"],
     {"g_regions.name": {"operator": "eq", "value": "South"}}, {}),
    ("galaxy_shared_dim", "galaxy", "g_sales", ["g_products.name"], ["g_sales.revenue", "g_targets.target"], {}, {}),
    ("galaxy_grain_month", "galaxy", "g_sales", ["g_sales__order_date__date_dim.date"],
     ["g_sales.revenue", "g_targets.target"], {}, {"time_grains": {"g_sales__order_date__date_dim.date": "month"}}),
    ("galaxy_top_n", "galaxy", "g_sales", ["g_products.name"], ["g_sales.revenue", "g_targets.target"], {},
     {"top_n": {"field": "g_sales.revenue", "n": 1}}),
    ("chasm_refused", "chasm", "g_sales", ["g_tickets.priority"], ["g_sales.revenue"], {}, {}),
    ("chasm_shared_dim_stitch", "chasm", "g_sales", ["g_customers.id"], ["g_sales.revenue", "g_tickets.ticket_count"],
     {}, {}),
    ("bridge_refused", "bridge", "g_sales", ["g_product_tags.tag"], ["g_sales.revenue"], {}, {}),
    ("composite_key", "composite", "g_shop_sales", ["g_shops.name"], ["g_shop_sales.shop_revenue"], {}, {}),
    ("tz_grain_month", "tz", "g_events", ["g_events.ts"], ["g_events.ev_amount"], {},
     {"time_grains": {"g_events.ts": "month"}}),
    ("tz_calendar_month", "tz", "g_events", ["g_events__ts__date_dim.month"], ["g_events.ev_amount"], {}, {}),
    ("alias_role_group", "alias", "g_sales", ["g_ship.year"], ["g_sales.revenue"], {}, {}),
    ("alias_role_filter", "alias", "g_sales", [], ["g_sales.revenue"],
     {"g_ship.year": {"operator": "eq", "value": 2025}}, {}),
    ("sibling_from_fact", "sibling_facts", "g_sales", ["g_calendar.year"], ["g_sales.revenue"], {}, {}),
    ("sibling_from_dim", "sibling_facts", "g_customers", ["g_calendar.year"], ["g_sales.revenue"], {}, {}),
    ("bidir_dim_base_sums_fact", "star_both", "g_customers", ["g_customers.id"], ["g_sales.revenue"], {}, {}),
    ("bidir_fact_base", "star_both", "g_sales", ["g_customers.region_id"], ["g_sales.revenue"], {}, {}),
    ("reverse_filter_from_dim", "reverse_filter", "g_products", ["g_products.name"], [],
     {"g_sales.status": {"operator": "eq", "value": "ok"}}, {}),
]

SNAPSHOT_CASES = [
    ("snapshot_star_by_dim", ["snap_customers.region"], ["snap_orders.revenue"], {}),
    ("snapshot_star_filter", [], ["snap_orders.revenue"], {"snap_customers.region": {"operator": "eq", "value": "N"}}),
]


def _norm(v):
    if isinstance(v, Decimal):
        return int(v) if v == int(v) else float(v)
    if isinstance(v, float):
        return int(v) if v == int(v) else round(v, 6)
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    return v


def _rows(result, ordered: bool):
    rows = [[_norm(v) for v in r] for r in result]
    return rows if ordered else sorted(rows, key=lambda r: json.dumps(r, default=str))


def _url():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_pair1_baseline_parity executes SQL on Postgres (DATABASE_URL); it is not a unit test.")
    return url


@pytest.fixture(scope="module")
def engine_world():
    engine = sa.create_engine(_url())
    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        conn.execute(sa.text(f"CREATE SCHEMA {SCHEMA}"))
        for stmt in PHYSICAL:
            conn.execute(sa.text(stmt.format(s=SCHEMA)))
        views = {}
        for name, (table, dims, measures) in VIEWS.items():
            v = SemanticView(name=name, sql_table_name=(f"{SCHEMA}.{table}" if table else CAL_SQL),
                             dataset_table_id=None, dimensions=dims, measures=measures)
            db.add(v)
            views[name] = v
        db.flush()
        tz_dataset = Dataset(name="pair1_tz", settings={"calendar_dimension": {"timezone": "Asia/Ho_Chi_Minh"}})
        db.add(tz_dataset)
        db.flush()
        models = {}
        for key, explores in {**MODELS, **EXTRA_MODELS}.items():
            m = SemanticModel(name=f"pair1_{key}", dataset_id=(tz_dataset.id if key == "tz" else None))
            db.add(m)
            db.flush()
            for base, joins in explores.items():
                db.add(SemanticExplore(name=base, model_id=m.id, base_view_id=views[base].id,
                                       base_view_name=base, joins=joins))
            models[key] = m.id
        # snapshot-backed star: views bound to dataset tables, every table read
        # from a physical "generation" table through snapshot_overrides.
        conn.execute(sa.text(f"CREATE TABLE {SCHEMA}.gen1_customers(id int, region text)"))
        conn.execute(sa.text(f"INSERT INTO {SCHEMA}.gen1_customers VALUES (1,'N'),(2,'S'),(3,NULL)"))
        conn.execute(sa.text(f"CREATE TABLE {SCHEMA}.gen1_orders(id int, customer_id int, amount numeric)"))
        conn.execute(sa.text(f"INSERT INTO {SCHEMA}.gen1_orders VALUES (1,1,100),(2,1,50),(3,2,30),(4,3,7),(5,NULL,1)"))
        ds = Dataset(name="pair1_snapshot")
        db.add(ds)
        db.flush()
        t_c = DatasetTable(dataset_id=ds.id, display_name="customers", source_table_name="customers", columns_cache=[])
        t_o = DatasetTable(dataset_id=ds.id, display_name="orders", source_table_name="orders", columns_cache=[])
        db.add_all([t_c, t_o])
        db.flush()
        v_c = SemanticView(name="snap_customers", dataset_table_id=t_c.id,
                           dimensions=[{"name": "id", "type": "number", "sql": "${TABLE}.id"},
                                       {"name": "region", "type": "string", "sql": "${TABLE}.region"}], measures=[])
        v_o = SemanticView(name="snap_orders", dataset_table_id=t_o.id,
                           dimensions=[{"name": "customer_id", "type": "number", "sql": "${TABLE}.customer_id"}],
                           measures=[{"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"}])
        db.add_all([v_c, v_o])
        db.flush()
        m = SemanticModel(name="pair1_snapshot_model", dataset_id=ds.id)
        db.add(m)
        db.flush()
        db.add(SemanticExplore(name="snap_orders", model_id=m.id, base_view_id=v_o.id, base_view_name="snap_orders",
                               joins=[J("snap_customers", "customer_id", "id")]))
        db.add(SemanticExplore(name="snap_customers", model_id=m.id, base_view_id=v_c.id,
                               base_view_name="snap_customers", joins=[]))
        db.flush()
        models["snapshot"] = m.id
        overrides = {t_c.id: f"{SCHEMA}.gen1_customers", t_o.id: f"{SCHEMA}.gen1_orders"}
        yield db, conn, models, overrides
    finally:
        db.close()
        outer.rollback()
        conn.close()
        engine.dispose()


def _run_engine(world, model, base, dims, measures, filters, kwargs, overrides=None):
    db, conn, models, _ = world
    try:
        sql, _c, _ = SemanticQueryEngine(db, database_type="postgresql").generate_sql(
            explore_name=base, dimensions=dims, measures=measures, filters=filters, model_id=models[model],
            snapshot_overrides=overrides, **kwargs,
        )
    except ValueError as exc:
        return {"refused": type(exc).__name__}
    ordered = bool(kwargs.get("sorts") or kwargs.get("top_n"))
    return {"rows": _rows(conn.execute(sa.text(sql)), ordered)}


def _golden() -> dict:
    return json.loads(GOLDEN.read_text("utf-8")) if GOLDEN.exists() else {}


_CAPTURED: dict = {}


def _check(section: str, case_id: str, got) -> None:
    if CAPTURE:
        _CAPTURED.setdefault(section, {})[case_id] = got
        return
    want = _golden().get(section, {}).get(case_id)
    assert want is not None, f"{section}/{case_id}: no baseline captured"
    assert got == want, f"{section}/{case_id}: baseline {want} != now {got}"


@pytest.fixture(scope="module", autouse=True)
def _write_capture():
    yield
    if CAPTURE and _CAPTURED:
        merged = _golden()
        for section, cases in _CAPTURED.items():
            merged.setdefault(section, {}).update(cases)
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text(json.dumps(merged, indent=1, sort_keys=True, ensure_ascii=False) + "\n", "utf-8")


@pytest.mark.parametrize("case", ENGINE_CASES, ids=[c[0] for c in ENGINE_CASES])
def test_engine_business_numbers_match_the_pre_pair1_baseline(engine_world, case):
    case_id, model, base, dims, measures, filters, kwargs = case
    _check("engine", case_id, _run_engine(engine_world, model, base, dims, measures, filters, kwargs))


@pytest.mark.parametrize("case", SNAPSHOT_CASES, ids=[c[0] for c in SNAPSHOT_CASES])
def test_snapshot_backed_numbers_match_the_pre_pair1_baseline(engine_world, case):
    case_id, dims, measures, filters = case
    _check("snapshot", case_id,
           _run_engine(engine_world, "snapshot", "snap_orders", dims, measures, filters, {}, engine_world[3]))


# ── the HTTP routes on the seeded fixture (dataset 56) ──────────────────────

DATASET_ID = 56
TEAM = "dataset_table_188.team"


@pytest.fixture(scope="module")
def routes():
    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.core.dependencies import get_current_user
    from app.main import app
    from app.models.models import Chart, Dashboard, DashboardChart, DashboardPublicLink
    from app.services import query_cache

    engine = sa.create_engine(_url())
    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    table_ids = [t.id for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == DATASET_ID)]
    charts = [(c.id, c.name) for c in db.query(Chart).filter(Chart.dataset_table_id.in_(table_ids)).order_by(Chart.id)]
    if not charts:
        pytest.fail("no fixture charts — run scripts/seed_snowflake_ci_fixture.py first.")
    token = "pair1-parity-" + uuid.uuid4().hex[:10]
    dash = Dashboard(name=f"pair1 {token}", filters_config=[], pages_config=[])
    db.add(dash)
    db.flush()
    for i, (cid, _n) in enumerate(charts):
        db.add(DashboardChart(dashboard_id=dash.id, chart_id=cid, widget_type="chart",
                              layout={"x": 0, "y": i * 4, "w": 6, "h": 4}))
    db.add(DashboardPublicLink(dashboard_id=dash.id, name="pair1", token=token, is_active=True, filters_config=[]))
    db.flush()
    admin = type("U", (), {"id": uuid.UUID(int=7), "email": "pair1@x", "is_active": True,
                           "permissions": {"settings": "full"}})()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: admin
    saved = (query_cache.get_cached, query_cache.get_shared)
    query_cache.get_cached = lambda *_a, **_k: None  # compute, never a cache hit
    query_cache.get_shared = lambda *_a, **_k: None
    model_id = db.query(SemanticModel).filter(SemanticModel.dataset_id == DATASET_ID).one().id
    try:
        yield TestClient(app), charts, token, model_id
    finally:
        query_cache.get_cached, query_cache.get_shared = saved
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        db.close()
        outer.rollback()
        conn.close()
        engine.dispose()


def _chart_payload(resp):
    if resp.status_code != 200:
        return {"status": resp.status_code}
    data = resp.json().get("data") or []
    rows = [[_norm(v) for _k, v in sorted(r.items())] for r in data]
    return {"rows": sorted(rows, key=lambda r: json.dumps(r, default=str))}


def test_every_fixture_chart_matches_the_baseline_on_every_route(routes):
    client, charts, token, _m = routes
    filt = json.dumps([{"field": TEAM, "semanticField": TEAM, "operator": "eq", "value": "North",
                        "datasetId": DATASET_ID}])
    for cid, name in charts:
        _check("routes", f"saved:{name}", _chart_payload(client.get(f"/api/v1/charts/{cid}/data")))
        _check("routes", f"tile:{name}", _chart_payload(client.get(f"/api/v1/charts/{cid}/data?context=dashboard")))
        _check("routes", f"tile_filtered:{name}", _chart_payload(
            client.get(f"/api/v1/charts/{cid}/data", params={"context": "dashboard", "filters": filt})))
        _check("routes", f"public:{name}", _chart_payload(
            client.get(f"/api/v1/public/dashboards/{token}/charts/{cid}/data")))


DIRECT = [
    ("revenue_by_team", ["dataset_table_188.team"], ["dataset_table_193.total_revenue"], {}),
    ("revenue_by_team_north", ["dataset_table_188.team"], ["dataset_table_193.total_revenue"],
     {"dataset_table_188.team": {"operator": "eq", "value": "North"}}),
]


@pytest.mark.parametrize("case", DIRECT, ids=[c[0] for c in DIRECT])
def test_direct_semantic_query_matches_the_baseline(routes, case):
    client, _charts, _token, model_id = routes
    case_id, dims, measures, filters = case
    resp = client.post("/api/v1/semantic/query", json={
        "explore": "dataset_table_193", "model_id": model_id, "dimensions": dims, "measures": measures,
        "filters": filters, "limit": 10000})
    if resp.status_code != 200:
        got = {"status": resp.status_code}
    else:
        got = {"rows": sorted([[_norm(v) for v in r.values()] for r in resp.json().get("data") or []],
                              key=lambda r: json.dumps(r, default=str))}
    _check("direct", case_id, got)
