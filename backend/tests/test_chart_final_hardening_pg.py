"""Chart final hardening — the chart HTTP contract, executed on Postgres.

The shape of the user report ("bc_activity +2" vs a refusal naming
"bc_pfm → Date | bc_pfm → bc_owner → Date") is `G2_direct_region`: the fact
reaches `regions` directly AND through `customers`. The engine must REFUSE
(two meanings) — never pick a route — and the chart endpoints must say so in a
machine-readable way the Builder can explain. With either relationship
Inactive the meaning is determined and the chart answers the hand-computed
oracle.

Also locked here (Chart final-hardening audit):
  F1  PUT validates the MERGED chart, exactly like create;
  F2  `debug` (SQL with inlined filter values, routing, dialect) only for
      people who may edit the chart;
  F3  a non-refusal failure never returns raw exception text;
  F4  one aggregation vocabulary (percent_of_total saves; median is refused,
      not rewritten to "auto");
  F5  generated mode + a leftover SQL draft is validated as generated.
"""
from __future__ import annotations

import os
import uuid

import pytest
import sqlalchemy as sa

from tests import pair2_topology as T
from tests.pair3_world import chart_config, chart_world, save_chart


def _url():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_chart_final_hardening_pg executes charts on Postgres; it needs DATABASE_URL=postgresql://…")
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


@pytest.fixture(autouse=True)
def no_result_cache(monkeypatch):
    from app.services import query_cache

    monkeypatch.setattr(query_cache, "get_cached", lambda *_a, **_k: None)
    monkeypatch.setattr(query_cache, "begin_coalesced_compute", lambda *_a, **_k: (None, False))
    monkeypatch.setattr(query_cache, "set_cached", lambda *_a, **_k: None)


@pytest.fixture()
def http(pg):
    import uuid as _uuid

    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.core.dependencies import get_current_user
    from app.main import app

    holder = {}
    admin = type("U", (), {"id": _uuid.UUID(int=7), "email": "chf@x", "is_active": True,
                           "permissions": {"settings": "full", "explore_charts": "full", "datasets": "full"}})()
    app.dependency_overrides[get_db] = lambda: holder["db"]
    app.dependency_overrides[get_current_user] = lambda: admin
    try:
        yield TestClient(app, raise_server_exceptions=False), holder
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)


def _case(case_id):
    return next(c for c in T.CASES if c[0] == case_id)


def _key(pair):
    return (pair[0] is None, pair[0] or "", pair[1])


def _rows(payload):
    return sorted(((r.get("p2_regions.name", r.get("name")), r.get("p2_sales.revenue", r.get("revenue")))
                   for r in payload["data"]), key=_key)


# ── The user-reported shape: a refusal, structured, never a first-route-wins ──

def test_ambiguous_route_is_refused_with_a_structured_refusal(pg, http):
    client, holder = http
    _id, model, base, req, _ = _case("G2d.by_region")
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        bodies = []
        for _ in range(5):  # deterministic: the same refusal every run, never a number
            r = client.post("/api/v1/charts/preview-data", json={
                "dataset_table_id": w.tables[base].id, "chart_type": "TABLE", "config": chart_config(req)})
            assert r.status_code == 400, r.text
            assert r.headers.get("X-AppBI-Refusal") == "AMBIGUOUS_ROUTE"
            body = r.json()
            assert "data" not in body
            bodies.append(body)
        assert all(b == bodies[0] for b in bodies)
        refusal = bodies[0]["refusal"]
        assert refusal["category"] == "AMBIGUOUS_ROUTE"
        assert refusal["target"] == "p2_regions"
        assert len(refusal["routes"]) == 2 and len(set(refusal["routes"])) == 2
        assert any("p2_customers" in r for r in refusal["routes"])  # the via-intermediate path
        assert isinstance(bodies[0]["detail"], str) and bodies[0]["detail"]  # prose kept for compat

        # The saved chart refuses the same way (dashboard tile / reopen)
        chart = save_chart(w, base, req)
        g = client.get(f"/api/v1/charts/{chart.id}/data")
        assert g.status_code == 400 and g.json()["refusal"] == refusal

        # Save's dry-run gives the SAME structured refusal (Run == Save)
        d = client.post("/api/v1/charts/dry-run-create", json={
            "name": "x", "chart_type": "TABLE", "dataset_table_id": w.tables[base].id, "config": chart_config(req)})
        assert d.status_code == 200, d.text
        assert d.json()["ok"] is False and d.json()["runtime_refusal"] == refusal


