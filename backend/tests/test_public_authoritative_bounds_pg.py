"""Authoritative constraints fail CLOSED on the real public routes (Postgres).

Seeded CI fixture (dataset 56). The stage dimension is related to DEALS only
(deal → stage); the activity fact reaches owner and date, never stage. So a
constraint on ``stage_name`` cannot be applied to an activity chart:

  ordinary dashboard filter     ignored with a diagnostic — the documented
                                Power BI behaviour, unchanged (245 = unfiltered)
  public link 🔒 lock           REFUSED (it used to be dropped: the anonymous
                                viewer got the full activity total)
  public link 🚫 hidden         REFUSED, and the refusal names neither the
                                field nor the value
  page scope (hard bound)       REFUSED
  slicer dropdown under a lock  answers NOTHING, not every value
  malformed 🔒 dashboard filter 409 on every public path
and a related lock is APPLIED (deals in stage Won = 2500 of 8000). A result
cached for an ordinary request is never served for the authoritative one.

Metadata (dashboard, tiles, links) lives in one rolled-back transaction.
"""
from __future__ import annotations

import json
import os
import uuid

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

DATASET_ID = 56
STAGE = "dataset_table_189.stage_name"
SUBJECT = "dataset_table_192.subject"
TOKEN = "authbounds-" + uuid.uuid4().hex[:10]


def _lock(**kw):
    return {"field": STAGE, "semanticField": STAGE, "operator": "eq", "value": "Won", "datasetId": DATASET_ID, **kw}


@pytest.fixture(scope="module")
def ctx():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_public_authoritative_bounds_pg needs the seeded Postgres CI fixture (DATABASE_URL).")
    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.core.dependencies import get_current_user
    from app.main import app
    from app.models.models import Chart, Dashboard, DashboardChart, DashboardPublicLink

    engine = sa.create_engine(url)
    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    charts = {c.name: c.id for c in db.query(Chart).filter(Chart.name.in_(
        ["[snow] activity duration total", "[snow] Deal amount total"]))}
    if len(charts) != 2:
        pytest.fail("fixture charts missing — run scripts/seed_snowflake_ci_fixture.py first.")
    act, deal = charts["[snow] activity duration total"], charts["[snow] Deal amount total"]
    # The fixture's relationships are all cross-filter "both", which makes the
    # stage reachable from activity (activity → owner ← deal → stage). Make the
    # deal's owner and date relationships one-way (rolled back with the rest):
    # the charts' strict resolver then has NO route from activity to stage — a
    # genuinely unrelated constraint (the field stays in the binding's catalog,
    # so an ORDINARY filter on it takes the documented soft "ignored" path).
    from sqlalchemy.orm.attributes import flag_modified

    from app.models.semantic import SemanticExplore

    deal_explore = db.query(SemanticExplore).filter(SemanticExplore.base_view_name == "dataset_table_190").one()
    deal_explore.joins = [
        {**j, "cross_filter": "single"} if j.get("view") in ("dataset_table_188", "dataset_table_187") else j
        for j in deal_explore.joins
    ]
    flag_modified(deal_explore, "joins")
    db.flush()

    def dashboard(name, *, filters_config=None, pages_config=None, links=()):
        d = Dashboard(name=f"{name} {TOKEN}", filters_config=filters_config or [], pages_config=pages_config or [],
                      slicers_config=[{"field": SUBJECT, "semanticField": SUBJECT, "datasetId": DATASET_ID}])
        db.add(d)
        db.flush()
        for i, cid in enumerate((act, deal)):
            db.add(DashboardChart(dashboard_id=d.id, chart_id=cid, widget_type="chart",
                                  layout={"x": 0, "y": i * 4, "w": 6, "h": 4}))
        for suffix, cfg in links:
            db.add(DashboardPublicLink(dashboard_id=d.id, name=suffix, token=f"{TOKEN}-{suffix}", is_active=True,
                                       filters_config=cfg))
        db.flush()

    dashboard("links", links=[("plain", []), ("locked", [_lock()]), ("hidden", [_lock(hidden=True)])])
    dashboard("page", pages_config=[{"id": "page-1", "filters": [_lock()]}], links=[("page", [])])
    dashboard("malformed", filters_config=[_lock(operator="between", value=5, publicMode="locked")],
              links=[("malformed", [])])

    admin = type("U", (), {"id": uuid.UUID(int=7), "email": "authbounds@x", "is_active": True,
                           "permissions": {"settings": "full"}})()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: admin
    try:
        yield TestClient(app), act, deal, db, deal_explore
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        db.close()
        outer.rollback()
        conn.close()
        engine.dispose()


