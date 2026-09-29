"""A public link's constraints are decided once, by the engine, and enforced by the server.

Report Studio V3 completion, Milestone 1 (DoD 1.1 / 1.2). Before this:

  * `link_entry_has_value` read the raw value: a `between 5` lock stripped the
    field's slicer and page filter from the page while the engine DROPPED the
    lock — the viewer got wider data than the page scope; an `is_null` lock left
    an interactive slicer that silently did nothing;
  * "filters on this page" reached the query only because the viewer's page SENT
    them: a crafted request that left them out got data beyond the page, and a
    page filter marked 🔒/🚫 was dropped by the client and applied by nobody;
  * a 🚫 hidden dashboard/page entry was served to anonymous viewers verbatim,
    offered as a pickable field (so its distinct values could be listed), and
    handed to the public AI — which was told to NAME the filters it ran under.

Pure functions are called directly; the token path and the structure shaping run
against an in-memory SQLite schema.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.api import public as public_api
from app.core.database import Base
from app.models.models import Chart, Dashboard, DashboardChart, DashboardPublicLink
from app.services.filter_layered_merge import (
    LINK_ENTRY_EMPTY,
    LINK_ENTRY_ENFORCED,
    LINK_ENTRY_MALFORMED,
    disclosable_filters,
    link_entry_state,
    link_managed_field_keys,
    same_field_allow_list,
)


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


REGION = {"field": "region", "semanticField": "t1.region", "datasetId": 1}
PAGES = [
    {"id": "p1", "name": "Overview", "filters": [
        {**REGION, "operator": "in", "value": ["North", "South"]},
    ]},
    {"id": "p2", "name": "Tenants", "filters": [
        {"field": "tenant", "semanticField": "t1.tenant", "datasetId": 1, "operator": "in",
         "value": ["acme-42"], "publicMode": "hidden", "label": "Tenant"},
        {"field": "channel", "semanticField": "t1.channel", "datasetId": 1, "operator": "in",
         "value": ["Online"], "publicMode": "locked", "label": "Channel"},
    ]},
]


def _dash(**kw):
    tiles = kw.pop("tiles", [(7, "p1"), (8, "p2")])
    return SimpleNamespace(
        filters_config=kw.pop("filters_config", []),
        slicers_config=kw.pop("slicers_config", []),
        pages_config=kw.pop("pages_config", PAGES),
        dashboard_charts=[SimpleNamespace(chart_id=c, layout={"pageId": p}) for c, p in tiles],
        **kw,
    )


def _by_field(filters):
    return {f["field"]: f for f in filters}


# ── DoD 1.1 — one interpretation of a link entry ─────────────────────────────

@pytest.mark.parametrize("entry, state", [
    ({"field": "a", "operator": "between", "value": 5}, LINK_ENTRY_MALFORMED),
    ({"field": "a", "operator": "in", "value": 5}, LINK_ENTRY_MALFORMED),
    ({"field": "d", "operator": "between", "value": [], "datePreset": "no_such_preset"}, LINK_ENTRY_MALFORMED),
    ({"field": "a", "operator": "in", "value": ["   "]}, LINK_ENTRY_MALFORMED),
    ({"field": "a", "operator": "is_null"}, LINK_ENTRY_ENFORCED),
    ({"field": "d", "operator": "between", "value": [], "datePreset": "last_30_days"}, LINK_ENTRY_ENFORCED),
    ({"field": "a", "operator": "in", "value": "SP"}, LINK_ENTRY_ENFORCED),
    ({"field": "a", "operator": "in", "value": []}, LINK_ENTRY_EMPTY),
    ({"field": "a", "value": {}}, LINK_ENTRY_EMPTY),
    ({"field": "a", "hidden": True}, LINK_ENTRY_EMPTY),
    ({"field": "s", "limit": True, "value": "RC01"}, LINK_ENTRY_ENFORCED),
])
def test_the_engine_decides_what_a_link_entry_does(entry, state):
    assert link_entry_state(entry) == state


def test_what_the_structure_strips_is_exactly_what_the_engine_enforces():
    # is_null: enforced → its slicer must go (it would do nothing). between 5:
    # not enforced → the page must keep its controls (the link is refused anyway).
    assert link_managed_field_keys([{"field": "closed_at", "operator": "is_null"}]) == {"closed_at"}
    assert link_managed_field_keys([{"field": "amount", "operator": "between", "value": 5}]) == set()


def test_a_link_whose_constraint_cannot_be_applied_is_refused_not_widened(monkeypatch):
    monkeypatch.setattr(public_api, "resolve_embed_grant", lambda *_a, **_k: None)
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Chart.__table__, Dashboard.__table__, DashboardChart.__table__,
                                             DashboardPublicLink.__table__])
    with Session(engine) as db:
        db.add(Dashboard(id=1, name="R"))
        db.add(DashboardPublicLink(id=1, dashboard_id=1, name="bad", token="tok-bad", is_active=True, access_count=0,
                                   filters_config=[{"field": "amount", "operator": "between", "value": 5}]))
        db.add(DashboardPublicLink(id=2, dashboard_id=1, name="empty", token="tok-empty", is_active=True, access_count=0,
                                   filters_config=[{"field": "amount", "operator": "in", "value": []}]))
        db.commit()
        with pytest.raises(HTTPException) as exc:
            public_api._get_dashboard_by_token("tok-bad", db, track_access=False)
        assert exc.value.status_code == 409
        # The documented no-op still opens.
        assert public_api._get_dashboard_by_token("tok-empty", db, track_access=False)[0].id == 1


def test_an_unappliable_link_filter_cannot_be_saved():
    from app.api.dashboards import _refuse_unappliable_link_filters
    with pytest.raises(HTTPException) as exc:
        _refuse_unappliable_link_filters([{"field": "amount", "label": "Amount", "operator": "between", "value": 5}])
    assert exc.value.status_code == 422 and "Amount" in exc.value.detail
    _refuse_unappliable_link_filters([{"field": "amount", "operator": "in", "value": []}])  # empty lock: allowed


def test_an_empty_lock_is_a_no_op_on_the_data_path_too():
    merged = public_api._build_public_chart_filters(_dash(pages_config=[]), [{"field": "region", "value": {}}], [])
    assert merged == [], merged


# ── DoD 1.1 — the page scope is the server's, not the request's ─────────────

def test_a_request_that_omits_the_page_filter_still_gets_the_page_scope():
    merged = public_api._build_public_chart_filters(_dash(), [], [], page_ids=["p1"])
    assert _by_field(merged)["region"]["value"] == ["North", "South"]


def test_a_viewer_pick_outside_the_page_scope_falls_back_to_the_scope():
    viewer = [{**REGION, "operator": "in", "value": ["West"]}]
    merged = public_api._build_public_chart_filters(_dash(), [], viewer, page_ids=["p1"])
    assert _by_field(merged)["region"]["value"] == ["North", "South"]
    inside = public_api._build_public_chart_filters(_dash(), [], [{**REGION, "operator": "in", "value": ["North"]}],
                                                    page_ids=["p1"])
    assert _by_field(inside)["region"]["value"] == ["North"]


def test_a_locked_or_hidden_page_filter_is_applied_by_the_server():
    merged = _by_field(public_api._build_public_chart_filters(_dash(), [], [], page_ids=["p2"]))
    assert merged["tenant"]["value"] == ["acme-42"] and merged["channel"]["value"] == ["Online"]


def test_a_chart_cannot_be_asked_for_on_a_page_it_is_not_on():
    with pytest.raises(HTTPException) as exc:
        public_api._public_chart_page_ids(_dash(), 7, "p2")
    assert exc.value.status_code == 404
    assert public_api._public_chart_page_ids(_dash(), 7, None) == ["p1"]
    # On two pages without a page named: both scopes apply (never wider).
    both = _dash(tiles=[(9, "p1"), (9, "p2")])
    merged = _by_field(public_api._build_public_chart_filters(both, [], [], page_ids=public_api._public_chart_page_ids(both, 9, None)))
    assert {"region", "tenant", "channel"} <= set(merged)


def test_a_field_the_link_locks_replaces_the_page_filter_as_the_page_shows():
    link = [{**REGION, "operator": "in", "value": ["South"]}]
    merged = public_api._build_public_chart_filters(_dash(), link, [], page_ids=["p1"])
    regions = [f for f in merged if f["field"] == "region"]
    assert len(regions) == 1 and regions[0]["value"] == ["South"], regions


def test_the_public_ai_reads_each_chart_under_its_page_scope():
    scopes = public_api._public_page_scope_by_chart(_dash(), [])
    assert _by_field(scopes[7])["region"]["value"] == ["North", "South"]
    assert "tenant" in _by_field(scopes[8])


def test_a_dropdown_is_bounded_by_the_hard_scope_on_its_own_field():
    merged = public_api._build_public_chart_filters(_dash(), [], [], page_ids=["p1"])
    assert same_field_allow_list(merged, 1, "t1.region") == {"North", "South"}
    assert same_field_allow_list(merged, 1, "t1.channel") is None


# ── DoD 1.2 — a hidden constraint is applied and never disclosed ─────────────

def test_a_hidden_entry_is_enforced_but_never_named():
    dash = _dash(filters_config=[{"field": "seg", "operator": "in", "value": ["VIP"], "publicMode": "hidden"}])
    link = [{"field": "org", "operator": "in", "value": ["o-9"], "hidden": True}]
    merged = public_api._build_public_chart_filters(dash, link, [], page_ids=["p2"])
    fields = _by_field(merged)
    assert {"seg", "org", "tenant"} <= set(fields), "a hidden constraint is not applied"
    shown, withheld = disclosable_filters(merged)
    named = {f["field"] for f in shown}
    assert named.isdisjoint({"seg", "org", "tenant"}) and withheld == 3 and "channel" in named


def test_the_served_structure_and_the_field_picker_carry_no_hidden_entry():
    dash = _dash(filters_config=[
        {"field": "seg", "operator": "in", "value": ["VIP"], "publicMode": "hidden"},
        {"field": "year", "operator": "in", "value": [2026], "publicMode": "locked"},
        {"field": "cat", "operator": "in", "value": []},
    ])
    slicers, filters, pages = public_api._shaped_public_config(dash, [])
    assert [f["field"] for f in filters] == ["year", "cat"]
    p2 = next(p for p in pages if p["id"] == "p2")
    assert [f["field"] for f in p2["filters"]] == ["channel"], "a hidden page filter is served"
    inventory = public_api._public_viewer_filter_inventory(SimpleNamespace(
        filters_config=dash.filters_config, slicers_config=[], pages_config=PAGES))
    assert {f["field"] for f in inventory} == {"cat", "region"}, "a locked/hidden entry is offered as a pickable field"


def test_the_ai_is_not_handed_a_hidden_constraint():
    from app.services.agent_flows.tools.context import ToolContext
    dash = _dash(filters_config=[{"field": "seg", "operator": "in", "value": ["VIP"], "publicMode": "hidden"}])
    ctx = ToolContext(db=None, dashboard=None, public_filters=public_api._build_public_chart_filters(dash, [], []))
    shown, withheld = ctx.disclosed_filters()
    assert shown == [] and withheld == 1


def test_shaping_the_served_structure_never_writes_back():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Chart.__table__, Dashboard.__table__, DashboardChart.__table__])
    stored = [{"field": "seg", "operator": "in", "value": ["VIP"], "publicMode": "hidden"}]
    with Session(engine) as db:
        db.add(Dashboard(id=1, name="R", filters_config=stored, pages_config=PAGES))
        db.commit()
        dash = db.get(Dashboard, 1)
        public_api._shape_public_structure(dash, [])
        assert dash.filters_config == []
        db.commit()
        db.expire_all()
        assert db.get(Dashboard, 1).filters_config == stored, "serving a public copy rewrote the report's filters"


# ── Review findings on this change (semantic-guard) ─────────────────────────

def test_a_workboard_role_filter_is_enforced_not_refused():
    # Workboard-managed links store no `field`; the engine dropped the row
    # filter (every role saw every row) and the new state machine refused it.
    entry = {"datasetId": 1, "semanticField": "orders.region", "operator": "eq", "value": "north"}
    assert link_entry_state(entry) == LINK_ENTRY_ENFORCED
    merged = public_api._build_public_chart_filters(_dash(pages_config=[]), [entry], [])
    assert any(f.get("semanticField") == "orders.region" and f.get("value") == "north" for f in merged), merged
    from app.modules.workboards.services.dashboard_link_service import _coerce_slot
    assert _coerce_slot({"datasetId": 1, "semanticField": "orders.region"})["field"] == "orders.region"


@pytest.mark.parametrize("value", [["", ""], [""], [None]])
def test_a_cleared_value_is_the_no_op_not_a_broken_link(value):
    assert link_entry_state({"field": "d", "operator": "between" if len(value) == 2 else "in", "value": value}) == LINK_ENTRY_EMPTY


def test_an_is_null_lock_adds_to_the_page_filter_it_does_not_replace_it():
    link = [{**REGION, "operator": "is_not_null"}]
    merged = public_api._build_public_chart_filters(_dash(), link, [], page_ids=["p1"])
    regions = [f for f in merged if f["field"] == "region"]
    assert any(f.get("value") == ["North", "South"] for f in regions), "the page scope was replaced by an is_not_null lock"
    _s, _f, pages = public_api._shaped_public_config(_dash(), link)
    assert next(p for p in pages if p["id"] == "p1")["filters"], "the page filter was withheld although it still applies"


def test_a_page_filter_on_another_dataset_does_not_bound_the_chart():
    pages = [{"id": "p1", "filters": [{**REGION, "datasetId": 2, "operator": "in", "value": ["North"]}]}]
    assert public_api._build_public_chart_filters(_dash(pages_config=pages), [], [], page_ids=["p1"], chart_dataset_id=1) == []
    assert public_api._build_public_chart_filters(_dash(pages_config=pages), [], [], page_ids=["p1"], chart_dataset_id="2")


def test_a_public_chart_response_carries_no_emitted_sql_and_no_hidden_field_in_errors():
    assert public_api._public_chart_payload({"data": [1], "debug": {"sql_emitted": "tenant = 'acme-42'"}})["debug"] is None
    applied = [{"field": "tenant", "semanticField": "t1.tenant", "_disclose": False}]
    assert "tenant" not in public_api._public_error_text("filter t1.tenant could not be applied", applied)
    assert public_api._public_error_text("Bảng X chưa có relationship", applied) == "Bảng X chưa có relationship"


def test_the_ai_is_told_only_disclosable_filters_and_caches_by_page_scope():
    from app.services.agent_flows.dispatch import _disclosed
    from app.services.dashboard_ai_bot.thinking.tools import chart_cache_identity
    dash = _dash(filters_config=[{"field": "seg", "operator": "in", "value": ["VIP"], "publicMode": "hidden"}])
    merged = public_api._build_public_chart_filters(dash, [], [])
    assert _disclosed(merged) == [], "a hidden constraint reaches the flow envelope"
    bounded = SimpleNamespace(public_filters=[], excluded_columns=None, page_scope_by_chart={7: [{"field": "region"}]})
    unbounded = SimpleNamespace(public_filters=[], excluded_columns=None, page_scope_by_chart={})
    assert chart_cache_identity(bounded, 7) != chart_cache_identity(unbounded, 7), \
        "a pack read without a page scope would answer a viewer bound by one"
