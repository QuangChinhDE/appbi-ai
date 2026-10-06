"""Workboard runtime rows: READ / INSERT / UPDATE / DELETE under real Postgres RLS (HTTP).

A real published table screen over a real Postgres table (the test database
itself, reached through a datasource), driven through the public workspace
runtime by:

* app users (PIN session) of one role whose rows are filtered to their own
  (``owner_name = {{app_user.username}}``, create/update yes, delete no), and a
  manager role that sees every row and may delete;
* staff (AppBI bearer) through an internal workspace: a workboard VIEW share,
  a workboard EDIT share, and a user with no share at all.

Every write is checked IN THE TABLE afterwards (not only by status code): a
refused update must leave the row as it was, a refused delete must leave it
there, an insert must not land under another user's name.
"""
from __future__ import annotations

import secrets
import uuid

import pytest
from sqlalchemy import create_engine, text

from tests.authz_http import OWNER_URL, client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg


@pytest.fixture()
def world(db, monkeypatch):  # noqa: F811
    from sqlalchemy.engine import make_url

    from app.models.dataset import Dataset, DatasetTable
    from app.models.models import DataSource, DataSourceType
    from app.modules.workboards.models import Workboard, WorkboardAppUser, WorkboardWorkspace
    from app.modules.workboards.services import app_user_service

    monkeypatch.setenv("DATASOURCE_ALLOW_LOOPBACK", "true")
    run = uuid.uuid4().hex[:8]
    tname = f"wb_rls_{run}"
    eng = create_engine(OWNER_URL)
    with eng.begin() as c:
        c.execute(text(f"CREATE TABLE {tname} (id serial PRIMARY KEY, owner_name text NOT NULL, note text)"))
        c.execute(text(f"INSERT INTO {tname} (owner_name, note) VALUES "
                       "('alice', 'a1'), ('alice', 'a2'), ('bob', 'b1')"))

    url = make_url(OWNER_URL)
    work = dict(workboards="edit", datasets="edit")
    owner = make_user(db, "rows-owner", data_sources="edit", **work)
    staff_view = make_user(db, "rows-sview", **work)
    staff_edit = make_user(db, "rows-sedit", **work)
    stranger = make_user(db, "rows-stranger", **work)

    src = DataSource(name=f"rows-{run}", type=DataSourceType.POSTGRESQL, owner_id=owner.id,
                     config={"host": url.host, "port": url.port or 5432, "database": url.database,
                             "username": url.username, "password": url.password or ""})
    ds = Dataset(name=f"rows-{run}", owner_id=owner.id, purpose="operational") \
        if hasattr(Dataset, "purpose") else Dataset(name=f"rows-{run}", owner_id=owner.id)
    db.add_all([src, ds])
    db.flush()
    table = DatasetTable(dataset_id=ds.id, display_name=tname, source_table_name=tname, datasource_id=src.id)
    db.add(table)
    db.flush()
    layout = {"screens": [{
        "id": "rows", "kind": "table", "title": "Rows", "table_id": table.id,
        "primary_key_columns": ["id"],
        "table": {"columns": ["id", "owner_name", "note"], "editable_columns": ["note"],
                  "allow_add_row": True, "allow_delete_row": True},
        "rls": [
            {"role": "field", "filter_column": "owner_name", "filter_value": "{{app_user.username}}",
             "can_create": True, "can_update": True, "can_delete": False},
            {"role": "manager", "unrestricted": True, "can_create": True, "can_update": True,
             "can_delete": True},
        ],
    }]}
    slug = f"rows-{run}"
    wb = Workboard(name="rows", slug=slug, dataset_id=ds.id, primary_table_id=table.id, owner_id=owner.id,
                   layout_json=layout, published_layout_json=layout, is_published=True)
    db.add(wb)
    db.flush()
    pin = "741852"
    for name, role in (("alice", "field"), ("bob", "field"), ("lead", "manager")):
        db.add(WorkboardAppUser(workboard_id=wb.id, username=name, role=role, active=True,
                                pin_hash=app_user_service.hash_pin(pin), context={}))
    menu = [{"workboard_slug": slug, "label": "rows"}]
    ws_app = WorkboardWorkspace(name="rows app", token=secrets.token_urlsafe(24), access_mode="public_app_users",
                                owner_id=owner.id, is_active=True, menu_config=menu)
    ws_staff = WorkboardWorkspace(name="rows staff", token=secrets.token_urlsafe(24), access_mode="internal",
                                  owner_id=owner.id, is_active=True, menu_config=menu)
    db.add_all([ws_app, ws_staff])
    db.commit()
    share(db, "workboard", wb.id, staff_view, "view", owner)
    share(db, "workboard", wb.id, staff_edit, "edit", owner)
    yield dict(eng=eng, t=tname, wb=wb, pin=pin, ws_app=ws_app, ws_staff=ws_staff,
               staff_view=staff_view, staff_edit=staff_edit, stranger=stranger)
    with eng.begin() as c:
        c.execute(text(f"DROP TABLE IF EXISTS {tname}"))
    eng.dispose()


