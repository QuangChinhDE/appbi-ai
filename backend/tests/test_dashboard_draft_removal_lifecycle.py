"""Adding AND removing an element are draft edits.

Before this, only additions were drafts (AI blocks, slicer controls). Removing a
published chart, widget or control deleted the live row at once:
  * the public link and embed lost it before Publish;
  * Discard could not bring it back ("remove, then Discard" lost it for good);
  * Undo of a control removal re-created it as a NEW draft-only row, so
    "remove → Undo → Discard" deleted a control that was published;
  * "Delete filter" removed the entry in the draft and each control live, in
    separate requests — a failure halfway left half a change;
  * `has_draft` ignored added rows, so a draft that only added an element had
    no draft bar and Discard did nothing;
  * Discard wiped every author's layout draft;
  * a colleague's saved copy of a block could turn it back into a draft.

The route functions are called directly against an in-memory SQLite schema of
the two tables they touch; the permission checks are stubbed (they have their
own tests). "Public" is what `get_public_dashboard` serves: live rows that are
not draft-only.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.api import dashboards as api
from app.core.database import Base
from app.models.models import Chart, Dashboard, DashboardChart
from app.schemas.chart_config import DashboardChartLayout
from app.schemas.schemas import (
    DashboardAddChartRequest,
    DashboardUpdateDraftFiltersRequest,
    DashboardUpdateLayoutRequest,
)
from app.services.dashboard_service import is_draft_only_item


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


class _User:
    def __init__(self, uid: str):
        self.id = uid
        self.email = f"{uid[:4]}@example.com"
        self.full_name = uid[:4]


A = _User("aaaaaaaa-0000-0000-0000-000000000000")
B = _User("bbbbbbbb-0000-0000-0000-000000000000")
SLICERS = [{"id": "s-region", "field": "region", "type": "dropdown", "operator": "in", "value": []}]


@pytest.fixture()
def db(monkeypatch):
    monkeypatch.setattr(api, "require_edit_access", lambda *a, **k: None)
    monkeypatch.setattr(api, "require_view_access", lambda *a, **k: "full")
    monkeypatch.setattr(api.dashboard_presence, "heartbeat", lambda *a, **k: [], raising=False)
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Chart.__table__, Dashboard.__table__, DashboardChart.__table__])
    with Session(engine) as session:
        session.add(Dashboard(id=1, name="Fixture", slicers_config=list(SLICERS)))
        # A published text widget, and a published control for the region filter.
        session.add(DashboardChart(id=10, dashboard_id=1, chart_id=None, widget_type="text",
                                   widget_config={"text": "hi"}, layout={"x": 0, "y": 3, "w": 12, "h": 6, "_v": 1}))
        session.add(DashboardChart(id=20, dashboard_id=1, chart_id=None, widget_type="slicer",
                                   widget_config={"slicerId": "s-region", "treatment": "auto"},
                                   layout={"x": 0, "y": 0, "w": 8, "h": 3, "_v": 1}))
        session.commit()
        yield session


def test_public_paths_are_served_published_tiles_only_and_nothing_is_written(db):
    """Every public path (chart data, AI chat, recon, explore, briefing,
    distinct values) reads `dash.dashboard_charts` from _get_dashboard_by_token.
    A tile only in an editor's draft must not be in it, a pending removal's
    draft keys must not either — and shaping the served copy must never flush
    as a delete or an update of the real rows."""
    from app.api import public as public_api
    db.add(DashboardChart(id=30, dashboard_id=1, chart_id=None, widget_type="text", widget_config={"text": "draft"},
                          layout={"x": 0, "y": 9, "w": 12, "h": 3, "draftOnly": True, "draftOwner": A.id}))
    row = db.get(DashboardChart, 10)
    row.layout = {**row.layout, "draftRemoved": True, "draftRemovedBy": A.id}
    db.commit()
    dash = db.query(Dashboard).filter(Dashboard.id == 1).one()
    public_api._serve_published_only(dash)
    served = {dc.id: dc for dc in dash.dashboard_charts}
    assert set(served) == {10, 20}, "a draft-only tile is served to a public viewer"
    assert not any(k in served[10].layout for k in ("draftRemoved", "draftRemovedBy")), "draft state is served"
    db.commit()
    rows = _rows(db)
    assert set(rows) == {10, 20, 30}, "serving a public copy deleted a real row"
    assert rows[10].layout.get("draftRemovedBy") == A.id, "serving a public copy rewrote the author's draft"


def _with_draft_tile_and_pending_removal(db: Session) -> None:
    db.add(DashboardChart(id=30, dashboard_id=1, chart_id=None, widget_type="text", widget_config={"text": "draft"},
                          layout={"x": 0, "y": 9, "w": 12, "h": 3, "draftOnly": True, "draftOwner": A.id}))
    row = db.get(DashboardChart, 10)
    row.layout = {**row.layout, "draftRemoved": True, "draftRemovedBy": A.id}
    db.commit()


def test_the_access_bump_commit_does_not_undo_the_published_only_copy(db, monkeypatch):
    """A commit expires the served copy (expire_on_commit); the next read of
    dashboard_charts would reload the raw rows, draft tiles included. A capped
    link bumps its count — and commits — on every view."""
    from app.api import public as public_api
    from app.models.models import DashboardPublicLink
    DashboardPublicLink.__table__.create(db.get_bind(), checkfirst=True)
    monkeypatch.setattr(public_api, "resolve_embed_grant", lambda *_a, **_k: None)
    _with_draft_tile_and_pending_removal(db)
    db.add(DashboardPublicLink(id=1, dashboard_id=1, name="capped", token="tok-capped", filters_config=[],
                               is_active=True, max_access_count=100, access_count=0))
    db.commit()
    dash, *_ = public_api._get_dashboard_by_token("tok-capped", db, track_access=True, load_dashboard=True)
    assert db.get(DashboardPublicLink, 1).access_count == 1, "the fixture did not take the committing path"
    served = {dc.id: dc for dc in dash.dashboard_charts}
    assert set(served) == {10, 20}, "after the access-bump commit a public viewer is served a draft tile"
    assert "draftRemovedBy" not in served[10].layout


def test_the_public_ai_describes_only_datasets_of_published_tiles(db):
    """The public AI's knowledge scope (describe the model, search knowledge)
    followed every DashboardChart row: a dataset on an editor's draft-only tile
    was described to a public viewer before Publish. Reading the live
    relationship instead is not enough: retrieval logging commits the request
    session mid-turn, and the next read reloads the raw rows."""
    from app.api import public as public_api
    from app.models.dataset import DatasetTable
    from app.services.agent_flows.tools.context import ToolContext
    from app.services.dashboard_ai_bot import govern_tools
    DatasetTable.__table__.create(db.get_bind(), checkfirst=True)
    db.add(Chart(id=501, name="published", chart_type="BAR", config={}, dataset_table_id=71))
    db.add(Chart(id=502, name="draft", chart_type="BAR", config={}, dataset_table_id=72))
    db.add(DashboardChart(id=41, dashboard_id=1, chart_id=501, layout={"x": 0, "y": 20, "w": 12, "h": 6}))
    db.add(DashboardChart(id=42, dashboard_id=1, chart_id=502,
                          layout={"x": 0, "y": 26, "w": 12, "h": 6, "draftOnly": True, "draftOwner": A.id}))
    db.commit()
    dash = db.query(Dashboard).filter(Dashboard.id == 1).one()
    public_api._serve_published_only(dash)
    ctx = ToolContext.from_dashboard(db, dash, [])
    db.commit()  # what retrieve_doc_chunks / log_retrieval do during a turn
    tids, _dsids = govern_tools._scope(ctx)
    assert tids == {71}, f"the public AI scope includes a draft-only tile's dataset: {tids}"


def _rows(db: Session) -> dict[int, DashboardChart]:
    db.expire_all()
    return {r.id: r for r in db.query(DashboardChart).filter(DashboardChart.dashboard_id == 1).all()}


def _public_ids(db: Session) -> set[int]:
    """What /d and /embed draw: live rows, minus what is only in a draft."""
    return {i for i, r in _rows(db).items() if not is_draft_only_item(r)}


def _builder_ids(db: Session, user: _User) -> set[int]:
    db.expire_all()
    resp = api._serialize_dashboard_with_draft(db, db.query(Dashboard).filter(Dashboard.id == 1).one(), user)
    return {dc.id for dc in resp.dashboard_charts}


def _has_draft(db: Session, user: _User) -> bool:
    db.expire_all()
    return api._serialize_dashboard_with_draft(db, db.query(Dashboard).filter(Dashboard.id == 1).one(), user).has_draft


def _remove(db, tile_id, user=A):
    return api.remove_chart_from_dashboard(1, tile_id, True, db, user)


def _restore(db, tile_id, user=A):
    return api.restore_chart_in_draft(1, tile_id, db, user)


def _publish(db, user=A):
    return api.publish_dashboard_draft(1, api.PublishRequest(force=True), db, user)


def _discard(db, user=A):
    return api.discard_dashboard_draft(1, db, user)


def test_removing_a_published_element_is_a_draft_edit_until_publish(db):
    _remove(db, 10)
    assert 10 in _public_ids(db), "the public link lost the element before Publish"
    assert 10 not in _builder_ids(db, A), "the editor still shows what they removed"
    assert _has_draft(db, A), "a pending removal shows no draft bar"
    assert 10 in _builder_ids(db, B), "another author's draft lost an element A removed"
    _publish(db)
    assert 10 not in _rows(db), "Publish did not apply the removal"


def test_discard_brings_a_removed_element_back_exactly(db):
    before = dict(_rows(db)[20].layout)
    _remove(db, 20)
    _discard(db)
    rows = _rows(db)
    assert 20 in rows and rows[20].layout == before, "Discard did not restore the removed control"
    assert not _has_draft(db, A)


def test_remove_undo_discard_keeps_a_published_control_published(db):
    # The previous Undo re-created a NEW draft-only row; Discard then deleted it.
    _remove(db, 20)
    _restore(db, 20)            # Undo: the same row, the same id
    _discard(db)
    rows = _rows(db)
    assert 20 in rows, "remove → Undo → Discard lost a published control"
    assert not is_draft_only_item(rows[20]), "Undo turned a published control into a draft-only one"
    assert 20 in _public_ids(db)


def test_a_draft_only_element_is_deleted_at_once_and_only_by_its_author(db):
    resp = api.add_widget_to_dashboard(1, DashboardAddChartRequest(
        widget_type="text", widget_config={"text": "new"},
        layout=DashboardChartLayout(x=0, y=9, w=12, h=6, draftOnly=True)), db, A)
    new_id = max(dc.id for dc in resp.dashboard_charts)
    assert new_id not in _public_ids(db) and _has_draft(db, A), "a draft addition is public or has no draft bar"
    with pytest.raises(HTTPException) as exc:
        _remove(db, new_id, user=B)
    assert exc.value.status_code == 409, "an author could delete a colleague's unpublished element"
    _remove(db, new_id, user=A)
    assert new_id not in _rows(db)


def test_delete_filter_is_one_transaction(db, monkeypatch):
    # Injected failure while removing the second control: NOTHING is applied.
    db.add(DashboardChart(id=21, dashboard_id=1, chart_id=None, widget_type="slicer",
                          widget_config={"slicerId": "s-region"}, layout={"x": 8, "y": 0, "w": 8, "h": 3, "pageId": "p2"}))
    db.commit()
    real = api.remove_tile_in_draft
    calls = {"n": 0}

    def flaky(session, row, user_key):
        calls["n"] += 1
        if calls["n"] == 2:
            raise PermissionError("injected failure")
        return real(session, row, user_key)

    monkeypatch.setattr(api, "remove_tile_in_draft", flaky)
    with pytest.raises(HTTPException):
        api.update_dashboard_draft_filters(1, DashboardUpdateDraftFiltersRequest(
            slicers_config=[], remove_tile_ids=[20, 21]), db, A)
    db.expire_all()
    dash = db.query(Dashboard).filter(Dashboard.id == 1).one()
    assert not (dash.draft_snapshot or {}).get("slicers_config") and dash.draft_snapshot is None, "the entry was removed without its controls"
    assert all(not r.layout.get("draftRemoved") for r in _rows(db).values()), "a control was removed without the entry"

    monkeypatch.setattr(api, "remove_tile_in_draft", real)
    api.update_dashboard_draft_filters(1, DashboardUpdateDraftFiltersRequest(
        slicers_config=[], remove_tile_ids=[20, 21]), db, A)
    assert {20, 21} <= _public_ids(db), "public lost the filter's controls before Publish"
    assert not ({20, 21} & _builder_ids(db, A))
    _discard(db)
    assert {20, 21} <= _builder_ids(db, A), "Discard did not bring the controls back"
    dash = db.query(Dashboard).filter(Dashboard.id == 1).one()
    assert dash.slicers_config == SLICERS


def test_discard_keeps_other_authors_drafts(db):
    api.update_dashboard_draft_layout(1, DashboardUpdateLayoutRequest(
        chart_layouts=[{"id": 10, "layout": {"x": 12, "y": 3, "w": 12, "h": 6}}]), db, B)
    _remove(db, 20, user=B)
    _discard(db, user=A)
    db.expire_all()
    dash = db.query(Dashboard).filter(Dashboard.id == 1).one()
    assert str(B.id) in ((dash.draft_snapshot or {}).get("user_layouts") or {}), "A's Discard wiped B's layout draft"
    assert 20 not in _builder_ids(db, B), "A's Discard reverted B's removal"


def test_a_saved_layout_can_never_change_a_rows_draft_state(db):
    resp = api.add_widget_to_dashboard(1, DashboardAddChartRequest(
        widget_type="text", widget_config={"text": "A's block"},
        layout=DashboardChartLayout(x=0, y=9, w=12, h=6, draftOnly=True)), db, A)
    block = max(dc.id for dc in resp.dashboard_charts)
    _publish(db, user=A)
    stale = {"x": 12, "y": 9, "w": 12, "h": 6, "draftOnly": True, "draftOwner": str(A.id), "draftRemoved": True}
    # Saving a layout drops draft-state keys…
    api.update_dashboard_draft_layout(1, DashboardUpdateLayoutRequest(chart_layouts=[{"id": block, "layout": stale}]), db, B)
    db.expire_all()
    saved = db.query(Dashboard).filter(Dashboard.id == 1).one().draft_snapshot["user_layouts"][str(B.id)][str(block)]
    assert not ({"draftOnly", "draftOwner", "draftRemoved"} & set(saved)), "a saved layout kept draft-state keys"
    # …and Publish ignores them in a draft saved before that (B's editor had
    # copied the block's layout while it was still draft-only).
    dash = db.query(Dashboard).filter(Dashboard.id == 1).one()
    dash.draft_snapshot = {"user_layouts": {str(B.id): {str(block): stale}}}
    db.commit()
    _publish(db, user=B)
    row = _rows(db)[block]
    assert not is_draft_only_item(row) and not row.layout.get("draftRemoved"), "a colleague's publish re-hid a published block"
    assert row.layout["x"] == 12, "B's move was not published"


# ── Editing a published widget's content is a draft edit too ────────────────

def _edit_text(db, text, user=A):
    from app.schemas.schemas import DashboardUpdateWidgetRequest
    return api.update_widget_config(1, 10, DashboardUpdateWidgetRequest(widget_config={"text": text}), True, db, user)


def _builder_text(db, user):
    db.expire_all()
    resp = api._serialize_dashboard_with_draft(db, db.query(Dashboard).filter(Dashboard.id == 1).one(), user)
    return next(dc.widget_config.get("text") for dc in resp.dashboard_charts if dc.id == 10), resp.has_draft


def test_editing_a_published_widget_waits_for_publish_and_discard_drops_it(db):
    _edit_text(db, "draft words")
    assert _rows(db)[10].widget_config.get("text") == "hi", "the public link got the edit before Publish"
    assert _builder_text(db, A) == ("draft words", True), "the editor does not see their edit, or no draft bar"
    assert _builder_text(db, B)[0] == "hi", "another author sees A's unpublished edit"
    _discard(db)
    assert _builder_text(db, A) == ("hi", False), "Discard did not drop the edit"
    _edit_text(db, "published words")
    _publish(db)
    assert _rows(db)[10].widget_config.get("text") == "published words", "Publish did not apply the edit"


def test_one_authors_publish_or_discard_keeps_another_authors_widget_edit(db):
    _edit_text(db, "B's words", user=B)
    _discard(db, user=A)
    _publish(db, user=A)
    assert _builder_text(db, B)[0] == "B's words", "A's publish/discard dropped B's widget edit"
    assert _rows(db)[10].widget_config.get("text") == "hi", "A's publish published B's edit"