def _value(resp):
    assert resp.status_code == 200, resp.text
    (row,) = resp.json()["data"]
    return float(next(iter(row.values())))


def _public(client, suffix, chart_id):
    return client.get(f"/api/v1/public/dashboards/{TOKEN}-{suffix}/charts/{chart_id}/data")


def test_an_ordinary_dashboard_filter_with_no_path_is_still_ignored(ctx):
    client, act, _deal, *_ = ctx
    filt = json.dumps([{"field": STAGE, "semanticField": STAGE, "operator": "eq", "value": "Won",
                        "datasetId": DATASET_ID}])
    resp = client.get(f"/api/v1/charts/{act}/data", params={"context": "dashboard", "filters": filt})
    assert _value(resp) == 245, "the documented ordinary behaviour (unfiltered total) is unchanged"


def test_a_public_lock_with_no_path_to_the_chart_is_refused_not_dropped(ctx):
    client, act, _deal, *_ = ctx
    assert _value(_public(client, "plain", act)) == 245
    resp = _public(client, "locked", act)
    assert resp.status_code == 400, resp.text
    assert "Won" not in resp.text and "stage" not in resp.text


def test_a_related_public_lock_is_applied(ctx):
    client, _act, deal, *_ = ctx
    assert _value(_public(client, "plain", deal)) == 8000
    assert _value(_public(client, "locked", deal)) == 2500


def test_a_hidden_constraint_is_refused_without_naming_its_field_or_value(ctx):
    client, act, deal, *_ = ctx
    resp = _public(client, "hidden", act)
    assert resp.status_code == 400, resp.text
    assert "Won" not in resp.text and "stage" not in resp.text.lower()
    assert _value(_public(client, "hidden", deal)) == 2500


def test_a_page_bound_with_no_path_to_the_chart_is_refused(ctx):
    client, act, deal, *_ = ctx
    assert _public(client, "page", act).status_code == 400
    assert _value(_public(client, "page", deal)) == 2500


def test_a_malformed_locked_dashboard_filter_fails_closed(ctx):
    client, act, _deal, *_ = ctx
    assert _public(client, "malformed", act).status_code == 409


def test_a_dropdown_under_a_lock_it_cannot_apply_offers_nothing(ctx):
    """The slicer cascade routes through shared dims BOTH ways (its documented
    "members offered through any shared fact"), so with one-way relationships
    it still applies the stage lock (owner ← deal → stage) — a narrower list.
    With the deal's owner/date relationships OFF there is no route at all: the
    dropdown must offer nothing, not every value."""
    from sqlalchemy.orm.attributes import flag_modified

    client, _act, _deal, db, deal_explore = ctx
    saved = [dict(j) for j in deal_explore.joins]
    deal_explore.joins = [
        {**j, "is_active": False} if j.get("view") in ("dataset_table_188", "dataset_table_187") else j
        for j in saved
    ]
    flag_modified(deal_explore, "joins")
    db.flush()
    try:
        _assert_dropdown_under_unappliable_lock_is_empty(client)
    finally:
        deal_explore.joins = saved
        flag_modified(deal_explore, "joins")
        db.flush()


