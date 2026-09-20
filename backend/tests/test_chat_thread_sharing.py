"""A conversation can be handed to somebody, and that is not the same as handing
them the assistant.

WHY THIS FILE EXISTS
--------------------
Until now a conversation was private: every query in `direct_chat` filtered
`user_id == user.id`, and `chat` needed only two levels because there was nothing
to share. Sharing one introduces three questions that had never been separate —
may I READ this, may I ADD to it, may I MANAGE it — and one invariant that is the
whole reason the feature is safe:

    SHARING A CONVERSATION NEVER GRANTS THE FLOW.

Handing somebody a transcript must not become a back door around who may run the
assistant. Reading is granted by the thread's share; asking the next question is
still checked against the FLOW's share, every turn, by `resolve_for_chat`.
"""
from __future__ import annotations

import types
import uuid

import pytest

from app.services.agent_flows import direct_chat


class _Share:
    def __init__(self, permission: str):
        self.permission = types.SimpleNamespace(value=permission)


class _DB:
    """Stands in for the session `thread_access` consults."""


def _user(uid: str, chat_level: str = "view"):
    return types.SimpleNamespace(
        id=uuid.UUID(uid), email=f"{uid[:8]}@appbi.io",
        permissions={"chat": chat_level},
    )


def _thread(owner: str, tid: int = 7):
    return types.SimpleNamespace(id=tid, user_id=uuid.UUID(owner), brain_key="k")


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
    assert direct_chat.thread_access(_DB(), _user(OWNER), _thread(OWNER)) == "owner"


def test_a_stranger_gets_nothing():
    """Not shared, not theirs, and no oversight level — the conversation does not
    exist as far as they are concerned."""
    assert direct_chat.thread_access(_DB(), _user(OTHER), _thread(OWNER)) == "none"


@pytest.mark.parametrize("level", ["view", "edit"])
def test_a_share_grants_exactly_what_it_says(monkeypatch, level):
    monkeypatch.setattr(
        "app.core.resource_shares.get_highest_share_for_resource",
        lambda *a, **k: _Share(level),
    )

    assert direct_chat.thread_access(_DB(), _user(OTHER), _thread(OWNER)) == level


def test_chat_full_reads_anything_without_a_share():
    """The oversight level, meaning what `full` means in every other module.

    Deliberately NOT "owner": an administrator reading somebody's conversation is
    not its author, and `_require_owner` treats the two the same only for the
    lifecycle actions an administrator is expected to perform.
    """
    assert direct_chat.thread_access(_DB(), _user(OTHER, "full"), _thread(OWNER)) == "full"


def test_a_share_does_not_survive_losing_the_module():
    """`chat: none` is the floor the router enforces, and thread_access must not
    quietly hand out a level underneath it."""
    assert direct_chat.thread_access(_DB(), _user(OTHER, "none"), _thread(OWNER)) == "none"


# ── the invariant ───────────────────────────────────────────────────────────


def test_edit_on_a_thread_is_not_permission_to_run_the_flow():
    """THE WHOLE REASON THIS IS SAFE.

    `thread_access` answers about the CONVERSATION and nothing else. If it ever
    started consulting the flow — or worse, if the send path started trusting it
    instead of `resolve_for_chat` — then sharing a transcript would become a way
    to lend an assistant the sharer may not even own.

    Pinned as a source check because the alternative is an integration test that
    would pass for the wrong reason: `thread_access` returning `edit` is correct,
    and the danger is a CALLER that stops asking the second question.
    """
    import inspect

    from app.services.agent_flows import dispatch

    src = inspect.getsource(dispatch.run_for_chat_thread)
    # The docstring names both functions while explaining the rule, so compare
    # CALLS rather than mentions — otherwise this passes or fails on prose.
    body = src.split('"""')[-1]
    assert "thread_access(" in body
    assert "resolve_for_chat(" in body
    # The conversation gate runs first: somebody with no access to the thread must
    # be turned away before the flow is resolved on their behalf.
    assert body.index("thread_access(") < body.index("resolve_for_chat(")

    # Same treatment for `thread_access`: its docstring explains the split by
    # naming the other function, so only its CODE is checked.
    access_body = inspect.getsource(direct_chat.thread_access).split('"""')[-1]
    assert "resolve_for_chat" not in access_body, (
        "thread_access consulted the flow — sharing a transcript would then grant "
        "the assistant behind it"
    )
    assert "usable_brains" not in access_body


def test_sharing_a_conversation_is_gated_on_the_thread_not_the_flow():
    """`require_share_access` resolves CHAT_THREAD against the thread's own row, so
    "may I share this" is answered by owning the conversation — not by any relation
    to the flow inside it."""
    from app.core.share_access import _RESOURCE_MODEL_MAP
    from app.models.agent_flow_chat_thread import AgentFlowChatThread
    from app.models.resource_share import ResourceType

    model, module, lookup = _RESOURCE_MODEL_MAP[ResourceType.CHAT_THREAD]

    assert model is AgentFlowChatThread
    assert module == "chat"
    assert lookup == "id"


def test_chat_offers_the_level_sharing_requires():
    """`require_share_access` demands effective `full`, and
    `get_effective_permission` only lets an owner reach `full` on their own row
    when the MODULE level is `edit` or above. A two-level `chat` would therefore
    have left people unable to share the conversation they are holding — which is
    why this module grew past none/view."""
    from app.api.permissions import MODULE_ALLOWED_LEVELS

    levels = MODULE_ALLOWED_LEVELS["chat"]

    assert "edit" in levels, "without `edit`, an owner cannot share their own thread"
    assert "full" in levels, "without `full`, nobody can oversee conversations"
