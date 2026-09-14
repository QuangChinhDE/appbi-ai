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
from typing import Any

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
from app.services.agent_flows import chat_quota, direct_chat
from app.services.agent_flows import dispatch
from app.services.agent_flows.tools.context import CHAT_USER, ToolContext
from app.services.agent_flows.wire import event_to_envelope
from app.services.dashboard_ai_bot.public_link_config import deployment_key

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


class Ask(BaseModel):
    question: str = Field(min_length=1, max_length=4000)


def _thread_dict(t: Any) -> dict:
    return {
        "id": t.id,
        "brain_key": t.brain_key,
        "title": t.title or "",
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "last_active_at": t.last_active_at.isoformat() if t.last_active_at else None,
    }


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
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: Any = Depends(can_chat),
):
    """One row per flow — the published version, already filtered to what runs here.

    The flow BODY is never returned. It carries the author's prompts and the ids of
    every document and dataset the flow reads, none of which is the reader's business.
    """
    out = []
    for row, flow in direct_chat.published_chat_brains(db, user):
        out.append({
            "brain_key": row.brain_key,
            "name": row.name,
            "description": row.description or "",
            "version": row.version,
            "flow_id": row.flow_id,
            "knowledge_count": len(flow.bound_sources()),
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
    return _thread_dict(thread)


@router.get("/threads")
def list_threads(
    brain_key: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    _: Any = Depends(can_chat),
):
    return {
        "threads": [
            _thread_dict(t) for t in direct_chat.list_threads(db, user, brain_key)
        ]
    }


@router.get("/threads/{thread_id}")
def read_thread(
    thread_id: int,
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
        message = (
            "Bạn đọc được cuộc trò chuyện này, nhưng trợ lý đứng sau nó chưa được "
            "chia sẻ cho bạn — nên bạn chưa hỏi tiếp được."
        )
    if not reason and access in ("view", "full"):
        reason = "shared_read_only" if access == "view" else "oversight_read_only"
        message = (
            "Bạn đang xem một cuộc trò chuyện được chia sẻ ở mức chỉ đọc."
            if access == "view" else
            "Bạn đang xem cuộc trò chuyện của người khác với quyền giám sát."
        )
    return {
        **_thread_dict(thread),
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

    verdict = chat_quota.check_chat_quota(db, user)
    if not verdict.allowed:
        raise HTTPException(status_code=429, detail=verdict.message)

    row, flow, problem = direct_chat.resolve_for_chat(db, user, thread.brain_key)

    # A flow whose every step carries its own key needs nothing from the deployment.
    # Asked before demanding one, so a self-sufficient flow is not blocked by a
    # server that happens to have no OPENAI_API_KEY.
    # The provider travels WITH the key. A node set to `inherit` has nothing to
    # inherit otherwise, and the runtime's vendor dispatch fails on an empty provider
    # string with "nhà cung cấp không hỗ trợ" — an error that reads like a
    # configuration problem when it is really a dropped return value.
    api_key, provider = "", ""
    if flow is not None and flow.steps_missing_credentials():
        api_key, provider = deployment_key()
        if not api_key:
            raise HTTPException(
                status_code=409,
                detail="Máy chủ chưa có API key cho AI — chưa chat được. "
                       "Liên hệ quản trị viên để cấu hình.",
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
        api_key=api_key,
        provider=provider,
        locale="vi",
    )

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
                        "text": "Câu hỏi chạy quá lâu và đã bị dừng.",
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
                            "text": "Trợ lý không phản hồi và đã bị dừng.",
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
            yield _frame({"type": "error", "text": "Có lỗi khi chạy trợ lý."})
        finally:
            if pending is not None:
                pending.cancel()
            await agen.aclose()
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


def _frame(payload: dict) -> str:
    return f"data: {_json.dumps(payload, ensure_ascii=False, default=str)}\n\n"
