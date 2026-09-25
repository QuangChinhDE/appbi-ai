"""The presentation an editor approves is published as ONE unit.

Before this, AI Design (and the theme menu) wrote `theme_config` straight to the
live row on "Save draft": the public report changed colour while its layout was
still the old one, and a publish that then failed or hit a 409 left the report
half-new. The theme now travels in `draft_snapshot` beside the layouts:

  * staging it does not touch what public/embed read;
  * the editor's GET shows it (overlaid, like staged slicers and pages);
  * POST /publish applies theme + tiles + slicer cluster in the same commit;
  * a 409 applies NOTHING, and the draft survives for a retry;
  * discard drops it.

The route functions are called directly against an in-memory SQLite schema of
the two tables they touch; the permission checks are stubbed because they are
not what is under test (and have their own tests).
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.api import dashboards as api
from app.core.database import Base
from app.models.models import Dashboard, DashboardChart
from app.schemas.schemas import DashboardUpdateDraftFiltersRequest, DashboardUpdateLayoutRequest


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    # The pinned SQLAlchemy (requirements.txt) cannot render the Postgres UUID
    # owner_id column on SQLite; newer releases can, which hid this locally.
    return "CHAR(36)"


class _User:
    id = "11111111-1111-1111-1111-111111111111"
    email = "editor@example.com"
    full_name = "Editor"


LIVE_THEME = {"templateId": "brief", "colorwayId": "slate", "mode": "light"}
DRAFT_THEME = {"templateId": "console", "colorwayId": "graphite", "mode": "dark"}


@pytest.fixture()
def db(monkeypatch):
    monkeypatch.setattr(api, "require_edit_access", lambda *a, **k: None)
    monkeypatch.setattr(api, "require_view_access", lambda *a, **k: "full")
    monkeypatch.setattr(api.dashboard_presence, "heartbeat", lambda *a, **k: [], raising=False)
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dashboard.__table__, DashboardChart.__table__])
    with Session(engine) as session:
        dash = Dashboard(id=1, name="Fixture", theme_config=dict(LIVE_THEME),
                         slicer_cluster_layout={"position": "top"})
        session.add(dash)
        session.add(DashboardChart(id=10, dashboard_id=1, chart_id=None, widget_type="text",
                                   widget_config={"text": "hi"},
                                   layout={"x": 0, "y": 0, "w": 12, "h": 6, "_v": 1}))
        session.commit()
        yield session


def _live(db: Session) -> Dashboard:
    db.expire_all()
    return db.query(Dashboard).filter(Dashboard.id == 1).one()


def _stage(db: Session, **fields):
    return api.update_dashboard_draft_filters(1, DashboardUpdateDraftFiltersRequest(**fields), db, _User())


def _stage_layout(db: Session, layout: dict):
    return api.update_dashboard_draft_layout(
        1, DashboardUpdateLayoutRequest(chart_layouts=[{"id": 10, "layout": layout}]), db, _User())


def test_staging_a_theme_does_not_touch_the_published_report(db):
    response = _stage(db, theme_config=DRAFT_THEME)
    assert _live(db).theme_config == LIVE_THEME, "Save draft published the theme"
    # …while the editor sees what they staged.
    assert response.theme_config == DRAFT_THEME
    assert response.has_draft is True


def test_publish_applies_theme_tiles_and_slicers_together(db):
    _stage(db, theme_config=DRAFT_THEME, slicer_cluster_layout={"position": "left"})
    _stage_layout(db, {"x": 0, "y": 0, "w": 36, "h": 6, "locked": True})
    api.publish_dashboard_draft(1, api.PublishRequest(tile_base_v={"10": 1}), db, _User())
    live = _live(db)
    assert live.theme_config == DRAFT_THEME
    assert live.slicer_cluster_layout == {"position": "left"}
    tile = db.query(DashboardChart).filter(DashboardChart.id == 10).one()
    assert tile.layout["w"] == 36 and tile.layout["locked"] is True, "the lock did not survive publish"
    assert not (live.draft_snapshot or {}).get("theme_config"), "the applied theme draft was not cleared"


def test_a_conflicting_publish_applies_nothing_and_keeps_the_draft(db):
    _stage(db, theme_config=DRAFT_THEME)
    _stage_layout(db, {"x": 0, "y": 0, "w": 36, "h": 6})
    with pytest.raises(HTTPException) as exc:
        # Someone else published tile 10 since we loaded version 0.
        api.publish_dashboard_draft(1, api.PublishRequest(tile_base_v={"10": 0}), db, _User())
    assert exc.value.status_code == 409
    live = _live(db)
    assert live.theme_config == LIVE_THEME, "a refused publish still published the theme"
    tile = db.query(DashboardChart).filter(DashboardChart.id == 10).one()
    assert tile.layout["w"] == 12, "a refused publish still published a tile"
    assert (live.draft_snapshot or {}).get("theme_config") == DRAFT_THEME, "the draft was lost on conflict"


def test_discard_drops_the_staged_theme(db):
    _stage(db, theme_config=DRAFT_THEME)
    api.discard_dashboard_draft(1, db, _User())
    live = _live(db)
    assert live.theme_config == LIVE_THEME
    assert live.draft_snapshot is None


def test_a_staged_theme_survives_reload_for_the_editor(db):
    _stage(db, theme_config=DRAFT_THEME)
    reloaded = api._serialize_dashboard_with_draft(db, _live(db), _User())
    assert reloaded.theme_config == DRAFT_THEME


def test_publish_drops_the_cached_public_structure_and_a_refused_one_does_not(db, monkeypatch):
    """/d and /embed serve a structure cached by token for up to a minute. A
    viewer who opened the report just before Publish kept getting the old
    layout — the approved presentation was published but not SHOWN."""
    calls = []
    from app.services import query_cache
    monkeypatch.setattr(query_cache, "invalidate_all_public_meta", lambda: calls.append(1) or 0)
    _stage(db, theme_config=DRAFT_THEME)
    _stage_layout(db, {"x": 0, "y": 0, "w": 36, "h": 6})
    with pytest.raises(HTTPException):
        api.publish_dashboard_draft(1, api.PublishRequest(tile_base_v={"10": 0}), db, _User())
    assert calls == [], "a refused publish invalidated the public cache"
    api.publish_dashboard_draft(1, api.PublishRequest(tile_base_v={"10": 1}), db, _User())
    assert calls == [1], "publish left the public report cached on the old presentation"


# ── Blocks AI Design creates are part of the draft, not the live report ──────

class _Other:
    id = "22222222-2222-2222-2222-222222222222"
    email = "other@example.com"
    full_name = "Other"


@pytest.fixture()
def blocks(db, monkeypatch):
    """add_widget/serialise join the charts table this schema omits; neither is
    what is under test, so they return the plain row lookups."""
    from app.services import dashboard_service as ds
    monkeypatch.setattr(ds.DashboardService, "get_by_id",
                        staticmethod(lambda session, did: session.query(Dashboard).filter(Dashboard.id == did).first()))
    monkeypatch.setattr(api, "_serialize_dashboard_with_draft", lambda *a, **k: None)
    return db


def _add_block(db: Session, user, draft_only=True):
    from app.schemas.schemas import DashboardAddChartRequest
    req = DashboardAddChartRequest(
        chart_id=None, widget_type="narrative",
        widget_config={"variant": "headline", "items": [{"finding": "trend:10"}], "junk": 1},
        layout={"x": 0, "y": 20, "w": 36, "h": 4, **({"draftOnly": True, "draftOwner": "forged"} if draft_only else {})},
    )
    api.add_widget_to_dashboard(1, req, db, user)
    db.expire_all()
    return db.query(DashboardChart).filter(DashboardChart.widget_type == "narrative").order_by(DashboardChart.id.desc()).first()


def test_a_created_block_is_draft_only_and_owned_by_its_creator(blocks):
    from app.services.dashboard_service import is_draft_only_item
    db = blocks
    row = _add_block(db, _User())
    assert is_draft_only_item(row), "an AI-created block must not be live before Publish"
    assert row.layout["draftOwner"] == _User.id, "the owner is stamped server-side, not taken from the client"
    assert row.widget_config == {"variant": "headline", "items": [{"finding": "trend:10"}]}, "narrative config is closed"


def test_publish_takes_the_block_live_and_discard_of_another_user_keeps_it(blocks):
    from app.services.dashboard_service import is_draft_only_item
    db = blocks
    row = _add_block(db, _User())
    api.discard_dashboard_draft(1, db, _Other())       # someone else's discard
    db.expire_all()
    assert db.query(DashboardChart).filter(DashboardChart.id == row.id).first() is not None
    api.publish_dashboard_draft(1, api.PublishRequest(tile_base_v={}), db, _User())
    db.expire_all()
    live = db.query(DashboardChart).filter(DashboardChart.id == row.id).one()
    assert not is_draft_only_item(live) and "draftOwner" not in live.layout


def test_discard_removes_the_creators_unpublished_block(blocks):
    db = blocks
    row = _add_block(db, _User())
    api.discard_dashboard_draft(1, db, _User())
    db.expire_all()
    assert db.query(DashboardChart).filter(DashboardChart.id == row.id).first() is None
    # the published text widget is untouched
    assert db.query(DashboardChart).filter(DashboardChart.id == 10).first() is not None
