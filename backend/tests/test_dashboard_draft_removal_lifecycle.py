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
from app.services.dashboard_presence import heartbeat as _REAL_HEARTBEAT  # before any fixture stubs it


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
    db.add(DashboardPublicLink(id=1, dashboard_id=1, name="first-view", token="tok-capped", filters_config=[],
                               is_active=True, access_count=0, last_accessed_at=None))  # first view always commits the bump
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
            slicers_config=[], remove_tile_ids=[20, 21], base_rev=_rev(db, A)["rev"]), db, A)
    db.expire_all()
    dash = db.query(Dashboard).filter(Dashboard.id == 1).one()
    assert not (dash.draft_snapshot or {}).get("slicers_config") and dash.draft_snapshot is None, "the entry was removed without its controls"
    assert all(not r.layout.get("draftRemoved") for r in _rows(db).values()), "a control was removed without the entry"

    monkeypatch.setattr(api, "remove_tile_in_draft", real)
    api.update_dashboard_draft_filters(1, DashboardUpdateDraftFiltersRequest(
        slicers_config=[], remove_tile_ids=[20, 21], base_rev=_rev(db, A)["rev"]), db, A)
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


# ── Editing a chart "for this report only" is a draft swap (DoD 1.3) ─────────

def _with_published_chart_tile(db: Session) -> None:
    from app.models.dataset import Dataset, DatasetTable
    from app.models.models import ChartMetadata, ChartParameter
    for table in (Dataset.__table__, DatasetTable.__table__, ChartMetadata.__table__, ChartParameter.__table__):
        table.create(db.get_bind(), checkfirst=True)
    db.add(Chart(id=601, name="Revenue", chart_type="BAR", config={}, dataset_table_id=71))
    db.add(Chart(id=602, name="Revenue (this report)", chart_type="BAR", config={}, dataset_table_id=71))
    db.add(DashboardChart(id=60, dashboard_id=1, chart_id=601, parameters={"grain": "month"},
                          layout={"x": 0, "y": 20, "w": 18, "h": 12, "pageId": "p2"}))
    db.commit()


def _swap(db, tile_id, chart_id, user=A):
    return api.swap_tile_chart_in_draft(1, tile_id, api._SwapTileChartRequest(chart_id=chart_id), db, user)


def test_a_chart_edited_for_this_report_only_is_swapped_in_the_draft(db, monkeypatch):
    """The shared chart is untouched; the public link keeps the published chart
    until Publish; Discard puts the original back; the copy keeps the tile's
    place, page and per-report parameters."""
    monkeypatch.setattr(api, "require_view_access", lambda *a, **k: "full")
    _with_published_chart_tile(db)
    _swap(db, 60, 602)
    rows = _rows(db)
    copy = next(r for r in rows.values() if r.chart_id == 602)
    assert copy.layout["pageId"] == "p2" and (copy.layout["x"], copy.layout["w"]) == (0, 18)
    assert copy.parameters == {"grain": "month"}
    public = {rows[i].chart_id for i in _public_ids(db) if rows[i].chart_id}
    assert public == {601}, "the public link shows the unpublished copy, or lost the published chart"
    builder = {rows[i].chart_id for i in _builder_ids(db, A) if i in rows and rows[i].chart_id}
    assert builder == {602}, "the author does not see their copy in place of the original"
    _discard(db)
    assert {r.chart_id for r in _rows(db).values() if r.chart_id} == {601}, "Discard did not put the original back"
    _swap(db, 60, 602)
    _publish(db)
    assert {r.chart_id for r in _rows(db).values() if r.chart_id} == {602}, "Publish did not make the swap"


# ── Chart-instance parameters are a draft edit too (DoD 05) ─────────────────

def _bind(db, params, user=A):
    return api.update_chart_parameters(1, 60, api.DashboardUpdateChartParamsRequest(parameters=params), True, db, user)


def _builder_params(db, user):
    db.expire_all()
    resp = api._serialize_dashboard_with_draft(db, db.query(Dashboard).filter(Dashboard.id == 1).one(), user)
    return next(dc.parameters for dc in resp.dashboard_charts if dc.id == 60), resp.has_draft


