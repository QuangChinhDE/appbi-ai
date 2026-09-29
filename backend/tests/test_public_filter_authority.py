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
    hard_bounds_on_field,
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


def _regions(merged, field="region"):
    return sorted((f.get("operator"), repr(f.get("value"))) for f in merged if f["field"] == field)


def test_a_link_lock_ands_with_the_page_filter_it_never_replaces_it():
    # Before: a value-bearing lock REPLACED the page filter, so a link locked to
    # a region outside the page's scope served that region on that page.
    link = [{**REGION, "operator": "in", "value": ["West"]}]
    merged = public_api._build_public_chart_filters(_dash(), link, [], page_ids=["p1"])
    assert _regions(merged) == [("in", "['North', 'South']"), ("in", "['West']")], merged
    # The page filter is still served — read-only, since the viewer cannot change it.
    _s, _f, pages = public_api._shaped_public_config(_dash(), link)
    served = next(p for p in pages if p["id"] == "p1")["filters"]
    assert [(f["field"], f["publicMode"]) for f in served] == [("region", "locked")], served


def test_a_link_kill_marker_does_not_remove_the_page_filter():
    link = [{**REGION, "hidden": True}]
    merged = public_api._build_public_chart_filters(_dash(), link, [{**REGION, "operator": "in", "value": ["West"]}],
                                                    page_ids=["p1"])
    assert _regions(merged) == [("in", "['North', 'South']")], merged


def test_a_link_lock_does_not_replace_a_locked_dashboard_filter():
    dash = _dash(pages_config=[], filters_config=[
        {**REGION, "operator": "in", "value": ["North", "South"], "publicMode": "locked"}])
    merged = public_api._build_public_chart_filters(dash, [{**REGION, "operator": "eq", "value": "West"}], [])
    assert _regions(merged) == [("eq", "'West'"), ("in", "['North', 'South']")], merged


def test_a_link_kill_marker_does_not_remove_a_hidden_dashboard_filter_and_it_stays_unnamed():
    dash = _dash(pages_config=[], filters_config=[
        {"field": "seg", "semanticField": "t1.seg", "datasetId": 1, "operator": "not_in", "value": ["Staff"],
         "publicMode": "hidden"}])
    merged = public_api._build_public_chart_filters(dash, [{"field": "seg", "semanticField": "t1.seg", "hidden": True}], [])
    assert _regions(merged, "seg") == [("not_in", "['Staff']")], merged
    shown, withheld = disclosable_filters(merged)
    assert shown == [] and withheld == 1


def test_a_viewer_still_cannot_relax_a_locked_dashboard_filter():
    dash = _dash(pages_config=[], filters_config=[{**REGION, "operator": "in", "value": ["North"], "publicMode": "locked"}])
    merged = public_api._build_public_chart_filters(dash, [], [{**REGION, "operator": "in", "value": ["West"]}])
    assert _regions(merged) == [("in", "['North']")], merged


def test_a_link_scope_never_widens_a_lock_on_the_same_field():
    # A scope and a lock on one field: the intersect-with-fallback used to
    # REWRITE the lock to the allow-list (a lock on SP + scope RJ served RJ).
    link = [{**REGION, "operator": "in", "value": ["North"]}, {**REGION, "limit": True, "value": ["South"]}]
    merged = public_api._build_public_chart_filters(_dash(pages_config=[]), link, [])
    assert _regions(merged) == [("in", "['North']"), ("in", "['South']")], merged
    dash = _dash(pages_config=[], filters_config=[{**REGION, "operator": "eq", "value": "North", "publicMode": "locked"}])
    merged = public_api._build_public_chart_filters(dash, [{**REGION, "limit": True, "value": ["South"]}], [])
    assert ("eq", "'North'") in _regions(merged), merged


def test_an_ordinary_visible_default_is_still_replaced_by_the_link():
    dash = _dash(pages_config=[], filters_config=[{**REGION, "operator": "in", "value": ["North"]}])
    merged = public_api._build_public_chart_filters(dash, [{**REGION, "operator": "in", "value": ["West"]}], [])
    assert _regions(merged) == [("in", "['West']")], merged
    _s, filters, _p = public_api._shaped_public_config(dash, [{**REGION, "operator": "in", "value": ["West"]}])
    assert filters == [], "the viewer is offered a control on a field the link manages"


