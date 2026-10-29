"""POST /dashboards/import-html/build: draft_only, idempotency_key, strict_fields.

The build is how an HTML report becomes a native dashboard (the wizard, and the
MCP's execute_plan). Before these fields it created LIVE tiles at once, a
retried request created "Name (2)", and a plan whose fields did not exist only
logged a warning. Opt-in, each one; a call without them is unchanged.

Through the real application on Postgres (the row-locked publish, the unique
index, the advisory lock). Each test runs in its own rolled-back transaction.
What is stubbed is unrelated to the contract under test: the semantic binding a
chart gets (it needs a live datasource) and the best-effort model generation.
Fails, never skips, without Postgres.
"""
from __future__ import annotations

import json
import os
import uuid

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

COLUMNS = [{"name": "region", "type": "string"}, {"name": "revenue", "type": "number"}]
SLICERS = [{"id": "s-region", "field": "region", "type": "dropdown", "operator": "in", "value": []}]


def _analysis(*, metric_field: str = "revenue") -> dict:
    return {
        "suggested_dashboard_name": "Import draft " + uuid.uuid4().hex[:8],
        "chart_plans": [{
            "block_id": "b1",
            "title": "Revenue by region",
            "final_chart_type": "BAR",
            "source_key": "orders",
            "role_config": {"dimension": "region", "metrics": [{"field": metric_field, "agg": "sum"}]},
            "layout": {"x": 0, "y": 0, "w": 12, "h": 8},
        }],
        "widgets": [{"widget_type": "text", "title": "Intro", "widget_config": {"text": "hello"},
                     "layout": {"x": 0, "y": 8, "w": 12, "h": 3}}],
        "slicers": list(SLICERS),
        "theme_config": {"preset": "modern"},
    }


@pytest.fixture()
def ctx():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_dashboard_import_draft_build_pg needs Postgres (DATABASE_URL).")
    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.core.dependencies import get_current_user
    from app.main import app
    from app.models.dataset import Dataset, DatasetTable
    from app.models.user import User, UserStatus
    from app.services import chart_sql_authority, dashboard_html_import_service as svc
    from app.services import dataset_model_service

    mp = pytest.MonkeyPatch()
    mp.setattr(svc, "with_chart_semantic_binding", lambda _db, _tid, config, **_k: config)
    mp.setattr(chart_sql_authority, "require_custom_sql_authority", lambda *a, **k: None)
    mp.setattr(dataset_model_service, "generate_dataset_model", lambda *a, **k: None)

    engine = sa.create_engine(url)
    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    users = []
    for name in ("alice", "bob"):
        u = User(id=uuid.uuid4(), email=f"imp-{name}-{uuid.uuid4().hex[:8]}@x", full_name=name, password_hash="x",
                 status=UserStatus.ACTIVE, permissions={"dashboards": "full", "datasets": "full"},
                 google_oauth_scopes=[])
        db.add(u)
        users.append(u)
    db.flush()
    ds = Dataset(name="imp ds " + uuid.uuid4().hex[:8], owner_id=users[0].id)
    db.add(ds)
    db.flush()
    db.add(DatasetTable(dataset_id=ds.id, display_name="orders", source_kind="physical_table",
                        source_table_name="public.orders", columns_cache={"columns": COLUMNS}))
    db.flush()
    who = {"user": users[0]}
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: who["user"]
    try:
        yield TestClient(app), db, ds.id, users, who
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        mp.undo()
        db.close()
        outer.rollback()
        conn.close()
        engine.dispose()


def _build(client, dataset_id, analysis=None, **extra):
    data = {
        "analysis_json": json.dumps(analysis or _analysis()),
        "source_mode": "existing_dataset",
        "target_mode": "new_dashboard",
        "dataset_id": str(dataset_id),
    }
    data.update({k: (str(v).lower() if isinstance(v, bool) else str(v)) for k, v in extra.items()})
    return client.post("/api/v1/dashboards/import-html/build", data=data)


def _rows(db, dashboard_id):
    from app.models.models import DashboardChart
    db.expire_all()
    return db.query(DashboardChart).filter(DashboardChart.dashboard_id == dashboard_id).order_by(DashboardChart.id).all()


def _public(client, db, dashboard_id):
    from app.models.models import DashboardPublicLink
    token = "imp-" + uuid.uuid4().hex[:12]
    db.add(DashboardPublicLink(dashboard_id=dashboard_id, name="pub", token=token, is_active=True, filters_config=[]))
    db.flush()
    r = client.get(f"/api/v1/public/dashboards/{token}")
    assert r.status_code == 200, r.text
    return r.json()


