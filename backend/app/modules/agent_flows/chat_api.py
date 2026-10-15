"""API: /api/v1/agent-flows/chat/* — talking to a flow with no report on screen.

Its own module, not more routes in `api.py`, because the two answer different
questions: that file is the Studio's (author, version, publish, bind), this one is
the reader's (which assistants may I open, what did we say, ask the next thing).

NOT IN `api/public.py` EITHER. Everything there is anonymous by construction — the
caller is a link token, `ToolContext` defaults to `public_session`, and the knowledge
ceiling is "published and attached to this report". A route that carries a real user
placed among those would sooner or later inherit one of those defaults.

The layer is thin on purpose: eligibility and threads live in
`services/agent_flows/direct_chat.py`, the run path in `dispatch.run_for_chat_thread`,
the ceiling in `permissions.run_scope`. A rule that appears here is in the wrong file.
"""
from __future__ import annotations

import asyncio
import json as _json
import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import (
    get_current_user,
    module_floor,
    require_permission,
)
from app.models.user import User
from app.services.agent_flows import chat_quota, direct_chat, reader_capability
from app.services.agent_flows import dispatch
from app.services.agent_flows.tools.context import CHAT_USER, ToolContext
from app.services.agent_flows.wire import event_to_envelope

logger = logging.getLogger("app.agent_flows.chat")

#: A FLOOR ON THE ROUTER, not seven separate reminders.
#:
#: All seven endpoints below do carry `can_chat`, and an audit confirms it — but
#: that is the shape that has already failed in this codebase: seven list
#: endpoints across five modules answered `200 []` to a zero-permission user
#: because each was gated individually and each could be forgotten once. A floor
#: cannot be forgotten by the eighth endpoint somebody adds.
#:
#: `can_chat` stays on each handler. The floor is the cheaper question underneath
#: ("may this person open the module at all"); the per-endpoint gate is what the
#: handler's own contract states, and the two agreeing is the point.
router = APIRouter(
    prefix="/agent-flows/chat",
    tags=["agent-flows-chat"],
    # `module_floor` already returns a `Depends(...)` — see core/dependencies.py.
    dependencies=[module_floor("chat")],
)

#: The module floor, and nothing more. Chatting with a flow somebody shared with you
#: is not an authoring power, so it must not demand `edit`; `usable_brains` is what
#: decides WHICH flows, and it already fails closed on `none`.
#: ITS OWN KEY. This gated on `agent_flows` while AI Chat had no key of its own,
#: which meant the only way to let somebody ask an assistant a question was to
#: also let them into the flow builder.
can_chat = require_permission("chat", "view")

#: How long the stream may sit silent before it is declared dead, and how long one
#: turn may run in total. Matched to the public bot's, because the thing being waited
#: on — one reasoning-model call — is the same thing.
IDLE_TIMEOUT = 180.0
HARD_TIMEOUT = 600.0
KEEPALIVE_EVERY = 8.0


# ═══ Shapes ═══════════════════════════════════════════════════════════════════
class NewThread(BaseModel):
    brain_key: str = Field(min_length=1, max_length=64)


class RenameThread(BaseModel):
    title: str = Field(default="", max_length=255)


Lang = Literal["vi", "en"]


