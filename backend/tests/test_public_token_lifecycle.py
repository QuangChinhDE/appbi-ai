"""Public token lifecycle, asserted at the HTTP boundary.

One authority for a stable public token — an ACTIVE DashboardPublicLink — and
deterministic revocation:

  * a revoked (disabled / deleted) link's token fails at once on every public
    route, and there is no legacy `Dashboard.share_token` fallback to fall
    through to (the copy migration 0019 left behind is what let a revoked
    link keep serving);
  * the legacy /share endpoints refuse instead of minting a second authority;
  * a managed embed link's own token is never a public URL;
  * expiry is enforced and settable;
  * a password session is bound to the link AND its security generation:
    changing / clearing the password, disabling, re-enabling or changing the
    expiry invalidates every session minted before.

Runs the real routers against in-memory SQLite; only the permission checks of
the authoring API are stubbed (they have their own suites).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

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
    id = uuid.UUID("aaaaaaaa-0000-0000-0000-000000000000")
    email = "owner@example.com"
    full_name = "Owner"
    permissions = {"dashboards": "full"}
    is_active = True


@pytest.fixture()
def env(monkeypatch):
    from app.api import dashboards as dash_api
    from app.api import public as public_api
    from app.core.dependencies import get_current_user

    engine = create_engine(
        "sqlite://", future=True, connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(
        engine,
        tables=[Chart.__table__, Dashboard.__table__, DashboardChart.__table__,
                DashboardPublicLink.__table__, EmbedGrant.__table__],
    )
    SessionLocal = sessionmaker(bind=engine, future=True)

    def _db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    monkeypatch.setattr(dash_api, "require_edit_access", lambda *a, **k: None)
    monkeypatch.setattr(dash_api, "require_view_access", lambda *a, **k: "full")
    # Rate limits are per-process state; a suite must not throttle itself.
    monkeypatch.setattr(public_api._limiter, "enabled", False)

    app = FastAPI()
    app.state.limiter = public_api._limiter
    app.include_router(public_api.router)
    app.include_router(dash_api.router)
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: _User()

    with SessionLocal() as s:
        s.add(Dashboard(id=1, name="Revenue"))
        s.commit()
    return TestClient(app), SessionLocal


def _status(client, token, session=None):
    headers = {"X-Public-Session": session} if session else {}
    return client.get(f"/public/dashboards/{token}/snapshots/info", headers=headers).status_code


def _create(client, **body):
    r = client.post("/dashboards/1/public-links", json={"name": "Customers", **body})
    assert r.status_code == 201, r.text
    return r.json()


# ── one authority ────────────────────────────────────────────────────────────

def test_a_disabled_link_is_refused_and_does_not_fall_back_to_a_legacy_copy(env):
    client, S = env
    link = _create(client)
    # The exact shape migration 0019 left behind: the same token on the legacy column.
    with S() as s:
        s.get(Dashboard, 1).share_token = link["token"]
        s.commit()
    assert _status(client, link["token"]) == 200

    r = client.patch(f"/dashboards/1/public-links/{link['id']}", json={"is_active": False})
    assert r.status_code == 200
    assert _status(client, link["token"]) == 404


def test_a_deleted_link_is_refused_and_does_not_fall_back_to_a_legacy_copy(env):
    client, S = env
    link = _create(client)
    with S() as s:
        s.get(Dashboard, 1).share_token = link["token"]
        s.commit()
    assert client.delete(f"/dashboards/1/public-links/{link['id']}").status_code == 200
    for path in ("", "/snapshots/info", "/filters/distinct-values?dataset_id=1&field=x"):
        assert client.get(f"/public/dashboards/{link['token']}{path}").status_code == 404, path


def test_a_bare_legacy_share_token_is_not_a_public_credential(env):
    client, S = env
    with S() as s:
        s.get(Dashboard, 1).share_token = "legacy-only-token"
        s.commit()
    assert _status(client, "legacy-only-token") == 404


def test_the_legacy_share_endpoints_refuse_instead_of_minting_a_second_authority(env):
    client, S = env
    assert client.post("/dashboards/1/share", json={}).status_code == 410
    assert client.delete("/dashboards/1/share").status_code == 410
    with S() as s:
        assert s.get(Dashboard, 1).share_token is None


def test_a_managed_embed_links_own_token_is_not_a_public_url(env):
    client, S = env
    with S() as s:
        s.add(DashboardPublicLink(id=50, dashboard_id=1, name="embed:1:abc", token="managed-embed-token",
                                  filters_config=[], is_active=True, source="embed_api"))
        s.commit()
    assert _status(client, "managed-embed-token") == 404
    assert client.post("/public/dashboards/managed-embed-token/auth", json={"password": "x"}).status_code == 404


# ── expiry ───────────────────────────────────────────────────────────────────

def test_expiry_is_settable_and_enforced(env):
    client, S = env
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    link = _create(client, expires_at=future)
    assert link["expires_at"] is not None
    assert _status(client, link["token"]) == 200
    assert client.patch(f"/dashboards/1/public-links/{link['id']}", json={"expires_at": past}).status_code == 200
    assert _status(client, link["token"]) == 410
    # null = never expires; omitting the field leaves it alone
    assert client.patch(f"/dashboards/1/public-links/{link['id']}", json={"expires_at": None}).status_code == 200
    assert _status(client, link["token"]) == 200
    assert client.patch(f"/dashboards/1/public-links/{link['id']}", json={"name": "Renamed"}).json()["expires_at"] is None


# ── password sessions ────────────────────────────────────────────────────────

def _login(client, token, password):
    r = client.post(f"/public/dashboards/{token}/auth", json={"password": password})
    assert r.status_code == 200, r.text
    return r.json()["session_token"]


def test_a_password_link_needs_a_session_and_a_wrong_password_gets_none(env):
    client, _ = env
    link = _create(client, password="s3cret")
    assert _status(client, link["token"]) == 401
    assert client.post(f"/public/dashboards/{link['token']}/auth", json={"password": "nope"}).status_code == 403
    assert _status(client, link["token"], "not-a-jwt") == 401
    assert _status(client, link["token"], _login(client, link["token"], "s3cret")) == 200


def test_changing_the_password_invalidates_existing_sessions(env):
    client, _ = env
    link = _create(client, password="old-pass")
    old = _login(client, link["token"], "old-pass")
    client.patch(f"/dashboards/1/public-links/{link['id']}", json={"password": "new-pass"})
    assert _status(client, link["token"], old) == 401
    assert _status(client, link["token"], _login(client, link["token"], "new-pass")) == 200


def test_clearing_then_restoring_a_password_does_not_revive_old_sessions(env):
    client, _ = env
    link = _create(client, password="p1")
    old = _login(client, link["token"], "p1")
    client.patch(f"/dashboards/1/public-links/{link['id']}", json={"password": ""})
    assert _status(client, link["token"]) == 200  # open link now
    client.patch(f"/dashboards/1/public-links/{link['id']}", json={"password": "p1"})
    assert _status(client, link["token"], old) == 401


def test_disable_then_reenable_does_not_resurrect_a_session(env):
    client, _ = env
    link = _create(client, password="p1")
    old = _login(client, link["token"], "p1")
    client.patch(f"/dashboards/1/public-links/{link['id']}", json={"is_active": False})
    assert _status(client, link["token"], old) == 404
    client.patch(f"/dashboards/1/public-links/{link['id']}", json={"is_active": True})
    assert _status(client, link["token"], old) == 401


def test_a_session_is_bound_to_its_link(env):
    client, _ = env
    a = _create(client, password="same")
    b = _create(client, password="same")
    sess_a = _login(client, a["token"], "same")
    assert _status(client, b["token"], sess_a) == 401


def test_a_non_security_edit_keeps_sessions(env):
    client, _ = env
    link = _create(client, password="p1")
    sess = _login(client, link["token"], "p1")
    client.patch(f"/dashboards/1/public-links/{link['id']}", json={"name": "Renamed", "is_active": True})
    assert _status(client, link["token"], sess) == 200


# ── configurator preview ─────────────────────────────────────────────────────

def test_a_preview_is_a_real_short_lived_link_that_is_never_listed(env):
    client, S = env
    r = client.post("/dashboards/1/public-links/preview",
                    json={"filters_config": [], "appearance_config": {"show_page_tabs": False, "ai_bot_enabled": True,
                                                                       "ai_bot_key": "sk-secret"}})
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    assert _status(client, token) == 200
    assert client.get("/dashboards/1/public-links").json() == []
    with S() as s:
        link = s.query(DashboardPublicLink).filter_by(token=token).one()
        assert link.source == "preview" and link.expires_at is not None
        assert link.appearance_config.get("ai_bot_enabled") is False
        assert "ai_bot_key" not in link.appearance_config
        link.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        s.commit()
    assert _status(client, token) == 410


def test_a_new_preview_replaces_the_authors_previous_one(env):
    client, S = env
    first = client.post("/dashboards/1/public-links/preview", json={}).json()["token"]
    second = client.post("/dashboards/1/public-links/preview", json={}).json()["token"]
    assert _status(client, first) == 404
    assert _status(client, second) == 200
    with S() as s:
        assert s.query(DashboardPublicLink).filter_by(source="preview").count() == 1


def test_a_preview_refuses_a_filter_the_engine_cannot_apply(env):
    client, _ = env
    bad = [{"field": "amount", "label": "Amount", "operator": "between", "value": 5, "locked": True}]
    assert client.post("/dashboards/1/public-links/preview", json={"filters_config": bad}).status_code == 422
