"""Token domains never cross (HTTP, Postgres). Authz review H12 + Q7.

Every token class is minted by the product's own function and presented to
every staff-authentication path:
* ``GET /auth/me`` (get_current_user);
* an internal-mode workspace's staff bearer path;
* ``POST /auth/refresh``.
Only an access token authenticates staff; only a refresh token refreshes.
Legacy tokens signed with the raw SECRET_KEY (typed or untyped) verify nowhere.
The security stamp ends sessions on password change and deactivation.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from jose import jwt

from tests.authz_http import client, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg


@pytest.fixture()
def staff(db):  # noqa: F811
    from app.models.user import User

    p = make_user(db, "tok-staff", workboards="edit", datasets="edit")
    return p, db.get(User, p.id)


@pytest.fixture()
def tokens_for(db, staff):  # noqa: F811
    from app.api import auth as auth_api
    from app.api.public import _create_public_session
    from app.core.config import settings
    from app.modules.workboards.models import WorkboardWorkspace
    from app.modules.workboards.services import app_user_service
    from app.services.google_data_access_service import build_google_data_access_state

    _, user = staff
    ws = WorkboardWorkspace(name="T", token=uuid.uuid4().hex, access_mode="internal",
                            menu_config=[], owner_id=user.id, is_active=True)
    db.add(ws)
    db.commit()

    class _Link:
        token, id, auth_version = "lnk", 1, 0

    now = datetime.now(timezone.utc)
    legacy = {"sub": str(user.id), "jti": str(uuid.uuid4()), "exp": now + timedelta(hours=1)}
    out = {
        "access": auth_api.create_access_token(user),
        "refresh": auth_api.create_refresh_token(user),
        "oauth_state": build_google_data_access_state(user=user, return_to="/", popup=False),
        "public_session": _create_public_session(_Link()),
        "workspace_session": app_user_service.create_internal_session_token(ws, appbi_user=user)[0],
        "legacy_untyped_raw_key": jwt.encode(legacy, settings.SECRET_KEY, algorithm="HS256"),
        "legacy_typed_raw_key": jwt.encode({**legacy, "type": "access"}, settings.SECRET_KEY, algorithm="HS256"),
    }
    return out, ws


NON_ACCESS = ["refresh", "oauth_state", "public_session", "workspace_session",
              "legacy_untyped_raw_key", "legacy_typed_raw_key"]


@pytest.mark.parametrize("kind", NON_ACCESS)
def test_only_access_tokens_authenticate_staff(client, tokens_for, kind):  # noqa: F811
    toks, _ = tokens_for
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {toks[kind]}"}).status_code == 401
    assert client.get("/api/v1/auth/me", cookies={"access_token": toks[kind]}).status_code == 401


def test_access_token_authenticates_positive_control(client, tokens_for):  # noqa: F811
    toks, _ = tokens_for
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {toks['access']}"}).status_code == 200


@pytest.mark.parametrize("kind", NON_ACCESS)
def test_only_access_tokens_are_workspace_staff_bearers(client, tokens_for, kind):  # noqa: F811
    toks, ws = tokens_for
    r = client.get(f"/api/v1/public/workspaces/{ws.token}/menu",
                   headers={"Authorization": f"Bearer {toks[kind]}"})
    # the workspace_session kind is presented as a BEARER here, not its cookie
    assert r.status_code == 401, (kind, r.status_code)


@pytest.mark.parametrize("kind", ["access", "oauth_state", "public_session", "legacy_untyped_raw_key"])
def test_only_refresh_tokens_refresh(client, tokens_for, kind):  # noqa: F811
    toks, _ = tokens_for
    client.cookies.clear()
    assert client.post("/api/v1/auth/refresh", cookies={"refresh_token": toks[kind]}).status_code == 401


def test_refresh_token_refreshes_positive_control(client, tokens_for):  # noqa: F811
    toks, _ = tokens_for
    client.cookies.clear()
    assert client.post("/api/v1/auth/refresh", cookies={"refresh_token": toks["refresh"]}).status_code == 200


def test_access_token_is_not_an_oauth_state(tokens_for):
    from fastapi import HTTPException

    from app.services.google_data_access_service import decode_google_data_access_state

    toks, _ = tokens_for
    with pytest.raises(HTTPException):
        decode_google_data_access_state(toks["access"])
    assert decode_google_data_access_state(toks["oauth_state"])["purpose"] == "google_data_access"


def test_password_change_ends_other_sessions(client, db, staff):  # noqa: F811
    from passlib.context import CryptContext

    from app.api.auth import create_access_token
    from app.models.user import User

    p, user = staff
    user.password_hash = CryptContext(schemes=["bcrypt"]).hash("Old-Passw0rd!")
    db.commit()
    other_session = {"Authorization": f"Bearer {create_access_token(db.get(User, p.id))}"}
    client.cookies.clear()
    r = client.post("/api/v1/auth/change-password", headers=p.headers,
                    json={"old_password": "Old-Passw0rd!", "new_password": "New-Passw0rd!2"})
    assert r.status_code == 200, r.text
    assert client.get("/api/v1/auth/me", headers=other_session).status_code == 401
    # the session that changed it continues on its fresh cookie
    fresh = r.cookies.get("access_token")
    assert fresh and client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {fresh}"}).status_code == 200


def test_deactivation_ends_sessions(client, db, staff):  # noqa: F811
    p, _ = staff
    admin = make_user(db, "tok-admin", settings="full")
    assert client.get("/api/v1/auth/me", headers=p.headers).status_code == 200
    assert client.delete(f"/api/v1/users/{p.id}", headers=admin.headers).status_code == 204
    assert client.get("/api/v1/auth/me", headers=p.headers).status_code == 401
