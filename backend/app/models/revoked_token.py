"""
Revoked token model — server-side JWT blacklist for token revocation.

When a user logs out (or an admin force-revokes a session), the token's
``jti`` is stored here.  The ``get_current_user`` dependency checks this
table before accepting any JWT.
"""
import uuid

from sqlalchemy import Column, DateTime, String, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.core.database import Base


class RevokedToken(Base):
    __tablename__ = "revoked_tokens"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    jti = Column(String(64), nullable=False, unique=True, index=True)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("ix_revoked_tokens_expires_at", "expires_at"),
    )
