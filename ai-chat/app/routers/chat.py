"""
Chat router — WebSocket streaming + REST fallback + session management.
"""
import asyncio
import json
import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, Query, Depends, Request
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt

from app.config import settings
from app.schemas.chat import (
    ChatRequest,
    ConversationSession,
    DoneEvent,
    ErrorEvent,
    FeedbackRequest,
    SessionCreateRequest,
    SessionSummary,
)
from app.agents.orchestrator import get_or_create_session, run_agent, cleanup_expired_sessions, _sessions, load_session_from_db
from app.agents.governance import rate_limiter, check_token_budget, aggregate_session_usage
from app.agents.intent_classifier import IntentType

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/chat", tags=["chat"])

_ALGORITHM = "HS256"
_bearer = HTTPBearer(auto_error=False)


def _public_context(context: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Strip server-only fields before returning session context to the client."""
    if not isinstance(context, dict):
        return {}
    return {k: v for k, v in context.items() if k != "auth_token"}


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


def _require_auth_raw(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> tuple:
    """Like _require_auth but also returns the raw token string.
    Returns (payload_dict, raw_token_str).
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    raw = credentials.credentials
    payload = _decode_ws_token(raw)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return payload, raw


def _check_session_owner(session_id: str, user_id: str) -> ConversationSession:
    """Return in-memory session if it exists and belongs to user, else raise 404/403."""
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
                # Phase 3: token budget check on metrics event
                if isinstance(event, dict) and event.get("type") == "metrics":
                    intent_str = session.context.get("_last_intent", "default")
                    check_token_budget(
                        input_tokens=event.get("input_tokens"),
                        output_tokens=event.get("output_tokens"),
                        user_id=user_id,
                        session_id=session.session_id,
                        intent=intent_str,
                    )
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

            # Phase 3: rate limit check (uses last known intent or 'default')
            # We check against 'default' pre-classification; the real intent is checked
            # post-classification inside run_agent via session context
            allowed, remaining = rate_limiter.check(user_id, "default")
            if not allowed:
                await ws.send_json(ErrorEvent(
                    content="Bạn đã gửi quá nhiều yêu cầu. Vui lòng đợi một lúc rồi thử lại."
                ).model_dump())
                continue
            rate_limiter.record(user_id, "default")

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
async def chat_stream(req: ChatRequest, auth_ctx: tuple = Depends(_require_auth_raw)):
    """
    POST endpoint that streams NDJSON events (one per line).
    Useful for clients that cannot use WebSocket (e.g. curl, Postman).
    Requires Authorization: Bearer <jwt> header.
    """
    auth, raw_token = auth_ctx
    user_id: str = auth.get("sub", "")
    ai_level: str = auth.get("ai_level", "view")
    user_role: str = "editor" if ai_level in ("edit", "full") else "viewer"

    context = req.context or {}
    context["user_role"] = user_role
    context["user_id"] = user_id
    context["auth_token"] = raw_token
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
async def list_sessions(auth_ctx: tuple = Depends(_require_auth_raw)):
    """List sessions from backend DB (persistent), newest first."""
    auth, token = auth_ctx
    user_id: str = auth.get("sub", "")
    from app.clients.bi_client import bi_client
    db_sessions = await bi_client.list_chat_sessions(token=token)
    result = []
    for s in db_sessions:
        # Prefer in-memory last_message since DB doesn't store it separately
        mem = _sessions.get(s["session_id"])
        last_msg = None
        if mem:
            for m in reversed(mem.messages):
                if m.role in ("user", "assistant") and isinstance(m.content, str):
                    last_msg = m.content[:120]
                    break
        result.append(SessionSummary(
            session_id=s["session_id"],
            title=s["title"],
            created_at=s["created_at"],
            last_active=s["last_active"],
            message_count=s.get("message_count", 0),
            last_message=last_msg,
            context=_public_context(s.get("context")),
        ))
    return result


@router.post("/sessions", status_code=201)
async def create_session(
    body: SessionCreateRequest | None = None,
    auth_ctx: tuple = Depends(_require_auth_raw),
):
    """Create a new empty session and persist it to DB."""
    auth, token = auth_ctx
    user_id: str = auth.get("sub", "")
    from app.clients.bi_client import bi_client
    new_id = str(uuid.uuid4())
    session_context = body.context.copy() if body and body.context else {}
    session_context["auth_token"] = token
    session = ConversationSession(
        session_id=new_id,
        owner_user_id=user_id,
        context=session_context,
    )
    _sessions[new_id] = session
    await bi_client.upsert_chat_session(
        new_id,
        "New Conversation",
        user_id,
        token=token,
        context=body.context if body else None,
    )
    return {"session_id": new_id}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, auth_ctx: tuple = Depends(_require_auth_raw)):
    """Get session detail including message history.
    Loads from DB if not in memory (handles page refresh after restart).
    """
    auth, token = auth_ctx
    user_id: str = auth.get("sub", "")

    # Try in-memory first
    if session_id in _sessions:
        s = _sessions[session_id]
        if s.owner_user_id and s.owner_user_id != user_id:
            raise HTTPException(status_code=403, detail="Access denied")
    else:
        # Load from DB (includes share verification by the backend)
        s = await load_session_from_db(session_id, token)
        if s is None:
            raise HTTPException(status_code=404, detail="Session not found")

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
            # user_query stored via extra field when loaded from DB
            if hasattr(m, "extra") and m.extra and m.extra.get("user_query"):
                entry["userQuery"] = m.extra["user_query"]
        msgs.append(entry)
    return {
        "session_id": s.session_id,
        "title": s.title,
        "created_at": s.created_at.isoformat(),
        "last_active": s.last_active.isoformat(),
        "context": _public_context(s.context),
        "messages": msgs,
    }


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, auth_ctx: tuple = Depends(_require_auth_raw)):
    """Delete a conversation session (owner only) from memory and DB."""
    auth, token = auth_ctx
    user_id: str = auth.get("sub", "")
    if session_id in _sessions:
        _check_session_owner(session_id, user_id)
    _sessions.pop(session_id, None)
    from app.clients.bi_client import bi_client
    await bi_client.delete_chat_session(session_id, token=token)


