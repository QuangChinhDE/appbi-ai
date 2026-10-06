"""Workspace app-user sessions are revocable and never stale (HTTP, Postgres).

Before: a workspace session JWT carried the app user's role and context frozen
for its TTL (default 8h). PIN reset, deactivation, role change or logout did
not end it. Now every request re-reads the app user (row exists, active, same
session_epoch) and role/context come from the row.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg

PIN = "482913"


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.dataset import Dataset, DatasetTable
    from app.modules.workboards.models import Workboard, WorkboardAppUser, WorkboardWorkspace
    from app.modules.workboards.services.app_user_service import hash_pin

    owner = make_user(db, "s-owner", workboards="edit", datasets="edit")
    ds = Dataset(name=f"s-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add(ds)
    db.flush()
    t = DatasetTable(dataset_id=ds.id, display_name="t", source_table_name="t")
    db.add(t)
    db.flush()
    slug = f"s-{uuid.uuid4().hex[:8]}"
    wb = Workboard(name="S", slug=slug, dataset_id=ds.id, primary_table_id=t.id, owner_id=owner.id,
                   layout_json={}, is_published=True, published_layout_json={})
    db.add(wb)
    db.flush()
    au = WorkboardAppUser(workboard_id=wb.id, username=f"field{uuid.uuid4().hex[:4]}", pin_hash=hash_pin(PIN),
                          role="user", active=True, context={})
    db.add(au)
    ws = WorkboardWorkspace(name="S", token=uuid.uuid4().hex, access_mode="public_app_users",
                            menu_config=[{"workboard_slug": slug, "label": "S"}], owner_id=owner.id, is_active=True)
    db.add(ws)
    db.commit()
    return dict(owner=owner, wb=wb, au=au, ws=ws)


def _login(client, w):  # noqa: F811
    r = client.post(f"/api/v1/public/workspaces/{w['ws'].token}/login",
                    json={"username": w["au"].username, "pin": PIN})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    return {"X-Workspace-Session": r.json()["session_token"]}


def _menu(client, w, h):  # noqa: F811
    client.cookies.clear()
    return client.get(f"/api/v1/public/workspaces/{w['ws'].token}/menu", headers=h).status_code


def test_session_works_positive_control(client, world):  # noqa: F811
    assert _menu(client, world, _login(client, world)) == 200


def test_pin_change_ends_existing_sessions(client, world):  # noqa: F811
    h = _login(client, world)
    r = client.patch(f"/api/v1/workboards/{world['wb'].id}/app-users/{world['au'].id}",
                     headers=world["owner"].headers, json={"pin": "735190"})
    assert r.status_code == 200, r.text
    assert _menu(client, world, h) == 401


def test_deactivation_ends_existing_sessions(client, world):  # noqa: F811
    h = _login(client, world)
    r = client.patch(f"/api/v1/workboards/{world['wb'].id}/app-users/{world['au'].id}",
                     headers=world["owner"].headers, json={"active": False})
    assert r.status_code == 200, r.text
    assert _menu(client, world, h) == 401


def test_logout_ends_the_session_server_side(client, world):  # noqa: F811
    h = _login(client, world)
    client.cookies.clear()
    assert client.post(f"/api/v1/public/workspaces/{world['ws'].token}/logout", headers=h).status_code == 200
    assert _menu(client, world, h) == 401   # a copied token no longer works


def test_role_change_is_seen_on_the_next_request(client, db, world):  # noqa: F811
    from app.modules.workboards.models import WorkboardAppUser

    h = _login(client, world)
    row = db.get(WorkboardAppUser, world["au"].id)
    row.role = "admin"   # changed directly (no epoch bump): identity is re-read anyway
    db.commit()
    client.cookies.clear()
    r = client.get(f"/api/v1/public/workspaces/{world['ws'].token}/menu", headers=h)
    assert r.status_code == 200 and r.json()["app_user"]["role"] == "admin"
