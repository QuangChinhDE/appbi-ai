"""
Chat session models — persistent storage for AI chat history.

chat_sessions  → one row per conversation, owned by a user
chat_messages  → all messages (user + assistant) in order, with metrics + feedback
"""
import datetime

from sqlalchemy import BigInteger, Column, DateTime, ForeignKey, Integer, String, Text, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.core.database import Base


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(100), unique=True, nullable=False, index=True)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title = Column(Text, nullable=False, default="New Conversation")
    created_at = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)
    last_active = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)
    message_count = Column(Integer, default=0, nullable=False)

    messages = relationship(
        "ChatMessage",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="ChatMessage.id",
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    session_id = Column(
        String(100),
        ForeignKey("chat_sessions.session_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # AI-assigned turn ID (only on assistant messages, NULL on user messages)
    message_id = Column(String(100), nullable=True)
    role = Column(String(20), nullable=False)   # "user" | "assistant"
    content = Column(Text, nullable=False, default="")
    # For assistant messages: the user question that triggered this response.
    # Stored so the correction button renders correctly when history is restored.
    user_query = Column(Text, nullable=True)
    charts = Column(JSON, nullable=True)
    metrics = Column(JSON, nullable=True)
    feedback_rating = Column(String(10), nullable=True)   # NULL / "up" / "down"
    feedback_comment = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)

    session = relationship("ChatSession", back_populates="messages")
