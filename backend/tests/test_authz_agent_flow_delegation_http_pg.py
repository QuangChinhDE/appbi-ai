"""A shared flow is not the owner's data authority (decision Q2). Real Postgres.

Before: run_scope = owner's rights ∩ attachments - anyone the flow was shared
with got answers from data only the owner could read (confused deputy).
Now: a signed-in caller other than the owner gets owner-only data ONLY through
an explicit, revocable delegation created by the owner for an attached resource
the owner can read.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.agent_brain import AgentBrainVersion
    from app.models.dataset import Dataset
    from app.models.user import User

    owner = make_user(db, "f-owner", agent_flows="edit", datasets="edit", chat="edit")
    reader = make_user(db, "f-reader", agent_flows="view", datasets="view", chat="view")
    ds_private = Dataset(name=f"hr-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    ds_shared = Dataset(name=f"sales-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    ds_unattached = Dataset(name=f"other-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add_all([ds_private, ds_shared, ds_unattached])
    db.commit()
    share(db, "dataset", ds_shared.id, reader, "view", owner)
    key = f"flow_{uuid.uuid4().hex[:8]}"
    body = {"name": "F", "nodes": [{"key": "a", "type": "agent", "name": "A", "prompt": "p", "tools": [],
            "knowledge": [{"source": "semantic", "ref": str(ds_private.id), "description": "Bảng lương và hồ sơ nhân sự; tra khi hỏi về lương thưởng."},
                          {"source": "semantic", "ref": str(ds_shared.id), "description": "Doanh số bán hàng theo ngày; tra khi hỏi về doanh thu."}]}]}
    row = AgentBrainVersion(brain_key=key, version=1, name="F", body=body, status="published",
                            owner_email=db.get(User, owner.id).email)
    db.add(row)
    db.commit()
    share(db, "agent_brain", key, reader, "view", owner)
    return dict(owner=owner, reader=reader, key=key, row=row, private=ds_private, shared=ds_shared,
                unattached=ds_unattached)


def _scope(db, world, who):  # noqa: F811
    from app.models.user import User
    from app.services.agent_flows import registry as reg
    from app.services.agent_flows.permissions import run_scope

    db.expire_all()
    return set(run_scope(db, world["row"], reg.parse_flow(world["row"]), None,
                         caller=db.get(User, world[who].id))["dataset_ids"])


def test_shared_flow_alone_does_not_lend_owner_data(db, world):  # noqa: F811
    assert _scope(db, world, "reader") == {world["shared"].id}       # their own access only
    assert _scope(db, world, "owner") == {world["private"].id, world["shared"].id}


def test_explicit_delegation_then_revocation(client, db, world):  # noqa: F811
    url = f"/api/v1/agent-flows/brains/{world['key']}/delegations"
    r = client.post(url, headers=world["owner"].headers,
                    json={"grantee_user_id": str(world["reader"].id), "resource_type": "dataset",
                          "resource_id": world["private"].id})
    assert r.status_code == 201, r.text
    assert _scope(db, world, "reader") == {world["private"].id, world["shared"].id}
    r = client.delete(f"{url}/{r.json()['id']}", headers=world["owner"].headers)
    assert r.status_code == 200 and r.json()["revoked_at"]
    assert _scope(db, world, "reader") == {world["shared"].id}       # next turn: gone


def test_only_the_owner_delegates_and_only_attached_readable_resources(client, db, world):  # noqa: F811
    url = f"/api/v1/agent-flows/brains/{world['key']}/delegations"
    body = {"grantee_user_id": str(world["reader"].id), "resource_type": "dataset",
            "resource_id": world["private"].id}
    assert client.post(url, headers=world["reader"].headers, json=body).status_code in (403, 404)
    assert client.post(url, headers=world["owner"].headers,
                       json={**body, "resource_id": world["unattached"].id}).status_code == 400
    assert client.post(url, headers=world["owner"].headers,
                       json={**body, "grantee_user_id": None}).status_code == 400
    assert client.post(url, headers=world["owner"].headers,
                       json={**body, "grantee_user_id": "nope"}).status_code == 400


# ── Public links: the ASSIGNER's rights bound the flow (second review, F1) ──────
#
# A flow shared with B at view, attaching a dataset only its owner A can read, was
# assignable by B to B's own public link - and the anonymous run then used A's
# rights. Now assigning needs read on everything the flow attaches, and a public
# run is bounded by the current assigner's rights as well (fails closed).

def _public_link(db, who):  # noqa: F811
    import secrets as _s

    from app.models.models import Dashboard, DashboardPublicLink

    d = Dashboard(name=f"pub-{uuid.uuid4().hex[:6]}", owner_id=who.id)
    db.add(d)
    db.flush()
    link = DashboardPublicLink(dashboard_id=d.id, name="p", token=_s.token_urlsafe(24), is_active=True,
                               source="user")
    db.add(link)
    db.commit()
    return link


def _levels(db, who, **levels):  # noqa: F811
    from tests.authz_http import set_permissions

    set_permissions(db, who, **levels)


def test_shared_flow_cannot_be_put_on_the_viewers_public_link(client, db, world):  # noqa: F811
    _levels(db, world["reader"], agent_flows="view", datasets="view", chat="view", dashboards="edit")
    link = _public_link(db, world["reader"])
    body = {"link_id": link.id, "brain_key": world["key"], "data_contract": {}}
    for path, method in (("/api/v1/agent-flows/bindings", "put"), ("/api/v1/agent-flows/bindings/preflight", "post")):
        r = getattr(client, method)(path, headers=world["reader"].headers, json=body)
        assert r.status_code == 403, (path, r.status_code, r.text)
        assert "link công khai" in r.text


def test_owner_may_put_their_flow_on_their_link_positive_control(client, db, world):  # noqa: F811
    _levels(db, world["owner"], agent_flows="edit", datasets="edit", chat="edit", dashboards="edit")
    link = _public_link(db, world["owner"])
    r = client.post("/api/v1/agent-flows/bindings/preflight", headers=world["owner"].headers,
                    json={"link_id": link.id, "brain_key": world["key"], "data_contract": {}})
    assert r.status_code != 403 or "link công khai" not in r.text, r.text


def test_public_run_scope_is_bounded_by_the_assigner(db, world):  # noqa: F811
    from app.models.user import User
    from app.services.agent_flows import registry as reg
    from app.services.agent_flows.permissions import public_run_scope

    flow = reg.parse_flow(world["row"])

    def ds(email):
        db.expire_all()
        return set(public_run_scope(db, world["row"], flow, None, email)["dataset_ids"])

    assert ds(db.get(User, world["owner"].id).email) == {world["private"].id, world["shared"].id}
    assert ds(db.get(User, world["reader"].id).email) == {world["shared"].id}
    assert ds("nobody@nowhere.test") == set()        # unresolvable assigner: fail closed
    assert ds(None) == set()
