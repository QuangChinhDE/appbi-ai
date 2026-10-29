"""A conversation can be handed to somebody, and that is not the same as handing
them its data or the Agent Flow bound to it.

(Written for Flow-chat threads; since the unified AI Chat the conversation is
`chat_conversations` - services/chat/conversations.py - and these invariants moved
with it.) Three questions stay separate - may I READ it, may I ADD to it, may I
MANAGE it - and two invariants make sharing safe:

    SHARING A CONVERSATION NEVER GRANTS THE FLOW.
    SHARING A CONVERSATION NEVER GRANTS ITS DATA.

Reading is granted by the conversation's share; its stored answers are re-checked
against the reader (test_analyst_sessions_http_pg.py); asking the next question runs
as the CALLER, and an extension Flow is resolved against the CALLER's own share of
that Flow on every call (`dispatch.run_as_extension` -> `resolve_for_chat`).
"""
from __future__ import annotations

import types
import uuid

import pytest

from app.services.chat import conversations


class _Share:
    def __init__(self, permission: str):
        self.permission = types.SimpleNamespace(value=permission)


class _DB:
    """Stands in for the session `access` consults."""


def _user(uid: str, chat_level: str = "view"):
    return types.SimpleNamespace(
        id=uuid.UUID(uid), email=f"{uid[:8]}@appbi.io",
        permissions={"chat": chat_level},
    )


def _conv(owner: str, cid: int = 7):
    return types.SimpleNamespace(id=cid, user_id=uuid.UUID(owner), extension_flow_key="k")


OWNER = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


@pytest.fixture(autouse=True)
def _no_real_shares(monkeypatch):
    """Default: nothing is shared. Each test opts in to a share it wants."""
    monkeypatch.setattr(
        "app.core.resource_shares.get_highest_share_for_resource",
        lambda *a, **k: None,
    )


def test_the_person_who_started_it_owns_it():
    assert conversations.access(_DB(), _user(OWNER), _conv(OWNER)) == "owner"


def test_a_stranger_gets_nothing():
    assert conversations.access(_DB(), _user(OTHER), _conv(OWNER)) == "none"


@pytest.mark.parametrize("level", ["view", "edit"])
def test_a_share_grants_exactly_what_it_says(monkeypatch, level):
    monkeypatch.setattr(
        "app.core.resource_shares.get_highest_share_for_resource",
        lambda *a, **k: _Share(level),
    )
    assert conversations.access(_DB(), _user(OTHER), _conv(OWNER)) == level


def test_chat_full_reads_anything_without_a_share():
    """Oversight, not authorship: `full` reads and deletes, it never asks."""
    assert conversations.access(_DB(), _user(OTHER, "full"), _conv(OWNER)) == "full"
    assert not conversations.can_ask("full")


def test_a_share_does_not_survive_losing_the_module(monkeypatch):
    monkeypatch.setattr(
        "app.core.resource_shares.get_highest_share_for_resource",
        lambda *a, **k: _Share("edit"),
    )
    assert conversations.access(_DB(), _user(OTHER, "none"), _conv(OWNER)) == "none"


# ── the invariants ──────────────────────────────────────────────────────────


def test_edit_on_a_conversation_is_not_permission_to_run_its_flow():
    """`access` answers about the CONVERSATION and nothing else; the extension is
    resolved for the person asking, every call. Pinned as a source check: the
    danger is a caller that stops asking the second question."""
    import inspect

    from app.services.agent_flows import dispatch

    access_body = inspect.getsource(conversations.access).split('"""')[-1]
    assert "resolve_for_chat" not in access_body and "usable_brains" not in access_body, (
        "conversation access consulted the flow - sharing a transcript would then lend the flow")
    body = inspect.getsource(dispatch.run_as_extension).split('"""', 2)[-1]
    assert "direct_chat.resolve_for_chat(db, user, flow_key)" in body, (
        "the extension must be resolved against the CALLER's own share of the flow")


def test_sharing_a_conversation_is_gated_on_the_conversation_not_the_flow():
    """`require_share_access` resolves CHAT_CONVERSATION against the conversation's
    own row. The retired thread and analyst-session types are not shareable."""
    from app.core.share_access import _RESOURCE_MODEL_MAP
    from app.models.chat_conversation import ChatConversation
    from app.models.resource_share import ResourceType

    model, module, lookup = _RESOURCE_MODEL_MAP[ResourceType.CHAT_CONVERSATION]
    assert model is ChatConversation and module == "chat" and lookup == "id"
    assert ResourceType.CHAT_THREAD not in _RESOURCE_MODEL_MAP
    assert ResourceType.ANALYST_SESSION not in _RESOURCE_MODEL_MAP


def test_chat_offers_the_level_sharing_requires():
    """An owner reaches effective `full` on their own row only at module `edit`+,
    and sharing requires `full`; so `chat` keeps all four levels."""
    from app.api.permissions import MODULE_ALLOWED_LEVELS

    levels = MODULE_ALLOWED_LEVELS["chat"]
    assert "edit" in levels, "without `edit`, an owner cannot share their own conversation"
    assert "full" in levels, "without `full`, nobody can oversee conversations"
