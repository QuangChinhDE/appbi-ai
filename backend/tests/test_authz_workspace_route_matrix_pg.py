"""Every Workspace runtime route: the token is an address, never authority.

Walks the REAL route table for ``/api/v1/public/workspaces/{token}/workboards/
{workboard_id}/...`` so a route added tomorrow is covered today, and calls each
one (real app, Postgres, app role) as:

* token only (no session, no bearer);
* AppBI staff with ``workboards: view`` and no relation to the workboard;
* AppBI staff with ``workboards: edit`` and no relation;

None may succeed (2xx) and none may crash (5xx). Then a Workboard VIEWER may
not succeed on any route that mutates or sends data out.
"""
from __future__ import annotations

import io
import re
import uuid

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg

PREFIX = "/api/v1/public/workspaces/{token}/workboards/{workboard_id}"

#: POST routes that only READ (query shapes). Everything else that is not GET
#: mutates state or sends data somewhere.
READ_POSTS = {"/screens/{screen_id}/table",
              "/screens/{screen_id}/actions/{action_id}/open-related-records"}


def _routes():
    from app.main import app

    out = []
    for r in app.routes:
        p = getattr(r, "path", "")
        if p.startswith(PREFIX):
            for m in sorted(r.methods):
                out.append((m, p))
    return out


ROUTES = _routes()


def test_the_walk_sees_the_workspace_runtime():
    assert len(ROUTES) >= 20, ROUTES


@pytest.fixture(scope="module")
def world():
    from app.core.database import SessionLocal
    from app.models.dataset import Dataset, DatasetTable
    from app.modules.workboards.models import Workboard, WorkboardWorkspace

    s = SessionLocal()
    owner = make_user(s, "m-owner", workboards="edit", datasets="edit")
    ds = Dataset(name=f"m-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    s.add(ds)
    s.flush()
    t = DatasetTable(dataset_id=ds.id, display_name="rows", source_table_name="rows")
    s.add(t)
    s.flush()
    slug = f"m-{uuid.uuid4().hex[:8]}"
    wb = Workboard(name="M", slug=slug, dataset_id=ds.id, primary_table_id=t.id, owner_id=owner.id,
                   layout_json={}, is_published=True, published_layout_json={})
    s.add(wb)
    s.flush()
    ws = WorkboardWorkspace(name="M", token=uuid.uuid4().hex, access_mode="internal",
                            menu_config=[{"workboard_slug": slug, "label": "M"}],
                            owner_id=owner.id, is_active=True)
    s.add(ws)
    s.commit()
    principals = {
        "token_only": None,
        "staff_module_view": make_user(s, "m-sv", workboards="view", datasets="view"),
        "staff_module_edit": make_user(s, "m-se", workboards="edit", datasets="edit"),
        "wb_viewer": make_user(s, "m-wv", workboards="view", datasets="view"),
    }
    share(s, "workboard", wb.id, principals["wb_viewer"], "view", owner)
    yield dict(ws=ws, wb=wb, p=principals)
    s.close()


def _call(client, method, path, world, who):  # noqa: F811
    url = (path.replace("{token}", world["ws"].token)
               .replace("{workboard_id}", str(world["wb"].id)))
    url = re.sub(r"\{[a-z_]+\}", "x1", url)
    headers = world["p"][who].headers if world["p"][who] is not None else {}
    if path.endswith("/media"):
        return client.post(url, headers=headers, files={"file": ("a.png", io.BytesIO(b"\x89PNG"), "image/png")})
    if method == "GET":
        return client.get(url, headers=headers)
    return client.request(method, url, headers=headers, json={})


@pytest.mark.parametrize("who", ["token_only", "staff_module_view", "staff_module_edit"])
@pytest.mark.parametrize("method,path", ROUTES)
def test_no_relation_never_succeeds(client, world, who, method, path):  # noqa: F811
    r = _call(client, method, path, world, who)
    assert not (200 <= r.status_code < 300), (who, method, path, r.status_code, r.text[:200])
    assert r.status_code < 500, (who, method, path, r.status_code, r.text[:200])


@pytest.mark.parametrize("method,path", [rt for rt in ROUTES
                                         if rt[0] != "GET" and rt[1][len(PREFIX):] not in READ_POSTS])
def test_workboard_viewer_cannot_mutate(client, world, method, path):  # noqa: F811
    r = _call(client, method, path, world, "wb_viewer")
    assert not (200 <= r.status_code < 300), (method, path, r.status_code, r.text[:200])
    assert r.status_code < 500, (method, path, r.status_code, r.text[:200])


def test_workboard_viewer_can_open_the_app_positive_control(client, world):  # noqa: F811
    r = _call(client, "GET", PREFIX + "/app", world, "wb_viewer")
    assert r.status_code == 200, r.text
