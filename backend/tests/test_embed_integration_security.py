"""API/M2M embed: who may mint an `emb_` grant, and what a grant's policy says.

Contract (docs/embed-integration-api.md):
  * POST /integrations/embed/resolve accepts a Personal Access Token ONLY — a
    logged-in browser session is refused;
  * the PAT must carry `dashboards: edit` (or full) and its owner must be able
    to EDIT the dashboard — the bar for creating a public link, since a minted
    URL is an unauthenticated capability for the report; `full_report=true`
    passes the same gate;
  * a grant lives only while its minting PAT is live (revoke the PAT → every
    link it issued stops);
  * the framing policy is an explicit STATE — unrestricted / restricted /
    invalid — never an empty list standing for "unknown", "expired" and
    "unrestricted" at once; origin matching is decided server-side by one
    canonical matcher;
  * report export is not part of the integration surface.

Everything goes through the real auth dependency (real PAT parsing, hashing,
scope caps and session JWTs) on in-memory SQLite.
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
from app.core.personal_access_tokens import (
    build_personal_access_token,
    create_personal_access_token_secret,
    hash_personal_access_token_secret,
)
from app.models.models import Chart, Dashboard, DashboardChart, DashboardPublicLink, EmbedGrant
from app.models.personal_access_token import PersonalAccessToken
from app.models.resource_share import ResourceShare
from app.models.revoked_token import RevokedToken
from app.models.team import Team, TeamMembership
from app.models.user import User, UserStatus


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


TABLES = [User.__table__, RevokedToken.__table__, Team.__table__, TeamMembership.__table__, PersonalAccessToken.__table__, ResourceShare.__table__, Chart.__table__,
          Dashboard.__table__, DashboardChart.__table__, DashboardPublicLink.__table__, EmbedGrant.__table__]

OWNER = uuid.UUID("aaaaaaaa-0000-0000-0000-000000000001")
STRANGER = uuid.UUID("bbbbbbbb-0000-0000-0000-000000000002")
FULL = {"dashboards": "full", "explore_charts": "full", "datasets": "full", "data_sources": "full", "workboards": "full"}
# An ordinary editor: may edit what they own or what is shared to them with edit.
EDITOR = {"dashboards": "edit", "explore_charts": "edit", "datasets": "view"}


def _utc_on_load(target, *_a):
    """SQLite drops tzinfo; Postgres (production) returns aware datetimes."""
    for attr in ("last_used_at", "expires_at", "revoked_at"):
        v = target.__dict__.get(attr)
        if isinstance(v, datetime) and v.tzinfo is None:
            target.__dict__[attr] = v.replace(tzinfo=timezone.utc)


@pytest.fixture()
def env(monkeypatch):
    from sqlalchemy import event

    from app.api import integrations, public
    from app.api.auth import create_access_token

    for ev in ("load", "refresh"):
        event.listen(PersonalAccessToken, ev, _utc_on_load)
        event.listen(EmbedGrant, ev, _utc_on_load)

    # Postgres-only `'{}'::jsonb` server defaults cannot be created on SQLite.
    saved = []
    for table in TABLES:
        for col in table.columns:
            sd = col.server_default
            if sd is not None and "::" in str(getattr(sd, "arg", "")):
                saved.append((col, sd))
                col.server_default = None
    engine = create_engine("sqlite://", future=True, connect_args={"check_same_thread": False}, poolclass=StaticPool)
    try:
        Base.metadata.create_all(engine, tables=TABLES)
    finally:
        for col, sd in saved:
            col.server_default = sd
    S = sessionmaker(bind=engine, future=True)

    def _db():
        s = S()
        try:
            yield s
        finally:
            s.close()

    monkeypatch.setattr(public._limiter, "enabled", False)
    monkeypatch.setattr(integrations._limiter, "enabled", False)

    app = FastAPI()
    app.state.limiter = public._limiter
    app.include_router(public.router)
    app.include_router(integrations.router)
    app.dependency_overrides[get_db] = _db

    with S() as s:
        for uid, email, perms in ((OWNER, "owner@example.com", FULL), (STRANGER, "stranger@example.com", EDITOR)):
            s.add(User(id=uid, email=email, full_name=email, password_hash="x",
                       status=UserStatus.ACTIVE, permissions=dict(perms), google_oauth_scopes=[]))
        s.add(Dashboard(id=1, name="Revenue", owner_id=OWNER))
        s.commit()
        owner = s.get(User, OWNER)
        session_jwt = create_access_token(owner)

    def make_pat(uid=OWNER, scopes=None, *, revoked=False, expired=False):
        tid = uuid.uuid4()
        secret = create_personal_access_token_secret()
        with S() as s:
            s.add(PersonalAccessToken(
                id=tid, owner_id=uid, name="integration", secret_hash=hash_personal_access_token_secret(secret),
                secret_suffix=secret[-6:], scopes=scopes if scopes is not None else {"dashboards": "edit"},
                revoked_at=datetime.now(timezone.utc) if revoked else None,
                expires_at=(datetime.now(timezone.utc) - timedelta(minutes=1)) if expired else None,
            ))
            s.commit()
        return tid, build_personal_access_token(tid, secret)

    yield TestClient(app), S, session_jwt, make_pat
    for ev in ("load", "refresh"):
        event.remove(PersonalAccessToken, ev, _utc_on_load)
        event.remove(EmbedGrant, ev, _utc_on_load)


def _mint(client, bearer, **body):
    payload = {"dashboard_id": 1, "full_report": True, **body}
    headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
    return client.post("/integrations/embed/resolve", json=payload, headers=headers)


def _grant_token(resp) -> str:
    assert resp.status_code == 200, resp.text
    return resp.json()["embed_path"].split("/embed/")[1]


# ── who may mint ─────────────────────────────────────────────────────────────

def test_no_credentials_cannot_mint(env):
    client, *_ = env
    assert _mint(client, None).status_code == 401


def test_a_browser_session_cannot_mint(env):
    client, _S, session_jwt, _ = env
    r = _mint(client, session_jwt)
    assert r.status_code == 403
    assert "Personal Access Token" in r.json()["detail"]


def test_a_browser_session_cookie_cannot_mint_either(env):
    client, _S, session_jwt, _ = env
    client.cookies.set("access_token", session_jwt)
    assert client.post("/integrations/embed/resolve", json={"dashboard_id": 1, "full_report": True}).status_code == 403


def test_a_view_scoped_pat_cannot_mint_even_for_its_owners_dashboard(env):
    client, _S, _jwt, make_pat = env
    _tid, pat = make_pat(scopes={"dashboards": "view"})
    assert _mint(client, pat).status_code == 403


def test_a_pat_without_a_dashboards_scope_cannot_mint(env):
    client, _S, _jwt, make_pat = env
    _tid, pat = make_pat(scopes={"datasets": "full"})
    assert _mint(client, pat).status_code == 403


def test_a_pat_whose_owner_cannot_edit_the_dashboard_cannot_mint(env):
    client, S, _jwt, make_pat = env
    _tid, pat = make_pat(uid=STRANGER, scopes={"dashboards": "edit"})
    assert _mint(client, pat).status_code == 403  # no relation at all
    with S() as s:
        s.add(ResourceShare(resource_type="dashboard", resource_id="1", user_id=STRANGER,
                            permission="view", shared_by=OWNER))
        s.commit()
    assert _mint(client, pat).status_code == 403  # view share is not enough
    with S() as s:
        s.query(ResourceShare).one().permission = "edit"
        s.commit()
    assert _mint(client, pat).status_code == 200  # an edit share is the bar


def test_a_revoked_or_expired_pat_cannot_mint(env):
    client, _S, _jwt, make_pat = env
    assert _mint(client, make_pat(revoked=True)[1]).status_code == 401
    assert _mint(client, make_pat(expired=True)[1]).status_code == 401


def test_an_edit_scoped_pat_of_an_editor_mints_and_the_grant_records_its_pat(env):
    client, S, _jwt, make_pat = env
    tid, pat = make_pat(scopes={"dashboards": "edit"})
    token = _grant_token(_mint(client, pat))
    assert token.startswith("emb_")
    with S() as s:
        grant = s.query(EmbedGrant).one()
        assert grant.personal_access_token_id == tid
    assert client.get(f"/public/dashboards/{token}/snapshots/info").status_code == 200


def test_full_report_without_filters_still_needs_the_explicit_flag(env):
    client, _S, _jwt, make_pat = env
    _tid, pat = make_pat()
    assert _mint(client, pat, full_report=False).status_code == 400


# ── grant lifecycle ──────────────────────────────────────────────────────────

def test_revoking_the_pat_ends_every_grant_it_minted(env):
    client, S, _jwt, make_pat = env
    tid, pat = make_pat()
    token = _grant_token(_mint(client, pat))
    assert client.get(f"/public/dashboards/{token}/snapshots/info").status_code == 200
    with S() as s:
        s.get(PersonalAccessToken, tid).revoked_at = datetime.now(timezone.utc)
        s.commit()
    assert client.get(f"/public/dashboards/{token}/snapshots/info").status_code == 410
    assert client.get(f"/public/embed/{token}/policy").json()["state"] == "invalid"


def test_a_grant_without_a_recorded_pat_is_refused(env):
    client, S, _jwt, make_pat = env
    _tid, pat = make_pat()
    token = _grant_token(_mint(client, pat))
    with S() as s:
        s.query(EmbedGrant).one().personal_access_token_id = None  # pre-migration grant
        s.commit()
    assert client.get(f"/public/dashboards/{token}/snapshots/info").status_code == 410


# ── framing policy ───────────────────────────────────────────────────────────

def _policy(client, token, origin=None):
    q = {"origin": origin} if origin else {}
    r = client.get(f"/public/embed/{token}/policy", params=q)
    assert r.status_code == 200, r.text
    return r.json()


def test_policy_states_are_explicit(env):
    client, S, _jwt, make_pat = env
    _tid, pat = make_pat()
    assert _policy(client, "emb_" + "0" * 64)["state"] == "invalid"            # unknown
    assert _policy(client, "a-stable-public-token")["state"] == "unrestricted"  # stable link
    open_token = _grant_token(_mint(client, pat))
    assert _policy(client, open_token)["state"] == "unrestricted"
    with S() as s:
        g = s.query(EmbedGrant).one()
        g.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        s.commit()
    assert _policy(client, open_token)["state"] == "invalid"                    # expired
    restricted = _grant_token(_mint(client, pat, allowed_origins=["https://app.base.vn"]))
    with S() as s:
        s.query(EmbedGrant).filter(EmbedGrant.expires_at > datetime.now(timezone.utc)).one().revoked_at = datetime.now(timezone.utc)
        s.commit()
    assert _policy(client, restricted)["state"] == "invalid"                    # revoked


@pytest.mark.parametrize("origin, allowed", [
    ("https://app.base.vn", True),
    ("https://reports.base.vn", True),          # *.base.vn
    ("https://deep.reports.base.vn", True),
    ("https://base.vn", False),                 # wildcard covers subdomains, not the parent
    ("https://evil-base.vn", False),            # label boundary
    ("https://base.vn.evil.com", False),
    ("http://app.base.vn", False),              # scheme
    ("https://app.base.vn:8443", False),        # port
    ("https://app.base.vn:443", True),          # default port
    ("http://localhost:3000", True),            # exact with port
    ("http://localhost:3001", False),
    ("not an origin", False),
])
def test_origin_matching_is_decided_by_the_one_canonical_matcher(env, origin, allowed):
    client, _S, _jwt, make_pat = env
    _tid, pat = make_pat()
    token = _grant_token(_mint(client, pat, allowed_origins=["https://app.base.vn", "https://*.base.vn", "http://localhost:3000"]))
    p = _policy(client, token, origin)
    assert p["state"] == "restricted"
    assert p["origin_allowed"] is allowed, (origin, p)


@pytest.mark.parametrize("bad", ["*", "app.base.vn", "ftp://x.y", "https://*", "https://a.*.b", "https://x.y/path"])
def test_an_invalid_declared_origin_is_refused_at_mint(env, bad):
    client, _S, _jwt, make_pat = env
    _tid, pat = make_pat()
    assert _mint(client, pat, allowed_origins=[bad]).status_code == 400


# ── capability boundary ──────────────────────────────────────────────────────

def test_report_export_is_not_part_of_the_integration_surface(env):
    client, _S, _jwt, make_pat = env
    _tid, pat = make_pat()
    token = _grant_token(_mint(client, pat))
    assert client.get(f"/public/dashboards/{token}/exports/capabilities").status_code == 403
    assert client.post(f"/public/dashboards/{token}/exports", json={}).status_code in (403, 503)
    assert client.post(f"/public/dashboards/{token}/exports/pptx", json={"slides": []}).status_code in (403, 422)
