"""Personal access token model for non-browser API clients."""
from __future__ import annotations

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.core.database import Base


class PersonalAccessToken(Base):
    __tablename__ = "personal_access_tokens"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    secret_hash = Column(String(128), nullable=False)
    # Reversibly-encrypted secret (Fernet, key in app env — NOT in the DB) so the
    # owner/admin can reveal the token again. Null = created before reveal was
    # enabled, or no encryption key configured (reveal unavailable → rotate).
    secret_enc = Column(String, nullable=True)
    secret_suffix = Column(String(12), nullable=False)
    scopes = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    # Origins allowed to IFRAME the embed links this token mints, e.g.
    # ["https://app.base.vn", "https://*.base-datateam.com"]. Declared ONCE per
    # integration (any /integrations/embed/resolve call may set it, or an admin
    # can) and then remembered, so the host app doesn't resend it on every mint.
    #
    # NULL / [] = unrestricted, which is the historical behaviour: links keep
    # working anywhere. As soon as a list is present, enforcement turns on for
    # this token's links — the browser refuses to frame them elsewhere and
    # opening the URL outside an iframe is refused.
    embed_allowed_origins = Column(JSONB, nullable=True)
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        Index("ix_personal_access_tokens_owner_created", "owner_id", "created_at"),
        Index("ix_personal_access_tokens_expires_at", "expires_at"),
        Index("ix_personal_access_tokens_revoked_at", "revoked_at"),
    )
