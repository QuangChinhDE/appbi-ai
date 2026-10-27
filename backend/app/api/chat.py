"""AI Chat API: the ONE place a signed-in person asks a question.

Contract: docs/features/unified-ai-chat/contract.md. The Data Core answers through
the Governed Query Service under the asker's identity; an Agent Flow bound to a
conversation is an optional extension. No Flow is needed to ask anything.

Gate: the `chat` module (router floor + per-route `chat: view`). Which DATA a turn
may touch is decided per Dataset by GQS (EXPLORE relation, GovernAIScope) on every
read, and every stored answer is re-checked against each reader
(services/chat/conversations.py).

  GET    /chat/catalog                         what I may ask about; Flows I may add
  GET    /chat/conversations                   mine and shared with me
  POST   /chat/conversations                   start one (no Flow needed)
  GET    /chat/conversations/{id}              its turns, redacted for me
  PATCH  /chat/conversations/{id}              rename; bind/unbind an extension (owner)
  DELETE /chat/conversations/{id}              soft delete (owner, `chat: full`)
  POST   /chat/conversations/{id}/turns        ask: SSE `accepted`, `status`*,
                                               `extension`*, `final`, `done`
  POST   /chat/turns/{turn_id}/cancel          stop my running turn
  POST   /chat/turns/{turn_id}/feedback        my verdict on my answer
  POST   /chat/consents                        I accept a dropped filter
  GET    /chat/legacy/{kind}/{legacy_id}       an old Analyst/Flow-chat link -> its conversation

The turn runs as a server-side task: closing the page does not lose it (a reload
shows it), and only the asker's explicit cancel stops it.
"""
from __future__ import annotations

import asyncio
import json as _json
import logging
import os
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import module_floor, require_permission
from app.models.user import User
from app.services.chat import conversations, envelope as env, orchestrator

logger = logging.getLogger("app.chat")

router = APIRouter(prefix="/chat", tags=["chat"], dependencies=[module_floor("chat")])
can_chat = require_permission("chat", "view")

KEEPALIVE_EVERY = 8.0
_TASKS: set[asyncio.Task] = set()


class NewConversation(BaseModel):
    title: Optional[str] = Field(None, max_length=255)
    #: optional: an Agent Flow to use as this conversation's extension
    extension_flow_key: Optional[str] = Field(None, max_length=64)


class ConversationPatch(BaseModel):
    title: Optional[str] = Field(None, max_length=255)
    #: "" removes the extension; absent leaves it unchanged
    extension_flow_key: Optional[str] = Field(None, max_length=64)


class TurnBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    #: the client's key for THIS submit: a retry with the same key is the same turn
    idempotency_key: str = Field(..., pattern=r"^[A-Za-z0-9_-]{8,64}$")
    #: False = a new topic in the same conversation (no follow-up context)
    follow_up: bool = True
    extension: Literal["auto", "always", "never"] = "auto"
    choice_token: Optional[str] = Field(None, max_length=2000)
    dataset_id: Optional[int] = None
    value_choice: Optional[dict] = None
    consented_plan: Optional[dict] = None
    drop_consent: Optional[str] = Field(None, max_length=2000)


class FeedbackBody(BaseModel):
    verdict: str = Field(..., pattern=r"^(up|down)$")
    comment: Optional[str] = Field(None, max_length=1000)
    reason: Optional[str] = Field(None, pattern=r"^(correct|wrong_metric|wrong_dataset|wrong_metric_or_source|"
                                                 r"wrong_filter|incorrect_number|wrong_interpretation|"
                                                 r"unsupported_but_answerable|ux_issue|wrong_document)$")


class ConsentBody(BaseModel):
    query_fingerprint: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    fields: list[str] = Field(..., min_length=1, max_length=20)