class Ask(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    #: The reader's UI language. It was hardcoded `"vi"` on this route, so an
    #: English reader got Vietnamese refusals and notices from the server while
    #: the screen around them was English.
    lang: Lang = "vi"


class Rate(BaseModel):
    rating: Literal["up", "down"] | None = None


#: Sentences this layer writes for a reader, in both UI languages. The client
#: translates by `readonly_reason` code first; these are what an older client, or
#: one that does not know the code, shows instead.
_TEXT: dict[str, dict[str, str]] = {
    "assistant_not_shared": {
        "vi": "Bạn đọc được cuộc trò chuyện này, nhưng trợ lý đứng sau nó chưa được "
              "chia sẻ cho bạn — nên bạn chưa hỏi tiếp được.",
        "en": "You can read this conversation, but its assistant has not been shared "
              "with you, so you cannot continue it.",
    },
    "shared_read_only": {
        "vi": "Bạn đang xem một cuộc trò chuyện được chia sẻ ở mức chỉ đọc.",
        "en": "This conversation was shared with you to read only.",
    },
    "oversight_read_only": {
        "vi": "Bạn đang xem cuộc trò chuyện của người khác với quyền giám sát.",
        "en": "You are viewing someone else's conversation with oversight access.",
    },
    "read_only_write": {
        "vi": "Bạn chỉ có quyền xem cuộc trò chuyện này, không thể hỏi tiếp hay đánh giá.",
        "en": "You can only read this conversation; you cannot continue or rate it.",
    },
    "turn_in_progress": {
        "vi": "Cuộc trò chuyện này đang có một câu hỏi chưa trả lời xong (có thể ở tab "
              "khác). Hãy đợi câu trả lời đó rồi hỏi tiếp.",
        "en": "This conversation is still answering another question (perhaps in another "
              "tab). Wait for that answer, then ask again.",
    },
    "rate_owner_only": {
        "vi": "Chỉ người tạo cuộc trò chuyện mới đánh giá được câu trả lời.",
        "en": "Only the person who started this conversation can rate its answers.",
    },
    "stream_too_long": {
        "vi": "Câu hỏi chạy quá lâu và đã bị dừng.",
        "en": "The question ran too long and was stopped.",
    },
    "stream_idle": {
        "vi": "Trợ lý không phản hồi và đã bị dừng.",
        "en": "The assistant stopped responding, so the turn was ended.",
    },
    "stream_failed": {
        "vi": "Có lỗi khi chạy trợ lý.",
        "en": "Something went wrong while running the assistant.",
    },
    "missing_credential": {
        "vi": "Trợ lý này chưa được cấu hình AI key nên chưa chat được. "
              "Vui lòng liên hệ tác giả của trợ lý.",
        "en": "This assistant has no AI key configured yet, so it cannot chat. "
              "Please contact its author.",
    },
}


def _text(key: str, lang: str) -> str:
    entry = _TEXT.get(key) or {}
    return entry.get(lang) or entry.get("vi") or ""


def _thread_dict(t: Any, user: Any = None) -> dict:
    out = {
        "id": t.id,
        "brain_key": t.brain_key,
        "title": t.title or "",
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "last_active_at": t.last_active_at.isoformat() if t.last_active_at else None,
    }
    if user is not None:
        # Rename and delete are the owner's (`_require_owner`). The list says
        # which rows those are, so the sidebar stops offering a pencil and a bin
        # on a colleague's shared conversation that would only answer 403.
        out["is_owner"] = str(t.user_id) == str(getattr(user, "id", ""))
        # MANAGE (rename, delete) is the owner's — and `chat: full`'s, which
        # manages anything in the module the way `full` does in every module
        # (`_require_owner`). Managing is not speaking: `full` still may not add a
        # turn or rate one. The client offers exactly what this says.
        out["can_manage"] = out["is_owner"] or direct_chat._is_module_admin(user, "chat")
    return out


def _availability(db: Session, user: Any, flow: Any) -> str:
    """Why this reader cannot get an answer right now, or "" when they can.

    The SAME two gates the turn applies — rollout policy, then a usable key per
    step — asked up front, so the catalogue and the input box say it before a
    question is spent finding out. Policy is reported here, never changed.
    """
    gate = dispatch._reader_gate(user_email=getattr(user, "email", None))
    if gate:
        return gate
    if flow is not None:
        from app.services.agent_flows.credentials import StoredCredentials

        if StoredCredentials(db).problems(flow):
            return "missing_credential"
    return ""


# ═══ Which assistants may I open ══════════════════════════════════════════════
def _require_owner(db: Session, user: Any, thread: Any, action: str) -> None:
    """Renaming and deleting belong to the person who started the conversation.

    Being given a conversation — even at `edit`, which lets you ask the next
    question in it — does not make it yours to rename or throw away. `chat: full`
    is oversight and manages anything, the way `full` does in every module.
    """
    if direct_chat.thread_access(db, user, thread) in ("owner", "full"):
        return
    raise HTTPException(
        status_code=403,
        detail=f"Chỉ người tạo cuộc trò chuyện mới {action} được.",
    )


@router.get("/brains")
def list_chat_brains(
    lang: str = "vi",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: Any = Depends(can_chat),
):
    """One row per flow — the published version, already filtered to what runs here.

    The flow BODY is never returned. It carries the author's prompts and the ids of
    every document and dataset the flow reads, none of which is the reader's business.
    """
    out = []
    lang = "en" if lang == "en" else "vi"
    for row, flow in direct_chat.published_chat_brains(db, user):
        unavailable = _availability(db, user, flow)
        out.append({
            "brain_key": row.brain_key,
            "name": row.name,
            "description": row.description or "",
            "version": row.version,
            "flow_id": row.flow_id,
            "knowledge_count": len(flow.bound_sources()),
            # ADDITIVE, and RECOMPUTED for this surface rather than projected from
            # the author's coverage view. `coverage()` describes the FLOW's grants
            # and carries tool names, pack names, node keys and document ids —
            # none of it the reader's business — and Chat refuses tools the flow
            # was granted, so the author's answer would also be the wrong answer.
            "capability": reader_capability.capability(flow, surface="chat", lang=lang),
            # Listed even when it cannot answer for this reader (pilot not open to
            # them, no key yet): hiding it would make "where did my assistant go"
            # unanswerable. The code says why; the client words it.
            "available": not unavailable,
            "unavailable_reason": unavailable,
        })
    return {"brains": out}


# ═══ Threads ══════════════════════════════════════════════════════════════════
@router.post("/threads")
def create_thread(
    body: NewThread,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: Any = Depends(can_chat),
):
    _, _flow, problem = direct_chat.resolve_for_chat(db, user, body.brain_key)
    if problem:
        # 404 for everything, deliberately. "This flow exists but you may not chat
        # with it" is a directory of other people's flows, and the same argument the
        # Studio already makes for reading one.
        raise HTTPException(status_code=404, detail="Không tìm thấy trợ lý này")
    thread = direct_chat.create_thread(db, user, body.brain_key)
    return _thread_dict(thread, user)


@router.get("/threads")
def list_threads(
    brain_key: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: Any = Depends(can_chat),
):
    return {
        "threads": [
            _thread_dict(t, user) for t in direct_chat.list_threads(db, user, brain_key)
        ]
    }


@router.get("/threads/{thread_id}")
def read_thread(
    thread_id: int,
    lang: Lang = "vi",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: Any = Depends(can_chat),
):
    thread = direct_chat.get_thread(db, user, thread_id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy cuộc trò chuyện")

    access = direct_chat.thread_access(db, user, thread)

    # The flow's CURRENT state, resolved now rather than remembered: a thread whose
    # flow was unpublished or has grown a report-reading step must open read-only,
    # and the client needs to know that before it renders an input box.
    row, _flow, problem = direct_chat.resolve_for_chat(db, user, thread.brain_key)

    # TWO SEPARATE REASONS A CONVERSATION IS READ-ONLY, and conflating them would
    # tell somebody to go fix the wrong thing.
    #
    #   the flow      unpublished, or shaped so it cannot run here — the author's
    #                 problem, and `resolve_for_chat` already words it.
    #   this person   they were handed the conversation to READ, or they can read
    #                 it but may not use the assistant behind it. Sharing a
    #                 transcript never grants the flow; that stays with the flow's
    #                 own share, which is the one gate for "who may ask".
    reason, message = problem or "", direct_chat.BLOCK_MESSAGES.get(problem, "") if problem else ""
    if reason == "not_published" and access != "owner":
        # THE VAGUE WORDING IS FOR STRANGERS, AND THIS PERSON IS NOT ONE.
        #
        # `resolve_for_chat` answers `not_published` for "never yours", "no longer
        # yours" and "no published version" alike, on purpose: telling them apart
        # would tell a caller which flows exist. But somebody reading a
        # conversation that was deliberately shared with them already knows this
        # assistant exists — its name is two fields above — so the vagueness
        # protects nothing here and only sends them to ask the wrong question.
        reason = "assistant_not_shared"
        message = _text(reason, lang)
    if not reason and not direct_chat.may_write(access):
        reason = "shared_read_only" if access == "view" else "oversight_read_only"
        message = _text(reason, lang)
    if not reason:
        # The flow runs and this person may write — but the rollout policy or a
        # missing key would still refuse every question. Said before they type.
        gate = _availability(db, user, _flow)
        if gate:
            reason = gate
            message = _text(gate, lang) or dispatch._block_message(gate)
    return {
        **_thread_dict(thread, user),
        "brain_name": (row.name if row is not None else thread.brain_key),
        #: `owner` · `edit` · `view` · `full` — what the client may offer. It drives
        #: the input box, the rename field and the Share button in one value rather
        #: than three guesses.
        "access": access,
        "readonly_reason": reason,
        "readonly_message": message,
        "messages": direct_chat.transcript(db, thread),
    }


@router.patch("/threads/{thread_id}")
def rename_thread(
    thread_id: int,
    body: RenameThread,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: Any = Depends(can_chat),
):
    thread = direct_chat.get_thread(db, user, thread_id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy cuộc trò chuyện")
    _require_owner(db, user, thread, "đổi tên")
    thread.title = (body.title or "").strip()[:255] or None
    db.commit()
    return _thread_dict(thread)


@router.delete("/threads/{thread_id}")
def delete_thread(
    thread_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: Any = Depends(can_chat),
):
    thread = direct_chat.get_thread(db, user, thread_id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy cuộc trò chuyện")
    _require_owner(db, user, thread, "xoá")
    direct_chat.soft_delete(db, thread)
    # THE CONVERSATION'S MEMORY GOES WITH IT. The transcript ages out on the
    # run-content window; the facts the assistant carried between turns live in
    # `ai_chat_sessions` and nothing ever pruned them, so a deleted conversation
    # kept its memory forever. Nothing reads it after deletion.
    _forget_memory(db, thread.session_key)
    return {"ok": True}


# ═══ The turn ═════════════════════════════════════════════════════════════════
@router.post("/threads/{thread_id}/messages")
async def send_message(
    thread_id: int,
    body: Ask,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: Any = Depends(can_chat),
):
    """Ask the next question. Streams the same SSE the public bot streams.

    THE THREE CHECKS THAT HAPPEN BEFORE A SINGLE TOKEN IS SPENT, in this order and
    all failing as plain HTTP because the stream has not opened yet:

      own the thread      404 — a thread id is not a capability
      quota               429 — the ceiling is per user per day, above the run budget
      a key to call with  409 — the deployment has none and no step brought one

    Everything after that is the engine's, and its refusals arrive INSIDE the stream
    as a `blocked` envelope with a code, which is the only channel that carries one.
    """
    thread = direct_chat.get_thread(db, user, thread_id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy cuộc trò chuyện")

    # READING IS NOT WRITING. A `view` share and `chat: full` oversight both open
    # the transcript, and neither may add to it. Refused as HTTP before the stream
    # — and before quota is spent — so the client gets a status, not a 200 that
    # merely says no. The engine re-checks on the way in (`run_for_chat_thread`).
    if not direct_chat.may_write(direct_chat.thread_access(db, user, thread)):
        raise HTTPException(status_code=403, detail=_text("read_only_write", body.lang))

    verdict = chat_quota.check_chat_quota(db, user)
    if not verdict.allowed:
        detail = verdict.message
        if body.lang == "en":
            detail = (
                f"You have used all {verdict.limit_runs} AI chat turns allowed in 24 hours "
                f"({verdict.runs_today}/{verdict.limit_runs}). Try again later — the "
                f"limit counts the last 24 hours."
            )
        raise HTTPException(status_code=429, detail=detail)

    row, flow, problem = direct_chat.resolve_for_chat(db, user, thread.brain_key)

    # EVERY STEP RUNS ON ITS OWN STORED KEY — refused here, before the stream opens,
    # when any step has none it can use. There is no server key to fall back to.
    if flow is not None:
        from app.services.agent_flows.credentials import StoredCredentials

        if StoredCredentials(db).problems(flow):
            raise HTTPException(
                status_code=409, detail=_text("missing_credential", body.lang),
            )

    history = direct_chat.history_turns(db, thread)
    thread_id_value = thread.id

    # `dashboard=None` is the whole point: there is no report, and a stub row would
    # make every report-reading tool believe otherwise. `CHAT_USER` is what makes the
    # knowledge ceiling honour this reader's own grants and what makes `remember_fact`
    # refuse — a flow shared with someone must not let them rewrite what it knows.
    ctx = ToolContext(
        db=db,
        dashboard=None,
        public_filters=[],
        actor_type=CHAT_USER,
        actor_ref=getattr(user, "email", None) or str(getattr(user, "id", "")),
    )

    # Ids, not the objects: the stream body runs after this request's session has
    # been closed, which detaches everything loaded here. `run_for_chat_thread`
    # reloads both and re-checks ownership on the way in.
    agen = dispatch.run_for_chat_thread(
        db,
        thread_id=thread_id_value,
        user_id=user.id,
        ctx=ctx,
        question=body.question,
        history=history,
        locale=body.lang,
    )

    lang = body.lang

    # ONE ACTIVE TURN PER CONVERSATION. Two tabs (or an owner and an editor)
    # asking at once each read the history and memory before the other wrote, so
    # the second answer was built on a stale conversation and the last memory
    # write won. Taken before the stream opens so the refusal is a plain status;
    # released only after the turn's own record is written (end of the stream).
    turn_lock = _ThreadTurnLock.acquire(thread_id_value)
    if turn_lock is None:
        await agen.aclose()
        raise HTTPException(status_code=423, detail=_text("turn_in_progress", lang))

    async def sse_stream():
        loop = asyncio.get_event_loop()
        started = loop.time()
        last_event = started
        pending: asyncio.Future | None = None
        sent_done = False
        try:
            while True:
                if loop.time() - started > HARD_TIMEOUT:
                    yield _frame({
                        "type": "error",
                        "text": _text("stream_too_long", lang),
                    })
                    break
                # `asyncio.wait`, never `wait_for`: the latter CANCELS what it waits
                # on, which on the public path killed the very model call the
                # keepalive existed to wait for.
                if pending is None:
                    pending = asyncio.ensure_future(agen.__anext__())
                finished, _ = await asyncio.wait({pending}, timeout=KEEPALIVE_EVERY)
                try:
                    if not finished:
                        raise asyncio.TimeoutError
                    ev = pending.result()
                    pending = None
                except StopAsyncIteration:
                    pending = None
                    break
                except asyncio.TimeoutError:
                    if loop.time() - last_event > IDLE_TIMEOUT:
                        yield _frame({
                            "type": "error",
                            "text": _text("stream_idle", lang),
                        })
                        break
                    # A comment frame: SSE ignores it, every proxy counts it as
                    # traffic, and the connection stops looking dead.
                    yield ": keepalive\n\n"
                    continue

                last_event = loop.time()
                envelope = event_to_envelope(ev)
                if envelope is not None:
                    if envelope.get("type") == "done":
                        sent_done = True
                    yield _frame(envelope)
        except Exception:  # noqa: BLE001
            logger.exception("[chat] stream failed for thread %s", thread_id)
            yield _frame({"type": "error", "text": _text("stream_failed", lang)})
        finally:
            # CANCEL, THEN LET IT FINISH, THEN CLOSE. `pending` is a task still
            # INSIDE the generator; `aclose()` on a generator that is running
            # raises RuntimeError, which killed the stream before the `done` below
            # on every timeout. The cancelled task runs the turn's own `finally` —
            # the one that records an abandoned turn — so it is waited for, briefly.
            if pending is not None:
                pending.cancel()
                try:
                    await asyncio.wait({pending}, timeout=5.0)
                except BaseException:  # noqa: BLE001 — a disconnect cancels us too
                    pass
            try:
                await agen.aclose()
            except RuntimeError:
                # Still running only if the cancelled step ignored cancellation for
                # 5s; its task finishes on its own and records the turn there.
                logger.warning("[chat] turn generator still running at close (thread %s)", thread_id)
            turn_lock.release()
            # The engine ends every run with `done`; this is for the paths that never
            # reached it — a timeout, or an exception — so the client always has a
            # terminator to stop on rather than waiting out its own idle timer.
            if not sent_done:
                yield _frame({"type": "done"})

    return StreamingResponse(
        sse_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


def _forget_memory(db: Session, session_key: str | None) -> None:
    if not session_key:
        return
    from app.models.ai_chat_session import AiChatSession

    try:
        db.query(AiChatSession).filter(AiChatSession.session_key == session_key).delete(
            synchronize_session=False)
        db.commit()
    except Exception:  # noqa: BLE001 — the delete itself already succeeded
        db.rollback()
        logger.warning("[chat] memory not cleared for a deleted thread", exc_info=True)


# ═══ Judging an answer ════════════════════════════════════════════════════════
@router.post("/threads/{thread_id}/runs/{run_id}/rating")
def rate_answer(
    thread_id: int,
    run_id: int,
    body: Rate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: Any = Depends(can_chat),
):
    """Thumbs up or down on ONE answer, by the person it was given to.

    The Studio's rating route demands authoring rights on the flow — right for an
    author grading runs, wrong for the reader who actually received the answer.
    This one is scoped by the CONVERSATION instead: the run must belong to this
    thread, and the caller must be the conversation's OWNER.

    ONE RATING PER ANSWER, AND IT IS THE OWNER'S. The verdict lands on the run
    (`agent_flow_runs.rating`, the field the author's Runs tab filters by), so it
    has exactly one holder. Letting an `edit` sharee rate too meant two people
    silently overwriting each other's verdict on one row. A run does not record
    who asked a turn, so "the asker" cannot be the holder without a schema change;
    the owner is the person the conversation — and its feedback — belongs to.
    """
    thread = direct_chat.get_thread(db, user, thread_id)
    if thread is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy cuộc trò chuyện")
    if direct_chat.thread_access(db, user, thread) != "owner":
        raise HTTPException(status_code=403, detail=_text("rate_owner_only", "vi"))

    from app.models.agent_flow_run import AgentFlowRun

    run = (
        db.query(AgentFlowRun)
        .filter(AgentFlowRun.id == run_id, AgentFlowRun.chat_thread_id == thread.id)
        .first()
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy câu trả lời")
    run.rating = body.rating
    db.commit()
    return {"ok": True, "run_id": run.id, "rating": run.rating}


class _ThreadTurnLock:
    """A Postgres session advisory lock on (CHAT, thread id), held for one turn.

    On its OWN connection from a non-pooled engine: the lock lives for the whole
    stream, and holding a pooled connection that long would drain the pool the
    request path needs. Closing the connection releases the lock, so a crashed
    worker cannot leave a conversation locked. Not Postgres (SQLite tests): no-op.
    """

    _KEY = 0x43484154  # "CHAT"
    _engine = None

    def __init__(self, conn: Any, thread_id: int):
        self._conn = conn
        self._thread_id = thread_id

    @classmethod
    def _eng(cls):
        if cls._engine is None:
            from sqlalchemy import create_engine
            from sqlalchemy.pool import NullPool

            from app.core.database import app_engine

            cls._engine = create_engine(app_engine.url, poolclass=NullPool)
        return cls._engine

    @classmethod
    def acquire(cls, thread_id: int) -> "_ThreadTurnLock | None":
        from app.core.database import app_engine
        from sqlalchemy import text

        if app_engine.dialect.name != "postgresql":
            return cls(None, thread_id)
        conn = cls._eng().connect()
        got = conn.execute(text("SELECT pg_try_advisory_lock(:k, :t)"),
                           {"k": cls._KEY, "t": int(thread_id)}).scalar()
        conn.commit()
        if not got:
            conn.close()
            return None
        return cls(conn, thread_id)

    def release(self) -> None:
        if self._conn is None:
            return
        from sqlalchemy import text

        try:
            self._conn.execute(text("SELECT pg_advisory_unlock(:k, :t)"),
                               {"k": self._KEY, "t": int(self._thread_id)})
        except Exception:  # noqa: BLE001 — closing releases it regardless
            logger.warning("[chat] turn lock unlock failed (thread %s)", self._thread_id)
        finally:
            self._conn.close()
            self._conn = None

    def __del__(self):  # a stream that never started still frees the lock
        try:
            self.release()
        except Exception:  # noqa: BLE001
            pass


def _frame(payload: dict) -> str:
    return f"data: {_json.dumps(payload, ensure_ascii=False, default=str)}\n\n"