@router.post("/sessions/{session_id}/messages/{message_id}/feedback")
async def submit_feedback(
    session_id: str,
    message_id: str,
    req: FeedbackRequest,
    auth_ctx: tuple = Depends(_require_auth_raw),
):
    """Submit thumbs-up/down feedback. Persisted to DB + updated in memory."""
    auth, token = auth_ctx
    user_id: str = auth.get("sub", "")

    # Update in-memory if session is loaded
    if session_id in _sessions:
        s = _check_session_owner(session_id, user_id)
        for m in s.messages:
            if m.role == "assistant" and m.message_id == message_id:
                m.feedback = {"rating": req.rating, "comment": req.comment}
                break

    # Always persist to DB
    from app.clients.bi_client import bi_client
    await bi_client.update_chat_feedback(session_id, message_id, req.rating, req.comment, token=token)

    logger.info(f"Feedback: session={session_id} msg={message_id} rating={req.rating}")
    return {"status": "ok", "message_id": message_id, "rating": req.rating}


@router.post("/cleanup", status_code=200)
async def cleanup_sessions(auth: dict = Depends(_require_auth)):
    """Manually trigger expired session cleanup (any authenticated user)."""
    count = cleanup_expired_sessions()
    return {"removed": count}


# ── Phase 3: Usage & Governance endpoints ─────────────────────────────────────

@router.get("/usage/{session_id}")
async def get_session_usage(session_id: str, auth_ctx: tuple = Depends(_require_auth_raw)):
    """
    Return token usage and estimated cost for a session.
    Aggregates from metrics stored on assistant messages.
    """
    auth, token = auth_ctx
    user_id: str = auth.get("sub", "")

    # Try in-memory first, fall back to DB load
    if session_id not in _sessions:
        s = await load_session_from_db(session_id, token)
        if s is None:
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        s = _check_session_owner(session_id, user_id)

    return aggregate_session_usage(s)


@router.get("/rate-limits")
async def get_rate_limits(auth: dict = Depends(_require_auth)):
    """Return current rate limit usage for the authenticated user."""
    user_id: str = auth.get("sub", "")
    usage = rate_limiter.get_usage(user_id)
    return {
        "user_id": user_id,
        "limits": usage,
        "limits_config": {
            "LOOKUP":  {"requests": 60, "window": "1 hour"},
            "EXPLORE": {"requests": 30, "window": "1 hour"},
            "INSIGHT": {"requests": 10, "window": "1 hour"},
            "CREATE":  {"requests": 20, "window": "1 hour"},
        },
    }


# ── Phase 4: Feedback analytics endpoint ─────────────────────────────────────

@router.get("/admin/feedback-stats")
async def get_feedback_stats(auth_ctx: tuple = Depends(_require_auth_raw)):
    """
    Return AI Chat satisfaction stats per intent type.
    Loads feedback from all rated messages in the backend DB.
    Admin-level endpoint — any authenticated user can view.
    """
    auth, token = auth_ctx
    from app.agents.feedback_analyzer import get_feedback_analyzer
    analyzer = get_feedback_analyzer()
    if not analyzer._loaded:
        await analyzer.load_feedback(token=token)
    return {
        "satisfaction_by_intent": analyzer.get_satisfaction_stats(),
        "total_rated": len(analyzer._examples),
        "best_insight_examples": [
            {
                "question": ex.question[:100],
                "tools_used": ex.tool_calls,
                "rating": ex.rating,
            }
            for ex in analyzer.get_best_examples(intent="INSIGHT", limit=5)
        ],
        "insight_failure_patterns": analyzer.get_failure_patterns(intent="INSIGHT"),
    }


@router.post("/admin/feedback-reload")
async def reload_feedback(auth_ctx: tuple = Depends(_require_auth_raw)):
    """Force reload of feedback examples cache (use after collecting new ratings)."""
    auth, token = auth_ctx
    from app.agents.feedback_analyzer import get_feedback_analyzer
    analyzer = get_feedback_analyzer()
    analyzer._loaded = False  # Force fresh load
    count = await analyzer.load_feedback(token=token)
    return {"loaded_examples": count}


