"""Workspaces: the token and the module are never Workboard data authority (HTTP).

Regressions locked (independent review of demo@11473148):

* F-WB1 — an AppBI bearer token with only ``workboards: view`` became an
  ``_internal`` staff identity in an internal-mode workspace, and
  ``can_app_user_access_workboard`` returned True for it: every workboard in the
  menu was readable and writable with no object check and no row filter.
* F-WB2 — ``/workspaces`` list/get returned EVERY workspace with its portal
  token to any ``workboards: view`` user; update / rotate / delete /
  preview-session needed only ``workboards: edit`` on anyone's workspace; menu
  slugs needed no access to the workboard itself.
* H12 (part) — the staff-bearer decoder accepted any JWT signed with the key,
  including refresh tokens.

Each refusal is paired with the positive control that must keep working.
"""
from __future__ import annotations

import io
import uuid

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
       b"\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\x35\x81\x84"
       b"\x00\x00\x00\x00IEND\xaeB`\x82")


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.dataset import Dataset, DatasetTable
    from app.modules.workboards.models import Workboard, WorkboardWorkspace

    owner = make_user(db, "wb-owner", workboards="edit", datasets="edit")
    view_only = make_user(db, "wb-viewonly", workboards="view", datasets="view")
    editor_module = make_user(db, "wb-editmodule", workboards="edit", datasets="edit")
    shared_view = make_user(db, "wb-sharedview", workboards="view", datasets="view")
    shared_edit = make_user(db, "wb-sharededit", workboards="edit", datasets="view")
    admin = make_user(db, "wb-admin", workboards="full", datasets="full")

    ds = Dataset(name=f"wbds-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add(ds)
    db.flush()
    tbl = DatasetTable(dataset_id=ds.id, display_name="rows", source_table_name="rows")
    db.add(tbl)
    db.flush()
    slug = f"wb-{uuid.uuid4().hex[:8]}"
    wb = Workboard(name="Secret app", slug=slug, dataset_id=ds.id, primary_table_id=tbl.id, owner_id=owner.id,
                   layout_json={}, is_published=True, published_layout_json={})
    db.add(wb)
    db.flush()
    ws = WorkboardWorkspace(name="Portal", token=uuid.uuid4().hex, access_mode="internal",
                            menu_config=[{"workboard_slug": slug, "label": "Secret"}],
                            owner_id=owner.id, is_active=True)
    db.add(ws)
    db.commit()
    for p, lvl in ((shared_view, "view"), (shared_edit, "edit")):
        share(db, "workboard", wb.id, p, lvl, owner)
        share(db, "dataset", ds.id, p, "view", owner)
    return dict(owner=owner, view_only=view_only, editor_module=editor_module,
                shared_view=shared_view, shared_edit=shared_edit, admin=admin,
                wb=wb, ws=ws, ds=ds)


def _app(client, w, who):  # noqa: F811
    return client.get(f"/api/v1/public/workspaces/{w['ws'].token}/workboards/{w['wb'].id}/app",
                      headers=who.headers)


def _upload(client, w, who):  # noqa: F811
    return client.post(
        f"/api/v1/public/workspaces/{w['ws'].token}/workboards/{w['wb'].id}/media",
        headers=who.headers,
        files={"file": ("x.png", io.BytesIO(PNG), "image/png")},
    )


# ── F-WB1: staff in an internal workspace ────────────────────────────────────

def test_module_view_plus_token_cannot_open_an_unshared_workboard(client, world):  # noqa: F811
    r = _app(client, world, world["view_only"])
    assert r.status_code == 403, r.text


def test_module_edit_plus_token_cannot_open_an_unshared_workboard(client, world):  # noqa: F811
    assert _app(client, world, world["editor_module"]).status_code == 403


def test_staff_with_a_share_can_open_it_positive_control(client, world):  # noqa: F811
    for who in ("shared_view", "shared_edit", "owner", "admin"):
        r = _app(client, world, world[who])
        assert r.status_code == 200, (who, r.status_code, r.text[:300])


def test_unshared_staff_cannot_write_through_the_runtime(client, world):  # noqa: F811
    assert _upload(client, world, world["view_only"]).status_code == 403


def test_view_share_cannot_write_through_the_runtime(client, world):  # noqa: F811
    r = _upload(client, world, world["shared_view"])
    assert r.status_code == 403, r.text


def test_edit_share_can_write_positive_control(client, world):  # noqa: F811
    r = _upload(client, world, world["shared_edit"])
    assert r.status_code in (200, 201), r.text


def test_menu_hides_workboards_the_staff_member_cannot_open(client, world):  # noqa: F811
    tok = world["ws"].token
    r = client.get(f"/api/v1/public/workspaces/{tok}/menu", headers=world["view_only"].headers)
    assert r.status_code in (200, 401, 403)
    if r.status_code == 200:
        assert all(i["workboard_id"] != world["wb"].id for i in r.json().get("menu", []))
    r = client.get(f"/api/v1/public/workspaces/{tok}/menu", headers=world["shared_view"].headers)
    assert r.status_code == 200, r.text
    assert any(i["workboard_id"] == world["wb"].id for i in r.json().get("menu", []))


def test_a_refresh_token_is_not_a_staff_bearer(client, db, world):  # noqa: F811
    from app.api.auth import create_refresh_token
    from app.models.user import User

    u = db.get(User, world["shared_edit"].id)
    refresh = {"Authorization": f"Bearer {create_refresh_token(u)}"}
    r = client.get(f"/api/v1/public/workspaces/{world['ws'].token}/workboards/{world['wb'].id}/app",
                   headers=refresh)
    assert r.status_code == 401, r.text


# ── F-WB2: the workspace admin API ───────────────────────────────────────────

def test_workspace_list_is_scoped(client, world):  # noqa: F811
    ids = lambda who: {w["id"] for w in client.get("/api/v1/workspaces", headers=world[who].headers).json()}  # noqa: E731
    assert world["ws"].id not in ids("view_only")
    assert world["ws"].id not in ids("editor_module")
    assert world["ws"].id in ids("owner")
    assert world["ws"].id in ids("shared_view")
    assert world["ws"].id in ids("admin")


def test_workspace_get_hides_unrelated_workspaces(client, world):  # noqa: F811
    url = f"/api/v1/workspaces/{world['ws'].id}"
    assert client.get(url, headers=world["view_only"].headers).status_code == 404
    assert client.get(url, headers=world["owner"].headers).status_code == 200


def test_public_mode_token_only_for_managers(client, db, world):  # noqa: F811
    ws = world["ws"]
    ws.access_mode = "public_app_users"
    db.merge(ws)
    db.commit()
    url = f"/api/v1/workspaces/{ws.id}"
    assert client.get(url, headers=world["shared_view"].headers).json()["token"] is None
    assert client.get(url, headers=world["owner"].headers).json()["token"] == ws.token


@pytest.mark.parametrize("who,expected", [("editor_module", 404), ("shared_edit", 403)])
def test_non_managers_cannot_mutate_a_workspace(client, world, who, expected):  # noqa: F811
    wid = world["ws"].id
    h = world[who].headers
    assert client.patch(f"/api/v1/workspaces/{wid}", headers=h, json={"name": "pwned"}).status_code == expected
    assert client.post(f"/api/v1/workspaces/{wid}/rotate-token", headers=h).status_code == expected
    assert client.post(f"/api/v1/workspaces/{wid}/preview-session", headers=h, json={}).status_code == expected
    assert client.delete(f"/api/v1/workspaces/{wid}", headers=h).status_code == expected


def test_owner_and_admin_can_manage_positive_control(client, world):  # noqa: F811
    wid = world["ws"].id
    assert client.patch(f"/api/v1/workspaces/{wid}", headers=world["owner"].headers,
                        json={"name": "renamed"}).status_code == 200
    assert client.post(f"/api/v1/workspaces/{wid}/rotate-token",
                       headers=world["admin"].headers).status_code == 200


def test_menu_entry_requires_edit_on_that_workboard(client, world):  # noqa: F811
    slug = world["wb"].slug
    body = {"name": "mine", "access_mode": "internal",
            "menu_config": [{"workboard_slug": slug, "label": "x"}]}
    assert client.post("/api/v1/workspaces", headers=world["editor_module"].headers,
                       json=body).status_code == 403
    r = client.post("/api/v1/workspaces", headers=world["owner"].headers, json=body)
    assert r.status_code == 201, r.text


def test_unknown_menu_slug_is_refused(client, world):  # noqa: F811
    body = {"name": "x", "menu_config": [{"workboard_slug": f"nope-{uuid.uuid4().hex}", "label": "x"}]}
    assert client.post("/api/v1/workspaces", headers=world["owner"].headers, json=body).status_code == 400


# ── Workboard <-> Dataset contract (binding needs BUILD; runtime is delegated) ──

@pytest.fixture()
def binder(db, world):  # noqa: F811
    """Workboard editor whose ONLY dataset authority is a `view` grant."""
    from app.models.dataset import DatasetGrant

    u = make_user(db, "wb-binder", workboards="edit", datasets="edit")
    share(db, "workboard", world["wb"].id, u, "edit", world["owner"])
    db.add(DatasetGrant(dataset_id=world["ds"].id, user_id=u.id, verb="view", granted_by=world["owner"].id))
    db.commit()
    return u


def test_dataset_view_cannot_bind_or_publish_a_workboard(client, world, binder):  # noqa: F811
    wid = world["wb"].id
    assert client.post(f"/api/v1/workboards/{wid}/publish", headers=binder.headers).status_code == 403
    assert client.post(f"/api/v1/workboards/{wid}/rebind/preview", headers=binder.headers,
                       json={"dataset_id": world["ds"].id}).status_code in (403, 422)


def test_runtime_write_is_workboard_delegated_but_opens_no_dataset_action(client, world, binder):  # noqa: F811
    # Data entry through the workboard is the workboard's (edit) authority...
    assert _upload(client, world, binder).status_code in (200, 201)
    # ...and grants nothing on the dataset itself: no raw rows, no model edit.
    ds = world["ds"].id
    assert client.get(f"/api/v1/datasets/{ds}/tables", headers=binder.headers).status_code in (403, 404)
    assert client.put(f"/api/v1/datasets/{ds}", headers=binder.headers,
                      json={"name": "x"}).status_code in (403, 404)


def test_dataset_build_can_publish_positive_control(client, db, world):  # noqa: F811
    from app.models.dataset import DatasetGrant

    u = make_user(db, "wb-builder", workboards="edit", datasets="edit")
    share(db, "workboard", world["wb"].id, u, "edit", world["owner"])
    db.add(DatasetGrant(dataset_id=world["ds"].id, user_id=u.id, verb="build", granted_by=world["owner"].id))
    db.commit()
    r = client.post(f"/api/v1/workboards/{world['wb'].id}/publish", headers=u.headers)
    assert r.status_code != 403, r.text