def _assert_dropdown_under_unappliable_lock_is_empty(client):
    plain = client.get(f"/api/v1/public/dashboards/{TOKEN}-plain/filters/distinct-values",
                       params={"dataset_id": DATASET_ID, "field": SUBJECT})
    assert plain.status_code == 200 and len(plain.json()["values"]) >= 1, plain.text
    locked = client.get(f"/api/v1/public/dashboards/{TOKEN}-locked/filters/distinct-values",
                        params={"dataset_id": DATASET_ID, "field": SUBJECT})
    assert locked.status_code == 200 and locked.json()["values"] == [], locked.text


def test_a_result_cached_for_an_ordinary_request_is_never_served_for_the_authoritative_one(ctx):
    """Same chart, same predicate: the authed ordinary request (soft drop,
    unfiltered) is computed and cached first; the public lock must still be
    refused — the cache identity carries which constraints are authoritative."""
    client, act, _deal, *_ = ctx
    filt = json.dumps([{"field": STAGE, "semanticField": STAGE, "operator": "eq", "value": "Won",
                        "datasetId": DATASET_ID}])
    assert _value(client.get(f"/api/v1/charts/{act}/data", params={"context": "dashboard", "filters": filt})) == 245
    assert _public(client, "locked", act).status_code == 400


# ── Integration embed (POST /integrations/embed/resolve): filter identity ────
#
# The API resolves a caller's filter to ONE filterable field of the dashboard,
# never a guess. On this fixture `subject` is a dimension of TWO views of the
# same dataset (dataset_table_191 = activity-side, dataset_table_192), and
# `stage_name` exists once. The minted emb_ then reads data through the same
# public route as every other link (no separate query path).

SUBJECT_A = "dataset_table_191.subject"
SUBJECT_B = "dataset_table_192.subject"


@pytest.fixture()
def api_embed(ctx):
    """A dashboard whose chart binding exposes stage_name + both `subject`s, the
    deal chart for a data check, and a REAL PAT of the dashboard's owner."""
    from app.core.dependencies import AUTH_TOKEN_KIND_ATTR, PERSONAL_ACCESS_TOKEN_ID_ATTR, get_current_user
    from app.core.personal_access_tokens import create_personal_access_token_secret, hash_personal_access_token_secret
    from app.main import app
    from app.models.models import Chart, Dashboard, DashboardChart
    from app.models.personal_access_token import PersonalAccessToken
    from app.models.user import User, UserStatus

    client, _act, deal, db, _explore = ctx
    owner = User(id=uuid.uuid4(), email=f"embed-{uuid.uuid4().hex[:12]}@x", full_name="embed owner", password_hash="x",
                 status=UserStatus.ACTIVE, permissions={"dashboards": "full"}, google_oauth_scopes=[])
    db.add(owner)
    db.flush()
    pat = PersonalAccessToken(id=uuid.uuid4(), owner_id=owner.id, name="api-embed",
                              secret_hash=hash_personal_access_token_secret(create_personal_access_token_secret()),
                              secret_suffix="abcdef", scopes={"dashboards": "edit"})
    db.add(pat)
    inventory = Chart(name=f"inventory {TOKEN} {uuid.uuid4().hex[:8]}", chart_type="TABLE", config={"semanticBinding": {
        "datasetId": DATASET_ID, "reachableFields": [STAGE, SUBJECT_A, SUBJECT_B]}})
    db.add(inventory)
    db.flush()
    dash = Dashboard(name=f"api-embed {TOKEN} {uuid.uuid4().hex[:8]}", owner_id=owner.id)
    db.add(dash)
    db.flush()
    for i, cid in enumerate((inventory.id, deal)):
        db.add(DashboardChart(dashboard_id=dash.id, chart_id=cid, widget_type="chart",
                              layout={"x": 0, "y": i * 4, "w": 6, "h": 4}))
    db.flush()
    setattr(owner, AUTH_TOKEN_KIND_ATTR, "personal_access_token")
    setattr(owner, PERSONAL_ACCESS_TOKEN_ID_ATTR, pat.id)
    previous = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_current_user] = lambda: owner
    try:
        yield client, dash.id, deal, db
    finally:
        app.dependency_overrides[get_current_user] = previous


