"""Authored Tablet / Phone dashboard layouts, asserted at the HTTP boundary.

  * the server is the validation authority for a device layout draft
    (breakpoint, 36 columns, integer cells in the grid, no overlap, the
    dashboard's own tiles on the requested page, reset-marker shape);
  * a device draft never reaches public state before Publish; Publish promotes
    it (revision bumped) in the same transaction as the rest; Discard drops it;
  * one author's layout never silently replaces another's: 409
    responsive_conflict names the page/breakpoint, force is an explicit choice;
  * what no longer exists is pruned (removed tiles, deleted pages);
  * duplication copies the PUBLISHED report: draft-only rows and draft keys
    stay behind; device items and section references follow the new tile ids;
  * Phase-0: PUT /layout cannot publish/hide a draft row and bumps `_v`;
    /relayout stages into the caller's draft; a legacy tile without a page is
    on the report's first page when there is no page-1.

Runs the real routers against in-memory SQLite (JSONB-specific behaviour has
its own Postgres suite: test_dashboard_responsive_layouts_pg.py); only the
permission checks of the authoring API are stubbed.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core import get_db
from app.core.database import Base
from app.models.models import Chart, Dashboard, DashboardChart, DashboardPublicLink, EmbedGrant


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


class _User:
    def __init__(self, uid: str, name: str):
        self.id = uuid.UUID(uid)
        self.email = f"{name}@example.com"
        self.full_name = name
        self.permissions = {"dashboards": "full"}
        self.is_active = True


ALICE = _User("aaaaaaaa-0000-0000-0000-000000000001", "alice")
BOB = _User("bbbbbbbb-0000-0000-0000-000000000002", "bob")
TOKEN = "resp-public-token"


@pytest.fixture()
def env(monkeypatch):
    from app.api import dashboards as dash_api
    from app.api import public as public_api
    from app.core.dependencies import get_current_user
    from app.services import query_cache

    engine = create_engine("sqlite://", future=True, connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Chart.__table__, Dashboard.__table__, DashboardChart.__table__,
                                             DashboardPublicLink.__table__, EmbedGrant.__table__])
    S = sessionmaker(bind=engine, future=True)

    def _db():
        s = S()
        try:
            yield s
        finally:
            s.close()

    monkeypatch.setattr(dash_api, "require_edit_access", lambda *a, **k: None)
    monkeypatch.setattr(dash_api, "require_view_access", lambda *a, **k: "full")
    monkeypatch.setattr(public_api._limiter, "enabled", False)
    who = {"user": ALICE}
    app = FastAPI()
    app.state.limiter = public_api._limiter
    app.include_router(public_api.router)
    app.include_router(dash_api.router)
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: who["user"]

    with S() as s:
        s.add(Dashboard(id=1, name="Revenue", pages_config=[{"id": "page-1", "name": "One"}, {"id": "page-2", "name": "Two"}]))
        # Text widgets: real tiles without chart hydration.
        for tid, page, y in ((11, "page-1", 0), (12, "page-1", 6), (13, "page-1", 12), (21, "page-2", 0)):
            s.add(DashboardChart(id=tid, dashboard_id=1, chart_id=None, widget_type="text",
                                 widget_config={"text": f"tile {tid}"},
                                 layout={"x": 0, "y": y, "w": 18, "h": 6, "pageId": page, "gv": 2, "_v": 1}))
        s.add(DashboardPublicLink(dashboard_id=1, name="public", token=TOKEN, is_active=True, filters_config=[]))
        s.commit()
    query_cache.invalidate_all_public_meta()
    return TestClient(app), S, who


def _custom(cells: dict, **kw) -> dict:
    return {"mode": "custom", "cols": 36, "generatorVersion": 1, "baseFingerprint": "fnv1a64:0123456789abcdef",
            "source": "auto-freeze", "items": cells, **kw}


TABLET = {"11": {"x": 0, "y": 0, "w": 36, "h": 5}, "12": {"x": 0, "y": 5, "w": 18, "h": 7}, "13": {"x": 18, "y": 5, "w": 18, "h": 7}}


def _draft(client, profile, page="page-1", bp="md", base_rev=0):
    return client.put("/dashboards/1/draft-responsive", json={"page_id": page, "breakpoint": bp, "profile": profile, "base_rev": base_rev})


def _editor(client):
    r = client.get("/dashboards/1")
    assert r.status_code == 200, r.text
    return r.json()


def _public(client):
    r = client.get(f"/public/dashboards/{TOKEN}")
    assert r.status_code == 200, r.text
    return r.json()


# ── validation (the server is the authority) ────────────────────────────────

@pytest.mark.parametrize("profile, message", [
    (_custom({"11": {"x": 0, "y": 0, "w": 20, "h": 5}, "12": {"x": 10, "y": 2, "w": 10, "h": 5}}), "overlap"),
    (_custom({"11": {"x": 30, "y": 0, "w": 10, "h": 5}}), "outside"),
    (_custom({"11": {"x": -1, "y": 0, "w": 10, "h": 5}}), "negative"),
    (_custom({"11": {"x": 0, "y": 0, "w": 0, "h": 5}}), "at least 1x1"),
    (_custom({"11": {"x": 0, "y": 0, "w": 10.5, "h": 5}}), "integer"),
    (_custom({"11": {"x": True, "y": 0, "w": 10, "h": 5}}), "integer"),
    (_custom({"11": {"x": 0, "y": 0, "w": 10, "h": 5, "static": True}}), "exactly"),
    (_custom({"11": {"x": 0, "y": 0, "w": 10, "h": 5}}, cols=12), "cols must be 36"),
    (_custom({"999": {"x": 0, "y": 0, "w": 10, "h": 5}}), "not a tile of this dashboard"),
    (_custom({"21": {"x": 0, "y": 0, "w": 10, "h": 5}}), "not on page"),
    (_custom({}), "non-empty"),
    ({"mode": "custom", "cols": 36, "items": TABLET}, "generatorVersion"),
    ({"mode": "freeform", "items": TABLET}, "mode must be"),
    ({"mode": "auto", "items": TABLET}, "reset marker"),
    (_custom(TABLET, draftOnly=True), "unknown profile keys"),
])
def test_an_invalid_device_layout_is_refused_and_nothing_is_stored(env, profile, message):
    client, S, _ = env
    r = _draft(client, profile)
    assert r.status_code == 400 and message in r.text, r.text
    with S() as s:
        assert not (s.get(Dashboard, 1).draft_snapshot or {}).get("user_responsive_layouts")


def test_an_unsupported_breakpoint_or_page_is_refused(env):
    client, *_ = env
    assert _draft(client, _custom(TABLET), bp="lg").status_code == 400
    assert _draft(client, _custom(TABLET), page="page-9").status_code == 400


# ── AUTO, draft isolation, publish, discard ──────────────────────────────────

def test_a_dashboard_without_device_layouts_is_auto_everywhere(env):
    client, *_ = env
    assert _editor(client)["responsive_layouts"] is None
    assert _public(client)["responsive_layouts"] is None


def test_a_device_draft_is_the_authors_until_publish_and_never_public_before(env):
    client, *_ = env
    assert _draft(client, _custom(TABLET)).status_code == 200
    ed = _editor(client)
    assert ed["has_draft"] is True and ed["responsive_layouts"] is None
    assert ed["draft_responsive_layouts"]["page-1"]["md"]["items"]["12"] == {"x": 0, "y": 5, "w": 18, "h": 7}
    assert _public(client)["responsive_layouts"] is None, "a draft device layout reached the public report"

    pub = client.post("/dashboards/1/publish", json={})
    assert pub.status_code == 200, pub.text
    live = pub.json()["responsive_layouts"]["pages"]["page-1"]["md"]
    assert live["rev"] == 1 and live["items"] == TABLET and live["updatedBy"] == str(ALICE.id)
    assert pub.json()["draft_responsive_layouts"] is None
    seen = _public(client)["responsive_layouts"]["pages"]["page-1"]["md"]
    assert seen["items"] == TABLET
    # A viewer gets what it draws, nothing about who or when.
    assert set(seen) == {"mode", "cols", "generatorVersion", "items"}, seen


def test_desktop_and_other_devices_are_untouched_by_a_tablet_publish(env):
    client, S, _ = env
    with S() as s:
        before = {dc.id: dict(dc.layout) for dc in s.query(DashboardChart).all()}
    _draft(client, _custom(TABLET))
    client.post("/dashboards/1/publish", json={})
    with S() as s:
        after = {dc.id: dict(dc.layout) for dc in s.query(DashboardChart).all()}
        doc = s.get(Dashboard, 1).responsive_layouts
    assert after == before, "a device layout publish wrote desktop geometry"
    assert set(doc["pages"]["page-1"]) == {"md"} and "page-2" not in doc["pages"]


def test_discard_drops_the_device_draft_and_keeps_the_published_layout(env):
    client, *_ = env
    _draft(client, _custom(TABLET))
    client.post("/dashboards/1/publish", json={})
    moved = {**TABLET, "11": {"x": 0, "y": 20, "w": 36, "h": 5}}
    _draft(client, _custom(moved), base_rev=1)
    r = client.post("/dashboards/1/discard-draft", json={})
    assert r.status_code == 200 and r.json()["draft_responsive_layouts"] is None
    assert r.json()["responsive_layouts"]["pages"]["page-1"]["md"]["items"] == TABLET


def test_reset_to_auto_is_a_draft_until_publish_then_removes_the_layout(env):
    client, *_ = env
    _draft(client, _custom(TABLET))
    client.post("/dashboards/1/publish", json={})
    assert _draft(client, {"mode": "auto"}, base_rev=1).status_code == 200
    assert _public(client)["responsive_layouts"]["pages"]["page-1"]["md"]["items"] == TABLET
    r = client.post("/dashboards/1/publish", json={})
    assert r.json()["responsive_layouts"] is None
    assert _public(client)["responsive_layouts"] is None


def test_a_viewer_who_saw_the_old_layout_gets_the_new_one_right_after_publish(env):
    """The public structure is cached by token; Publish must invalidate it."""
    client, *_ = env
    assert _public(client)["responsive_layouts"] is None  # cached now
    _draft(client, _custom(TABLET))
    client.post("/dashboards/1/publish", json={})
    assert _public(client)["responsive_layouts"]["pages"]["page-1"]["md"]["items"] == TABLET


# ── concurrency ──────────────────────────────────────────────────────────────

def test_two_authors_on_the_same_page_breakpoint_the_second_publish_is_refused_then_forced(env):
    client, _, who = env
    who["user"] = ALICE
    _draft(client, _custom(TABLET))
    who["user"] = BOB
    bobs = {**TABLET, "11": {"x": 0, "y": 30, "w": 36, "h": 5}}
    _draft(client, _custom(bobs))
    who["user"] = ALICE
    assert client.post("/dashboards/1/publish", json={}).status_code == 200
    who["user"] = BOB
    r = client.post("/dashboards/1/publish", json={})
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "responsive_conflict" and detail["responsive"] == ["page-1:md"]
    assert _public(client)["responsive_layouts"]["pages"]["page-1"]["md"]["items"] == TABLET, "a refused publish wrote"
    forced = client.post("/dashboards/1/publish", json={"force": True})
    assert forced.status_code == 200
    live = forced.json()["responsive_layouts"]["pages"]["page-1"]["md"]
    assert live["items"]["11"]["y"] == 30 and live["rev"] == 2


def test_authors_on_different_breakpoints_or_pages_never_conflict(env):
    client, _, who = env
    who["user"] = ALICE
    _draft(client, _custom(TABLET))
    who["user"] = BOB
    _draft(client, _custom({"11": {"x": 0, "y": 0, "w": 36, "h": 8}, "12": {"x": 0, "y": 8, "w": 36, "h": 8}, "13": {"x": 0, "y": 16, "w": 36, "h": 8}}), bp="xs")
    _draft(client, _custom({"21": {"x": 0, "y": 0, "w": 36, "h": 9}}), page="page-2")
    who["user"] = ALICE
    assert client.post("/dashboards/1/publish", json={}).status_code == 200
    who["user"] = BOB
    r = client.post("/dashboards/1/publish", json={})
    assert r.status_code == 200, r.text
    doc = r.json()["responsive_layouts"]["pages"]
    assert set(doc["page-1"]) == {"md", "xs"} and set(doc["page-2"]) == {"md"}
    assert doc["page-1"]["md"]["items"] == TABLET, "bob's publish touched alice's tablet layout"


def test_one_authors_publish_keeps_the_other_authors_device_draft(env):
    client, S, who = env
    who["user"] = BOB
    _draft(client, _custom({"21": {"x": 0, "y": 0, "w": 36, "h": 9}}), page="page-2")
    who["user"] = ALICE
    _draft(client, _custom(TABLET))
    client.post("/dashboards/1/publish", json={})
    with S() as s:
        snap = s.get(Dashboard, 1).draft_snapshot
    assert str(BOB.id) in snap["user_responsive_layouts"] and str(ALICE.id) not in snap["user_responsive_layouts"]


# ── reconciliation of what no longer exists ─────────────────────────────────

def test_a_removed_tile_leaves_the_published_device_layout_on_publish(env):
    client, *_ = env
    _draft(client, _custom(TABLET))
    client.post("/dashboards/1/publish", json={})
    assert client.delete("/dashboards/1/charts/13?draft=true").status_code in (200, 204)
    r = client.post("/dashboards/1/publish", json={})
    items = r.json()["responsive_layouts"]["pages"]["page-1"]["md"]["items"]
    assert set(items) == {"11", "12"}, items


def test_a_deleted_page_takes_its_device_layouts_with_it(env):
    client, *_ = env
    _draft(client, _custom({"21": {"x": 0, "y": 0, "w": 36, "h": 9}}), page="page-2")
    client.post("/dashboards/1/publish", json={})
    ed = _editor(client)
    r = client.put("/dashboards/1/draft-filters", json={
        "pages_config": [{"id": "page-1", "name": "One"}], "base_rev": ed["shared_draft"]["rev"]})
    assert r.status_code == 200, r.text
    assert client.post("/dashboards/1/publish", json={}).json()["responsive_layouts"] is None


def test_a_tile_moved_to_another_page_in_the_draft_belongs_to_that_page(env):
    client, *_ = env
    r = client.put("/dashboards/1/draft-layout", json={"chart_layouts": [
        {"id": 13, "layout": {"x": 0, "y": 6, "w": 18, "h": 6, "pageId": "page-2"}}]})
    assert r.status_code == 200
    assert _draft(client, _custom(TABLET)).status_code == 400, "a tile moved away in the draft is still on page-1"
    assert _draft(client, _custom({"21": {"x": 0, "y": 0, "w": 36, "h": 9}, "13": {"x": 0, "y": 9, "w": 36, "h": 6}}), page="page-2").status_code == 200


def test_the_authors_draft_only_tile_can_be_placed_another_authors_cannot(env):
    client, S, who = env
    with S() as s:
        s.add(DashboardChart(id=14, dashboard_id=1, widget_type="text", widget_config={},
                             layout={"x": 0, "y": 18, "w": 18, "h": 6, "pageId": "page-1", "draftOnly": True, "draftOwner": str(BOB.id)}))
        s.commit()
    cells = {**TABLET, "14": {"x": 0, "y": 12, "w": 36, "h": 6}}
    who["user"] = ALICE
    assert _draft(client, _custom(cells)).status_code == 400
    who["user"] = BOB
    assert _draft(client, _custom(cells)).status_code == 200
    r = client.post("/dashboards/1/publish", json={})
    assert "14" in r.json()["responsive_layouts"]["pages"]["page-1"]["md"]["items"], "the published block lost its place"


# ── duplication copies the published report ─────────────────────────────────

def test_a_duplicate_copies_published_tiles_only_and_maps_device_items_and_sections_to_the_new_ids(env, monkeypatch):
    client, S, _ = env
    _draft(client, _custom(TABLET))
    client.post("/dashboards/1/publish", json={})
    with S() as s:
        # Tile 12 sits in section 11; a colleague's unpublished block is on the page.
        t12 = s.get(DashboardChart, 12)
        t12.layout = {**t12.layout, "sectionId": 11}
        t13 = s.get(DashboardChart, 13)
        t13.layout = {**t13.layout, "draftRemoved": True, "draftRemovedBy": str(BOB.id)}
        s.add(DashboardChart(id=15, dashboard_id=1, widget_type="text", widget_config={"text": "secret draft"},
                             layout={"x": 0, "y": 30, "w": 9, "h": 3, "pageId": "page-1", "draftOnly": True, "draftOwner": str(BOB.id)}))
        s.commit()
        from app.services.dashboard_html_import_service import serialize_dashboard_snapshot
        from app.services.dashboard_service import DashboardService
        snap = serialize_dashboard_snapshot(DashboardService.get_by_id(s, 1))
    assert {t["dashboard_chart_id"] for t in snap["charts"]} == {11, 12, 13, 21}, "a draft-only row was copied"
    assert all(not ({"draftOnly", "draftOwner", "draftRemoved", "draftRemovedBy"} & set(t["layout"])) for t in snap["charts"])

    from app.services.dashboard_html_import_service import rebuild_dashboard_from_snapshot
    monkeypatch.setattr("app.services.dashboard_html_import_service._place_slicer_controls", lambda *a, **k: None)
    with S() as s:
        copy = rebuild_dashboard_from_snapshot(s, snapshot=snap, current_user=ALICE)
        new = {dc.widget_config.get("text"): dc for dc in copy.dashboard_charts}
        items = copy.responsive_layouts["pages"]["page-1"]["md"]["items"]
        assert set(items) == {str(new["tile 11"].id), str(new["tile 12"].id), str(new["tile 13"].id)}
        assert items[str(new["tile 12"].id)] == TABLET["12"]
        assert new["tile 12"].layout["sectionId"] == new["tile 11"].id, "the copy's section points at the source dashboard"
        assert "secret draft" not in new


# ── Phase 0 ──────────────────────────────────────────────────────────────────

def test_the_live_layout_api_cannot_publish_or_hide_a_draft_row_and_bumps_the_version(env):
    client, S, _ = env
    with S() as s:
        s.add(DashboardChart(id=16, dashboard_id=1, widget_type="text", widget_config={},
                             layout={"x": 0, "y": 40, "w": 9, "h": 3, "pageId": "page-1", "draftOnly": True, "draftOwner": str(BOB.id), "_v": 0}))
        s.commit()
    r = client.put("/dashboards/1/layout", json={"chart_layouts": [
        {"id": 16, "layout": {"x": 9, "y": 40, "w": 9, "h": 3, "pageId": "page-1"}},
        {"id": 11, "layout": {"x": 0, "y": 0, "w": 18, "h": 6, "pageId": "page-1", "draftRemoved": True, "_v": 99}},
    ]})
    assert r.status_code == 200, r.text
    with S() as s:
        t16, t11 = s.get(DashboardChart, 16).layout, s.get(DashboardChart, 11).layout
    assert t16["draftOnly"] is True and t16["draftOwner"] == str(BOB.id) and t16["x"] == 9, t16
    assert "draftRemoved" not in t11 and t11["_v"] == 2, t11


def test_relayout_stages_into_the_callers_draft_and_writes_no_live_row(env):
    client, S, _ = env
    with S() as s:
        before = {dc.id: dict(dc.layout) for dc in s.query(DashboardChart).all()}
    r = client.post("/dashboards/1/relayout", json={"template_family": "console", "page_id": "page-1"})
    assert r.status_code == 200, r.text
    with S() as s:
        after = {dc.id: dict(dc.layout) for dc in s.query(DashboardChart).all()}
        snap = s.get(Dashboard, 1).draft_snapshot
    assert after == before, "relayout wrote live rows"
    mine = snap["user_layouts"][str(ALICE.id)]
    assert set(mine) == {"11", "12", "13"}, mine
    assert client.post("/dashboards/1/relayout", json={"template_family": "console", "page_id": "nope"}).status_code == 200
    with S() as s:
        assert {dc.id: dict(dc.layout) for dc in s.query(DashboardChart).all()} == before


def test_a_legacy_tile_without_a_page_stays_on_page_1_and_is_never_rehomed_into_a_served_page():
    """ONE rule for every server path. A report without a page-1 does not
    draw such a tile — and must not START serving it (re-homing would publish
    a tile nobody published)."""
    from app.services.dashboard_service import tile_page_id
    assert tile_page_id({}, [{"id": "page-1"}, {"id": "b"}]) == "page-1"
    assert tile_page_id({}, [{"id": "a"}, {"id": "b"}]) == "page-1"
    assert tile_page_id({}, None) == "page-1"
    assert tile_page_id({"pageId": "b"}, [{"id": "a"}, {"id": "b"}]) == "b"