def _readable(db: Session, user: User, conversation_id: int):
    c, level = conversations.get(db, user, conversation_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy cuộc trò chuyện.")
    return c, level


def _usable_flow(db: Session, user: User, flow_key: str) -> None:
    from app.services.agent_flows import direct_chat

    try:
        _row, _flow, problem = direct_chat.resolve_for_chat(db, user, flow_key)
    except Exception:  # noqa: BLE001 - Agent Flow not installed here
        db.rollback()
        problem = "not_published"
    if problem:
        # 404 for every reason: "this flow exists but is not yours" is a directory
        raise HTTPException(status_code=404, detail="Không dùng được luồng hỗ trợ này.")


@router.get("/catalog")
def catalog(lang: str = "vi", db: Session = Depends(get_db), user: User = Depends(can_chat)) -> dict[str, Any]:
    from app.services.data_core.catalog import is_identifier

    items = conversations.data_catalog(db, user)
    sources = [{"explore_id": c.explore_id, "dataset_id": c.dataset_id, "dataset": c.dataset_name,
                "source_type": c.source_type,
                "measures": [f.label for f in c.fields if f.kind == "measure"][:12],
                "dimensions": [f.label for f in c.fields if f.kind == "dimension" and not is_identifier(f)][:12]}
               for c in items]
    extensions = []
    try:
        from app.services.agent_flows import direct_chat, reader_capability

        for row, flow in direct_chat.published_chat_brains(db, user):
            extensions.append({"flow_key": row.brain_key, "name": row.name, "description": row.description or "",
                               "capability": reader_capability.capability(flow, surface="chat", lang=lang)})
    except Exception:  # noqa: BLE001 - no Agent Flow module here: no extensions to offer
        db.rollback()
    return {"sources": sources, "extensions": extensions}


@router.get("/conversations")
def list_conversations(db: Session = Depends(get_db), user: User = Depends(can_chat)) -> dict[str, Any]:
    return {"conversations": [conversations.conversation_view(db, user, c, level, None, with_turns=False)
                              for c, level in conversations.list_for(db, user)]}


@router.post("/conversations", status_code=201)
def create_conversation(body: NewConversation, db: Session = Depends(get_db),
                        user: User = Depends(can_chat)) -> dict[str, Any]:
    key = (body.extension_flow_key or "").strip() or None
    if key:
        _usable_flow(db, user, key)
    c = conversations.create(db, user, body.title, key)
    return conversations.conversation_view(db, user, c, "owner", None, with_turns=False)


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: int, db: Session = Depends(get_db),
                     user: User = Depends(can_chat)) -> dict[str, Any]:
    c, level = _readable(db, user, conversation_id)
    return conversations.conversation_view(db, user, c, level, conversations.ViewerScope.of(db, user))


@router.patch("/conversations/{conversation_id}")
def patch_conversation(conversation_id: int, body: ConversationPatch, db: Session = Depends(get_db),
                       user: User = Depends(can_chat)) -> dict[str, Any]:
    c, level = _readable(db, user, conversation_id)
    if level != "owner":
        raise HTTPException(status_code=403, detail="Chỉ người tạo cuộc trò chuyện mới đổi được.")
    fields = body.model_fields_set if hasattr(body, "model_fields_set") else body.__fields_set__
    if "title" in fields:
        c.title = (body.title or "").strip()[:255] or None
    if "extension_flow_key" in fields:
        key = (body.extension_flow_key or "").strip() or None
        if key:
            _usable_flow(db, user, key)
        c.extension_flow_key = key
    db.commit()
    return conversations.conversation_view(db, user, c, level, None, with_turns=False)


@router.delete("/conversations/{conversation_id}", status_code=204, response_model=None)
def delete_conversation(conversation_id: int, db: Session = Depends(get_db),
                        user: User = Depends(can_chat)) -> Response:
    from datetime import datetime, timezone

    c, level = _readable(db, user, conversation_id)
    if level not in ("owner", "full"):
        raise HTTPException(status_code=403, detail="Chỉ người tạo cuộc trò chuyện mới xoá được.")
    c.deleted_at = datetime.now(timezone.utc)
    db.commit()
    return Response(status_code=204)


def _frame(payload: dict) -> str:
    return f"data: {_json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


