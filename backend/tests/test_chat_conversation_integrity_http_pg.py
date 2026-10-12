"""Direct Chat conversation integrity, asserted at the HTTP boundary on Postgres.

Each test is one defect found in the Chat hardening audit (2026-10-12):

  H1  `chat: full` is oversight. The thread view told that person the conversation
      was read-only while the turn path let them append to somebody else's record.
  H3  A stored answer lost its typed blocks (metric/table/...) on reload — the
      transcript returned prose only, so a metric-only answer came back empty.
  H4  Run content is pruned after 180 days, and in Chat the run content IS the
      transcript: a live conversation silently lost its words.
  H5  A reader could not rate an answer; the only rating route demanded authoring
      rights on the flow.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg


def _thread(db, owner, *, brain_key="chat-hardening-missing", deleted=False):  # noqa: F811
    from app.models.agent_flow_chat_thread import AgentFlowChatThread

    t = AgentFlowChatThread(
        user_id=owner.id, brain_key=brain_key, title="t",
        session_key=f"dc_{uuid.uuid4().hex}",
        deleted_at=datetime.now(timezone.utc) if deleted else None,
    )
    db.add(t)
    db.commit()
    return t


def _run(db, thread, *, answer="", envelope=None, age_days=0, status="ok"):  # noqa: F811
    from app.models.agent_flow_run import AgentFlowRun, AgentFlowRunContent

    at = datetime.now(timezone.utc) - timedelta(days=age_days)
    run = AgentFlowRun(
        run_key=f"r_{uuid.uuid4().hex}", brain_key=thread.brain_key if thread else "x",
        chat_thread_id=thread.id if thread else None, status=status,
        trigger="direct_chat", question_norm="q", created_at=at,
    )
    db.add(run)
    db.flush()
    db.add(AgentFlowRunContent(
        run_id=run.id, question="Doanh thu tháng này?", answer=answer,
        citations=[], notices=[], output_envelope=envelope, created_at=at,
    ))
    db.commit()
    return run


@pytest.fixture()
def people(db):  # noqa: F811
    return dict(
        owner=make_user(db, "ch-owner", chat="edit"),
        admin=make_user(db, "ch-admin", chat="full"),
        viewer=make_user(db, "ch-viewer", chat="view"),
        editor=make_user(db, "ch-editor", chat="edit"),
        stranger=make_user(db, "ch-stranger", chat="edit"),
    )


# ── H1 ─────────────────────────────────────────────────────────────────────────
def test_oversight_cannot_append_to_someone_elses_conversation(client, db, people):  # noqa: F811
    t = _thread(db, people["owner"])
    detail = client.get(f"/api/v1/agent-flows/chat/threads/{t.id}", headers=people["admin"].headers)
    assert detail.status_code == 200 and detail.json()["access"] == "full"

    r = client.post(f"/api/v1/agent-flows/chat/threads/{t.id}/messages",
                    headers=people["admin"].headers, json={"question": "hello"})
    assert r.status_code == 403, r.text

    from app.models.agent_flow_run import AgentFlowRun
    db.expire_all()
    assert db.query(AgentFlowRun).filter(AgentFlowRun.chat_thread_id == t.id).count() == 0


def test_view_share_cannot_append_but_edit_share_can_reach_the_engine(client, db, people):  # noqa: F811
    t = _thread(db, people["owner"])
    share(db, "chat_thread", t.id, people["viewer"], "view", people["owner"])
    share(db, "chat_thread", t.id, people["editor"], "edit", people["owner"])

    r = client.post(f"/api/v1/agent-flows/chat/threads/{t.id}/messages",
                    headers=people["viewer"].headers, json={"question": "hello"})
    assert r.status_code == 403, r.text

    # The editor passes the thread gate; the flow does not exist, so the ENGINE
    # refuses inside the stream — which proves the thread gate let them through.
    r = client.post(f"/api/v1/agent-flows/chat/threads/{t.id}/messages",
                    headers=people["editor"].headers, json={"question": "hello"})
    assert r.status_code == 200, r.text
    assert '"blocked"' in r.text and "not_published" in r.text


# ── H3 ─────────────────────────────────────────────────────────────────────────
def test_restored_answer_keeps_its_blocks_and_stays_reader_safe(client, db, people):  # noqa: F811
    from app.services.agent_flows.envelope import (
        Answer, FlowOutput, MetricBlock, TableBlock, Column, Notice,
    )

    out = FlowOutput(
        run_id="r1",
        answer=Answer(blocks=[
            MetricBlock(label="Doanh thu", value=8043020000, format="currency"),
            TableBlock(columns=[Column(key="m", label="Tháng")], rows=[{"m": "T9"}]),
        ]),
        notices=[Notice(code="author_only_diag", text="secret trace", audience="author")],
    )
    t = _thread(db, people["owner"])
    _run(db, t, answer="", envelope=out.to_dict())

    r = client.get(f"/api/v1/agent-flows/chat/threads/{t.id}", headers=people["owner"].headers)
    assert r.status_code == 200, r.text
    msgs = r.json()["messages"]
    assistant = [m for m in msgs if m["role"] == "assistant"]
    assert len(assistant) == 1, msgs
    blocks = assistant[0]["blocks"]
    assert [b["type"] for b in blocks] == ["metric", "table"]
    assert blocks[0]["value"] == 8043020000
    assert "secret trace" not in r.text


# ── H4 ─────────────────────────────────────────────────────────────────────────
def test_prune_keeps_live_conversations_and_ages_out_the_rest(db, people):  # noqa: F811
    from app.models.agent_flow_run import AgentFlowRunContent
    from app.services.agent_flows.runs import prune

    live = _thread(db, people["owner"])
    gone = _thread(db, people["owner"], deleted=True)
    keep = _run(db, live, answer="kept", age_days=400)
    drop_deleted = _run(db, gone, answer="dropped", age_days=400)
    drop_bot = _run(db, None, answer="bot", age_days=400)
    fresh_bot = _run(db, None, answer="fresh", age_days=1)

    prune(db, content_days=180, step_days=30)
    db.expire_all()
    left = {c.run_id for c in db.query(AgentFlowRunContent).filter(AgentFlowRunContent.run_id.in_(
        [keep.id, drop_deleted.id, drop_bot.id, fresh_bot.id])).all()}
    assert left == {keep.id, fresh_bot.id}


# ── H5 ─────────────────────────────────────────────────────────────────────────
def test_reader_rates_an_answer_in_their_conversation(client, db, people):  # noqa: F811
    from app.models.agent_flow_run import AgentFlowRun

    t = _thread(db, people["owner"])
    other = _thread(db, people["stranger"])
    run = _run(db, t, answer="42")
    foreign = _run(db, other, answer="7")
    share(db, "chat_thread", t.id, people["viewer"], "view", people["owner"])
    base = f"/api/v1/agent-flows/chat/threads/{t.id}/runs"

    r = client.post(f"{base}/{run.id}/rating", headers=people["owner"].headers, json={"rating": "down"})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.get(AgentFlowRun, run.id).rating == "down"

    # The rating is restored with the transcript.
    msgs = client.get(f"/api/v1/agent-flows/chat/threads/{t.id}", headers=people["owner"].headers).json()["messages"]
    assert [m.get("rating") for m in msgs if m["role"] == "assistant"] == ["down"]

    # A run from another conversation cannot be rated through this one.
    r = client.post(f"{base}/{foreign.id}/rating", headers=people["owner"].headers, json={"rating": "up"})
    assert r.status_code == 404, r.text
    # A stranger cannot see the thread at all; a read-only sharee may not judge it.
    r = client.post(f"{base}/{run.id}/rating", headers=people["stranger"].headers, json={"rating": "up"})
    assert r.status_code == 404, r.text
    r = client.post(f"{base}/{run.id}/rating", headers=people["viewer"].headers, json={"rating": "up"})
    assert r.status_code == 403, r.text
    db.expire_all()
    assert db.get(AgentFlowRun, run.id).rating == "down"
    assert db.get(AgentFlowRun, foreign.id).rating is None

    r = client.post(f"{base}/{run.id}/rating", headers=people["owner"].headers, json={"rating": None})
    assert r.status_code == 200
    db.expire_all()
    assert db.get(AgentFlowRun, run.id).rating is None


# ── list ownership ────────────────────────────────────────────────────────────
def test_thread_list_says_which_rows_are_mine(client, db, people):  # noqa: F811
    mine = _thread(db, people["owner"])
    theirs = _thread(db, people["stranger"])
    share(db, "chat_thread", theirs.id, people["owner"], "view", people["stranger"])

    rows = client.get("/api/v1/agent-flows/chat/threads", headers=people["owner"].headers).json()["threads"]
    by_id = {r["id"]: r for r in rows}
    assert by_id[mine.id]["is_owner"] is True
    assert by_id[theirs.id]["is_owner"] is False


# ── H8 ─────────────────────────────────────────────────────────────────────────
def test_turn_runs_in_the_readers_language(client, db, people, monkeypatch):  # noqa: F811
    from app.services.agent_flows import dispatch
    from app.services.dashboard_ai_bot.events import AgentEvent

    seen = {}

    async def fake_run(db, **kw):
        seen["locale"] = kw.get("locale")
        yield AgentEvent(type="done")

    monkeypatch.setattr(dispatch, "run_for_chat_thread", fake_run)
    t = _thread(db, people["owner"])
    r = client.post(f"/api/v1/agent-flows/chat/threads/{t.id}/messages",
                    headers=people["owner"].headers, json={"question": "hi", "lang": "en"})
    assert r.status_code == 200, r.text
    assert seen["locale"] == "en"

    r = client.post(f"/api/v1/agent-flows/chat/threads/{t.id}/messages",
                    headers=people["owner"].headers, json={"question": "hi", "lang": "fr"})
    assert r.status_code == 422


# ── H10 ────────────────────────────────────────────────────────────────────────
def test_thread_says_up_front_when_the_rollout_would_refuse(client, db, people, monkeypatch):  # noqa: F811
    from app.services.agent_flows import direct_chat, dispatch

    monkeypatch.setattr(direct_chat, "resolve_for_chat",
                        lambda db, user, key: (type("R", (), {"name": "A"})(), None, ""))
    monkeypatch.setattr(dispatch, "_reader_gate", lambda **kw: "pilot_not_enrolled")
    t = _thread(db, people["owner"])
    body = client.get(f"/api/v1/agent-flows/chat/threads/{t.id}?lang=en",
                      headers=people["owner"].headers).json()
    assert body["readonly_reason"] == "pilot_not_enrolled"
    assert "pilot" in body["readonly_message"]

    monkeypatch.setattr(dispatch, "_reader_gate", lambda **kw: None)
    body = client.get(f"/api/v1/agent-flows/chat/threads/{t.id}", headers=people["owner"].headers).json()
    assert body["readonly_reason"] == ""


# ── stream lifecycle ──────────────────────────────────────────────────────────
def test_a_stalled_turn_ends_with_an_error_and_a_terminator(client, db, people, monkeypatch):  # noqa: F811
    """The idle watchdog cancelled the in-flight step and then called `aclose()` on
    a generator that was still running — `RuntimeError`, the stream died after the
    error frame, and the client never received `done`."""
    import asyncio

    from app.modules.agent_flows import chat_api
    from app.services.agent_flows import dispatch
    from app.services.dashboard_ai_bot.events import AgentEvent

    cleaned = {}

    async def stalled(db, **kw):
        try:
            yield AgentEvent(type="text", text="partial")
            await asyncio.sleep(60)
        finally:
            cleaned["ran"] = True

    monkeypatch.setattr(dispatch, "run_for_chat_thread", stalled)
    monkeypatch.setattr(chat_api, "KEEPALIVE_EVERY", 0.2)
    monkeypatch.setattr(chat_api, "IDLE_TIMEOUT", 0.5)
    t = _thread(db, people["owner"])
    r = client.post(f"/api/v1/agent-flows/chat/threads/{t.id}/messages",
                    headers=people["owner"].headers, json={"question": "hi"})
    assert r.status_code == 200
    frames = [line for line in r.text.splitlines() if line.startswith("data: ")]
    assert '"error"' in frames[-2], frames
    assert frames[-1] == 'data: {"type": "done"}', frames
    assert cleaned.get("ran") is True