def _app_session(client, world, username):  # noqa: F811
    r = client.post(f"/api/v1/public/workspaces/{world['ws_app'].token}/login",
                    json={"username": username, "pin": world["pin"]})
    assert r.status_code == 200, r.text
    client.cookies.clear()  # each principal carries ONLY its own session header
    return {"X-Workspace-Session": r.json()["session_token"]}


def _base(world, ws_key):
    return f"/api/v1/public/workspaces/{world[ws_key].token}/workboards/{world['wb'].id}/screens/rows"


def _read(client, world, headers, ws_key="ws_app"):  # noqa: F811
    return client.post(f"{_base(world, ws_key)}/table", headers=headers, json={"page": 1})


def _owners(resp) -> list[str]:
    rows = resp.json().get("rows") or []
    out = []
    for r in rows:
        v = r.get("values", r) if isinstance(r, dict) else {}
        out.append((v.get("owner_name") if isinstance(v, dict) else None) or r.get("owner_name"))
    return out


def _db_rows(world):
    with world["eng"].connect() as c:
        return {r.id: (r.owner_name, r.note) for r in c.execute(text(f"SELECT id, owner_name, note FROM {world['t']}"))}


def _id_of(world, owner, note):
    return next(i for i, (o, n) in _db_rows(world).items() if o == owner and n == note)


# ── READ ─────────────────────────────────────────────────────────────────────

def test_rls_read_scopes_rows_per_app_user(client, world):  # noqa: F811
    alice = _read(client, world, _app_session(client, world, "alice"))
    assert alice.status_code == 200, alice.text
    assert sorted(_owners(alice)) == ["alice", "alice"]
    bob = _read(client, world, _app_session(client, world, "bob"))
    assert sorted(_owners(bob)) == ["bob"]
    lead = _read(client, world, _app_session(client, world, "lead"))
    assert sorted(_owners(lead)) == ["alice", "alice", "bob"]


def test_staff_read_needs_a_workboard_share(client, world):  # noqa: F811
    client.cookies.clear()
    assert _read(client, world, world["staff_view"].headers, "ws_staff").status_code == 200
    r = _read(client, world, world["stranger"].headers, "ws_staff")
    assert r.status_code in (403, 404), r.text
    assert "a1" not in r.text


# ── INSERT ───────────────────────────────────────────────────────────────────

def test_insert_lands_under_the_callers_own_name(client, world):  # noqa: F811
    h = _app_session(client, world, "alice")
    r = client.post(f"{_base(world, 'ws_app')}/rows", headers=h,
                    json={"values": {"owner_name": "bob", "note": "planted"}})
    rows = _db_rows(world)
    planted = [o for o, n in rows.values() if n == "planted"]
    # either refused outright, or forced onto the caller - never stored as bob
    assert "bob" not in planted, (r.status_code, r.text, planted)
    ok = client.post(f"{_base(world, 'ws_app')}/rows", headers=h,
                     json={"values": {"owner_name": "alice", "note": "mine"}})
    assert ok.status_code in (200, 201), ok.text
    assert ("alice", "mine") in _db_rows(world).values()