def test_the_public_ai_reads_each_chart_under_its_page_scope():
    scopes = public_api._public_page_scope_by_chart(_dash(), [])
    assert _by_field(scopes[7])["region"]["value"] == ["North", "South"]
    assert "tenant" in _by_field(scopes[8])


class _Cascade(Exception):
    def __init__(self, filters):
        self.filters = filters


def _cascade_of(monkeypatch, view_name, field_name, filters):
    """The filters the REAL dropdown query (``_distinct_values_full``) cascades
    by, after its self-strip — captured where it builds its cache key."""
    from app.services import chart_contracts, dataset_model_service, semantic_query_engine

    class _Query:
        def filter(self, *_a, **_k):
            return self

        def all(self):
            return []

        def first(self):
            return SimpleNamespace(name=view_name, dataset_table_id=None)

    def capture(items, **_k):
        raise _Cascade(list(items or []))

    monkeypatch.setattr(dataset_model_service, "_distinct_snapshot_context", lambda *_a, **_k: ({}, None))
    monkeypatch.setattr(semantic_query_engine, "SemanticQueryEngine", lambda _db: SimpleNamespace(views_cache={}))
    monkeypatch.setattr(chart_contracts, "normalize_filter_conditions", capture)
    with pytest.raises(_Cascade) as got:
        dataset_model_service._distinct_values_full(SimpleNamespace(query=lambda *_a, **_k: _Query()), 1,
                                                    f"{view_name}.{field_name}", filters=filters)
    return got.value.filters


def test_a_dropdown_keeps_every_hard_bound_on_its_own_field_and_drops_only_picks(monkeypatch):
    dash = _dash(filters_config=[
        {**REGION, "operator": "not_in", "value": ["North"], "publicMode": "hidden"},
        {"field": "channel", "semanticField": "t1.channel", "datasetId": 1, "operator": "in", "value": ["Web"]},
    ], slicers_config=[{**REGION, "operator": "in", "value": ["South"]}])
    bounds: list = []
    merged = public_api._build_public_chart_filters(dash, [], [], page_ids=["p1"], hard_bounds_out=bounds)
    on_region = hard_bounds_on_field(bounds, 1, "t1.region")
    assert sorted((f["operator"], repr(f["value"])) for f in on_region) == [
        ("in", "['North', 'South']"), ("not_in", "['North']")], "a non-`in` hard bound was not kept"
    assert hard_bounds_on_field(bounds, 2, "t1.region") == [], "a bound on another dataset constrains this one"
    assert hard_bounds_on_field(bounds, 1, "t1.channel") == [], "a visible default is treated as a hard bound"
    cascade = _cascade_of(monkeypatch, "t1", "region", [*merged, *on_region])
    region_terms = sorted((f["operator"], repr(f["value"])) for f in cascade if f.get("field") == "region")
    # Every merged condition on the field is stripped (a merged pick would pin the
    # list); the raw hard bounds come back marked, whatever their operator.
    assert region_terms == [("in", "['North', 'South']"), ("not_in", "['North']")], region_terms
    assert any(f.get("field") == "channel" for f in cascade), "a filter on another field stopped cascading"


def _public_dropdown(monkeypatch, dash, viewer_filters, dropped=()):
    import json
    monkeypatch.setattr(public_api, "_get_dashboard_by_token", lambda *_a, **_k: (dash, [], None, {}))
    monkeypatch.setattr(public_api, "_build_public_filter_fields",
                        lambda *_a, **_k: [{"datasetId": 1, "semanticField": "t1.region"}])
    seen: dict = {}

    def fake_distinct(_db, _ds, _field, **kw):
        seen["filters"] = kw["filters"]
        return {"values": ["South", "West"], "dropped_filters": list(dropped)}

    monkeypatch.setattr(public_api, "get_distinct_field_values", fake_distinct)
    endpoint = public_api.get_public_filter_distinct_values
    endpoint = getattr(endpoint, "__wrapped__", endpoint)  # past the rate limiter
    out = endpoint("tok", None, dataset_id=1, field="t1.region", limit=200, offset=0, search=None,
                   filters=json.dumps(viewer_filters), page_id="p1", db=None, x_public_session=None)
    return out, seen["filters"]


