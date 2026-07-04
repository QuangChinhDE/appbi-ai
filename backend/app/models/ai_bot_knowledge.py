"""Persistent institutional memory for the dashboard AI bot.

This is what turns the bot from a stateless "tool-spawning answerer" into a
learning employee: durable knowledge ABOUT a company/report that accumulates
across sessions and days, is curated (candidate → validated → retired), and is
injected back into the system prompt every turn so the bot grows more
domain-aware over time.

Scope is per **dashboard_id** (the report = the company's data view). All public
links pointing at the same dashboard share one growing knowledge base. The API
key and any PII never live here — only distilled facts/concepts/insights.

Lifecycle (see services/dashboard_ai_bot/knowledge.py):
  candidate  — just captured from a bot finding; unproven, NOT injected yet.
  validated  — user-taught, up-voted, or recurred across turns/days; INJECTED.
  retired    — contradicted, superseded, or decayed below threshold; ignored.
"""
from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.sql import func

from app.core.database import Base


class AiBotKnowledge(Base):
    __tablename__ = "ai_bot_knowledge"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # The dashboard (report) this learning belongs to — the "company" unit.
    dashboard_id = Column(Integer, nullable=False, index=True)

    # concept | fact | insight | preference | correction
    #   concept    — domain vocabulary / how a metric is defined for THIS company
    #   fact       — a durable, validated statement about the company/data
    #   insight    — a validated analytical finding (trend/driver/anomaly)
    #   preference — how the user likes answers (tone, focus, format)
    #   correction — records that a prior belief was wrong (supersedes another)
    kind = Column(String(20), nullable=False, default="fact")

    # The learning itself, in the report's language (Vietnamese-friendly).
    content = Column(Text, nullable=False)

    # Provenance for the claim: {"chart_ids": [..], "metric_values": {..},
    # "sources": [url,...], "note": "..."}. Kept small.
    evidence = Column(JSON, nullable=True)

    # 0..1 belief strength. user_taught starts high; recurrence raises it;
    # contradiction / staleness lowers it.
    confidence = Column(Float, nullable=False, default=0.5)

    # candidate | validated | retired
    status = Column(String(16), nullable=False, default="candidate", index=True)

    # user_taught | user_feedback | bot_finding | bot_reflection | bot_selfcorrect
    source = Column(String(24), nullable=False, default="bot_finding")

    # How many independent times we've seen this (recurrence → trust).
    support_count = Column(Integer, nullable=False, default=1)
    # How many times current data / user contradicted it (→ retire).
    contradiction_count = Column(Integer, nullable=False, default=0)

    # Normalised dedupe key (kind + slug of content) so re-observing the same
    # learning reinforces the existing row instead of spawning duplicates.
    dedupe_key = Column(String(160), nullable=True, index=True)

    # When this entry was replaced by a newer/corrected one (id), it is retired.
    superseded_by = Column(Integer, nullable=True)

    created_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Last time this learning was observed/reinforced — drives recency ranking
    # and staleness decay in the daily reflection job.
    last_seen_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at = Column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        # Fast injection query: validated entries for a dashboard, newest first.
        Index("ix_ai_bot_knowledge_dash_status", "dashboard_id", "status"),
        # Fast dedupe lookup on capture.
        Index("ix_ai_bot_knowledge_dash_key", "dashboard_id", "dedupe_key"),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "dashboard_id": self.dashboard_id,
            "kind": self.kind,
            "content": self.content,
            "evidence": self.evidence or {},
            "confidence": round(float(self.confidence or 0.0), 3),
            "status": self.status,
            "source": self.source,
            "support_count": self.support_count,
            "contradiction_count": self.contradiction_count,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "last_seen_at": self.last_seen_at.isoformat() if self.last_seen_at else None,
        }
