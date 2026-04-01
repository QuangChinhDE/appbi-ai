"""
Chat Sessions API — persistent storage for AI chat history.

All endpoints require authentication. The AI service uses these endpoints
to persist sessions so history survives container restarts.

Routes:
  GET    /chat-sessions            — list sessions for current user (+ shared)
  POST   /chat-sessions            — upsert session (create or update title/last_active)
  GET    /chat-sessions/{sid}      — get session + messages (owner or shared)
  DELETE /chat-sessions/{sid}      — delete session (owner only)
  POST   /chat-sessions/{sid}/messages          — append a batch of messages
  PUT    /chat-sessions/{sid}/messages/{mid}/feedback  — update feedback on a message
"""
import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.models.chat_session import ChatSession, ChatMessage
from app.models.resource_share import ResourceShare, ResourceType
from app.models.user import User

router = APIRouter(prefix="/chat-sessions", tags=["chat-sessions"])


# ── Pydantic schemas ───────────────────────────────────────────────────────────

class SessionUpsert(BaseModel):
    session_id: str
    title: str = "New Conversation"
    owner_user_id: str  # UUID string from JWT


class MessageAppend(BaseModel):
    role: str           # "user" | "assistant"
    content: str
    message_id: Optional[str] = None
    user_query: Optional[str] = None
    charts: Optional[list] = None
    metrics: Optional[dict] = None


class MessagesAppendRequest(BaseModel):
    messages: List[MessageAppend]


class FeedbackUpdate(BaseModel):
    rating: str             # "up" | "down"
    comment: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_session_or_403(
    db: Session,
    session_id: str,
    current_user: User,
    require_owner: bool = False,
) -> ChatSession:
    """Load session; raises 404/403 if not found or not accessible."""
    s = db.query(ChatSession).filter(ChatSession.session_id == session_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")

    if str(s.owner_id) == str(current_user.id):
        return s

    if require_owner:
        raise HTTPException(status_code=403, detail="Access denied")

    # Check resource_shares
    share = (
        db.query(ResourceShare)
        .filter(
            ResourceShare.resource_type == ResourceType.CHAT_SESSION,
            ResourceShare.resource_id == session_id,
            ResourceShare.user_id == current_user.id,
        )
        .first()
    )
    if not share:
        raise HTTPException(status_code=403, detail="Access denied")
    return s


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("")
def list_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all sessions owned by (or shared with) the current user, newest first."""
    # Own sessions
    own = (
        db.query(ChatSession)
        .filter(ChatSession.owner_id == current_user.id)
        .all()
    )
    # Shared sessions
    shared_ids = (
        db.query(ResourceShare.resource_id)
        .filter(
            ResourceShare.resource_type == ResourceType.CHAT_SESSION,
            ResourceShare.user_id == current_user.id,
        )
        .all()
    )
    shared_session_ids = [r[0] for r in shared_ids]
    shared = []
    if shared_session_ids:
        shared = (
            db.query(ChatSession)
            .filter(ChatSession.session_id.in_(shared_session_ids))
            .all()
        )

    all_sessions = {s.session_id: s for s in own + shared}
    result = sorted(all_sessions.values(), key=lambda s: s.last_active, reverse=True)

    return [
        {
            "session_id": s.session_id,
            "title": s.title,
            "created_at": s.created_at.isoformat(),
            "last_active": s.last_active.isoformat(),
            "message_count": s.message_count,
            "is_owner": str(s.owner_id) == str(current_user.id),
        }
        for s in result
    ]


@router.post("", status_code=201)
def upsert_session(
    body: SessionUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new session or update title/last_active if it already exists."""
    existing = db.query(ChatSession).filter(ChatSession.session_id == body.session_id).first()
    if existing:
        if str(existing.owner_id) != str(current_user.id):
            raise HTTPException(status_code=403, detail="Access denied")
        existing.title = body.title
        existing.last_active = datetime.datetime.utcnow()
        db.commit()
        return {"session_id": existing.session_id, "created": False}

    session = ChatSession(
        session_id=body.session_id,
        owner_id=current_user.id,
        title=body.title,
    )
    db.add(session)
    db.commit()
    return {"session_id": session.session_id, "created": True}


@router.get("/{session_id}")
def get_session(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get session detail + full message history. Owner or shared users."""
    s = _get_session_or_403(db, session_id, current_user)
    msgs = []
    for m in s.messages:
        entry: dict = {
            "role": m.role,
            "content": m.content,
        }
        if m.role == "assistant":
            if m.message_id:
                entry["message_id"] = m.message_id
            if m.user_query:
                entry["user_query"] = m.user_query
            if m.charts:
                entry["charts"] = m.charts
            if m.metrics:
                entry["metrics"] = m.metrics
            if m.feedback_rating:
                entry["feedback"] = {"rating": m.feedback_rating, "comment": m.feedback_comment}
        msgs.append(entry)
    return {
        "session_id": s.session_id,
        "title": s.title,
        "created_at": s.created_at.isoformat(),
        "last_active": s.last_active.isoformat(),
        "message_count": s.message_count,
        "messages": msgs,
    }


@router.delete("/{session_id}", status_code=204)
def delete_session(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a session and all its messages. Owner only."""
    s = _get_session_or_403(db, session_id, current_user, require_owner=True)
    db.delete(s)
    db.commit()


@router.post("/{session_id}/messages", status_code=201)
def append_messages(
    session_id: str,
    body: MessagesAppendRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Append a batch of new messages to a session (called by AI service after each turn)."""
    s = _get_session_or_403(db, session_id, current_user)
    for m in body.messages:
        msg = ChatMessage(
            session_id=session_id,
            message_id=m.message_id,
            role=m.role,
            content=m.content,
            user_query=m.user_query,
            charts=m.charts,
            metrics=m.metrics,
        )
        db.add(msg)
    s.last_active = datetime.datetime.utcnow()
    s.message_count = (
        db.query(func.count(ChatMessage.id))
        .filter(
            ChatMessage.session_id == session_id,
            ChatMessage.role.in_(["user", "assistant"]),
        )
        .scalar()
        or 0
    ) + len(body.messages)
    db.commit()
    return {"appended": len(body.messages)}


@router.put("/{session_id}/messages/{message_id}/feedback", status_code=200)
def update_message_feedback(
    session_id: str,
    message_id: str,
    body: FeedbackUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update thumbs up/down feedback on an AI message. Owner only."""
    _get_session_or_403(db, session_id, current_user, require_owner=True)
    msg = (
        db.query(ChatMessage)
        .filter(
            ChatMessage.session_id == session_id,
            ChatMessage.message_id == message_id,
        )
        .first()
    )
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    msg.feedback_rating = body.rating
    msg.feedback_comment = body.comment
    db.commit()
    return {"status": "ok"}