def test_the_public_dropdown_query_carries_the_raw_hard_bounds_and_no_viewer_marker(monkeypatch):
    dash = _dash(filters_config=[{**REGION, "operator": "not_in", "value": ["North"], "publicMode": "hidden"}])
    viewer = [{**REGION, "operator": "in", "value": ["North"], "_hard_bound": True, "_disclose": False}]
    out, sent = _public_dropdown(monkeypatch, dash, viewer)
    hard = sorted((f["operator"], repr(f["value"])) for f in sent if f.get("_hard_bound"))
    assert hard == [("in", "['North', 'South']"), ("not_in", "['North']")], hard
    assert all(f.get("datasetId") == 1 for f in sent if f.get("_hard_bound")), "a hard bound the SQL builder would skip"
    assert out["values"] == ["South", "West"] and out["dropped_filters"] == []


def test_the_public_dropdown_offers_nothing_when_a_hard_bound_on_its_field_could_not_apply(monkeypatch):
    dash = _dash(filters_config=[{**REGION, "operator": "not_in", "value": ["North"], "publicMode": "hidden"}])
    out, _ = _public_dropdown(monkeypatch, dash, [], dropped=[{"semantic_field": "t1.region", "reason": "field_not_on_view"}])
    assert out["values"] == [] and out["total"] == 0, "a bound the query dropped widened the dropdown"
    out, _ = _public_dropdown(monkeypatch, dash, [], dropped=[{"semantic_field": "t1.channel", "reason": "no_join_path"}])
    assert out["values"] == ["South", "West"], "an unrelated dropped cascade emptied the dropdown"


def test_the_deploy_audit_names_links_that_now_refuse_or_return_nothing():
    from app.services.public_link_audit import EMPTY, NARROWED, REFUSED, audit_link
    findings = audit_link(
        [{**REGION, "operator": "in", "value": ["West"]},            # outside the page scope → empty
         {"field": "tenant", "semanticField": "t1.tenant", "operator": "in", "value": ["acme-42", "x"]},
         {"field": "amount", "operator": "between", "value": 5}],    # engine cannot apply → refused
        filters_config=[], pages_config=PAGES)
    kinds = sorted((f["kind"], f["field"]) for f in findings)
    assert kinds == [(EMPTY, "t1.region"), (NARROWED, "t1.tenant"), (REFUSED, "amount")], kinds
    assert all(f["remedy"] for f in findings)
    assert audit_link([{**REGION, "operator": "in", "value": ["North"]}], pages_config=PAGES)[0]["kind"] == NARROWED
    assert audit_link([], pages_config=PAGES) == []


# ── DoD 04 — role-scoped links (workboard roles, embed claims) ──────────────

def _role_link(role, mapping=None):
    from app.modules.workboards.services.dashboard_link_service import _build_filters_config
    return _build_filters_config(mapping if mapping is not None else [{"datasetId": 1, "semanticField": "t1.region"}], role)


def test_two_roles_each_get_only_their_rows_whatever_the_viewer_sends():
    for role, other in (("north", "south"), ("south", "north")):
        viewer = [{**REGION, "operator": "in", "value": [other]}]   # a crafted request for the other role's rows
        merged = public_api._build_public_chart_filters(_dash(pages_config=[]), _role_link(role), viewer)
        regions = [(f["operator"], f["value"]) for f in merged if f.get("semanticField") == "t1.region"]
        # The role condition is always applied; a crafted pick can only AND
        # with it (no rows), never replace it.
        assert ("eq", role) in regions and all(
            f.get("_layer_source") == "link_locked" or f["value"] != [role]
            for f in merged if f.get("semanticField") == "t1.region"), (role, regions)


def test_a_role_filter_ands_with_the_page_scope_and_an_exclusion_stays_an_exclusion():
    merged = public_api._build_public_chart_filters(_dash(), _role_link("North"), [], page_ids=["p1"])
    both = sorted((f["operator"], repr(f["value"])) for f in merged if f.get("semanticField") == "t1.region")
    assert both == [("eq", "'North'"), ("in", "['North', 'South']")], merged
    excl = [{**REGION, "operator": "not_in", "value": ["Staff"]}]
    merged = public_api._build_public_chart_filters(_dash(pages_config=[]), excl, [{**REGION, "operator": "in", "value": ["Staff"]}])
    assert _regions(merged) == [("not_in", "['Staff']")], "a viewer pick replaced the exclusion"


