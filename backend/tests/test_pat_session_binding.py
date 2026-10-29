"""Session-bound personal access tokens (spec W1 / F2) — HTTP, Postgres.

A PAT minted with ``bind_to_session: true`` (the Claude MCP connect page does
this) must stop working when its owner's ``security_stamp`` rotates: a password
change, an admin status change, a deactivation. A legacy/unbound PAT keeps its
historical behaviour and survives a password change.

Every case mints a REAL token through ``POST /auth/personal-access-tokens/`` and
drives the real change-password / users routes.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import Principal, client, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg

PAT_URL = "/api/v1/auth/personal-access-tokens/"
PROBE = "/api/v1/datasets/"
PASSWORD = "Old-passw0rd!x"


def _with_password(db, p: Principal) -> Principal:  # noqa: F811
    from app.api.auth import _pwd
    from app.models.user import User

    u = db.get(User, p.id)
    u.password_hash = _pwd.hash(PASSWORD)
    db.commit()
    return p


def _fresh_session(db, p: Principal) -> Principal:  # noqa: F811
    """A new browser session for the user's CURRENT stamp."""
    from app.api.auth import create_access_token
    from app.models.user import User

    db.expire_all()
    u = db.get(User, p.id)
    return Principal(u, create_access_token(u))


def _mint(client, human, bind):  # noqa: F811
    body = {"name": f"t-{uuid.uuid4().hex[:6]}", "scopes": {"datasets": "view"}, "expires_in_days": 30}
    if bind is not None:
        body["bind_to_session"] = bind
    r = client.post(PAT_URL, headers=human.headers, json=body)
    assert r.status_code == 201, r.text
    out = r.json()
    return {"Authorization": f"Bearer {out['token']}"}, out


def _change_password(client, human):  # noqa: F811
    r = client.post("/api/v1/auth/change-password", headers=human.headers,
                    json={"old_password": PASSWORD, "new_password": PASSWORD + "2"})
    assert r.status_code == 200, r.text


@pytest.fixture()
def human(db):  # noqa: F811
    return _with_password(db, make_user(db, "pat-bind", datasets="view"))


@pytest.fixture()
def admin(db):  # noqa: F811
    return make_user(db, "pat-bind-admin", settings="full")


def test_schema_default_is_unbound(client, human):  # noqa: F811
    from app.schemas.personal_access_token import PersonalAccessTokenCreate

    assert PersonalAccessTokenCreate(name="x", scopes={"datasets": "view"}).bind_to_session is False
    _, body = _mint(client, human, None)
    assert body["item"]["bound_to_session"] is False


def test_bound_pat_works_then_ends_on_password_change(client, db, human):  # noqa: F811
    pat, body = _mint(client, human, True)
    assert body["item"]["bound_to_session"] is True
    assert client.get(PROBE, headers=pat).status_code == 200
    _change_password(client, human)
    r = client.get(PROBE, headers=pat)
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid or expired token"


def test_unbound_pat_survives_password_change(client, human):  # noqa: F811
    pat, _ = _mint(client, human, False)
    assert client.get(PROBE, headers=pat).status_code == 200
    _change_password(client, human)
    assert client.get(PROBE, headers=pat).status_code == 200


def test_bound_pat_ends_on_admin_status_toggle(client, db, human, admin):  # noqa: F811
    pat, _ = _mint(client, human, True)
    assert client.get(PROBE, headers=pat).status_code == 200
    for st in ("deactivated", "active"):
        r = client.put(f"/api/v1/users/{human.id}", headers=admin.headers, json={"status": st})
        assert r.status_code == 200, r.text
    # The account is ACTIVE again, but the stamp rotated: the bound token stays dead.
    assert client.get(PROBE, headers=pat).status_code == 401


def test_bound_pat_ends_on_deactivation(client, human, admin):  # noqa: F811
    pat, _ = _mint(client, human, True)
    assert client.get(PROBE, headers=pat).status_code == 200
    assert client.delete(f"/api/v1/users/{human.id}", headers=admin.headers).status_code == 204
    assert client.get(PROBE, headers=pat).status_code == 401


def test_user_with_null_stamp_can_bind_and_use(client, db, human):  # noqa: F811
    from app.models.personal_access_token import PersonalAccessToken
    from app.models.user import User

    u = db.get(User, human.id)
    u.security_stamp = None
    db.commit()
    session = _fresh_session(db, human)
    pat, body = _mint(client, session, True)
    db.expire_all()
    row = db.get(PersonalAccessToken, uuid.UUID(body["item"]["id"]))
    assert row.bound_to_session is True and row.bound_security_stamp == ""
    assert client.get(PROBE, headers=pat).status_code == 200


def test_rotate_rebinds_a_bound_token(client, db, human):  # noqa: F811
    pat, body = _mint(client, human, True)
    _change_password(client, human)
    assert client.get(PROBE, headers=pat).status_code == 401
    session = _fresh_session(db, human)
    r = client.post(f"{PAT_URL}{body['item']['id']}/rotate", headers=session.headers)
    assert r.status_code == 200, r.text
    assert r.json()["item"]["bound_to_session"] is True
    new_pat = {"Authorization": f"Bearer {r.json()['token']}"}
    assert client.get(PROBE, headers=new_pat).status_code == 200


def test_update_can_bind_but_never_unbind(client, db, human):  # noqa: F811
    _, body = _mint(client, human, True)
    tid = body["item"]["id"]
    r = client.put(f"{PAT_URL}{tid}", headers=human.headers,
                   json={"name": "renamed", "scopes": {"datasets": "view"}, "bind_to_session": False})
    assert r.status_code == 200, r.text
    assert r.json()["bound_to_session"] is True