def test_binding_a_published_chart_to_a_parameter_waits_for_publish(db):
    # Before: PATCH /parameters wrote the live row — /d changed at once and
    # Discard could not take it back.
    _with_published_chart_tile(db)
    bound = {"grain": "month", "__whatifBindings": [{"param": "p", "role": "metric"}]}
    _bind(db, bound)
    assert _rows(db)[60].parameters == {"grain": "month"}, "the public link got the binding before Publish"
    assert _builder_params(db, A) == (bound, True), "the author does not see their binding, or no draft bar"
    assert _builder_params(db, B)[0] == {"grain": "month"}, "another author sees A's unpublished binding"
    _publish(db, B)
    assert _rows(db)[60].parameters == {"grain": "month"}, "B's publish published A's binding"
    _discard(db, A)
    assert _builder_params(db, A) == ({"grain": "month"}, False), "Discard did not drop the binding"
    _bind(db, bound)
    _publish(db, A)
    assert _rows(db)[60].parameters == bound, "Publish did not apply the binding"


# ── "Only this report" is one server transaction; a copy never outlives it (DoD 06)

def _fork_env(db, monkeypatch):
    from app.services import chart_service, chart_semantic_service, dataset_crud
    monkeypatch.setattr(chart_semantic_service, "with_chart_semantic_binding", lambda _db, _t, cfg, **_k: cfg)
    monkeypatch.setattr(chart_service, "with_chart_semantic_binding", lambda _db, _t, cfg, **_k: cfg)
    monkeypatch.setattr(dataset_crud.DatasetCRUDService, "get_table_by_id", staticmethod(lambda _db, _id: object()))
    _with_published_chart_tile(db)
    # The fork now resolves the dataset of the table it binds and authorizes it
    # (BUILD/READ, see fork_tile_chart_for_report). This file tests the draft
    # LIFECYCLE and stubs every access gate, so that gate is stubbed like the
    # others; the authorization itself is tested against the real gate in
    # test_authz_chart_sql_http_pg.py (fork onto a foreign dataset is refused).
    from app.models.dataset import Dataset, DatasetTable
    db.add(Dataset(id=7, name="orders"))
    db.add(DatasetTable(id=71, dataset_id=7, display_name="orders", source_table_name="orders"))
    db.commit()
    monkeypatch.setattr(api._authz, "require", lambda *a, **k: None)


def _fork(db, tile=60, name="Revenue", user=A, **extra):
    from app.schemas import ChartMetadataUpsert, ChartParameterCreate
    body = api._ForkChartRequest(
        name=name, chart_type="BAR", dataset_table_id=71,
        config={"roleConfig": {"dimension": "orders.region", "metrics": [{"field": "orders.revenue", "agg": "sum"}]}},
        metadata=ChartMetadataUpsert(domain="sales", tags=["kpi"]),
        parameters=[ChartParameterCreate(parameter_name="date_range", parameter_type="time_range")],
        **extra,
    )
    # A real user id is a UUID (the chart's owner column); the draft key is str(id) either way.
    import uuid
    from types import SimpleNamespace
    author = SimpleNamespace(id=uuid.UUID(user.id), email=user.email, full_name=user.full_name)
    return api.fork_tile_chart_for_report(1, tile, body, db, author)


def _charts(db):
    db.expire_all()
    return {c.id: c for c in db.query(Chart).all()}


def test_a_report_only_copy_is_one_transaction_with_its_metadata_and_parameters(db, monkeypatch):
    from app.models.models import ChartMetadata, ChartParameter
    _fork_env(db, monkeypatch)
    _fork(db)
    copies = [c for c in _charts(db).values() if (c.config or {}).get("reportCopy")]
    assert len(copies) == 1 and copies[0].config["reportCopy"] == {"dashboardId": 1}, copies
    copy = copies[0]
    assert copy.name != "Revenue", "the copy took the shared chart's name — it reads as the shared chart in the library"
    assert db.query(ChartMetadata).filter(ChartMetadata.chart_id == copy.id).one().tags == ["kpi"]
    assert [p.parameter_name for p in db.query(ChartParameter).filter(ChartParameter.chart_id == copy.id)] == ["date_range"]
    tile = next(r for r in _rows(db).values() if r.chart_id == copy.id)
    assert tile.parameters == {"grain": "month"} and is_draft_only_item(tile), "the copy is not a draft in the tile's place"
    assert {r.chart_id for i, r in _rows(db).items() if i in _public_ids(db) and r.chart_id} == {601}


