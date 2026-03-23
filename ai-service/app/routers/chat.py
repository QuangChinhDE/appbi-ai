"""
Chat router — WebSocket streaming + REST fallback + session management.
"""
import asyncio
import json
import logging
import uuid
from typing import List, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, Query, Depends, Request
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt

from app.config import settings
from app.schemas.chat import ChatRequest, ConversationSession, DoneEvent, ErrorEvent, FeedbackRequest, SessionSummary
from app.agents.orchestrator import get_or_create_session, run_agent, cleanup_expired_sessions, _sessions

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/chat", tags=["chat"])

_ALGORITHM = "HS256"
_bearer = HTTPBearer(auto_error=False)


def _decode_ws_token(token: str | None) -> dict | None:
    """Decode and validate a JWT token. Returns payload or None on failure."""
    if not token:
        return None
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[_ALGORITHM])
    except JWTError:
        return None


def _require_auth(credentials: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict:
    """FastAPI dependency — validate Bearer token, return JWT payload or raise 401."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    payload = _decode_ws_token(credentials.credentials)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return payload


def _check_session_owner(session_id: str, user_id: str) -> ConversationSession:
    """Return session if it exists and belongs to user, else raise 404/403."""
    if session_id not in _sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    s = _sessions[session_id]
    # Sessions created before this fix have owner_user_id="" — allow access
    if s.owner_user_id and s.owner_user_id != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    return s


# ── WebSocket ──────────────────────────────────────────────────────────────────

@router.websocket("/ws")
async def websocket_chat(
    ws: WebSocket,
    token: str | None = Query(default=None),
):
    """
    WebSocket endpoint for streaming AI chat.
    Auth: pass JWT as ?token=<jwt> query parameter.
    Viewer role cannot use execute_sql tool.
    """
    # ── Auth check ────────────────────────────────────────────────────────────
    payload = _decode_ws_token(token)
    if payload is None:
        await ws.close(code=4001, reason="Unauthorized — provide ?token=<jwt>")
        return

    # ai_level is embedded in JWT by backend: none/view/edit/full
    # edit/full users can call execute_sql; view/none are restricted to pre-built charts
    ai_level: str = payload.get("ai_level", "view")
    user_role: str = "editor" if ai_level in ("edit", "full") else "viewer"
    user_id: str = payload.get("sub", "")

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
            # Inject user role so orchestrator can restrict execute_sql for viewers
            context["user_role"] = user_role
            context["user_id"] = user_id
            context["auth_token"] = token
            session = get_or_create_session(session_id, context)
            # Bind session to this user so REST endpoints can enforce ownership
            if session.owner_user_id == "":
                session.owner_user_id = user_id

            agent_task = asyncio.create_task(_run_and_send(session, message))

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
        await _cancel_current()
    except Exception as e:
        logger.exception(f"WebSocket error: {e}")
        await _cancel_current()


# ── REST streaming (SSE-compatible) ───────────────────────────────────────────

@router.post("/stream")
async def chat_stream(req: ChatRequest, auth: dict = Depends(_require_auth)):
    """
    POST endpoint that streams NDJSON events (one per line).
    Useful for clients that cannot use WebSocket (e.g. curl, Postman).
    Requires Authorization: Bearer <jwt> header.
    """
    user_id: str = auth.get("sub", "")
    ai_level: str = auth.get("ai_level", "view")
    user_role: str = "editor" if ai_level in ("edit", "full") else "viewer"

    context = req.context or {}
    context["user_role"] = user_role
    context["user_id"] = user_id
    session = get_or_create_session(req.session_id, context)
    if session.owner_user_id == "":
        session.owner_user_id = user_id

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
async def list_sessions(auth: dict = Depends(_require_auth)):
    """List active sessions belonging to the authenticated user, newest first."""
    user_id: str = auth.get("sub", "")
    result = []
    for s in sorted(_sessions.values(), key=lambda x: x.last_active, reverse=True):
        # Only return sessions owned by this user (empty owner = legacy, skip)
        if s.owner_user_id != user_id:
            continue
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
async def create_session(auth: dict = Depends(_require_auth)):
    """Create a new empty session and return its ID."""
    user_id: str = auth.get("sub", "")
    new_id = str(uuid.uuid4())
    session = ConversationSession(session_id=new_id, owner_user_id=user_id)
    _sessions[new_id] = session
    return {"session_id": new_id}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, auth: dict = Depends(_require_auth)):
    """Get session detail including message history (for restore on page load)."""
    user_id: str = auth.get("sub", "")
    s = _check_session_owner(session_id, user_id)
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
            if m.charts:
                entry["charts"] = m.charts
        msgs.append(entry)
    return {
        "session_id": s.session_id,
        "title": s.title,
        "created_at": s.created_at.isoformat(),
        "last_active": s.last_active.isoformat(),
        "messages": msgs,
    }


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, auth: dict = Depends(_require_auth)):
    """Delete a conversation session (owner only)."""
    user_id: str = auth.get("sub", "")
    _check_session_owner(session_id, user_id)  # raises 404/403 if not allowed
    _sessions.pop(session_id, None)


@router.post("/sessions/{session_id}/messages/{message_id}/feedback")
async def submit_feedback(session_id: str, message_id: str, req: FeedbackRequest, auth: dict = Depends(_require_auth)):
    """Submit thumbs-up/down feedback for a specific AI message (owner only)."""
    user_id: str = auth.get("sub", "")
    s = _check_session_owner(session_id, user_id)
    for m in s.messages:
        if m.role == "assistant" and m.message_id == message_id:
            m.feedback = {"rating": req.rating, "comment": req.comment}
            logger.info(f"Feedback received: session={session_id} msg={message_id} rating={req.rating}")
            return {"status": "ok", "message_id": message_id, "rating": req.rating}
    raise HTTPException(status_code=404, detail="Message not found")


@router.post("/cleanup", status_code=200)
async def cleanup_sessions(auth: dict = Depends(_require_auth)):
    """Manually trigger expired session cleanup (any authenticated user)."""
    count = cleanup_expired_sessions()
    return {"removed": count}