@pytest.mark.parametrize("case_id", ["G12.direct_inactive.fact_by_region",
                                     "G12.customer_region_inactive.fact_by_region"])
def test_an_inactive_relationship_determines_the_meaning(pg, http, case_id):
    client, holder = http
    _id, model, base, req, expected = _case(case_id)
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        want = sorted(((e["p2_regions.name"], e["p2_sales.revenue"]) for e in expected), key=_key)
        for _ in range(3):
            r = client.post("/api/v1/charts/preview-data", json={
                "dataset_table_id": w.tables[base].id, "chart_type": "TABLE", "config": chart_config(req)})
            assert r.status_code == 200, r.text
            assert _rows(r.json()) == want
        chart = save_chart(w, base, req)
        g = client.get(f"/api/v1/charts/{chart.id}/data")
        assert g.status_code == 200 and _rows(g.json()) == want  # preview == saved


# ── F2: diagnostics only for editors ──────────────────────────────────────────

@pytest.mark.parametrize("perm,sees_sql", [("view", False), ("edit", True), ("full", True)])
def test_chart_data_debug_is_editor_only(pg, http, monkeypatch, perm, sees_sql):
    client, holder = http
    _id, model, base, req, _ = _case("G12.direct_inactive.fact_by_region")
    monkeypatch.setattr("app.api.charts.get_effective_permission", lambda *a, **k: perm)
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, base, req)
        r = client.get(f"/api/v1/charts/{chart.id}/data")
        assert r.status_code == 200, r.text
        debug = r.json().get("debug") or {}
        raw = r.text
        if sees_sql:
            assert debug.get("sql_emitted") and debug.get("routing")
        else:
            for key in ("sql_emitted", "sql_emitted_per_group", "routing", "dialect", "warnings"):
                assert debug.get(key) in (None, [], {}), (key, debug)
            assert "SELECT" not in raw.upper().replace("SELECTEDCOLUMNS", "")
            assert T.S not in raw  # no physical schema name


# ── F3: raw failures never reach the caller ───────────────────────────────────

def test_a_driver_failure_is_answered_without_its_text(pg, http, monkeypatch):
    client, holder = http
    _id, model, base, req, _ = _case("G12.direct_inactive.fact_by_region")
    secret = "password=hunter2 host=10.9.8.7 dbname=prod_finance"

    def boom(*_a, **_k):
        raise RuntimeError(f"could not connect: {secret}")

    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, base, req)
        monkeypatch.setattr("app.services.chart_service.ChartService.get_chart_data", staticmethod(boom))
        monkeypatch.setattr("app.services.chart_service.ChartService.preview_chart_data", staticmethod(boom))
        for r in (client.get(f"/api/v1/charts/{chart.id}/data"),
                  client.post("/api/v1/charts/preview-data", json={
                      "dataset_table_id": w.tables[base].id, "chart_type": "TABLE", "config": chart_config(req)})):
            assert r.status_code == 500
            assert "hunter2" not in r.text and "10.9.8.7" not in r.text and "prod_finance" not in r.text
            assert "ref" in r.json()["detail"].lower() or "tham chiếu" in r.json()["detail"]
        d = client.post("/api/v1/charts/dry-run-create", json={
            "name": "x", "chart_type": "TABLE", "dataset_table_id": w.tables[base].id, "config": chart_config(req)})
        assert d.status_code == 200 and "hunter2" not in d.text


def test_a_batch_tile_failure_is_answered_without_its_text(pg, monkeypatch):
    from app.services.chart_service import ChartService

    _id, model, base, req, _ = _case("G12.direct_inactive.fact_by_region")
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        chart = save_chart(w, base, req)

        class _NoClose:
            def __init__(self, db):
                self._db = db

            def __getattr__(self, n):
                return getattr(self._db, n)

            def close(self):
                pass

        monkeypatch.setattr("app.core.database.SessionLocal", lambda: _NoClose(w.db))

        def boom(*_a, **_k):
            raise RuntimeError("password=hunter2 at 10.9.8.7")

        monkeypatch.setattr(ChartService, "get_chart_data", staticmethod(boom))
        [item] = ChartService.get_charts_data_batch([{"chart_id": chart.id}])
        assert item["ok"] is False and item["status"] == 500
        assert "hunter2" not in item["error"] and "10.9.8.7" not in item["error"]