def test_a_failed_fork_leaves_no_chart_behind(db, monkeypatch):
    from app.services import dashboard_service
    _fork_env(db, monkeypatch)
    before = set(_charts(db))

    def boom(*_a, **_k):
        raise PermissionError("injected: the tile belongs to another author's draft")

    monkeypatch.setattr(dashboard_service, "swap_tile_chart_in_draft", boom)
    with pytest.raises(HTTPException) as exc:
        _fork(db)
    assert exc.value.status_code == 409
    assert set(_charts(db)) == before, "a failed 'only this report' left a chart in the library"
    assert {r.chart_id for r in _rows(db).values() if r.chart_id} == {601}


def test_discard_deletes_the_copy_it_no_longer_needs(db, monkeypatch):
    _fork_env(db, monkeypatch)
    _fork(db)
    _discard(db)
    assert not [c for c in _charts(db).values() if (c.config or {}).get("reportCopy")], "Discard left the copy in the library"
    assert {r.chart_id for r in _rows(db).values() if r.chart_id} == {601}
    assert 601 in _charts(db), "Discard deleted the shared chart"


def test_editing_the_unpublished_copy_again_does_not_copy_the_copy(db, monkeypatch):
    _fork_env(db, monkeypatch)
    _fork(db)
    tile = next(r for r in _rows(db).values() if r.chart_id not in (None, 601))
    first = tile.chart_id
    _fork(db, tile=tile.id, name="Revenue v2")
    copies = [c for c in _charts(db).values() if (c.config or {}).get("reportCopy")]
    assert [c.id for c in copies] == [first], "a second edit made a copy of the copy"
    assert copies[0].name == "Revenue v2"


def test_publishing_a_newer_copy_deletes_the_one_it_replaced_and_a_report_delete_deletes_its_copies(db, monkeypatch):
    _fork_env(db, monkeypatch)
    _fork(db)
    _publish(db)
    v1 = next(r for r in _rows(db).values() if r.chart_id not in (None, 601))
    assert not is_draft_only_item(v1)
    _fork(db, tile=v1.id, name="Revenue v2")          # published copy → a new draft copy
    _publish(db)
    ids = {r.chart_id for r in _rows(db).values() if r.chart_id}
    assert v1.chart_id not in _charts(db), "the replaced copy stayed in the library"
    assert 601 in _charts(db), "publishing a copy deleted the shared chart it was made from"
    (v2,) = ids
    # A copy another report started using is not deleted with this one.
    from app.models.models import DashboardPublicLink
    DashboardPublicLink.__table__.create(db.get_bind(), checkfirst=True)
    db.add(Dashboard(id=2, name="Other"))
    db.add(DashboardChart(id=99, dashboard_id=2, chart_id=v2, layout={"x": 0, "y": 0, "w": 6, "h": 4}))
    db.commit()
    from app.services import DashboardService
    DashboardService.delete(db, 1)
    assert v2 in _charts(db), "deleting the report deleted a copy another report uses"
    db.query(DashboardChart).filter(DashboardChart.id == 99).delete()
    db.commit()
    db.add(Dashboard(id=3, name="Solo"))
    db.add(DashboardChart(id=98, dashboard_id=3, chart_id=v2, layout={}))
    db.commit()
    copy = db.get(Chart, v2)
    copy.config = {**copy.config, "reportCopy": {"dashboardId": 3}}
    db.commit()
    DashboardService.delete(db, 3)
    assert v2 not in _charts(db), "deleting a report left its report-only copy behind"


