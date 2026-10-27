"""THE conversation store of AI Chat (docs/features/unified-ai-chat/contract.md).

ONE STORE, NOT TWO
------------------
AI Chat and the AI Analyst each kept their own: `agent_flow_chat_threads` (whose
transcript was rebuilt from run content that retention pruning deletes) and
`analyst_sessions` (turns stored, never pruned). Both are imported here by alembic
20261027_0001 and nothing at runtime reads them any more; they stay until the
migration is accepted, so the history is recoverable.

WHAT A TURN IS
--------------
One question and its ONE answer envelope, written by the chat service only
(services/chat). `status` moves `running` -> one terminal state exactly once; the
update that moves it is conditional on `running`, so a cancel and a finished answer
cannot both win. `idempotency_key` makes a retried submit the same turn, not a second
paid one.

WHAT A STORED TURN IS NOT
-------------------------
A grant. `dataset_ids`/`refs` (what the Data Core read) and `doc_ids` (what an
extension cited) are re-checked against the VIEWER's current rights on every read;
anything they may not read is returned as `redacted` (services/chat/conversations.py).
"""
from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.core.database import Base

#: Every status a turn can hold. `running` is the only non-terminal one.
TURN_STATUSES = ("running", "answered", "clarification_required", "refused", "failed", "cancelled")
TERMINAL_STATUSES = TURN_STATUSES[1:]


class ChatConversation(Base):
    __tablename__ = "chat_conversations"

    id = Column(Integer, primary_key=True, index=True)
    #: the owner: rename, delete, share and choosing the extension are theirs
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(255), nullable=True)
    #: the OPTIONAL Agent Flow bound to this conversation as an extension. NULL is the
    #: normal case: the Data Core answers on its own.
    extension_flow_key = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_active_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    #: where an imported conversation came from: `analyst_session` | `flow_thread`, and
    #: its id there. Old links resolve through these; NULL for every new conversation.
    legacy_kind = Column(String(24), nullable=True)
    legacy_id = Column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_chat_conversations_user_active", "user_id", "last_active_at"),
        UniqueConstraint("legacy_kind", "legacy_id", name="uq_chat_conversations_legacy"),
    )


class ChatTurn(Base):
    __tablename__ = "chat_turns"

    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False,
                             index=True)
    seq = Column(Integer, nullable=False)
    #: the GQS run id of the turn: ledger rows, cancel and feedback key on it
    turn_id = Column(String(32), nullable=False, unique=True)
    #: the client's key for this submit; a retry with the same key is the same turn
    idempotency_key = Column(String(64), nullable=True)
    #: who asked: an `edit` recipient asks as themselves, never as the owner
    asked_by = Column(UUID(as_uuid=True), nullable=False, index=True)
    question = Column(Text, nullable=False)
    status = Column(String(24), nullable=False)
    #: `core` for every new turn; `analyst_v1` / `flow_v0` for imported history
    origin = Column(String(16), nullable=False, server_default="core")
    dataset_ids = Column(JSONB, nullable=False, server_default="[]")
    refs = Column(JSONB, nullable=False, server_default="[]")
    doc_ids = Column(JSONB, nullable=False, server_default="[]")
    #: the ONE answer envelope (services/chat/envelope.py); `{}` while running
    envelope = Column(JSONB, nullable=False, server_default="{}")
    usage = Column(JSONB, nullable=False, server_default="{}")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    #: the `agent_flow_runs.id` an imported `flow_v0` turn came from
    legacy_run_id = Column(Integer, nullable=True)

    __table_args__ = (
        UniqueConstraint("conversation_id", "seq", name="uq_chat_turns_seq"),
        UniqueConstraint("conversation_id", "idempotency_key", name="uq_chat_turns_idempotency"),
        CheckConstraint("status IN ('running', 'answered', 'clarification_required', 'refused', 'failed', "
                        "'cancelled')", name="ck_chat_turns_status"),
        Index("ix_chat_turns_asker_time", "asked_by", "created_at"),
        Index("uq_chat_turns_legacy_run", "legacy_run_id", unique=True,
              postgresql_where="legacy_run_id IS NOT NULL"),
    )


class ChatExtensionInvocation(Base):
    """One call of an Agent Flow as an extension of one turn (contract ext.v1).

    The Flow's own run (metrics, trace, cost) is in `agent_flow_runs` under
    `run_key`; this row is what the Core asked for, why, under which ceiling, and
    what it accepted from the result."""

    __tablename__ = "chat_extension_invocations"

    id = Column(Integer, primary_key=True)
    invocation_id = Column(String(32), nullable=False, unique=True)
    turn_id = Column(String(32), nullable=False, index=True)
    conversation_id = Column(Integer, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False)
    flow_key = Column(String(64), nullable=False)
    flow_version = Column(Integer, nullable=True)
    #: explicit | document_need | core_unsupported
    reason = Column(String(32), nullable=False)
    #: ok | refused | failed | cancelled | timeout | unavailable
    status = Column(String(16), nullable=False)
    code = Column(String(48), nullable=True)
    run_key = Column(String(64), nullable=True)
    ceiling = Column(JSONB, nullable=False, server_default="{}")
    results = Column(JSONB, nullable=False, server_default="[]")
    warnings = Column(JSONB, nullable=False, server_default="[]")
    usage = Column(JSONB, nullable=False, server_default="{}")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    completed_at = Column(DateTime(timezone=True), nullable=True)


class ChatFeedback(Base):
    """A person's verdict on one answer they asked. Insert-only; nothing reads it
    back into an answer."""

    __tablename__ = "chat_feedback"

    id = Column(Integer, primary_key=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    user_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    turn_id = Column(String(32), nullable=False, index=True)
    verdict = Column(String(8), nullable=False)
    reason = Column(String(40), nullable=True)
    comment = Column(String(1000), nullable=True)
    rc_sha = Column(String(40), nullable=True)
    #: `analyst_feedback` | `flow_run_rating` for imported rows
    legacy_source = Column(String(24), nullable=True)

    __table_args__ = (
        CheckConstraint("verdict IN ('up', 'down')", name="ck_chat_feedback_verdict"),
        CheckConstraint("reason IS NULL OR reason IN ('correct', 'wrong_metric', 'wrong_dataset', "
                        "'wrong_metric_or_source', 'wrong_filter', 'incorrect_number', 'wrong_interpretation', "
                        "'unsupported_but_answerable', 'ux_issue', 'wrong_document')",
                        name="ck_chat_feedback_reason"),
    )
