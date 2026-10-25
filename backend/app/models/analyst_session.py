"""A persisted AI Analyst conversation (a "session") and its turns.

WHY A TURNS TABLE (and not the chat pattern)
--------------------------------------------
A direct-chat transcript is rebuilt from `agent_flow_run_content`, which the runtime
writes. The Analyst has no such table: a turn existed only in the browser. So each
turn is stored here, exactly as `/analyst/ask` returned it to the person who asked,
with rows capped at ANALYST_MAX_ROWS and no SQL text or choice tokens.

WHAT A STORED TURN IS NOT
-------------------------
It is not a grant. `dataset_ids` and `refs` record what the turn read so that EVERY
read of it re-checks the viewer's CURRENT rights (services/analyst/sessions.py): a
share of the session, or the owner after a revoked grant, sees the question and
`redacted` instead of numbers they may no longer read.
"""
from __future__ import annotations

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.core.database import Base


class AnalystSession(Base):
    __tablename__ = "analyst_sessions"

    id = Column(Integer, primary_key=True, index=True)
    #: the owner: rename, delete and share are theirs (share also needs `analyst >= edit`)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_active_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    #: soft delete, the only lifecycle state (same reasoning as AgentFlowChatThread)
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (Index("ix_analyst_sessions_user_active", "user_id", "last_active_at"),)


class AnalystSessionTurn(Base):
    __tablename__ = "analyst_session_turns"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("analyst_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    seq = Column(Integer, nullable=False)
    #: the GQS run id of this turn: ledger rows, feedback and cancel key on it
    turn_id = Column(String(32), nullable=False, unique=True)
    #: who asked: an `edit` recipient asks as themselves, never as the owner
    asked_by = Column(UUID(as_uuid=True), nullable=False)
    question = Column(String(1000), nullable=False)
    status = Column(String(16), nullable=False)
    #: what the turn read, re-checked against the viewer on every read
    dataset_ids = Column(JSONB, nullable=False, server_default="[]")
    refs = Column(JSONB, nullable=False, server_default="[]")
    response = Column(JSONB, nullable=False, server_default="{}")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (UniqueConstraint("session_id", "seq", name="uq_analyst_session_turns_seq"),)
