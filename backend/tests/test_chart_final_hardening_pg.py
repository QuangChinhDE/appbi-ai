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
        assert d.status_code == 200 and d.json()["ok"] is False, d.text
        assert any("median" in e for e in d.json()["validation_errors"]), d.json()


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


# ── Chart final closure ───────────────────────────────────────────────────────


def test_a_value_error_is_shown_only_when_it_carries_nothing_internal(pg, http, monkeypatch):
    """"It is a ValueError" does not make a message safe. A config message is
    shown; a ValueError that echoes a DSN / host / SQL / driver is answered with
    the reference id; a semantic refusal keeps its structured body."""
    client, holder = http
    _id, model, base, req, _ = _case("G12.direct_inactive.fact_by_region")
    leaky = [
        "could not connect: host=10.9.8.7 user=svc password=hunter2 dbname=prod_finance",
        "postgresql+psycopg2://svc:hunter2@10.9.8.7:5432/prod_finance unreachable",
        "bad value near SELECT secret_col FROM prod_finance.payroll",
        "google.api_core.exceptions.BadRequest: projects/acme-prod-9 dataset not found",
    ]
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, base, req)
        body = {"dataset_table_id": w.tables[base].id, "chart_type": "TABLE", "config": chart_config(req)}
        for text in leaky:
            def boom(*_a, _t=text, **_k):
                raise ValueError(_t)
            monkeypatch.setattr("app.services.chart_service.ChartService.get_chart_data", staticmethod(boom))
            monkeypatch.setattr("app.services.chart_service.ChartService.preview_chart_data", staticmethod(boom))
            for r in (client.get(f"/api/v1/charts/{chart.id}/data"),
                      client.post("/api/v1/charts/preview-data", json=body),
                      client.post("/api/v1/charts/dry-run-create", json={"name": "x", **body})):
                for secret in ("hunter2", "10.9.8.7", "prod_finance", "payroll", "acme-prod-9", "psycopg2"):
                    assert secret not in r.text, (text, r.status_code, r.text)
            assert client.get(f"/api/v1/charts/{chart.id}/data").status_code == 400
        # an ordinary config message is still actionable, verbatim
        msg = "Field 'region' xuất hiện ở nhiều bảng đã JOIN — đổi reference sang 'p2_regions.region'"

        def config_error(*_a, **_k):
            raise ValueError(msg)
        monkeypatch.setattr("app.services.chart_service.ChartService.preview_chart_data", staticmethod(config_error))
        r = client.post("/api/v1/charts/preview-data", json=body)
        assert r.status_code == 400 and r.json()["detail"] == msg and "refusal" not in r.json()


def test_a_batch_tile_value_error_is_sanitised_too(pg, monkeypatch):
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
            raise ValueError("host=10.9.8.7 password=hunter2")

        monkeypatch.setattr(ChartService, "get_chart_data", staticmethod(boom))
        [item] = ChartService.get_charts_data_batch([{"chart_id": chart.id}])
        assert item["ok"] is False and item["status"] == 400
        assert "hunter2" not in item["error"] and "10.9.8.7" not in item["error"]