def _resolve(client, dashboard_id, *filters):
    return client.post("/api/v1/integrations/embed/resolve",
                       json={"dashboard_id": dashboard_id, "filters": list(filters)})


def _f(**kw):
    return {"operator": "in", "value": ["x"], **kw}


def test_api_embed_a_unique_bare_field_is_accepted_and_locks_the_data(api_embed):
    client, dash_id, deal, _db = api_embed
    r = _resolve(client, dash_id, {"field": "stage_name", "operator": "eq", "value": "Won"})
    assert r.status_code == 200, r.text
    token = r.json()["embed_path"].split("/embed/")[1]
    # The grant reads through the ordinary public route: the deal total under the
    # lock is the fixture's Won total, as for any locked link (2500 of 8000).
    assert _value(client.get(f"/api/v1/public/dashboards/{token}/charts/{deal}/data")) == 2500


def test_api_embed_an_unknown_field_is_refused(api_embed):
    client, dash_id, _deal, _db = api_embed
    r = _resolve(client, dash_id, _f(field="no_such_field"))
    assert r.status_code == 400 and "not filterable" in r.text, r.text


def test_api_embed_an_ambiguous_bare_field_is_refused_never_routed_to_one_of_them(api_embed):
    client, dash_id, _deal, _db = api_embed
    r = _resolve(client, dash_id, _f(field="subject"))
    assert r.status_code == 400, r.text
    assert "ambiguous" in r.text and "semanticField" in r.text


def test_api_embed_a_qualified_field_with_its_dataset_selects_exactly_that_field(api_embed):
    client, dash_id, _deal, db = api_embed
    from app.models.models import DashboardPublicLink
    r = _resolve(client, dash_id, _f(field="subject", semanticField=SUBJECT_B, datasetId=DATASET_ID))
    assert r.status_code == 200, r.text
    link = db.query(DashboardPublicLink).filter(DashboardPublicLink.dashboard_id == dash_id,
                                                DashboardPublicLink.filter_hash == r.json()["filter_hash"]).one()
    (entry,) = link.filters_config
    # The canonical lock carries the exact identity — not the other `subject`.
    assert entry["semanticField"] == SUBJECT_B and entry["datasetId"] == DATASET_ID, entry
    # The bare column name, as the Public Links dialog and the filter pane store
    # it — a qualified `field` made the lock a different merge key from the same
    # field's filters, so it ANDed with them instead of replacing them.
    assert entry["field"] == "subject", entry


def test_api_embed_a_qualified_field_with_the_wrong_dataset_is_refused(api_embed):
    client, dash_id, _deal, _db = api_embed
    r = _resolve(client, dash_id, _f(semanticField=SUBJECT_A, datasetId=DATASET_ID + 999))
    assert r.status_code == 400 and "does not belong to dataset" in r.text, r.text
    r = _resolve(client, dash_id, _f(field="stage_name", semanticField=SUBJECT_A, datasetId=DATASET_ID))
    assert r.status_code == 400 and "does not match" in r.text, r.text


def test_api_embed_the_same_resolved_filter_hashes_the_same_however_it_is_spelled(api_embed):
    client, dash_id, _deal, _db = api_embed
    spellings = [
        {"field": "stage_name", "operator": "in", "value": ["Won", "Lead"]},
        {"field": "STAGE_NAME", "operator": "IN", "value": ["Lead", "Won"]},
        {"semanticField": STAGE, "datasetId": DATASET_ID, "operator": "in", "value": ["Won", "Lead"]},
        {"field": STAGE, "operator": "in", "value": ["Lead", "Won"]},
    ]
    hashes = set()
    for s in spellings:
        r = _resolve(client, dash_id, s)
        assert r.status_code == 200, (s, r.text)
        hashes.add(r.json()["filter_hash"])
    assert len(hashes) == 1, hashes