@router.post("/conversations/{conversation_id}/turns")
async def ask(conversation_id: int, body: TurnBody, request: Request, db: Session = Depends(get_db),
              user: User = Depends(can_chat)):
    from starlette.concurrency import run_in_threadpool

    from app.services import llm_test_budget as _budget

    if _budget.active():
        # Test harness labels for the spending ledger (ignored unless a test budget is set).
        _budget.PURPOSE.set(request.headers.get("x-appbi-test-purpose", "")[:60])
        _budget.CASE_ID.set(request.headers.get("x-appbi-test-case", "")[:60])
        _budget.RC_SHA.set(request.headers.get("x-appbi-test-rc", "")[:40])
    req = orchestrator.TurnRequest(
        question=body.question, idempotency_key=body.idempotency_key, follow_up=body.follow_up,
        extension=body.extension, choice_token=body.choice_token, dataset_id=body.dataset_id,
        value_choice=body.value_choice, consented_plan=body.consented_plan, drop_consent=body.drop_consent)
    try:
        turn, replay = await run_in_threadpool(orchestrator.begin, db, user, conversation_id, req)
    except orchestrator.TurnRejected as r:
        raise HTTPException(status_code=r.status_code, detail=r.detail)
    accepted = {"type": "accepted", "conversation_id": turn.conversation_id, "turn_id": turn.turn_id,
                "seq": turn.seq, "replayed": replay}
    headers = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}

    if replay:
        if turn.status == "running":
            raise HTTPException(status_code=409, detail={"code": "turn_running", "turn_id": turn.turn_id})
        stored = env.normalize(turn.envelope, turn.status)

        async def replayed():
            yield _frame(accepted)
            yield _frame({"type": "final", "turn_id": turn.turn_id, "seq": turn.seq, "envelope": stored})
            yield _frame({"type": "done"})

        return StreamingResponse(replayed(), media_type="text/event-stream", headers=headers)

    queue: asyncio.Queue = asyncio.Queue()
    turn_id, seq, user_id = turn.turn_id, turn.seq, user.id

    async def work():
        try:
            final = await orchestrator.run(turn_id, user_id, conversation_id, req, queue.put_nowait)
        except Exception:  # noqa: BLE001 - the turn row is finished as failed by the reader's next load
            logger.exception("[chat] turn %s crashed", turn_id)
            final = env.failed("internal_error", "Có lỗi khi xử lý câu hỏi; hãy thử lại.")
        queue.put_nowait({"type": "final", "turn_id": turn_id, "seq": seq, "envelope": final})

    task = asyncio.create_task(work())
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)

    async def stream():
        yield _frame(accepted)
        while True:
            try:
                ev = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_EVERY)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            yield _frame(ev)
            if ev.get("type") == "final":
                break
        yield _frame({"type": "done"})

    return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)


@router.post("/turns/{turn_id}/cancel")
def cancel(turn_id: str, db: Session = Depends(get_db), user: User = Depends(can_chat)) -> dict[str, Any]:
    if len(turn_id) != 32:
        raise HTTPException(status_code=404, detail="Không tìm thấy câu hỏi.")
    try:
        return orchestrator.cancel(db, user, turn_id)
    except orchestrator.TurnRejected as r:
        raise HTTPException(status_code=r.status_code, detail=r.detail)


@router.post("/turns/{turn_id}/feedback", status_code=201)
def feedback(turn_id: str, body: FeedbackBody, db: Session = Depends(get_db),
             user: User = Depends(can_chat)) -> dict[str, Any]:
    """The person's verdict on an answer THEY asked for."""
    from app.models.chat_conversation import ChatConversation, ChatFeedback, ChatTurn

    t = (db.query(ChatTurn).join(ChatConversation, ChatConversation.id == ChatTurn.conversation_id)
         .filter(ChatTurn.turn_id == turn_id, ChatConversation.deleted_at.is_(None)).first())
    if t is None or str(t.asked_by) != str(user.id):
        raise HTTPException(status_code=404, detail="Không tìm thấy câu trả lời.")
    row = ChatFeedback(user_id=user.id, turn_id=turn_id, verdict=body.verdict, reason=body.reason,
                       comment=(body.comment or "").strip() or None,
                       rc_sha=(os.environ.get("APPBI_BUILD_SHA") or "")[:40] or None)
    db.add(row)
    db.commit()
    return {"id": row.id}


@router.post("/consents")
def consent(body: ConsentBody, user: User = Depends(can_chat)) -> dict[str, Any]:
    """Called by the person's own click. The token is bound to this user and this
    exact query; GQS verifies it and the ledger spends it once."""
    from app.core.config import settings

    if not getattr(settings, "ANALYST_DROP_CONSENT_ENABLED", False):
        raise HTTPException(status_code=403, detail="Accepting a dropped filter is not enabled on this server.")
    from app.services.governed_query import consent as c

    return {"drop_consent": c.issue(user_id=user.id, query_fp=body.query_fingerprint, fields=body.fields),
            "expires_in": c.DEFAULT_TTL_SECONDS}


@router.get("/legacy/{kind}/{legacy_id}")
def resolve_legacy(kind: Literal["analyst_session", "flow_thread"], legacy_id: int, db: Session = Depends(get_db),
                   user: User = Depends(can_chat)) -> dict[str, Any]:
    """Where an old /analyst/s/{id} or /chat?thread={id} link now lives. Resolves
    only what this person may read; nothing is ever answered on the old engines."""
    c = conversations.by_legacy(db, user, kind, legacy_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy cuộc trò chuyện.")
    return {"conversation_id": c.id}