def test_percent_of_total_round_trips_create_reopen_update_and_runtime(pg, http):
    """A saved explicit percent_of_total keeps its meaning everywhere: create,
    GET (what the editor reopens), dry-run normalisation, an update, and the
    runtime answer (shares of the hand-computed total 198)."""
    client, holder = http
    _id, model, base, req, _ = _case("G12.direct_inactive.fact_by_region")
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        _with_user(w)
        t = w.tables[base].id
        cfg = _bar(agg="percent_of_total")
        d = client.post("/api/v1/charts/dry-run-create", json={"name": _n("pct d"), "chart_type": "BAR",
                                                                "dataset_table_id": t, "config": cfg})
        assert d.status_code == 200 and d.json()["ok"] is True, d.text
        assert d.json()["normalized_config"]["roleConfig"]["metrics"][0]["agg"] == "percent_of_total"
        c = client.post("/api/v1/charts/", json={"name": _n("pct"), "chart_type": "BAR", "dataset_table_id": t,
                                                  "config": d.json()["normalized_config"]})
        assert c.status_code in (200, 201), c.text
        cid = c.json()["id"]
        reopened = client.get(f"/api/v1/charts/{cid}").json()
        assert reopened["config"]["roleConfig"]["metrics"][0]["agg"] == "percent_of_total"
        u = client.put(f"/api/v1/charts/{cid}", json={"config": reopened["config"], "chart_type": "BAR"})
        assert u.status_code == 200, u.text
        assert u.json()["config"]["roleConfig"]["metrics"][0]["agg"] == "percent_of_total"
        data = client.get(f"/api/v1/charts/{cid}/data")
        assert data.status_code == 200, data.text
        shares = {}
        for row in data.json()["data"]:
            region = row.get("p2_regions.name")
            value = next(v for k, v in row.items() if k != "p2_regions.name")
            shares[region] = float(value)
        scale = 100.0 if max(shares.values()) > 1.0 else 1.0
        expected = {"North": 130 / 198, "South": 61 / 198, None: 7 / 198}
        for k, v in expected.items():
            assert abs(shares[k] / scale - v) < 1e-6, shares


def test_a_legacy_chart_is_viewable_renameable_and_refused_only_on_semantic_edits(pg, http):
    """A stored chart missing a required role (written before the required-role
    check worked): still served, renameable and re-describable; a config / type /
    table edit is refused with a message naming the missing role; nothing is
    coerced or corrupted."""
    from app.models.models import Chart

    client, holder = http
    _id, model, base, req, _ = _case("G12.direct_inactive.fact_by_region")
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        _with_user(w)
        import uuid as _uuid
        legacy_cfg = _bar(dimension=None)
        legacy = Chart(name=_n("legacy bar"), dataset_table_id=w.tables[base].id, chart_type="BAR",
                       config=legacy_cfg, owner_id=_uuid.UUID(int=7))
        w.db.add(legacy)
        w.db.flush()
        stored = dict(legacy.config)
        assert client.get(f"/api/v1/charts/{legacy.id}/data").status_code != 422  # viewing is not validation
        assert client.put(f"/api/v1/charts/{legacy.id}", json={"name": _n("legacy renamed")}).status_code == 200
        assert client.put(f"/api/v1/charts/{legacy.id}", json={"description": "kept"}).status_code == 200
        for edit in ({"config": legacy_cfg}, {"chart_type": "LINE"}):
            r = client.put(f"/api/v1/charts/{legacy.id}", json=edit)
            assert r.status_code == 422, r.text
            assert "dimension" in r.json()["detail"] and "không hợp lệ" in r.json()["detail"], r.text
        w.db.expire_all()
        again = w.db.get(Chart, legacy.id)
        assert getattr(again.chart_type, "value", again.chart_type) == "BAR"
        assert again.config.get("roleConfig") == stored.get("roleConfig")


def test_there_is_one_chart_creation_path(pg, http):
    """The parallel agent/SDK paths are gone from the Chart application; the
    canonical contract (preview, dry-run, create, update, data) is the only one."""
    client, holder = http
    _id, model, base, req, _ = _case("G12.direct_inactive.fact_by_region")
    with chart_world(pg, model, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        t = w.tables[base].id
        for path in ("/api/v1/charts/ai-preview", "/api/v1/charts/normalize-config"):
            r = client.post(path, json={"dataset_table_id": t, "chart_type": "TABLE", "config": {}})
            assert r.status_code in (404, 405), (path, r.status_code)
        from app.main import app
        routes = {getattr(r, "path", "") for r in app.routes}
        assert not {p for p in routes if "ai-preview" in p or "normalize-config" in p}
        r = client.post("/api/v1/charts/preview-data", json={
            "dataset_table_id": t, "chart_type": "TABLE", "config": chart_config(req)})
        assert r.status_code == 200, r.text
