"""
UserNotification — server-side, per-user notification feed.

Replaces the old frontend-only localStorage store (`appbi.notifications`),
which had no server backing at all: two toast() calls on two different
browsers/devices never agreed on what happened, and background events
(observability incidents, snapshot failures, user invites) had no way to
reach the user — only admin-configured alert channels (email/Slack/webhook)
ever saw them.

`dedup_key` lets a repeating background condition (e.g. "dataset 42 keeps
failing to snapshot") update ONE unread row instead of spamming a new one
per scan, mirroring the same idea as ObservabilityIncident.dedup_key.
"""
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base

NOTIFICATION_LEVELS = ("success", "error", "info", "warning")


class UserNotification(Base):
    __tablename__ = "user_notifications"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    level = Column(String(20), nullable=False, default="info")   # success|error|info|warning
    title = Column(String(500), nullable=False)
    description = Column(Text, nullable=True)
    link = Column(String(500), nullable=True)     # deep-link, e.g. /observability?incident=42
    source = Column(String(40), nullable=True)     # observability|snapshot|invite|system

    # Repeating background conditions update the same unread row instead of
    # creating a new one every scan/refresh cycle.
    dedup_key = Column(String(160), nullable=True, index=True)

    read = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    __table_args__ = (
        Index("ix_user_notification_user_read", "user_id", "read"),
    )
