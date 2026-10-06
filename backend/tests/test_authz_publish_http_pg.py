"""PUBLISH is its own action; capability tokens only reach publishers (HTTP).

Decision Q3: publish = resource owner or module admin; a shared EDIT never
implies it. Regressions locked (authz review of demo@11473148):
* N-DB1 - GET /dashboards/{id}/public-links handed every anonymous link token
  to any viewer of the dashboard.
* N-DB2 - public link create/update/delete, dashboard publish, embed minting
  and Workboard publish/public links needed only `edit`.
* N-AF1 - binding an assistant to a dashboard's public link needed only VIEW
  on the dashboard.
"""
from __future__ import annotations

import secrets
import uuid

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.models import Dashboard, DashboardPublicLink

    owner = make_user(db, "p-owner", dashboards="edit", explore_charts="edit", datasets="edit",
                      agent_flows="edit")
    editor = make_user(db, "p-editor", dashboards="edit", explore_charts="edit", datasets="edit",
                       agent_flows="edit")
    viewer = make_user(db, "p-viewer", dashboards="edit", explore_charts="view", datasets="view",
                       agent_flows="edit")
    admin = make_user(db, "p-admin", dashboards="full", explore_charts="full", datasets="full")
    dash = Dashboard(name=f"pub-{uuid.uuid4().hex[:8]}", owner_id=owner.id)
    db.add(dash)
    db.flush()
    link = DashboardPublicLink(dashboard_id=dash.id, name="L", token=secrets.token_urlsafe(24),
                               is_active=True, source="user")
    db.add(link)
    db.commit()
    share(db, "dashboard", dash.id, editor, "edit", owner)
    share(db, "dashboard", dash.id, viewer, "view", owner)
    return dict(owner=owner, editor=editor, viewer=viewer, admin=admin, dash=dash, link=link)


def _links(client, world, who):  # noqa: F811
    r = client.get(f"/api/v1/dashboards/{world['dash'].id}/public-links", headers=world[who].headers)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize("who", ["viewer", "editor"])
def test_non_publishers_never_receive_link_tokens(client, world, who):  # noqa: F811
    rows = _links(client, world, who)
    assert rows and all(r["token"] is None for r in rows)
    assert world["link"].token not in str(rows)
    assert all(r["capabilities"]["manage"] is False for r in rows)


@pytest.mark.parametrize("who", ["owner", "admin"])
def test_publishers_receive_tokens_positive_control(client, world, who):  # noqa: F811
    rows = _links(client, world, who)
    assert any(r["token"] == world["link"].token for r in rows)
    assert all(r["capabilities"]["manage"] is True for r in rows)


def test_shared_editor_cannot_publish_anything(client, world):  # noqa: F811
    d, l, h = world["dash"].id, world["link"].id, world["editor"].headers
    assert client.post(f"/api/v1/dashboards/{d}/public-links", headers=h, json={"name": "x"}).status_code == 403
    assert client.patch(f"/api/v1/dashboards/{d}/public-links/{l}", headers=h,
                        json={"is_active": False}).status_code == 403
    assert client.delete(f"/api/v1/dashboards/{d}/public-links/{l}", headers=h).status_code == 403
    # (POST /dashboards/{id}/publish is the INTERNAL draft->published step of
    # co-authoring, not a public surface: it stays at edit by design.)


def test_owner_can_create_a_link_positive_control(client, world):  # noqa: F811
    r = client.post(f"/api/v1/dashboards/{world['dash'].id}/public-links",
                    headers=world["owner"].headers, json={"name": "mine"})
    assert r.status_code == 201, r.text
    assert r.json()["token"]


@pytest.mark.parametrize("who", ["viewer", "editor"])
def test_assistant_binding_to_a_public_link_needs_publish(client, world, who):  # noqa: F811
    r = client.put("/api/v1/agent-flows/bindings", headers=world[who].headers,
                   json={"link_id": world["link"].id, "brain_key": "whatever"})
    assert r.status_code == 403, r.text
    r = client.delete(f"/api/v1/agent-flows/bindings/link/{world['link'].id}", headers=world[who].headers)
    assert r.status_code == 403, r.text


def test_binding_reads_stay_open_to_viewers_positive_control(client, world):  # noqa: F811
    r = client.get(f"/api/v1/agent-flows/bindings/link/{world['link'].id}", headers=world["viewer"].headers)
    assert r.status_code != 403, r.text


def test_shared_editor_pat_cannot_mint_an_embed(client, world):  # noqa: F811
    r = client.post("/api/v1/auth/personal-access-tokens/", headers=world["editor"].headers,
                    json={"name": "e", "scopes": {"dashboards": "edit"}, "expires_in_days": 1})
    assert r.status_code == 201, r.text
    pat = {"Authorization": f"Bearer {r.json()['token']}"}
    r = client.post("/api/v1/integrations/embed/resolve", headers=pat,
                    json={"dashboard_id": world["dash"].id, "full_report": True})
    assert r.status_code == 403, r.text