def test_legacy_build_without_new_fields_is_live_as_before(ctx):
    client, db, ds_id, users, _who = ctx
    r = _build(client, ds_id)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["draft_only"] is False and body["idempotent_replay"] is False
    rows = _rows(db, body["dashboard_id"])
    kinds = sorted(row.widget_type for row in rows)
    assert kinds == ["chart", "slicer", "text"], kinds
    assert not any((row.layout or {}).get("draftOnly") for row in rows), "a legacy build made drafts"
    from app.models.models import Dashboard
    dash = db.get(Dashboard, body["dashboard_id"])
    assert dash.slicers_config == SLICERS and dash.import_idempotency_key is None
    assert not (dash.draft_snapshot or {}), dash.draft_snapshot
    assert len(_public(client, db, body["dashboard_id"])["dashboard_charts"]) == 3
    # Not idempotent without a key: a second identical call is a second dashboard.
    again = _build(client, ds_id, analysis=json.loads(json.dumps(_analysis())))
    assert again.status_code == 201 and again.json()["dashboard_id"] != body["dashboard_id"]


def test_draft_only_build_is_the_callers_draft_until_publish(ctx):
    client, db, ds_id, users, who = ctx
    r = _build(client, ds_id, draft_only=True)
    assert r.status_code == 201, r.text
    did = r.json()["dashboard_id"]
    assert r.json()["draft_only"] is True
    rows = _rows(db, did)
    assert sorted(row.widget_type for row in rows) == ["chart", "slicer", "text"]
    for row in rows:
        assert row.layout.get("draftOnly") is True and row.layout.get("draftOwner") == str(users[0].id), row.layout

    from app.models.models import Dashboard
    dash = db.get(Dashboard, did)
    # Filters and theme are in the shared draft, not live.
    assert dash.slicers_config == [] and dash.draft_snapshot["slicers_config"] == SLICERS
    assert dash.draft_snapshot["theme_config"].get("preset") == "modern"
    assert not (dash.theme_config or {}).get("preset")

    # Published view: nothing yet.
    pub = _public(client, db, did)
    assert pub["dashboard_charts"] == [] and not pub.get("slicers_config"), pub
    # Another editor sees only the author's unpublished draft, and cannot
    # publish it: their publish leaves every tile a draft and the shared
    # draft pending (without acknowledging it, their publish is refused).
    who["user"] = users[1]
    theirs = client.get(f"/api/v1/dashboards/{did}")
    if theirs.status_code == 200:
        for dc in theirs.json()["dashboard_charts"]:
            assert dc["layout"].get("draftOnly") is True and dc["layout"].get("draftOwner") == str(users[0].id)
        refused = client.post(f"/api/v1/dashboards/{did}/publish", json={})
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "shared_draft_other_authors"
        assert client.post(f"/api/v1/dashboards/{did}/publish", json={"keep_shared": True}).status_code == 200
        assert all(row.layout.get("draftOnly") for row in _rows(db, did)), "another editor published the author's draft"
        assert _public(client, db, did)["dashboard_charts"] == []
    else:
        assert theirs.status_code in (403, 404), theirs.text
    who["user"] = users[0]
    # The author's editor sees the draft overlay.
    mine = client.get(f"/api/v1/dashboards/{did}").json()
    assert mine["has_draft"] is True and mine["slicers_config"] == SLICERS

    # A normal publish (the shared revision the author was shown) makes it live.
    rev = mine["shared_draft"]["rev"]
    tile_base_v = {str(dc["id"]): int((dc.get("layout") or {}).get("_v") or 0) for dc in mine["dashboard_charts"]}
    pr = client.post(f"/api/v1/dashboards/{did}/publish", json={"tile_base_v": tile_base_v, "shared_ack_rev": rev})
    assert pr.status_code == 200, pr.text
    rows = _rows(db, did)
    assert not any((row.layout or {}).get("draftOnly") for row in rows)
    db.expire_all()
    dash = db.get(Dashboard, did)
    assert dash.slicers_config == SLICERS and (dash.theme_config or {}).get("preset") == "modern"
    pub = _public(client, db, did)
    assert len(pub["dashboard_charts"]) == 3 and pub["slicers_config"] == SLICERS


def test_discard_of_a_draft_only_build_removes_what_it_created(ctx):
    client, db, ds_id, users, _who = ctx
    did = _build(client, ds_id, draft_only=True).json()["dashboard_id"]
    r = client.post(f"/api/v1/dashboards/{did}/discard-draft", json={})
    assert r.status_code == 200, r.text
    assert _rows(db, did) == []
    from app.models.models import Dashboard
    db.expire_all()
    assert db.get(Dashboard, did).draft_snapshot is None


