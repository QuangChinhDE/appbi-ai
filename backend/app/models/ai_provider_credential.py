"""A stored AI provider key that Agent Flow steps reference by id.

WHY A ROW AND NOT A FIELD ON THE STEP
-------------------------------------
A flow is shareable and exportable. A key written into a step would travel with
every share and every export file, and would have to be pasted again into every
step of every flow. So the secret lives here, once, encrypted; a step stores only
`credential_id`, and the runtime resolves it (`services/agent_flows/credentials.py`).

Ownership is per user, like a datasource: whoever creates the key owns it and may
share it (`ResourceType.AI_CREDENTIAL`). A share lets the recipient USE the key in
their own steps — it never reveals the secret, which no endpoint returns.
"""
from __future__ import annotations

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.core.database import Base

#: The vendors a key may belong to. Mirrors `models_catalogue.MODELS`; kept here as
#: a constant rather than imported so the model layer depends on no service.
AI_CREDENTIAL_PROVIDERS = ("openai", "anthropic", "gemini")


class AiProviderCredential(Base):
    __tablename__ = "ai_provider_credentials"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(120), nullable=False)
    provider = Column(String(20), nullable=False)
    #: `encrypt_value(secret)` — always `_enc:`-prefixed. The service refuses to
    #: write a row when encryption is not configured, so plaintext never lands here.
    secret_enc = Column(Text, nullable=False)
    #: The last four characters, so a person can tell two keys apart. Never more.
    key_hint = Column(String(8), nullable=False, default="")
    #: The key the builder pre-selects for a new step of this provider. A picker
    #: convenience only: the runtime never falls back to it.
    is_default = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    last_test_at = Column(DateTime(timezone=True), nullable=True)
    last_test_ok = Column(Boolean, nullable=True)
    #: Sanitised: no key, no query string. See `credentials.sanitize_error`.
    last_test_error = Column(String(200), nullable=True)
    #: Soft delete. A step still pointing here reports "key đã bị xoá" by name
    #: instead of an anonymous "not found".
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "provider IN ('openai', 'anthropic', 'gemini')",
            name="ck_ai_provider_credentials_provider",
        ),
        Index("ix_ai_provider_credentials_owner", "owner_id"),
        # One default per owner and provider, among live keys.
        Index(
            "uq_ai_provider_credentials_default",
            "owner_id", "provider",
            unique=True,
            postgresql_where=text("is_default AND deleted_at IS NULL"),
            sqlite_where=text("is_default AND deleted_at IS NULL"),
        ),
        # One name per owner, among live keys.
        Index(
            "uq_ai_provider_credentials_owner_name",
            "owner_id", "name",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
    )