def test_a_role_slot_that_cannot_be_applied_refuses_the_link_instead_of_showing_every_row():
    link = _role_link("north", mapping=[{"datasetId": 1, "semanticField": "region"}])   # no view qualifier
    with pytest.raises(HTTPException) as exc:
        public_api._refuse_malformed_link(link)
    assert exc.value.status_code == 409


def test_a_role_filter_bounds_only_charts_of_its_own_dataset():
    merged = public_api._build_public_chart_filters(_dash(pages_config=[]), _role_link("north"), [])
    [role_entry] = [f for f in merged if f.get("semanticField") == "t1.region"]
    assert role_entry["datasetId"] == 1, "the engine applies a role entry by its datasetId; it must carry it"


def test_an_unmapped_role_on_a_managed_screen_gets_no_token():
    from app.modules.workboards.services.dashboard_link_service import resolve_managed_token
    layout = {"screens": [{"id": "s1", "kind": "dashboard", "dashboard": {"managed_links": {"north": "tok-n", "south": "tok-s"}}}]}
    assert resolve_managed_token(layout_json=layout, screen_id="s1", app_user_role="north") == "tok-n"
    assert resolve_managed_token(layout_json=layout, screen_id="s1", app_user_role="east") is None
    assert resolve_managed_token(layout_json=layout, screen_id="s1", app_user_role=None) is None


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


def test_the_public_model_names_only_fields_the_served_report_uses():
    model = {"views": [
        {"name": "orders", "sql_table": "raw.orders_secret", "dimensions": [
            {"name": "region", "label": "Region", "sql": "r"},
            {"name": "tenant", "label": "Tenant (internal)"},
        ], "measures": [
            {"name": "revenue", "label": "Revenue", "type": "sum", "sql": "SUM(x)", "format": {"kind": "currency", "currency": "BRL"}},
            {"name": "margin_secret", "label": "Margin", "type": "sum"},
        ]},
        {"name": "staff", "dimensions": [{"name": "salary_band", "label": "Salary band"}], "measures": []},
    ]}
    # A real chart config: the fields it reads are in roleConfig (a bare name is
    # qualified by its binding's base view); its binding lists the whole explore.
    dash = SimpleNamespace(
        dashboard_charts=[SimpleNamespace(layout={}, chart=SimpleNamespace(config={
            "roleConfig": {"dimension": "orders.region", "metrics": [{"field": "revenue", "agg": "sum"}]},
            "semanticBinding": {"baseViewName": "orders", "dimensionFields": ["orders.region", "orders.tenant"],
                                "measureFields": ["orders.revenue", "orders.margin_secret"]}}))],
        slicers_config=[], filters_config=[], pages_config=[])
    trimmed = public_api._trim_model_for_public(model, public_api._public_field_refs(dash))
    assert trimmed == {"views": [{"name": "orders",
                                  "dimensions": [{"name": "region", "label": "Region"}],
                                  "measures": [{"name": "revenue", "label": "Revenue",
                                                "format": {"kind": "currency", "currency": "BRL", "decimals": None},
                                                "type": "sum"}]}]}, trimmed


