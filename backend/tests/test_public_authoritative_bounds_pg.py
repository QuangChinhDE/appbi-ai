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