# ── Phase UI: Dataset-aware initial suggestions ───────────────────────────────

@router.get("/initial-suggestions")
async def get_initial_suggestions(
    session_id: str,
    auth_ctx: tuple = Depends(_require_auth_raw),
):
    """
    Return 4-6 contextual starter questions based on the session's dataset.

    Used by the frontend empty-state to replace hardcoded QUICK_PROMPTS.
    If no dataset is scoped, returns generic data analysis questions.
    """
    auth, token = auth_ctx

    # Get session context to find dataset
    session = _sessions.get(session_id)
    dataset_id = session.context.get("dataset_id") if session else None
    dataset_name = session.context.get("dataset_name") if session else None

    if not dataset_id:
        return {"suggestions": _generic_starter_questions()}

    # Load dataset tables to build context-aware questions
    from app.clients.bi_client import bi_client
    try:
        dataset = await bi_client.get_dataset(int(dataset_id), token=token)
        tables = dataset.get("tables", [])
        suggestions = _dataset_starter_questions(tables, str(dataset_name or f"Dataset {dataset_id}"))
        return {"suggestions": suggestions}
    except Exception:
        return {"suggestions": _generic_starter_questions()}


def _collect_columns(tables: list) -> list[dict]:
    """Flatten all column names from dataset tables."""
    cols = []
    for tbl in tables[:5]:  # cap at 5 tables
        for c in (tbl.get("columns_cache") or {}).get("columns", []):
            if isinstance(c, dict):
                cols.append({"name": c.get("name", ""), "type": c.get("type", ""), "table": tbl.get("display_name", "")})
        if tbl.get("column_stats"):
            for col_name in list(tbl["column_stats"].keys())[:20]:
                cols.append({"name": col_name, "type": "", "table": tbl.get("display_name", "")})
    return cols


def _dataset_starter_questions(tables: list, dataset_name: str) -> list[str]:
    """
    Generate contextual starter questions based on the dataset's tables and columns.
    Uses keyword detection on column names — no LLM call needed.
    """
    cols = _collect_columns(tables)
    col_names_lower = {c["name"].lower() for c in cols}
    tbl_names = [t.get("display_name") or t.get("name", "") for t in tables[:3]]
    tbl_label = tbl_names[0] if tbl_names else dataset_name

    questions: list[str] = []

    # Always add: overview question
    questions.append(f"Tổng quan về dữ liệu trong {dataset_name} là gì?")

    # Time-based questions if date columns exist
    date_keywords = {"date", "time", "created", "updated", "month", "year", "ngày", "tháng", "năm", "at"}
    if any(any(kw in name for kw in date_keywords) for name in col_names_lower):
        questions.append(f"Xu hướng dữ liệu của {tbl_label} theo thời gian như thế nào?")

    # Status/completion questions
    status_keywords = {"status", "state", "completed", "done", "active", "trạng thái", "hoàn thành", "is_"}
    if any(any(kw in name for kw in status_keywords) for name in col_names_lower):
        questions.append("Phân bổ theo trạng thái hiện tại là gì?")

    # Person/assignee questions
    person_keywords = {"assignee", "user", "person", "owner", "created_by", "nhân viên", "người dùng", "member"}
    if any(any(kw in name for kw in person_keywords) for name in col_names_lower):
        questions.append("Top 10 nhân viên/người dùng hoạt động nhiều nhất?")

    # Revenue/metric questions
    metric_keywords = {"revenue", "amount", "value", "total", "count", "sum", "price", "cost", "doanh thu", "giá trị"}
    if any(any(kw in name for kw in metric_keywords) for name in col_names_lower):
        questions.append(f"Tổng các chỉ số quan trọng trong {tbl_label} là bao nhiêu?")

    # Project/category questions
    project_keywords = {"project", "category", "group", "type", "team", "department", "dự án", "nhóm", "loại"}
    if any(any(kw in name for kw in project_keywords) for name in col_names_lower):
        questions.append("So sánh hiệu suất giữa các nhóm/dự án?")

    # Deadline/completion questions
    deadline_keywords = {"deadline", "due", "miss", "overdue", "late", "trễ", "hạn"}
    if any(any(kw in name for kw in deadline_keywords) for name in col_names_lower):
        questions.append("Tỷ lệ trễ deadline hiện tại là bao nhiêu %?")

    # Always add: create dashboard question
    questions.append(f"Tạo dashboard tổng quan cho {dataset_name}")

    # Return first 6 questions
    return questions[:6]


def _generic_starter_questions() -> list[str]:
    """Fallback questions when no dataset is scoped."""
    return [
        "Dataset nào tôi đang có quyền truy cập?",
        "Tổng quan về dữ liệu trong hệ thống là gì?",
        "Tạo dashboard từ dữ liệu hiện có",
        "Dữ liệu có chart và báo cáo nào?",
        "Phân tích xu hướng theo thời gian",
        "Top 10 kết quả theo chỉ số quan trọng nhất",
    ]
