"""A person's verdict on one Analyst answer (engineering dogfood / pilot feedback).

One row per click: which turn (the ledger's run id), who, up or down, an optional
comment. Insert-only from the API; nothing reads it back into an answer."""
from sqlalchemy import CheckConstraint, Column, DateTime, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base


class AnalystFeedback(Base):
    __tablename__ = "analyst_feedback"

    id = Column(Integer, primary_key=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    user_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    turn_id = Column(String(32), nullable=False, index=True)
    verdict = Column(String(8), nullable=False)
    comment = Column(String(1000), nullable=True)
    rc_sha = Column(String(40), nullable=True)

    __table_args__ = (
        CheckConstraint("verdict IN ('up', 'down')", name="ck_analyst_feedback_verdict"),
    )