# ── F1 / F4 / F5: one validation contract for create, update and dry-run ─────

def _with_user(w):
    """The HTTP user as a real row: chart.owner_id is a foreign key."""
    import uuid as _uuid

    from app.models.user import User, UserStatus

    uid = _uuid.UUID(int=7)
    if w.db.get(User, uid) is None:
        w.db.add(User(id=uid, email=f"chf-{_uuid.uuid4().hex[:6]}@x", full_name="chf",
                      status=UserStatus.ACTIVE, permissions={}))
        w.db.flush()


def _n(label):
    return f"{label} {uuid.uuid4().hex[:8]}"


def _bar(dimension="p2_regions.name", agg="sum", **extra):
    role = {"metrics": [{"field": "p2_sales.revenue", "agg": agg}]}
    if dimension:
        role["dimension"] = dimension
    return {"chartType": "BAR", "queryMode": "generated", "roleConfig": role, "generatedRoleConfig": role, **extra}


def test_update_validates_the_final_chart_state(pg, http):
    client, holder = http
    _id, model, base, req, _ = _case("G12.direct_inactive.fact_by_region")
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        _with_user(w)
        t = w.tables[base].id
        c = client.post("/api/v1/charts/", json={"name": _n("f1 bar"), "chart_type": "BAR",
                                                  "dataset_table_id": t, "config": _bar()})
        assert c.status_code in (200, 201), c.text
        cid = c.json()["id"]
        # create refuses a BAR without a dimension …
        bad = client.post("/api/v1/charts/", json={"name": _n("f1 bad"), "chart_type": "BAR",
                                                    "dataset_table_id": t, "config": _bar(dimension=None)})
        assert bad.status_code == 422, bad.text
        # … so a config-only update must refuse the same final state
        u = client.put(f"/api/v1/charts/{cid}", json={"config": _bar(dimension=None)})
        assert u.status_code == 422, u.text
        # a type-only update to SCATTER (no axes in the stored config) is refused too
        u2 = client.put(f"/api/v1/charts/{cid}", json={"chart_type": "SCATTER"})
        assert u2.status_code == 422, u2.text
        # the stored chart is unchanged
        assert client.get(f"/api/v1/charts/{cid}").json()["chart_type"] == "BAR"
        # a rename is not a semantic change and stays allowed
        assert client.put(f"/api/v1/charts/{cid}", json={"name": _n("f1 renamed")}).status_code == 200


def test_one_aggregation_vocabulary(pg, http):
    client, holder = http
    _id, model, base, req, _ = _case("G12.direct_inactive.fact_by_region")
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        _with_user(w)
        t = w.tables[base].id
        ok = client.post("/api/v1/charts/", json={"name": _n("f4 pct"), "chart_type": "BAR", "dataset_table_id": t,
                                                   "config": _bar(agg="percent_of_total")})
        assert ok.status_code in (200, 201), ok.text  # previewable ⇒ saveable
        upper = client.post("/api/v1/charts/", json={"name": _n("f4 upper"), "chart_type": "BAR", "dataset_table_id": t,
                                                      "config": _bar(agg="SUM")})
        assert upper.status_code in (200, 201), upper.text  # case-insensitive everywhere
        bad = client.post("/api/v1/charts/", json={"name": _n("f4 median"), "chart_type": "BAR", "dataset_table_id": t,
                                                    "config": _bar(agg="median")})
        assert bad.status_code == 422
        d = client.post("/api/v1/charts/dry-run-create", json={"name": _n("f4 d"), "chart_type": "BAR",
                                                                "dataset_table_id": t, "config": _bar(agg="median")})
        # dry-run must not silently rewrite median → auto and call it valid
        assert d.status_code == 422 or d.json().get("ok") is False, d.text
        if d.status_code == 200:
            assert d.json()["normalized_config"]["roleConfig"]["metrics"][0]["agg"] == "median"


def test_generated_mode_with_a_leftover_sql_draft_is_validated_as_generated(pg, http):
    client, holder = http
    _id, model, base, req, _ = _case("G12.direct_inactive.fact_by_region")
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        _with_user(w)
        cfg = _bar(dimension=None, customSql="SELECT 1 AS x")
        r = client.post("/api/v1/charts/", json={"name": _n("f5"), "chart_type": "BAR",
                                                  "dataset_table_id": w.tables[base].id, "config": cfg})
        assert r.status_code == 422, r.text  # runtime runs GENERATED: a BAR without dimension