def test_a_served_chart_binding_names_only_the_fields_the_report_uses():
    # The binding listed EVERY field of the explore; served as-is, an anonymous
    # viewer read the whole dataset's field names from any chart config.
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Chart.__table__, Dashboard.__table__, DashboardChart.__table__])
    binding = {"datasetId": 1, "baseViewName": "t1", "dimensionFields": ["t1.region", "t1.salary", "t1.tenant"],
               "measureFields": ["t1.revenue", "t1.margin_secret"], "reachableFields": ["t1.region", "t1.salary"],
               "reachableDimensionFields": ["t1.region", "t1.salary", "t2.secret_dim"],
               "reachableMeasureFields": ["t1.revenue", "t2.secret_measure"],
               "reachableViews": [{"name": "t1"}, {"name": "t2"}]}
    stored = {"roleConfig": {"dimension": "t1.region", "metrics": [{"field": "t1.revenue", "agg": "sum"}]}, "semanticBinding": binding}
    with Session(engine) as db:
        db.add(Chart(id=7, name="c", chart_type="BAR", config=stored))
        db.add(Dashboard(id=1, name="R", pages_config=[]))
        db.add(DashboardChart(id=70, dashboard_id=1, chart_id=7, layout={}))
        db.commit()
        dash = db.get(Dashboard, 1)
        refs = public_api._public_field_refs(dash)
        assert "t1.salary" not in refs, "the binding's own catalog counted as a use"
        public_api._trim_served_binding_catalogs(dash, refs)
        served = dash.dashboard_charts[0].chart.config["semanticBinding"]
        assert served["dimensionFields"] == ["t1.region"] and served["measureFields"] == ["t1.revenue"]
        assert served["reachableFields"] == ["t1.region"]
        assert served["reachableDimensionFields"] == ["t1.region"] and served["reachableMeasureFields"] == ["t1.revenue"]
        assert served["reachableViews"] == [{"name": "t1"}], "a joinable view's name is served although no field on it is used"
        db.commit()
        db.expire_all()
        assert db.get(Chart, 7).config["semanticBinding"]["dimensionFields"] == ["t1.region", "t1.salary", "t1.tenant"],             "trimming the served copy rewrote the chart"


def test_a_viewer_filter_may_name_only_fields_the_served_report_exposes():
    charts = [SimpleNamespace(chart_id=7, layout={"pageId": "p1"},
                              chart=SimpleNamespace(config={"roleConfig": {"dimension": "t1.channel"}}))]
    dash = _dash(pages_config=PAGES)
    dash.dashboard_charts = charts
    viewer = [{**REGION, "operator": "in", "value": ["North"]},                                        # a page filter: exposed
              {"field": "channel", "semanticField": "t1.channel", "operator": "in", "value": ["Web"]},  # a chart dimension (cross-filter)
              {"field": "salary", "semanticField": "t1.salary", "operator": "gt", "value": 9000},        # nothing exposes it
              {"field": "tenant", "semanticField": "t1.tenant", "operator": "in", "value": ["acme-42"]}] # only a HIDDEN filter uses it
    merged = public_api._build_public_chart_filters(dash, [], viewer, page_ids=["p1"])
    fields = {f.get("semanticField") for f in merged}
    assert "t1.channel" in fields and "t1.region" in fields
    assert "t1.salary" not in fields, "a viewer sliced the data by a field the report never shows"
    viewer_tenant = [f for f in merged if f.get("semanticField") == "t1.tenant" and f.get("_layer_source") != "page_scope"]
    assert viewer_tenant == [], "a viewer probed the field of a hidden constraint"


@pytest.mark.parametrize("crafted", [
    {"field": "region", "semanticField": "t1.salary", "operator": "gt", "value": 9000},     # harmless field, crafted semanticField
    {"fieldKey": "t1.region", "semanticField": "t1.salary", "operator": "gt", "value": 9000},
    {"field": "region", "semanticField": "customers.region", "operator": "in", "value": ["x"]},  # same bare name, other view
    {"semanticField": "t1.status", "operator": "in", "value": ["x"]},                         # only a TITLE says "Status"
])
def test_a_crafted_viewer_filter_cannot_borrow_an_exposed_name(crafted):
    charts = [SimpleNamespace(chart_id=7, layout={"pageId": "p1"},
                              chart=SimpleNamespace(config={"roleConfig": {"dimension": "t1.channel"},
                                                            "styleConfig": {"chartTitle": "Status"}}))]
    dash = _dash(pages_config=PAGES)
    dash.dashboard_charts = charts
    merged = public_api._build_public_chart_filters(dash, [], [crafted], page_ids=["p1"])
    assert not any(f.get("semanticField") == crafted["semanticField"] for f in merged), merged


