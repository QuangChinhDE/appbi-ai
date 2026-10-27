"""A conversation's owner can share it; nobody else can (HTTP). N-CT1.

A conversation is owned through ``user_id``. The list filter knew that column; the
object check (get_effective_permission) once knew only owner_id / owner_email, so
the OWNER of a thread was "none" on it and the share answered 403 unless they held
chat:full. Ownership columns come from the authz registry for both paths.

Since the unified AI Chat the conversation is `chat_conversations` (the retired
`chat_thread` type is no longer shareable: its shares were migrated, 20261027_0001).
"""
from __future__ import annotations

import pytest

from tests.authz_http import client, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg


@pytest.fixture()
def conversation(db):  # noqa: F811
    from app.models.chat_conversation import ChatConversation

    owner = make_user(db, "t-owner", chat="edit")
    other = make_user(db, "t-other", chat="edit")
    friend = make_user(db, "t-friend", chat="view")
    c = ChatConversation(user_id=owner.id, title="t")
    db.add(c)
    db.commit()
    return dict(owner=owner, other=other, friend=friend, c=c)


def test_owner_can_share_their_conversation(client, conversation):  # noqa: F811
    r = client.post(f"/api/v1/shares/chat_conversation/{conversation['c'].id}",
                    headers=conversation["owner"].headers,
                    json={"user_id": str(conversation["friend"].id), "permission": "view"})
    assert r.status_code in (200, 201), r.text


def test_non_owner_cannot_share_it(client, conversation):  # noqa: F811
    r = client.post(f"/api/v1/shares/chat_conversation/{conversation['c'].id}",
                    headers=conversation["other"].headers,
                    json={"user_id": str(conversation["friend"].id), "permission": "view"})
    assert r.status_code in (403, 404), r.text


def test_the_retired_thread_type_cannot_be_shared(client, conversation):  # noqa: F811
    r = client.post(f"/api/v1/shares/chat_thread/{conversation['c'].id}", headers=conversation["owner"].headers,
                    json={"user_id": str(conversation["friend"].id), "permission": "view"})
    assert r.status_code in (400, 404), r.text