def test_a_report_copy_stays_one_when_explore_saves_it(db, monkeypatch):
    from app.schemas import ChartUpdate
    from app.services.chart_service import ChartService
    _fork_env(db, monkeypatch)
    monkeypatch.setattr(ChartService, "hydrate_runtime_config", staticmethod(lambda _db, c: c))
    _fork(db)
    copy = next(c for c in _charts(db).values() if (c.config or {}).get("reportCopy"))
    ChartService.update(db, copy.id, ChartUpdate(config={"roleConfig": {"dimension": "orders.city", "metrics": []}}))
    assert _charts(db)[copy.id].config.get("reportCopy") == {"dashboardId": 1}, "an Explore save dropped the copy marker"


def test_chart_usage_names_only_the_reports_the_caller_may_see(monkeypatch, db):
    from app.api import charts as charts_api
    _with_published_chart_tile(db)
    db.add(Dashboard(id=2, name="Private board"))
    db.add(DashboardChart(id=61, dashboard_id=2, chart_id=601, layout={"x": 0, "y": 0, "w": 8, "h": 6}))
    db.commit()
    monkeypatch.setattr(charts_api, "require_view_access", lambda *a, **k: "full")
    monkeypatch.setattr(charts_api, "get_effective_permission",
                        lambda _db, _u, dash, _m: "none" if dash.id == 2 else "view")
    usage = charts_api.get_chart_usage(601, db, A)
    assert [r["name"] for r in usage["reports"]] == ["Fixture"] and usage["other_reports"] == 1


# ── Co-authoring: the shared filters/pages/theme draft is never overwritten,
#    published or discarded silently (DoD 1.4) ──────────────────────────────

def _stage(db, user, **fields):
    # The editor always sends the revision it loaded (shared_draft.rev); a test
    # that does not name one means "the current one".
    if "base_rev" not in fields:
        fields["base_rev"] = _rev(db, user)["rev"]
    return api.update_dashboard_draft_filters(1, DashboardUpdateDraftFiltersRequest(**fields), db, user)


def _rev(db, user):
    db.expire_all()
    return api._serialize_dashboard_with_draft(db, db.query(Dashboard).filter(Dashboard.id == 1).one(), user).shared_draft


def test_a_stale_copy_of_the_shared_draft_cannot_overwrite_a_colleagues_edit(db):
    base = _rev(db, A)["rev"]
    _stage(db, A, filters_config=[{"field": "region", "operator": "in", "value": ["North"]}], base_rev=base)
    with pytest.raises(HTTPException) as exc:
        _stage(db, B, pages_config=[{"id": "p1", "name": "Overview"}], base_rev=base)  # B loaded before A saved
    assert exc.value.status_code == 409 and exc.value.detail["code"] == "shared_draft_stale"
    # Recoverable: B reloads (new revision, A's edit in it) and saves on top.
    _stage(db, B, pages_config=[{"id": "p1", "name": "Overview"}], base_rev=_rev(db, B)["rev"])
    assert _rev(db, B)["other_authors"] and _rev(db, A)["other_authors"]


def test_publishing_a_tile_a_colleague_just_published_is_a_409_naming_them(db, monkeypatch):
    # The real presence service (the fixture stubs it with a list; it returns a
    # dict, and reading it as a list turned this conflict into a 500).
    monkeypatch.setattr(api.dashboard_presence, "heartbeat", _REAL_HEARTBEAT)
    monkeypatch.setattr(api.dashboard_presence, "_PRESENCE", {})
    _REAL_HEARTBEAT(1, A.id, "Ann", "ann@example.com")
    live_v = db.get(DashboardChart, 10).layout["_v"]
    for user, x in ((A, 3), (B, 6)):
        api.update_dashboard_draft_layout(1, DashboardUpdateLayoutRequest(chart_layouts=[
            {"id": 10, "layout": {"x": x, "y": 3, "w": 12, "h": 6}}]), db, user)
    api.publish_dashboard_draft(1, api.PublishRequest(tile_base_v={"10": live_v}), db, A)
    with pytest.raises(HTTPException) as exc:
        api.publish_dashboard_draft(1, api.PublishRequest(tile_base_v={"10": live_v}), db, B)
    assert exc.value.status_code == 409 and exc.value.detail["tiles"], exc.value.detail
    assert exc.value.detail["last_editor"] == "Ann", exc.value.detail
    assert db.get(DashboardChart, 10).layout["x"] == 3, "B's stale publish overwrote A's"


