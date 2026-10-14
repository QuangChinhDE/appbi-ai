"""A conversation's owner can share it; nobody else can (HTTP). N-CT1.

AgentFlowChatThread is owned through ``user_id``. The list filter knew that
column; the object check (get_effective_permission) knew only owner_id /
owner_email, so the OWNER of a thread was "none" on it and
POST /shares/chat_thread/{id} answered 403 unless they held chat:full.
Ownership columns now come from the authz registry for both paths.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg


@pytest.fixture()
def thread(db):  # noqa: F811
    from app.models.agent_flow_chat_thread import AgentFlowChatThread

    owner = make_user(db, "t-owner", chat="edit")
    other = make_user(db, "t-other", chat="edit")
    friend = make_user(db, "t-friend", chat="view")
    t = AgentFlowChatThread(user_id=owner.id, brain_key="b", title="t", session_key=uuid.uuid4().hex)
    db.add(t)
    db.commit()
    return dict(owner=owner, other=other, friend=friend, t=t)


def test_owner_can_share_their_thread(client, thread):  # noqa: F811
    r = client.post(f"/api/v1/shares/chat_thread/{thread['t'].id}", headers=thread["owner"].headers,
                    json={"user_id": str(thread["friend"].id), "permission": "view"})
    assert r.status_code in (200, 201), r.text


def test_non_owner_cannot_share_it(client, thread):  # noqa: F811
    r = client.post(f"/api/v1/shares/chat_thread/{thread['t'].id}", headers=thread["other"].headers,
                    json={"user_id": str(thread["friend"].id), "permission": "view"})
    assert r.status_code in (403, 404), r.text