@pytest.mark.parametrize("name", ["Khu vực", "ID KH", "2024_sales"])
def test_a_slicer_on_a_raw_column_header_is_kept_and_labelled(name):
    # Field names are raw headers (Sheets): the gate must not judge them by an
    # identifier pattern, or the slicer is silently ignored (unfiltered numbers).
    slicer = {"id": "s1", "field": name, "semanticField": f"dataset_table_12.{name}", "datasetId": 1, "operator": "in", "value": []}
    dash = _dash(pages_config=[], slicers_config=[slicer])
    dash.dashboard_charts = [SimpleNamespace(chart_id=7, layout={}, chart=SimpleNamespace(dataset_table_id=12, config={
        "roleConfig": {"dimension": name, "metrics": [{"field": "Doanh thu (VND)", "agg": "sum"}]}}))]
    pick = {**slicer, "value": ["HN"]}
    merged = public_api._build_public_chart_filters(dash, [], [pick])
    assert any(f.get("value") == ["HN"] for f in merged), f"a viewer pick on {name!r} was dropped"
    model = {"views": [{"name": "dataset_table_12", "dimensions": [{"name": name, "label": name}],
                        "measures": [{"name": "Doanh thu (VND)", "label": "Doanh thu", "format": {"kind": "currency", "currency": "VND"}}]}]}
    trimmed = public_api._trim_model_for_public(model, public_api._public_field_refs(dash))
    assert trimmed["views"] and trimmed["views"][0]["measures"], "a measure with a non-identifier name lost its label/format"


def test_a_bare_fieldkey_slicer_is_kept_and_a_smuggled_linked_field_is_not():
    slicer = {"id": "s1", "field": "region", "fieldKey": "region", "operator": "in", "value": []}
    dash = _dash(pages_config=[], slicers_config=[slicer])
    merged = public_api._build_public_chart_filters(dash, [], [{**slicer, "value": ["North"]}])
    assert any(f.get("value") == ["North"] for f in merged), "a slicer whose fieldKey has no dot was dropped"
    smuggled = {**REGION, "operator": "in", "value": ["North"], "linkedFields": ["t9.order_status"]}
    dash = _dash()
    merged = public_api._build_public_chart_filters(dash, [], [smuggled], page_ids=["p1"])
    assert not any(f.get("linkedFields") for f in merged), "an unexposed linked field rode along an exposed one"


def test_a_chart_saved_without_a_binding_still_exposes_its_bare_fields():
    dash = _dash(pages_config=[])
    dash.dashboard_charts = [SimpleNamespace(chart_id=7, layout={}, chart=SimpleNamespace(dataset_table_id=3, config={
        "roleConfig": {"dimension": "customer_state"}}))]
    click = {"field": "customer_state", "semanticField": "dataset_table_3.customer_state", "operator": "in", "value": ["SP"]}
    merged = public_api._build_public_chart_filters(dash, [], [click])
    assert any(f.get("value") == ["SP"] for f in merged), "a cross-filter from a binding-less chart was dropped"


def test_a_calendar_cross_filter_survives_the_viewer_gate():
    # A date axis mapped to the calendar: a click sends the calendar field.
    charts = [SimpleNamespace(chart_id=7, layout={"pageId": "p1"}, chart=SimpleNamespace(config={
        "roleConfig": {"dimension": "order_date"},
        "semanticBinding": {"baseViewName": "t1", "fieldMap": {"order_date": "cal_t1.date"},
                            "calendarFieldMappings": [{"sourceField": "order_date", "calendarField": "date", "semanticField": "cal_t1.date"},
                                                      {"sourceField": "ship_date", "calendarField": "date", "semanticField": "cal_t1_ship.date"}]}}))]
    dash = _dash(pages_config=[])
    dash.dashboard_charts = charts
    click = {"field": "order_date", "semanticField": "cal_t1.date", "operator": "in", "value": ["2018-01-01"]}
    other = {"field": "ship_date", "semanticField": "cal_t1_ship.date", "operator": "in", "value": ["2018-01-01"]}
    merged = public_api._build_public_chart_filters(dash, [], [click, other])
    fields = {f.get("semanticField") for f in merged}
    assert "cal_t1.date" in fields, "a calendar cross-filter click was dropped"
    assert "cal_t1_ship.date" not in fields, "a calendar mapping of a field no chart uses was exposed"


def test_a_viewer_inventory_never_falls_back_to_every_reachable_dimension(monkeypatch):
    calls = []
    monkeypatch.setattr(public_api, "_augment_with_slicer_fields", lambda _db, _d, fields: calls.append(fields) or fields)
    assert public_api._build_public_filter_fields(None, _dash(), [], legacy_scan=False) == []
    assert calls == [[]]


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