def test_a_shared_draft_write_that_names_no_revision_is_refused(db):
    # Before, an omitted base_rev skipped the check: an old cached editor or a
    # script overwrote a colleague's pending filters/pages/theme without a word.
    _stage(db, A, filters_config=[{"field": "region", "operator": "in", "value": ["North"]}])
    with pytest.raises(HTTPException) as exc:
        _stage(db, B, filters_config=[], base_rev=None)
    assert exc.value.status_code == 409 and exc.value.detail["code"] == "shared_draft_stale"
    db.expire_all()
    assert db.get(Dashboard, 1).draft_snapshot["filters_config"][0]["value"] == ["North"], "the refused write changed the draft"


def test_every_draft_write_locks_the_dashboard_row(db, monkeypatch):
    # The per-author buckets and the shared draft are ONE JSON column; each write
    # reads it, changes it and writes it back. Without a row lock two concurrent
    # writes both read the old snapshot and the later commit drops the other's.
    import inspect
    for fn in (api.update_widget_config, api.update_chart_parameters, api.update_dashboard_draft_layout,
               api.update_dashboard_draft_filters, api.publish_dashboard_draft, api.discard_dashboard_draft,
               api.fork_tile_chart_for_report, api.swap_tile_chart_in_draft):
        assert "_dashboard_for_draft_write(db, dashboard_id)" in inspect.getsource(fn), fn.__name__
    from sqlalchemy.dialects import postgresql
    sql = str(api._draft_write_query(db, 1).statement.compile(dialect=postgresql.dialect()))
    assert "FOR UPDATE OF dashboards" in sql, sql


def test_publish_never_applies_a_colleagues_shared_edits_without_saying_so(db):
    _stage(db, B, filters_config=[{"field": "region", "operator": "in", "value": ["South"]}])
    with pytest.raises(HTTPException) as exc:
        _publish(db, A)
    assert exc.value.status_code == 409 and exc.value.detail["code"] == "shared_draft_other_authors"
    assert exc.value.detail["authors"] == [B.full_name]
    # Publish only mine: B's filter edit stays pending, live filters unchanged.
    api.publish_dashboard_draft(1, api.PublishRequest(force=True, keep_shared=True), db, A)
    db.expire_all()
    assert (db.get(Dashboard, 1).filters_config or []) == []
    assert _rev(db, B)["has_changes"], "keeping the shared draft dropped B's edit"
    # Publish everything, having been shown whose edits it contains.
    rev = _rev(db, A)["rev"]
    api.publish_dashboard_draft(1, api.PublishRequest(force=True, shared_ack_rev=rev), db, A)
    db.expire_all()
    assert db.get(Dashboard, 1).filters_config[0]["value"] == ["South"]
    assert not _rev(db, A)["has_changes"] and _rev(db, A)["rev"] != rev, "a stale copy would still be accepted after Publish"


def test_discard_never_drops_a_colleagues_shared_edits_without_saying_so(db):
    _stage(db, B, theme_config={"accent": "#123456"})
    with pytest.raises(HTTPException) as exc:
        _discard(db, A)
    assert exc.value.status_code == 409 and exc.value.detail["action"] == "discard"
    api.discard_dashboard_draft(1, db, A, api.DiscardRequest(keep_shared=True))
    assert _rev(db, B)["has_changes"], "A's discard dropped B's theme edit"
    api.discard_dashboard_draft(1, db, A, api.DiscardRequest(shared_ack_rev=_rev(db, A)["rev"]))
    assert not _rev(db, B)["has_changes"]


def test_a_single_author_publishes_and_discards_as_before(db):
    _stage(db, A, filters_config=[{"field": "region", "operator": "in", "value": ["North"]}])
    _publish(db, A)
    db.expire_all()
    assert db.get(Dashboard, 1).filters_config[0]["value"] == ["North"]
    _stage(db, A, theme_config={"accent": "#000"})
    _discard(db, A)
    assert not _rev(db, A)["has_changes"]
