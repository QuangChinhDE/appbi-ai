"""Per-turn telemetry for the Dashboard AI Bot.

One row per question→answer turn (the ``ai_chat_sessions`` table keeps only
running totals + the message array). Captures tokens, tools, mode and timing
so we can later analyse cost, latency and which capabilities actually get
used — to drive UX/cost upgrades.

No PII beyond a truncated question snippet (public-link viewers are
anonymous). The API key is never stored.
"""
from sqlalchemy import Boolean, Column, DateTime, Float, Index, Integer, JSON, String, Text
from sqlalchemy.sql import func

from app.core.database import Base


class AiChatTurnLog(Base):
    __tablename__ = "ai_chat_turn_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # Link token + browser-tab session this turn belongs to.
    token = Column(String(200), nullable=False, index=True)
    session_key = Column(String(64), nullable=True, index=True)

    # Resolved depth ("normal" | "thinking") and how it was chosen
    # ("auto" | "manual" | admin default).
    mode = Column(String(20), nullable=True)
    routed = Column(String(20), nullable=True)

    provider = Column(String(20), nullable=True)
    model = Column(String(120), nullable=True)

    # Truncated user question (analytics only).
    question = Column(Text, nullable=True)

    # Token + cost accounting for THIS turn.
    prompt_tokens = Column(Integer, nullable=False, default=0)
    completion_tokens = Column(Integer, nullable=False, default=0)
    rounds = Column(Integer, nullable=False, default=0)
    usd = Column(Float, nullable=True)

    # Capability usage for upgrade analysis.
    tools_used = Column(JSON, nullable=True)          # ["get_chart_summary", ...]
    web_searched = Column(Boolean, nullable=False, default=False)
    had_answer = Column(Boolean, nullable=False, default=True)
    errored = Column(Boolean, nullable=False, default=False)
    latency_ms = Column(Integer, nullable=True)

    # P1-02 — share of the answer's figures that trace back to an evidence row
    # (NULL = nothing to check: no figures, or the turn called no tools).
    verification_coverage = Column(Float, nullable=True)
    verification_unmatched = Column(Integer, nullable=True)

    created_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    __table_args__ = (
        Index("ix_ai_chat_turn_logs_token_created", "token", "created_at"),
    )
