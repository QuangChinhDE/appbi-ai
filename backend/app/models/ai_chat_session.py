"""
SQLAlchemy model for persisted AI chat sessions.

Each session belongs to one public-link token and one browser tab
(identified by a client-generated UUID stored in localStorage).
Messages, conversation state and briefing are stored as JSON so the
frontend can restore a full conversation after a page reload.

The API key is NEVER stored here — it lives only in the browser's
sessionStorage / memory and the admin-configured key is stored in
appearance_config on the DashboardPublicLink, not here.
"""
from datetime import datetime

from sqlalchemy import Column, DateTime, Index, Integer, JSON, String, Text
from sqlalchemy.sql import func

from app.core.database import Base


class AiChatSession(Base):
    __tablename__ = "ai_chat_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # The public-link token that owns this session.
    token = Column(String(200), nullable=False, index=True)

    # Client-generated UUID (crypto.randomUUID()) stored in localStorage.
    # Unique per browser-tab so multiple users on the same link get
    # separate histories.
    session_key = Column(String(64), nullable=False, unique=True, index=True)

    # Provider / model chosen by the user (or pre-configured by admin).
    provider = Column(String(20), nullable=True)
    model = Column(String(120), nullable=True)

    # Full message array — [{role: "user"|"assistant", content: "..."}]
    # We strip statusLog from assistant messages before saving to keep
    # the payload lean.
    messages = Column(JSON, nullable=True, default=list)

    # Confirmed AiBriefing JSON blob (role / focus / domain …)
    briefing = Column(JSON, nullable=True)

    # Latest ConversationState snapshot (findings / hypotheses / …)
    #
    # CLIENT-SUPPLIED: the public session endpoint assigns this straight from the
    # request body, so nothing trusted may be kept here. See `flow_state` below.
    conv_state = Column(JSON, nullable=True)

    # WHAT AN AGENT FLOW ESTABLISHED IN THIS CONVERSATION — written ONLY by the
    # runtime, never from a request body. That separation is the whole reason it is
    # a second column instead of a key inside `conv_state`: a flow variable a viewer
    # could set would flow into prompts, branch conditions and tool arguments.
    #
    # Declared here as well as in the migration. It existed in the database and not
    # on this class, so `row.flow_state = {...}` set a plain Python attribute that
    # SQLAlchemy never persisted — no error, no write, and every turn re-read the
    # whole report while the code looked correct.
    flow_state = Column(JSON, nullable=True)

    # Running totals for analytics / cost tracking
    turn_count = Column(Integer, nullable=False, default=0)
    prompt_tokens = Column(Integer, nullable=False, default=0)
    completion_tokens = Column(Integer, nullable=False, default=0)

    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at = Column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        # Fast lookup for admin session list per token
        Index("ix_ai_chat_sessions_token_updated", "token", "updated_at"),
    )