def test_api_embed_two_fields_sharing_a_bare_name_are_two_scopes(api_embed):
    client, dash_id, _deal, _db = api_embed
    a = _resolve(client, dash_id, _f(semanticField=SUBJECT_A, datasetId=DATASET_ID))
    b = _resolve(client, dash_id, _f(semanticField=SUBJECT_B, datasetId=DATASET_ID))
    assert a.status_code == 200 and b.status_code == 200, (a.text, b.text)
    assert a.json()["filter_hash"] != b.json()["filter_hash"]


# ── Integration embed: the API lock composes with page scope, viewer choices and
# the dropdown domain exactly as any link lock does (same public route) ───────

def _embed_dashboard(db, deal, owner_id, *, pages_config=None):
    """The deal chart + an inventory chart, a Region-like slicer on stage_name
    (so a viewer filter on it is an EXPOSED field, not dropped as unknown)."""
    from app.models.models import Chart, Dashboard, DashboardChart, DashboardPublicLink

    inventory = Chart(name=f"inventory {TOKEN} {uuid.uuid4().hex[:8]}", chart_type="TABLE", config={
        "semanticBinding": {"datasetId": DATASET_ID, "reachableFields": [STAGE, SUBJECT_A, SUBJECT_B]}})
    db.add(inventory)
    db.flush()
    dash = Dashboard(name=f"api-embed-page {TOKEN} {uuid.uuid4().hex[:8]}", owner_id=owner_id,
                     pages_config=pages_config or [],
                     slicers_config=[{"field": STAGE, "semanticField": STAGE, "datasetId": DATASET_ID},
                                     {"field": SUBJECT_B, "semanticField": SUBJECT_B, "datasetId": DATASET_ID}])
    db.add(dash)
    db.flush()
    for i, cid in enumerate((inventory.id, deal)):
        db.add(DashboardChart(dashboard_id=dash.id, chart_id=cid, widget_type="chart",
                              layout={"x": 0, "y": i * 4, "w": 6, "h": 4}))
    plain = f"{TOKEN}-plain-{uuid.uuid4().hex[:8]}"
    db.add(DashboardPublicLink(dashboard_id=dash.id, name="plain", token=plain, is_active=True, filters_config=[]))
    db.flush()
    return dash.id, plain


def _emb(client, dashboard_id, value):
    r = _resolve(client, dashboard_id, {"semanticField": STAGE, "datasetId": DATASET_ID, "operator": "in", "value": value})
    assert r.status_code == 200, r.text
    return r.json()["embed_path"].split("/embed/")[1]


def test_api_embed_lock_intersects_a_wider_page_scope(api_embed):
    """Page = {Won, Lead}, API lock = {Won}: the embed shows Won — the lock is
    not widened by the page, the page is not replaced by the lock."""
    client, dash_id, deal, db = api_embed
    from app.models.models import Dashboard
    owner = db.get(Dashboard, dash_id).owner_id
    page = [{"id": "page-1", "filters": [{"field": STAGE, "semanticField": STAGE, "datasetId": DATASET_ID,
                                           "operator": "in", "value": ["Won", "Lead"]}]}]
    d2, plain = _embed_dashboard(db, deal, owner, pages_config=page)
    page_only = _value(client.get(f"/api/v1/public/dashboards/{plain}/charts/{deal}/data"))
    assert page_only > 2500, "the page scope alone must be wider than Won, or this case proves nothing"
    token = _emb(client, d2, ["Won"])
    assert _value(client.get(f"/api/v1/public/dashboards/{token}/charts/{deal}/data")) == 2500


