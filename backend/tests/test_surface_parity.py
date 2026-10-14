"""The same chart gives the same VALUES on every surface that serves it.

Executed through the real HTTP routes on the seeded CI fixture (dataset 56):

  * saved chart            GET /api/v1/charts/{id}/data            (authed)
  * dashboard tile         GET /api/v1/charts/{id}/data?context=dashboard
  * public link            GET /api/v1/public/dashboards/{token}/charts/{id}/data  (anonymous)

and with a filter: the dashboard's runtime filter vs the same predicate LOCKED
on the public link. (Explore preview == dashboard tile is its own gate,
scripts/test_explore_dashboard_parity.py; PDF renders the public page and has
no query path of its own — PDF_EXPORT_ENABLED is off by default.)

The dashboard, its tiles and the link are created inside ONE transaction that
is rolled back, so the fixture is untouched. The app's lifespan (schedulers)
never starts: requests go through TestClient without entering its context.
"""
from __future__ import annotations

import os
import uuid

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

DATASET_ID = 56
TOKEN = "surface-parity-" + uuid.uuid4().hex[:12]
TEAM = "dataset_table_188.team"


@pytest.fixture(scope="module")
def client_and_charts():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_surface_parity needs the seeded Postgres CI fixture (DATABASE_URL).")
    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.core.dependencies import get_current_user
    from app.main import app
    from app.models.dataset import DatasetTable
    from app.models.models import Chart, Dashboard, DashboardChart, DashboardPublicLink
    from app.services import query_cache

    engine = sa.create_engine(url)
    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    table_ids = [t.id for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == DATASET_ID)]
    charts = [
        (c.id, c.name) for c in db.query(Chart).filter(Chart.dataset_table_id.in_(table_ids)).order_by(Chart.id)
        if "chasm" not in c.name  # refuses on every surface; not a parity case
    ]
    if not charts:
        pytest.fail("no fixture charts — run scripts/seed_snowflake_ci_fixture.py first.")
    dash = Dashboard(name=f"parity {TOKEN}", filters_config=[], pages_config=[])
    db.add(dash)
    db.flush()
    for i, (cid, _n) in enumerate(charts):
        db.add(DashboardChart(dashboard_id=dash.id, chart_id=cid, widget_type="chart",
                              layout={"x": 0, "y": i * 4, "w": 6, "h": 4}))
    db.add(DashboardPublicLink(dashboard_id=dash.id, name="parity", token=TOKEN, is_active=True,
                               filters_config=[]))
    db.add(DashboardPublicLink(dashboard_id=dash.id, name="parity-north", token=TOKEN + "-n", is_active=True,
                               filters_config=[{"field": TEAM, "semanticField": TEAM, "operator": "eq",
                                                "value": "North", "publicMode": "locked", "datasetId": DATASET_ID}]))
    db.flush()

    admin = type("U", (), {"id": uuid.UUID(int=7), "email": "parity@x", "is_active": True,
                           "permissions": {"settings": "full"}})()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: admin
    saved_get = query_cache.get_cached
    query_cache.get_cached = lambda *_a, **_k: None  # compare computations, not cache hits
    try:
        yield TestClient(app), charts
    finally:
        query_cache.get_cached = saved_get
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        db.close()
        outer.rollback()
        conn.close()
        engine.dispose()


def _values(resp) -> list:
    assert resp.status_code == 200, resp.text[:500]
    rows = resp.json().get("data") or []
    return sorted(sorted(str(round(float(v), 6)) if isinstance(v, (int, float)) else str(v) for v in r.values())
                  for r in rows)


def test_saved_chart_dashboard_tile_and_public_link_agree(client_and_charts):
    client, charts = client_and_charts
    for cid, name in charts:
        saved = _values(client.get(f"/api/v1/charts/{cid}/data"))
        tile = _values(client.get(f"/api/v1/charts/{cid}/data", params={"context": "dashboard"}))
        public = _values(client.get(f"/api/v1/public/dashboards/{TOKEN}/charts/{cid}/data"))
        assert saved == tile == public, name
        assert saved, f"{name}: no rows — a parity of two empty results proves nothing"


def test_a_locked_link_filter_equals_the_same_dashboard_filter(client_and_charts):
    import json

    client, charts = client_and_charts
    runtime = json.dumps([{"field": TEAM, "semanticField": TEAM, "operator": "eq", "value": "North",
                           "datasetId": DATASET_ID}])
    compared = 0
    for cid, name in charts:
        tile = client.get(f"/api/v1/charts/{cid}/data", params={"context": "dashboard", "filters": runtime})
        public = client.get(f"/api/v1/public/dashboards/{TOKEN}-n/charts/{cid}/data")
        if tile.status_code != 200:
            # A chart the filter cannot reach refuses (or drops) the same way on both.
            assert public.status_code == tile.status_code, (name, tile.text[:200], public.text[:200])
            continue
        assert _values(tile) == _values(public), name
        compared += 1
    assert compared >= 3, "too few charts were compared under the filter"