def test_staff_view_cannot_insert_but_edit_can(client, world):  # noqa: F811
    client.cookies.clear()
    r = client.post(f"{_base(world, 'ws_staff')}/rows", headers=world["staff_view"].headers,
                    json={"values": {"owner_name": "alice", "note": "by-viewer"}})
    assert r.status_code == 403, r.text
    assert "by-viewer" not in [n for _, n in _db_rows(world).values()]
    ok = client.post(f"{_base(world, 'ws_staff')}/rows", headers=world["staff_edit"].headers,
                     json={"values": {"owner_name": "alice", "note": "by-editor"}})
    assert ok.status_code in (200, 201), ok.text
    assert "by-editor" in [n for _, n in _db_rows(world).values()]


# ── UPDATE ───────────────────────────────────────────────────────────────────

def test_update_only_reaches_rows_rls_lets_you_see(client, world):  # noqa: F811
    h = _app_session(client, world, "alice")
    bobs = _id_of(world, "bob", "b1")
    r = client.patch(f"{_base(world, 'ws_app')}/rows", headers=h,
                     json={"pk": {"id": bobs}, "values": {"note": "hijacked"}})
    assert r.status_code in (403, 404), r.text
    assert _db_rows(world)[bobs] == ("bob", "b1")
    mine = _id_of(world, "alice", "a1")
    ok = client.patch(f"{_base(world, 'ws_app')}/rows", headers=h,
                      json={"pk": {"id": mine}, "values": {"note": "a1-edited"}})
    assert ok.status_code == 200, ok.text
    assert _db_rows(world)[mine] == ("alice", "a1-edited")


def test_update_cannot_move_a_row_to_another_owner(client, world):  # noqa: F811
    h = _app_session(client, world, "alice")
    mine = _id_of(world, "alice", "a2")
    client.patch(f"{_base(world, 'ws_app')}/rows", headers=h,
                 json={"pk": {"id": mine}, "values": {"owner_name": "bob"}})
    assert _db_rows(world)[mine][0] == "alice"


def test_staff_view_cannot_update(client, world):  # noqa: F811
    client.cookies.clear()
    rid = _id_of(world, "alice", "a1")
    r = client.patch(f"{_base(world, 'ws_staff')}/rows", headers=world["staff_view"].headers,
                     json={"pk": {"id": rid}, "values": {"note": "viewer-edit"}})
    assert r.status_code == 403, r.text
    assert _db_rows(world)[rid] == ("alice", "a1")


# ── DELETE ───────────────────────────────────────────────────────────────────

def test_delete_follows_the_role_rule(client, world):  # noqa: F811
    rid = _id_of(world, "alice", "a2")
    r = client.request("DELETE", f"{_base(world, 'ws_app')}/rows", headers=_app_session(client, world, "alice"),
                       json={"pk": {"id": rid}})
    assert r.status_code == 403, r.text
    assert rid in _db_rows(world)
    ok = client.request("DELETE", f"{_base(world, 'ws_app')}/rows", headers=_app_session(client, world, "lead"),
                        json={"pk": {"id": rid}})
    assert ok.status_code == 200, ok.text
    assert rid not in _db_rows(world)


def test_staff_view_cannot_delete(client, world):  # noqa: F811
    client.cookies.clear()
    rid = _id_of(world, "bob", "b1")
    r = client.request("DELETE", f"{_base(world, 'ws_staff')}/rows", headers=world["staff_view"].headers,
                       json={"pk": {"id": rid}})
    assert r.status_code == 403, r.text
    assert rid in _db_rows(world)