def test_api_embed_a_narrower_page_scope_still_narrows_a_wider_lock(api_embed):
    """Page = {Won}, API lock = {Won, Lead}: Won — the lock never overrides the page."""
    client, dash_id, deal, db = api_embed
    from app.models.models import Dashboard
    owner = db.get(Dashboard, dash_id).owner_id
    page = [{"id": "page-1", "filters": [{"field": STAGE, "semanticField": STAGE, "datasetId": DATASET_ID,
                                           "operator": "in", "value": ["Won"]}]}]
    d2, _plain = _embed_dashboard(db, deal, owner, pages_config=page)
    token = _emb(client, d2, ["Won", "Lead"])
    assert _value(client.get(f"/api/v1/public/dashboards/{token}/charts/{deal}/data")) == 2500


def test_api_embed_a_viewer_cannot_widen_or_replace_the_lock(api_embed):
    """A viewer filter on the locked field, spelled as the product's own controls
    spell it (bare field + semanticField), is REPLACED by the lock: Won stays Won
    — the same answer an equivalent Public Links lock gives. Any other spelling
    can only narrow, never widen. (On the embed the locked field has no control;
    these requests are crafted.)"""
    client, dash_id, deal, db = api_embed
    from app.models.models import Dashboard
    owner = db.get(Dashboard, dash_id).owner_id
    d2, _plain = _embed_dashboard(db, deal, owner)
    token = _emb(client, d2, ["Won"])
    url = f"/api/v1/public/dashboards/{token}/charts/{deal}/data"
    for viewer in (["Lead"], ["Won", "Lead"]):
        ui = json.dumps([{"field": "stage_name", "semanticField": STAGE, "datasetId": DATASET_ID,
                          "operator": "in", "value": viewer}])
        got = _value(client.get(url, params={"filters": ui}))
        assert got == 2500, f"a viewer filter {viewer} moved the locked embed off Won ({got})"
        crafted = json.dumps([{"field": STAGE, "semanticField": STAGE, "datasetId": DATASET_ID,
                               "operator": "in", "value": viewer}])
        resp = client.get(url, params={"filters": crafted})
        assert resp.status_code == 200, resp.text
        rows = resp.json()["data"]
        value = float(next(iter(rows[0].values())) or 0) if rows else 0.0
        assert value <= 2500, f"a crafted viewer filter {viewer} widened the locked embed ({value})"


def test_api_embed_the_dropdown_domain_of_the_locked_field_is_the_lock(api_embed):
    client, dash_id, deal, db = api_embed
    from app.models.models import Dashboard
    owner = db.get(Dashboard, dash_id).owner_id
    d2, plain = _embed_dashboard(db, deal, owner)
    dv = lambda tok, field: client.get(f"/api/v1/public/dashboards/{tok}/filters/distinct-values",
                                       params={"dataset_id": DATASET_ID, "field": field})
    vals = lambda r: sorted(str(v.get("value") if isinstance(v, dict) else v) for v in r.json()["values"])
    wide = dv(plain, STAGE)
    assert wide.status_code == 200 and len(vals(wide)) > 1, wide.text
    token = _emb(client, d2, ["Won"])
    # The LOCKED field has no viewer control on the embed, so it offers no domain
    # at all (the reader sees the lock as a read-only banner) — nothing wider leaks.
    assert dv(token, STAGE).status_code == 404
    # Another field's dropdown is bounded by the lock: only the subjects of
    # activities on Won deals — the truth read straight from the fixture's tables.
    truth = sorted(r[0] for r in db.execute(sa.text(
        "select distinct a.subject from bcfix.bc_activity a "
        "join bcfix.bc_deal d on d.migrate_deal_id = a.deal_id "
        "join bcfix.bc_dim_stage s on s.migrate_stage_id = d.stage_id where s.stage_name = 'Won'")))
    unlocked = vals(dv(plain, SUBJECT_B))
    locked = dv(token, SUBJECT_B)
    assert locked.status_code == 200, locked.text
    assert len(truth) < len(unlocked), "the lock must narrow this domain, or this case proves nothing"
    assert vals(locked) == truth, f"the locked embed's subject dropdown offers {vals(locked)}, expected {truth}"
