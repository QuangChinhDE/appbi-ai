"""Write-time chart-config validation per ingress path, over real HTTP on Postgres.

The unit file (test_chart_config_write_validation.py) proves the contract and that
each write site calls the guard. This file proves the PRODUCT behaviour through
the real application, real authentication and the real request-scoped session, so
a refused request ends exactly as in production (what it flushed is not kept):

  preview-data, import-html/build, import-html/build-batch, import-snapshot,
  dashboard duplicate, in-place fork-chart.

For each path: a chart config with a time grain that does not exist
("invalid_period") is refused with an HTTP error; nothing is stored for it and no
dashboard is left half-built; a valid config is created, reopened and renders the
hand-computed numbers; custom-SQL authority is still enforced.
"""
from __future__ import annotations

import json
import uuid
from decimal import Decimal

import pytest
import sqlalchemy as sa
from sqlalchemy.engine import make_url

from tests.authz_http import OWNER_URL, client, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg

SCHEMA = "a2_paths"
INVALID = "invalid_period"
MONTH_TOTALS = [50, 150]          # a2_paths.orders by month: Jan 100+50, Feb 30+20


@pytest.fixture()
def world(db, monkeypatch):  # noqa: F811
    from app.core.config import settings as _settings
    from app.models.dataset import Dataset, DatasetGrant, DatasetTable
    from app.models.models import DataSource, DataSourceType
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    monkeypatch.setattr(_settings, "ALLOWED_PRIVATE_SOURCE_CIDRS", "127.0.0.0/8,::1/128")
    url = make_url(OWNER_URL)
    engine = sa.create_engine(OWNER_URL)
    with engine.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        c.execute(sa.text(f"CREATE SCHEMA {SCHEMA}"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.orders (id int, region text, revenue numeric, order_date date)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.orders VALUES (1,'North',100,'2026-01-05'),"
                          f"(2,'North',50,'2026-01-20'),(3,'South',30,'2026-02-03'),(4,'East',20,'2026-02-17')"))

    tag = uuid.uuid4().hex[:6]
    work = dict(datasets="edit", explore_charts="edit", dashboards="edit")
    owner = make_user(db, "a2-owner", data_sources="edit", **work)
    builder = make_user(db, "a2-builder", **work)    # BUILD grant on the dataset, no datasource right

    src = DataSource(name=f"a2-{tag}", type=DataSourceType.POSTGRESQL, owner_id=owner.id,
                     config={"host": url.host, "port": url.port or 5432, "database": url.database,
                             "username": url.username, "password": url.password or ""})
    ds = Dataset(name=f"a2-ds-{tag}", owner_id=owner.id, purpose="reporting")
    db.add_all([src, ds])
    db.flush()
    table = DatasetTable(dataset_id=ds.id, datasource_id=src.id, source_kind="physical_table",
                         source_table_name=f"{SCHEMA}.orders", display_name="orders", query_mode="live",
                         columns_cache={"columns": [{"name": "region", "type": "string"},
                                                    {"name": "revenue", "type": "number"},
                                                    {"name": "order_date", "type": "date"}]})
    model = SemanticModel(name=f"a2-model-{tag}", dataset_id=ds.id)
    db.add_all([table, model])
    db.flush()
    view_name = f"a2_orders_{tag}"
    view = SemanticView(name=view_name, sql_table_name=f"{SCHEMA}.orders", dataset_table_id=table.id,
                        dimensions=[{"name": "region", "type": "string", "sql": "${TABLE}.region"},
                                    {"name": "order_date", "type": "date", "sql": "${TABLE}.order_date"}],
                        measures=[{"name": "revenue", "type": "sum", "sql": "${TABLE}.revenue"}])
    db.add(view)
    db.flush()
    db.add(SemanticExplore(name=f"a2_x_{tag}", model_id=model.id, base_view_id=view.id,
                           base_view_name=view_name, joins=[]))
    db.add(DatasetGrant(dataset_id=ds.id, user_id=builder.id, verb="build", granted_by=owner.id))
    db.commit()
    w = dict(db=db, tag=tag, ds=ds, table=table, v=view_name, owner=owner, builder=builder)
    try:
        yield w
    finally:
        _cleanup(w)
        with engine.begin() as c:
            c.execute(sa.text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        engine.dispose()


def _cleanup(w):
    from app.models.models import Chart, Dashboard, DashboardChart, DashboardPublicLink

    db = w["db"]
    db.rollback()
    dash_ids = [d.id for d in db.query(Dashboard).filter(Dashboard.name.like(f"%{w['tag']}%"))]
    chart_ids = [c.id for c in db.query(Chart).filter(Chart.dataset_table_id == w["table"].id)]
    if dash_ids:
        db.query(DashboardPublicLink).filter(DashboardPublicLink.dashboard_id.in_(dash_ids)).delete(
            synchronize_session=False)
        db.query(DashboardChart).filter(DashboardChart.dashboard_id.in_(dash_ids)).delete(synchronize_session=False)
    if chart_ids:
        db.query(DashboardChart).filter(DashboardChart.chart_id.in_(chart_ids)).delete(synchronize_session=False)
        db.query(Chart).filter(Chart.id.in_(chart_ids)).delete(synchronize_session=False)
    if dash_ids:
        db.query(Dashboard).filter(Dashboard.id.in_(dash_ids)).delete(synchronize_session=False)
    db.commit()


# ── helpers ────────────────────────────────────────────────────────────────
def _role(w, grain):
    v = w["v"]
    return {"dimension": f"{v}.order_date", "metrics": [{"field": f"{v}.revenue", "agg": "sum"}],
            "timeGrains": {f"{v}.order_date": grain}}


def _state(w):
    """(dashboard ids named for this test, {chart id: config} on this test's table)."""
    from app.models.models import Chart, Dashboard

    db = w["db"]
    db.rollback()
    db.expire_all()
    dashes = {d.id for d in db.query(Dashboard).filter(Dashboard.name.like(f"%{w['tag']}%"))}
    charts = {c.id: (c.config or {}) for c in db.query(Chart).filter(Chart.dataset_table_id == w["table"].id)}
    return dashes, charts


def _stored_invalid(w):
    return [cid for cid, cfg in _state(w)[1].items() if INVALID in json.dumps(cfg)]


def _month_totals(client, w, chart_id, who="owner"):  # noqa: F811
    r = client.get(f"/api/v1/charts/{chart_id}/data", headers=w[who].headers)
    assert r.status_code == 200, r.text
    found = []
    for row in r.json().get("data", []):
        for value in row.values():
            try:
                n = Decimal(str(value))
            except Exception:  # noqa: BLE001 - labels and dates are not numbers
                continue
            if n in (50, 150):
                found.append(int(n))
    return sorted(found)



# ── 1. preview-data ────────────────────────────────────────────────────────
def _preview(client, w, config, who="owner"):  # noqa: F811
    return client.post("/api/v1/charts/preview-data", headers=w[who].headers,
                       json={"dataset_table_id": w["table"].id, "chart_type": "BAR", "config": config})


def test_preview_refuses_an_invalid_grain_and_previews_a_valid_one(client, world):  # noqa: F811
    bad = _preview(client, world, {"roleConfig": _role(world, INVALID)})
    assert bad.status_code == 422, bad.text
    assert "timeGrains" in bad.text and not bad.json().get("data")
    good = _preview(client, world, {"roleConfig": _role(world, "month")})
    assert good.status_code == 200, good.text
    assert _stored_invalid(world) == []


def test_preview_still_enforces_custom_sql_authority(client, world):  # noqa: F811
    custom = {"queryMode": "custom", "customSql": "SELECT 1 AS one", "roleConfig": _role(world, "month")}
    assert _preview(client, world, custom, who="builder").status_code == 403


# ── 2. import-html/build (single document) ─────────────────────────────────
def _plan(w, block_id, grain):
    return {"block_id": block_id, "title": f"Chart {block_id} {w['tag']}", "final_chart_type": "BAR",
            "source_key": "orders", "role_config": _role(w, grain),
            "layout": {"x": 0, "y": 0, "w": 12, "h": 8}}


def _analysis(w, *plans):
    return {"suggested_dashboard_name": f"A2 build {w['tag']}", "chart_plans": list(plans),
            "widgets": [], "slicers": []}


def _build(client, w, analysis, who="owner", batch=False):  # noqa: F811
    if batch:
        data = {"analyses_json": json.dumps([{"document_id": "d1", "analysis": analysis}]),
                "source_mode": "existing_dataset", "target_mode": "new_dashboard", "dataset_id": str(w["ds"].id),
                "dashboard_name": f"A2 batch {w['tag']}"}
        return client.post("/api/v1/dashboards/import-html/build-batch", headers=w[who].headers, data=data)
    data = {"analysis_json": json.dumps(analysis), "source_mode": "existing_dataset",
            "target_mode": "new_dashboard", "dataset_id": str(w["ds"].id), "dashboard_name": f"A2 build {w['tag']}"}
    return client.post("/api/v1/dashboards/import-html/build", headers=w[who].headers, data=data)


def test_build_refuses_an_invalid_grain_and_stores_nothing(client, world):  # noqa: F811
    r = _build(client, world, _analysis(world, _plan(world, "b1", INVALID)))
    assert r.status_code == 422, r.text
    assert _state(world)[0] == set() and _stored_invalid(world) == []


def test_build_creates_renders_and_reopens_a_valid_chart(client, world):  # noqa: F811
    r = _build(client, world, _analysis(world, _plan(world, "b1", "month")))
    assert r.status_code == 201, r.text
    _dashes, charts = _state(world)
    assert len(charts) == 1
    chart_id = next(iter(charts))
    assert _month_totals(client, world, chart_id) == MONTH_TOTALS


# ── 3. import-html/build-batch: all-or-nothing on an invalid later document ─
def _batch(client, w, *docs, who="owner"):  # noqa: F811
    analyses = [{"document_id": f"d{i}", "page_name": f"Page {i} {w['tag']}", "analysis": a}
                for i, a in enumerate(docs, start=1)]
    data = {"analyses_json": json.dumps(analyses), "source_mode": "existing_dataset",
            "target_mode": "new_dashboard", "dataset_id": str(w["ds"].id), "dashboard_name": f"A2 batch {w['tag']}"}
    return client.post("/api/v1/dashboards/import-html/build-batch", headers=w[who].headers, data=data)


def test_batch_with_a_valid_then_invalid_document_builds_nothing(client, world):  # noqa: F811
    # Document 1 is valid, document 2 carries an invalid grain. Before the fix,
    # document 1's page committed and the batch left a half-built dashboard.
    before_dashes, _ = _state(world)
    r = _batch(client, world,
               _analysis(world, _plan(world, "ok", "month")),
               _analysis(world, _plan(world, "bad", INVALID)))
    assert r.status_code == 422, r.text
    after_dashes, charts = _state(world)
    assert after_dashes == before_dashes, "a failed batch left a dashboard behind"
    assert _stored_invalid(world) == [] and charts == {}


def test_a_fully_valid_batch_builds_every_page(client, world):  # noqa: F811
    r = _batch(client, world,
               _analysis(world, _plan(world, "p1", "month")),
               _analysis(world, _plan(world, "p2", "month")))
    assert r.status_code == 201, r.text
    body = r.json()
    assert len(body["pages"]) == 2 and body["created_chart_count"] == 2
    charts = _state(world)[1]
    assert len(charts) == 2
    for cid in charts:
        assert _month_totals(client, world, cid) == MONTH_TOTALS


# ── 4. snapshot import + duplicate ─────────────────────────────────────────
def _make_dashboard_with_chart(world, grain):
    """A stored dashboard + chart (written straight to the DB) to serialize and
    re-import. A grain written here bypasses the write guard on purpose, so the
    snapshot path's own guard is what is under test."""
    from app.models.models import Chart, ChartType, Dashboard, DashboardChart

    db = world["db"]
    chart = Chart(name=f"src {world['tag']}", chart_type=ChartType.BAR, dataset_table_id=world["table"].id,
                  owner_id=world["owner"].id, config={"roleConfig": _role(world, grain)})
    db.add(chart)
    db.flush()
    dash = Dashboard(name=f"src dash {world['tag']}", owner_id=world["owner"].id)
    db.add(dash)
    db.flush()
    db.add(DashboardChart(dashboard_id=dash.id, chart_id=chart.id, widget_type="chart",
                          layout={"x": 0, "y": 0, "w": 12, "h": 8}))
    db.commit()
    return dash


def _import_snapshot(client, world, html, who="owner"):
    import io
    return client.post("/api/v1/dashboards/import-snapshot", headers=world[who].headers,
                       files={"file": ("snap.html", io.BytesIO(html.encode("utf-8")), "text/html")})


def test_snapshot_import_refuses_an_invalid_grain_chart(client, world):  # noqa: F811
    from app.services.dashboard_html_import_service import export_dashboard_html
    from app.services.dashboard_service import DashboardService

    src = _make_dashboard_with_chart(world, INVALID)
    html = export_dashboard_html(DashboardService.get_by_id(world["db"], src.id))
    before = _state(world)[0]
    r = _import_snapshot(client, world, html)
    assert r.status_code == 422, r.text
    assert _state(world)[0] == before, "snapshot import left a dashboard behind"


def test_snapshot_import_accepts_a_valid_grain_chart(client, world):  # noqa: F811
    from app.services.dashboard_html_import_service import export_dashboard_html
    from app.services.dashboard_service import DashboardService

    src = _make_dashboard_with_chart(world, "month")
    html = export_dashboard_html(DashboardService.get_by_id(world["db"], src.id))
    r = _import_snapshot(client, world, html)
    assert r.status_code == 201, r.text


def test_duplicate_refuses_a_dashboard_whose_chart_has_an_invalid_grain(client, world):  # noqa: F811
    src = _make_dashboard_with_chart(world, INVALID)
    before = _state(world)[0]
    r = client.post(f"/api/v1/dashboards/{src.id}/duplicate", headers=world["owner"].headers)
    assert r.status_code == 422, r.text
    assert _state(world)[0] == before, "duplicate left a copy behind"


def test_duplicate_copies_a_valid_dashboard(client, world):  # noqa: F811
    src = _make_dashboard_with_chart(world, "month")
    before = _state(world)[0]
    r = client.post(f"/api/v1/dashboards/{src.id}/duplicate", headers=world["owner"].headers)
    assert r.status_code == 201, r.text
    assert len(_state(world)[0]) == len(before) + 1


# ── 5. in-place fork-chart ─────────────────────────────────────────────────
def _tile_with_chart(world, grain="month"):
    from app.models.models import Chart, ChartType, Dashboard, DashboardChart

    db = world["db"]  # noqa: F841 - used below
    chart = Chart(name=f"shared {world['tag']}", chart_type=ChartType.BAR, dataset_table_id=world["table"].id,
                  owner_id=world["owner"].id, config={"roleConfig": _role(world, grain)})
    db.add(chart)
    db.flush()
    dash = Dashboard(name=f"fork dash {world['tag']}", owner_id=world["owner"].id)
    db.add(dash)
    db.flush()
    tile = DashboardChart(dashboard_id=dash.id, chart_id=chart.id, widget_type="chart",
                          layout={"x": 0, "y": 0, "w": 12, "h": 8})
    db.add(tile)
    db.commit()
    return dash, tile


def _fork(client, world, dash, tile, grain, who="owner"):
    return client.post(
        f"/api/v1/dashboards/{dash.id}/charts/{tile.id}/fork-chart", headers=world[who].headers,
        json={"name": f"forked {world['tag']}", "chart_type": "BAR", "dataset_table_id": world["table"].id,
              "config": {"roleConfig": _role(world, grain)}})


def test_fork_refuses_an_invalid_grain_and_stores_nothing(client, world):  # noqa: F811
    # fork-chart has two branches: the ChartCreate copy path (first fork) and the
    # in-place branch (a later fork on a tile already showing this user's draft).
    # The copy path refuses via ChartCreate; the in-place branch refuses via the
    # write guard (test_chart_config_write_validation.py asserts the in-place
    # branch references the guard). Here, over HTTP, an invalid grain is refused
    # (4xx) and nothing invalid is stored, and a valid fork succeeds.
    dash, tile = _tile_with_chart(world, "month")
    bad = _fork(client, world, dash, tile, INVALID)
    assert bad.status_code in (400, 422), bad.text
    assert _stored_invalid(world) == [], "a refused fork stored an invalid-grain chart"
    good = _fork(client, world, dash, tile, "month")
    assert good.status_code == 200, good.text
    # A second fork (now an in-place update of the draft) with a bad grain is
    # also refused, by whichever layer catches it first.
    world["db"].expire_all()
    again = _fork(client, world, dash, tile, INVALID)
    assert again.status_code in (400, 422), again.text
    assert _stored_invalid(world) == []

