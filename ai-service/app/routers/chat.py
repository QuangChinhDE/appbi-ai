"""
Chat router — WebSocket streaming + REST fallback + session management.
"""
import asyncio
import json
import logging
import uuid
from typing import List, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import StreamingResponse

from app.schemas.chat import ChatRequest, ConversationSession, DoneEvent, ErrorEvent, FeedbackRequest, SessionSummary
from app.agents.orchestrator import get_or_create_session, run_agent, cleanup_expired_sessions, _sessions

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/chat", tags=["chat"])


# ── WebSocket ──────────────────────────────────────────────────────────────────

@router.websocket("/ws")
async def websocket_chat(ws: WebSocket):
    """
    WebSocket endpoint for streaming AI chat.

    Client sends:
        {"session_id": "...", "message": "...", "context": {...}}
        {"type": "cancel"} — cancels the in-progress response

    Server streams JSON event objects:
        {"type": "thinking",    "content": "..."}
        {"type": "tool_call",   "tool": "...", "args": {...}}
        {"type": "tool_result", "tool": "...", "summary": "..."}
        {"type": "text",        "content": "..."}
        {"type": "chart",       "chart_id": 1, ...}
        {"type": "done",        "session_id": "...", "cancelled": true|false}
        {"type": "error",       "content": "..."}
    """
    await ws.accept()
    agent_task: Optional[asyncio.Task] = None

    async def _run_and_send(session: ConversationSession, message: str) -> None:
        try:
            async for event in run_agent(message, session):
                await ws.send_json(event)
            await ws.send_json(DoneEvent(session_id=session.session_id).model_dump())
        except asyncio.CancelledError:
            await ws.send_json({"type": "done", "session_id": session.session_id, "cancelled": True})
        except Exception as e:
            logger.exception("Agent error")
            await ws.send_json(ErrorEvent(content=str(e)).model_dump())

    async def _cancel_current() -> None:
        nonlocal agent_task
        if agent_task and not agent_task.done():
            agent_task.cancel()
            try:
                await agent_task
            except (asyncio.CancelledError, Exception):
                pass
        agent_task = None

    try:
        while True:
            raw = await ws.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json(ErrorEvent(content="Invalid JSON payload").model_dump())
                continue

            if payload.get("type") == "cancel":
                await _cancel_current()
                continue

            message = payload.get("message", "").strip()
            if not message:
                await ws.send_json(ErrorEvent(content="Message is empty").model_dump())
                continue

            await _cancel_current()

            session_id = payload.get("session_id")
            context = payload.get("context") or {}
            session = get_or_create_session(session_id, context)

            agent_task = asyncio.create_task(_run_and_send(session, message))

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
        await _cancel_current()
    except Exception as e:
        logger.exception(f"WebSocket error: {e}")
        await _cancel_current()


# ── REST streaming (SSE-compatible) ───────────────────────────────────────────

@router.post("/stream")
async def chat_stream(req: ChatRequest):
    """
    POST endpoint that streams NDJSON events (one per line).
    Useful for clients that cannot use WebSocket (e.g. curl, Postman).
    """
    session = get_or_create_session(req.session_id, req.context or {})

    async def generate():
        try:
            async for event in run_agent(req.message, session):
                yield json.dumps(event, ensure_ascii=False) + "\n"
            yield json.dumps(DoneEvent(session_id=session.session_id).model_dump(), ensure_ascii=False) + "\n"
        except Exception as e:
            yield json.dumps(ErrorEvent(content=str(e)).model_dump(), ensure_ascii=False) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


# ── Session management ─────────────────────────────────────────────────────────

@router.get("/sessions", response_model=List[SessionSummary])
async def list_sessions():
    """List all active sessions, newest first."""
    result = []
    for s in sorted(_sessions.values(), key=lambda x: x.last_active, reverse=True):
        last_msg = None
        for m in reversed(s.messages):
            if m.role in ("user", "assistant") and isinstance(m.content, str):
                last_msg = m.content[:120]
                break
        result.append(SessionSummary(
            session_id=s.session_id,
            title=s.title,
            created_at=s.created_at,
            last_active=s.last_active,
            message_count=len([m for m in s.messages if m.role in ("user", "assistant")]),
            last_message=last_msg,
        ))
    return result


@router.post("/sessions", status_code=201)
async def create_session():
    """Create a new empty session and return its ID."""
    new_id = str(uuid.uuid4())
    session = ConversationSession(session_id=new_id)
    _sessions[new_id] = session
    return {"session_id": new_id}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get session detail including message history (for restore on page load)."""
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    s = _sessions[session_id]
    msgs = []
    for m in s.messages:
        if m.role not in ("user", "assistant"):
            continue
        if m.role == "assistant" and not (m.content and isinstance(m.content, str) and m.content.strip()):
            continue
        entry: dict = {
            "role": m.role,
            "content": m.content if isinstance(m.content, str) else "",
        }
        if m.role == "assistant":
            if m.message_id:
                entry["message_id"] = m.message_id
            if m.metrics:
                entry["metrics"] = m.metrics
            if m.feedback:
                entry["feedback"] = m.feedback
        msgs.append(entry)
    return {
        "session_id": s.session_id,
        "title": s.title,
        "created_at": s.created_at.isoformat(),
        "last_active": s.last_active.isoformat(),
        "messages": msgs,
    }


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str):
    """Delete a conversation session."""
    _sessions.pop(session_id, None)


@router.post("/sessions/{session_id}/messages/{message_id}/feedback")
async def submit_feedback(session_id: str, message_id: str, req: FeedbackRequest):
    """Submit thumbs-up/down feedback for a specific AI message."""
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    s = _sessions[session_id]
    for m in s.messages:
        if m.role == "assistant" and m.message_id == message_id:
            m.feedback = {"rating": req.rating, "comment": req.comment}
            logger.info(f"Feedback received: session={session_id} msg={message_id} rating={req.rating}")
            return {"status": "ok", "message_id": message_id, "rating": req.rating}
    raise HTTPException(status_code=404, detail="Message not found")


@router.post("/cleanup", status_code=200)
async def cleanup_sessions():
    """Manually trigger expired session cleanup."""
    count = cleanup_expired_sessions()
    return {"removed": count}
