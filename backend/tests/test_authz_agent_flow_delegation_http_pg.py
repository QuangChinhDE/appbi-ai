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
