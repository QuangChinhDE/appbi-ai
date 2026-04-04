"""
SQLAlchemy model for AI Feedback — Feedback-Driven Knowledge System.

Captures user corrections when AI uses wrong table/chart.
session_id and message_id are VARCHAR (no FK) — chat sessions are
stored in-memory in the AI service, not persisted to PostgreSQL.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.core.database import Base


class AIFeedback(Base):
    __tablename__ = "ai_feedback"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Context — no FK because sessions are in-memory in AI service
    session_id = Column(String(100), nullable=True)
    message_id = Column(String(100), nullable=True)

    # Who submitted
    user_id = Column(UUID(as_uuid=True),
                     ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False)

    # What the user originally asked
    user_query = Column(Text, nullable=False)

    # What AI matched (may be wrong) — optional, AI service can omit
    ai_matched_resource_type = Column(String(50), nullable=True)  # "chart"|"dataset_table"
    ai_matched_resource_id = Column(Integer, nullable=True)

    # What the user says is correct
    feedback_type = Column(String(30), nullable=False)
    # Values: "wrong_table" | "wrong_chart" | "unclear" | "other"

    correct_resource_type = Column(String(50), nullable=True)  # "chart"|"dataset_table"
    correct_resource_id = Column(Integer, nullable=True)

    notes = Column(Text, nullable=True)
    is_positive = Column(Boolean, nullable=False, default=False)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Relationships
    user = relationship("User", foreign_keys=[user_id])
