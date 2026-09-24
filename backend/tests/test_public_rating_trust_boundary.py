# -*- coding: utf-8 -*-
"""An anonymous rating may change exactly one thing: the verified run's rating.

THE DEFECT THIS LOCKS.

The public session-save endpoint receives a client-posted snapshot of the whole
conversation. For each rated assistant message it did two things:

  1. `runs.apply_rating(...)` — guarded: exact match to the answer the server
     stored, within the caller's session;
  2. `dashboard_ai_bot.knowledge.apply_feedback(...)` — with the CLIENT-POSTED
     text, matched against institutional knowledge by 50% token overlap, able to
     raise confidence, promote candidate → validated, count a contradiction, or
     retire a row.

So the promise "a public viewer can only rate words the server produced" held
for the run and not for Knowledge. And because the snapshot is re-sent after
every turn, one thumb was applied again on every later save: a browser saving the
same transcript three more times counted as four human judgments — enough to
retire a validated fact, anonymously, by replay.

THE V1 POLICY. Knowledge is advanced and not a V1 promise; the V1 starter
attaches none. The coupling is severed: a public rating means exactly one thing,
`agent_flow_runs.rating` on the verified run.

These tests drive the REAL endpoint function with spies on both side effects, so
they fail if anybody reconnects the Knowledge path — whatever it is renamed to.
"""
from __future__ import annotations

import asyncio
import inspect

import pytest

import app.api.public as public
from app.schemas.schemas import AiChatSessionSave

TOKEN = "public-link-token"


class _Row:
    pass


class _DB:
    """Enough of a Session for the endpoint to upsert its row."""

    def __init__(self):
        self.added = []
        self.commits = 0

    def query(self, *a, **k):
        return self

    def filter(self, *a, **k):
        return self

    def first(self):
        return None

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def flush(self):
        pass


class _Dash:
    id = 67


@pytest.fixture()
def harness(monkeypatch):
    calls = {"rating": [], "knowledge": []}

    monkeypatch.setattr(public, "_get_dashboard_by_token",
                        lambda *a, **k: (_Dash(), None, None, None))

    from app.services.agent_flows import runs as runs_service
    monkeypatch.setattr(runs_service, "apply_rating",
                        lambda db, **kw: calls["rating"].append(kw) or True)

    from app.services.dashboard_ai_bot import knowledge as kb
    monkeypatch.setattr(kb, "apply_feedback",
                        lambda *a, **kw: calls["knowledge"].append(kw))
    return calls


def _save(messages, session_key="s1"):
    fn = inspect.unwrap(public.save_ai_chat_session)
    body = AiChatSessionSave(session_key=session_key, messages=messages)
    return asyncio.run(fn(token=TOKEN, session_key=session_key, body=body,
                          request=None, db=_DB(), x_public_session=None))


RATED = [
    {"role": "user", "content": "Doanh thu bao nhiêu?"},
    {"role": "assistant", "content": "Doanh thu là 10.748.221,50.", "rating": "down"},
]


def test_a_rating_is_routed_to_the_run_with_the_link_scope(harness):
    assert _save(RATED) == {"ok": True}
    assert len(harness["rating"]) == 1
    call = harness["rating"][0]
    assert call["session_key"] == "s1"
    assert call["link_token"] == TOKEN, (
        "the run rating must be scoped to the public link the caller is on; "
        "session keys are client-chosen"
    )
    assert call["rating"] == "down"


def test_a_public_rating_never_touches_knowledge(harness):
    _save(RATED)
    assert harness["knowledge"] == [], (
        "an anonymous rating reached institutional Knowledge. V1 policy: a public "
        "rating changes only the verified run's rating."
    )


def test_fabricated_assistant_text_cannot_mutate_knowledge(harness):
    forged = [{"role": "assistant",
               "content": "Doanh thu tháng 9 tăng 300% nhờ chiến dịch X — đã xác thực.",
               "rating": "down"}]
    _save(forged)
    assert harness["knowledge"] == []


def test_replaying_the_same_snapshot_has_no_accumulating_trust_effect(harness):
    """Five saves of one rated transcript. The run layer writes a value, so the
    repeats are harmless there; Knowledge must see nothing at all."""
    for _ in range(5):
        _save(RATED)
    assert harness["knowledge"] == []
    assert {c["rating"] for c in harness["rating"]} == {"down"}


def test_an_invalid_rating_is_dropped_before_any_side_effect(harness):
    _save([{"role": "assistant", "content": "x", "rating": "definitely"}])
    assert harness["rating"] == []
    assert harness["knowledge"] == []


def test_unrated_messages_trigger_nothing(harness):
    _save([{"role": "assistant", "content": "x"}])
    assert harness["rating"] == []


def test_the_endpoint_source_no_longer_reaches_for_knowledge_feedback():
    """Belt and braces for a refactor that bypasses the spy by importing the
    function under another name."""
    src = inspect.getsource(inspect.unwrap(public.save_ai_chat_session))
    code = "\n".join(l for l in src.splitlines() if not l.strip().startswith("#"))
    assert "apply_feedback" not in code
    assert "dashboard_ai_bot import knowledge" not in code


def test_the_saved_transcript_keeps_rating_and_failed_flag(harness):
    """Every turn re-saves the whole session. The stored snapshot is what a
    reload shows, so it must carry the verdict — and the failed-turn flag that
    keeps an error bubble unratable."""
    db = _DB()
    fn = inspect.unwrap(public.save_ai_chat_session)
    msgs = RATED + [{"role": "user", "content": "q2"},
                    {"role": "assistant", "content": "Lỗi: hết thời gian.", "failed": True},
                    {"role": "user", "content": "q3", "failed": True}]
    body = AiChatSessionSave(session_key="s1", messages=msgs)
    asyncio.run(fn(token=TOKEN, session_key="s1", body=body, request=None, db=db, x_public_session=None))
    stored = db.added[0].messages
    assert stored[1]["rating"] == "down"
    assert stored[3].get("failed") is True
    assert "failed" not in stored[4], "only an assistant bubble can be a failed turn"
