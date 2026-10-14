"""Authored device layouts on Postgres: the JSONB column, the row-locked draft
write, Publish's revision check and duplication through the real application.

Seeded CI fixture (any dashboard-capable database — the suite creates its own
dashboard, tiles and link inside ONE rolled-back transaction). Fails, never
skips, without Postgres.
"""
from __future__ import annotations

import os
import uuid

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

TOKEN = "resp-pg-" + uuid.uuid4().hex[:10]


def _custom(cells):
    return {"mode": "custom", "cols": 36, "generatorVersion": 1, "baseFingerprint": "fnv1a64:00000000000000aa",
            "source": "auto-freeze", "items": cells}


@pytest.fixture(scope="module")
def ctx():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_dashboard_responsive_layouts_pg needs Postgres (DATABASE_URL).")
    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.core.dependencies import get_current_user
    from app.main import app
    from app.models.models import Dashboard, DashboardChart, DashboardPublicLink
    from app.models.user import User, UserStatus

    engine = sa.create_engine(url)
    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    users = []
    for name in ("alice", "bob"):
        u = User(id=uuid.uuid4(), email=f"resp-{name}-{uuid.uuid4().hex[:8]}@x", full_name=name, password_hash="x",
                 status=UserStatus.ACTIVE, permissions={"dashboards": "full"}, google_oauth_scopes=[])
        db.add(u)
        users.append(u)
    db.flush()
    dash = Dashboard(name=f"responsive pg {TOKEN}", owner_id=users[0].id, pages_config=[{"id": "page-1", "name": "One"}])
    db.add(dash)
    db.flush()
    tiles = []
    for y in (0, 6, 12):
        t = DashboardChart(dashboard_id=dash.id, widget_type="text", widget_config={"text": f"t{y}"},
                           layout={"x": 0, "y": y, "w": 18, "h": 6, "pageId": "page-1", "gv": 2})
        db.add(t)
        tiles.append(t)
    db.add(DashboardPublicLink(dashboard_id=dash.id, name="pub", token=TOKEN, is_active=True, filters_config=[]))
    db.flush()
    who = {"user": users[0]}
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: who["user"]
    try:
        yield TestClient(app), db, dash.id, [t.id for t in tiles], users, who
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        db.close()
        outer.rollback()
        conn.close()
        engine.dispose()


def test_a_published_device_layout_is_stored_as_jsonb_and_served_from_it(ctx):
    client, db, did, tids, users, who = ctx
    who["user"] = users[0]
    cells = {str(tids[0]): {"x": 0, "y": 0, "w": 36, "h": 5}, str(tids[1]): {"x": 0, "y": 5, "w": 18, "h": 7},
             str(tids[2]): {"x": 18, "y": 5, "w": 18, "h": 7}}
    r = client.put(f"/api/v1/dashboards/{did}/draft-responsive", json={"page_id": "page-1", "breakpoint": "md", "profile": _custom(cells), "base_rev": 0})
    assert r.status_code == 200, r.text
    assert client.get(f"/api/v1/public/dashboards/{TOKEN}").json()["responsive_layouts"] is None, "draft reached public"
    assert client.post(f"/api/v1/dashboards/{did}/publish", json={}).status_code == 200
    kind = db.execute(sa.text("select jsonb_typeof(responsive_layouts), responsive_layouts->'pages'->'page-1'->'md'->>'rev' "
                              "from dashboards where id = :i"), {"i": did}).one()
    assert kind[0] == "object" and kind[1] == "1", kind
    served = client.get(f"/api/v1/public/dashboards/{TOKEN}").json()["responsive_layouts"]["pages"]["page-1"]["md"]
    assert served["items"] == cells


def test_publish_refuses_a_device_layout_someone_published_since_and_force_is_explicit(ctx):
    client, db, did, tids, users, who = ctx
    base = int(db.execute(sa.text("select coalesce((responsive_layouts->'pages'->'page-1'->'md'->>'rev')::int, 0) from dashboards where id = :i"), {"i": did}).scalar())
    mine = {str(tids[0]): {"x": 0, "y": 0, "w": 36, "h": 4}, str(tids[1]): {"x": 0, "y": 4, "w": 36, "h": 6}, str(tids[2]): {"x": 0, "y": 10, "w": 36, "h": 6}}
    theirs = {str(tids[0]): {"x": 0, "y": 0, "w": 12, "h": 4}, str(tids[1]): {"x": 12, "y": 0, "w": 24, "h": 6}, str(tids[2]): {"x": 0, "y": 6, "w": 36, "h": 6}}
    for user, cells in ((users[0], mine), (users[1], theirs)):
        who["user"] = user
        r = client.put(f"/api/v1/dashboards/{did}/draft-responsive", json={"page_id": "page-1", "breakpoint": "md", "profile": _custom(cells), "base_rev": base})
        assert r.status_code == 200, r.text
    who["user"] = users[1]
    assert client.post(f"/api/v1/dashboards/{did}/publish", json={}).status_code == 200
    who["user"] = users[0]
    refused = client.post(f"/api/v1/dashboards/{did}/publish", json={})
    assert refused.status_code == 409 and refused.json()["detail"]["responsive"] == ["page-1:md"], refused.text
    live = db.execute(sa.text("select responsive_layouts->'pages'->'page-1'->'md'->'items' from dashboards where id = :i"), {"i": did}).scalar()
    assert live == theirs, "a refused publish changed the published layout"
    forced = client.post(f"/api/v1/dashboards/{did}/publish", json={"force": True})
    assert forced.status_code == 200
    assert forced.json()["responsive_layouts"]["pages"]["page-1"]["md"]["items"] == mine


def test_a_duplicate_maps_the_published_device_layout_onto_the_copys_tiles(ctx):
    client, db, did, tids, users, who = ctx
    who["user"] = users[0]
    r = client.post(f"/api/v1/dashboards/{did}/duplicate")
    assert r.status_code < 400, r.text
    copy = r.json()
    new_ids = {str(dc["id"]) for dc in copy["dashboard_charts"]}
    items = copy["responsive_layouts"]["pages"]["page-1"]["md"]["items"]
    assert set(items) == new_ids and not (set(items) & {str(t) for t in tids}), items
