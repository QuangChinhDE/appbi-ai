"""The AI runtime's own records: the usage ledger and the public answer turns.

`ai_usage_ledger` - ONE row per paid model call, written BEFORE the call. The
Model Gateway (`services/ai_runtime/gateway.py`) reserves the call's worst-case
cost under a lock on every scope it bills (global, user, public link, turn), then
settles it with the provider's reported usage. Every ceiling reads this table, so
two concurrent calls cannot both pass a limit, and a call whose usage is unknown
counts at its worst case, never as free. No prompt, no answer, no secret is stored.

`public_answer_turns` - one row per question a public Dashboard AI Bot viewer
asked through the Answer Core: its idempotency key (a double click is one turn,
one spend), its terminal state (written once, `WHERE status = 'running'`, so a
Stop and a finished answer cannot both win, across workers), the envelope the
viewer got and the plan a follow-up refines. Keyed by link: revoking or deleting
the link removes its turns.
"""
from __future__ import annotations

from sqlalchemy import (
    JSON,
    BigInteger,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.core.database import Base


class AiUsageLedger(Base):
    __tablename__ = "ai_usage_ledger"

    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    call_id = Column(String(36), nullable=False, unique=True)
    #: what spent it: chat_core | public_core | chat_extension | public_extension | system
    purpose = Column(String(40), nullable=False)
    #: reserved -> settled | unknown (worst case kept: billed, usage not reported) | released
    status = Column(String(16), nullable=False)
    provider = Column(String(20), nullable=True)
    model = Column(String(120), nullable=True)
    user_id = Column(String(64), nullable=True)
    link_id = Column(Integer, nullable=True)
    turn_ref = Column(String(64), nullable=True)
    #: "server" or "credential:<id>" - which key paid, never the key
    credential_ref = Column(String(40), nullable=True)
    reserved_usd = Column(Float, nullable=False)
    actual_usd = Column(Float, nullable=True)
    input_tokens = Column(Integer, nullable=True)
    output_tokens = Column(Integer, nullable=True)
    #: sanitised error class only (no message: it can echo a key or a prompt)
    error = Column(String(80), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    settled_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_ai_usage_ledger_created", "created_at"),
        Index("ix_ai_usage_ledger_link_created", "link_id", "created_at"),
        Index("ix_ai_usage_ledger_user_created", "user_id", "created_at"),
        Index("ix_ai_usage_ledger_turn", "turn_ref"),
    )


class PublicAnswerTurn(Base):
    __tablename__ = "public_answer_turns"

    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    link_id = Column(Integer, ForeignKey("dashboard_public_links.id", ondelete="CASCADE"), nullable=False)
    #: a random key the viewer's browser holds for one conversation (follow-ups)
    conversation_key = Column(String(64), nullable=False)
    turn_id = Column(String(32), nullable=False, unique=True)
    idempotency_key = Column(String(64), nullable=False)
    question = Column(Text, nullable=False)
    #: running | answered | clarification_required | refused | failed | cancelled
    status = Column(String(24), nullable=False)
    envelope = Column(JSON, nullable=True)
    #: the Core plan of an answered turn, re-validated before a follow-up reuses it
    plan = Column(JSON, nullable=True)
    usd = Column(Float, nullable=True)
    #: the viewer's verdict on the answer: up | down (one current verdict, never cleared)
    rating = Column(String(8), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    finished_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("link_id", "idempotency_key", name="uq_public_answer_turns_link_idem"),
        Index("ix_public_answer_turns_conversation", "link_id", "conversation_key", "created_at"),
    )


__all__ = ["AiUsageLedger", "PublicAnswerTurn"]
