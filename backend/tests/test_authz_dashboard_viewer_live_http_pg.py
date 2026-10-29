"""A VIEW-only user reads the published report, never the editors' draft (HTTP).

Regression (demo@56c349ca): GET /dashboards/{id} overlaid the SHARED draft
(filters, slicers, slicer cluster, pages, theme) for anyone with view access.
An owner pressed Apply on a slicer in the Builder (PUT draft-filters, never
published) and a dashboard shared with 'view' rendered filtered numbers. The
draft-until-publish promise held for public links but not for signed-in viewers.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg

LIVE_SLICERS = [{"id": "s1", "field": "status", "value": None}]
DRAFT_SLICERS = [{"id": "s1", "field": "status", "value": ["delivered"]}]
LIVE_FILTERS = [{"id": "f1", "field": "region"}]
DRAFT_FILTERS = [{"id": "f1", "field": "region", "value": ["SP"]}]
LIVE_PAGES = [{"id": "p1", "name": "Live page"}]
DRAFT_PAGES = [{"id": "p1", "name": "Draft page"}]
LIVE_THEME = {"preset": "live"}
DRAFT_THEME = {"preset": "draft"}
LIVE_CLUSTER = {"x": 0}
DRAFT_CLUSTER = {"x": 7}


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.models import Dashboard, DashboardChart

    owner = make_user(db, "vl-owner", dashboards="edit", explore_charts="edit", datasets="edit")
    coauthor = make_user(db, "vl-coauthor", dashboards="edit", explore_charts="edit", datasets="edit")
    viewer = make_user(db, "vl-viewer", dashboards="edit", explore_charts="view", datasets="view")
    dash = Dashboard(
        name=f"vl-{uuid.uuid4().hex[:8]}", owner_id=owner.id,
        filters_config=LIVE_FILTERS, slicers_config=LIVE_SLICERS, pages_config=LIVE_PAGES,
        theme_config=LIVE_THEME, slicer_cluster_layout=LIVE_CLUSTER,
    )
    db.add(dash)
    db.flush()
    live_tile = DashboardChart(dashboard_id=dash.id, widget_type="text", widget_config={"text": "live"},
                               layout={"x": 0, "y": 0, "w": 4, "h": 2})
    draft_tile = DashboardChart(dashboard_id=dash.id, widget_type="text", widget_config={"text": "draft"},
                                layout={"x": 4, "y": 0, "w": 4, "h": 2,
                                        "draftOnly": True, "draftOwner": str(owner.id)})
    db.add_all([live_tile, draft_tile])
    db.commit()
    share(db, "dashboard", dash.id, coauthor, "edit", owner)
    share(db, "dashboard", dash.id, viewer, "view", owner)
    return dict(owner=owner, coauthor=coauthor, viewer=viewer, dash=dash,
                live_tile=live_tile.id, draft_tile=draft_tile.id)


def _get(client, world, who):  # noqa: F811
    r = client.get(f"/api/v1/dashboards/{world['dash'].id}", headers=world[who].headers)
    assert r.status_code == 200, r.text
    return r.json()


def _stage_draft(client, world):  # noqa: F811
    rev = _get(client, world, "owner")["shared_draft"]["rev"]
    r = client.put(f"/api/v1/dashboards/{world['dash'].id}/draft-filters", headers=world["owner"].headers,
                   json={"filters_config": DRAFT_FILTERS, "slicers_config": DRAFT_SLICERS,
                         "slicer_cluster_layout": DRAFT_CLUSTER, "pages_config": DRAFT_PAGES,
                         "theme_config": DRAFT_THEME, "base_rev": rev})
    assert r.status_code == 200, r.text


def _assert_live(body):
    assert body["filters_config"] == LIVE_FILTERS
    assert body["slicers_config"] == LIVE_SLICERS
    assert body["slicer_cluster_layout"] == LIVE_CLUSTER
    assert body["pages_config"] == LIVE_PAGES
    assert body["theme_config"] == LIVE_THEME


def test_view_only_user_reads_the_live_report_not_the_shared_draft(client, world):  # noqa: F811
    _stage_draft(client, world)
    body = _get(client, world, "viewer")
    assert body["user_permission"] == "view"
    _assert_live(body)
    assert body["has_draft"] is False
    assert body["shared_draft"] is None
    assert body["draft_layouts"] is None
    assert "delivered" not in str(body)


def test_view_only_user_never_sees_an_unpublished_tile(client, world):  # noqa: F811
    body = _get(client, world, "viewer")
    ids = {t["id"] for t in body["dashboard_charts"]}
    assert world["live_tile"] in ids
    assert world["draft_tile"] not in ids
    assert all("draftOnly" not in (t.get("layout") or {}) for t in body["dashboard_charts"])


@pytest.mark.parametrize("who", ["owner", "coauthor"])
def test_editors_still_read_the_draft_overlay_positive_control(client, world, who):  # noqa: F811
    _stage_draft(client, world)
    body = _get(client, world, who)
    assert body["filters_config"] == DRAFT_FILTERS
    assert body["slicers_config"] == DRAFT_SLICERS
    assert body["slicer_cluster_layout"] == DRAFT_CLUSTER
    assert body["pages_config"] == DRAFT_PAGES
    assert body["theme_config"] == DRAFT_THEME
    assert body["shared_draft"]["has_changes"] is True


def test_after_publish_viewer_and_editor_both_read_the_new_values(client, world):  # noqa: F811
    _stage_draft(client, world)
    r = client.post(f"/api/v1/dashboards/{world['dash'].id}/publish", headers=world["owner"].headers, json={})
    assert r.status_code == 200, r.text
    for who in ("viewer", "owner", "coauthor"):
        body = _get(client, world, who)
        assert body["slicers_config"] == DRAFT_SLICERS, who
        assert body["filters_config"] == DRAFT_FILTERS, who
        assert body["pages_config"] == DRAFT_PAGES, who
        assert body["theme_config"] == DRAFT_THEME, who
        assert body["slicer_cluster_layout"] == DRAFT_CLUSTER, who