def test_draft_only_refuses_append_to_an_existing_dashboard(ctx):
    client, db, ds_id, users, _who = ctx
    target = _build(client, ds_id).json()["dashboard_id"]
    before = len(_rows(db, target))
    for extra in ({"draft_only": True}, {"idempotency_key": "k-append"}):
        r = _build(client, ds_id, **{"target_mode": "append_to_dashboard", "target_dashboard_id": target, **extra})
        assert r.status_code == 400, r.text
        assert "new_dashboard" in r.json()["detail"]
    assert len(_rows(db, target)) == before, "a refused append still wrote tiles"


def test_same_idempotency_key_returns_the_first_build_and_creates_nothing(ctx):
    client, db, ds_id, users, who = ctx
    from app.models.models import Chart, Dashboard
    key = "mcp-run-" + uuid.uuid4().hex[:8]
    analysis = _analysis()
    first = _build(client, ds_id, analysis=analysis, idempotency_key=key, draft_only=True)
    assert first.status_code == 201, first.text
    did = first.json()["dashboard_id"]
    counts = (db.query(Dashboard).count(), db.query(Chart).count(), len(_rows(db, did)))
    again = _build(client, ds_id, analysis=analysis, idempotency_key=key, draft_only=True)
    assert again.status_code == 201, again.text
    body = again.json()
    assert body["dashboard_id"] == did and body["idempotent_replay"] is True and body["draft_only"] is True
    assert body["created_chart_count"] == 1
    db.expire_all()
    assert (db.query(Dashboard).count(), db.query(Chart).count(), len(_rows(db, did))) == counts, "a replay created objects"
    # Keys are per user: another user's same key is their own build.
    who["user"] = users[1]
    other = _build(client, ds_id, analysis=_analysis(), idempotency_key=key)
    who["user"] = users[0]
    assert other.status_code == 201 and other.json()["dashboard_id"] != did
    # A malformed key is refused before anything runs.
    assert _build(client, ds_id, idempotency_key="bad key with spaces").status_code == 400


def test_strict_fields_refuses_an_unknown_field_and_creates_nothing(ctx):
    client, db, ds_id, users, _who = ctx
    from app.models.models import Chart, Dashboard
    before = (db.query(Dashboard).count(), db.query(Chart).count())
    r = _build(client, ds_id, analysis=_analysis(metric_field="no_such_column"), strict_fields=True)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["reason"] == "unresolved_fields"
    assert detail["unresolved"] == [{"block_id": "b1", "source_key": "orders", "fields": ["no_such_column"],
                                     "reason": "unknown_fields"}]
    db.expire_all()
    assert (db.query(Dashboard).count(), db.query(Chart).count()) == before
    # Without strict_fields the same plan builds (today's warning behaviour).
    assert _build(client, ds_id, analysis=_analysis(metric_field="no_such_column")).status_code == 201
    # strict_fields with resolvable fields builds.
    assert _build(client, ds_id, strict_fields=True).status_code == 201


def test_strict_fields_refuses_an_unknown_source_key(ctx):
    client, db, ds_id, users, _who = ctx
    analysis = _analysis()
    analysis["chart_plans"][0]["source_key"] = "not_a_table"
    r = _build(client, ds_id, analysis=analysis, strict_fields=True)
    assert r.status_code == 422 and r.json()["detail"]["unresolved"][0]["reason"] == "unknown_source", r.text


def test_a_v1_plan_written_for_another_schema_is_refused_with_409(ctx):
    """The declared-plan path: a source_contract whose schema_fingerprint and
    columns do not match the dataset stops at analysis (409 on the route)."""
    from app.services.dashboard_html_import_service import SourceContractMismatch, _analyze_from_v1_metadata
    embedded = {
        "version": "appbi-import/v1",
        "source_contract": {"schema_fingerprint": "sha256:not-this-dataset", "expected_source_keys": ["orders"],
                            "expected_columns": {"orders": ["region", "gone_column"]}},
        "charts": [{"block_id": "b1", "chart_type": "BAR", "source_key": "orders",
                    "role_config": {"dimension": "region", "metrics": [{"field": "revenue", "agg": "sum"}]}}],
    }
    profile = {"source_key": "orders", "display_name": "orders", "columns": COLUMNS}
    with pytest.raises(SourceContractMismatch) as exc:
        _analyze_from_v1_metadata(embedded=embedded, document_summary={"blocks": []}, source_profile=profile,
                                  all_source_profiles={"orders": profile})
    assert any("gone_column" in f for f in exc.value.findings), exc.value.findings


def test_the_build_route_maps_a_source_contract_mismatch_to_409(ctx, monkeypatch):
    client, db, ds_id, users, _who = ctx
    from app.api import dashboards as api
    from app.services.dashboard_html_import_service import SourceContractMismatch

    def _raise(*_a, **_k):
        raise SourceContractMismatch(["Table 'orders' no longer has 'gone_column'."])

    monkeypatch.setattr(api, "build_dashboard_from_html_import_service", _raise)
    r = _build(client, ds_id)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["reason"] == "source_contract_mismatch"
