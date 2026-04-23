"""add personal_access_tokens table

Revision ID: 20260423_0001
Revises: 20260422_0001
Create Date: 2026-04-23
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision = "20260423_0001"
down_revision = "20260422_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "personal_access_tokens",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("owner_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("secret_hash", sa.String(length=128), nullable=False),
        sa.Column("secret_suffix", sa.String(length=12), nullable=False),
        sa.Column("scopes", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_personal_access_tokens_owner_id", "personal_access_tokens", ["owner_id"])
    op.create_index("ix_personal_access_tokens_owner_created", "personal_access_tokens", ["owner_id", "created_at"])
    op.create_index("ix_personal_access_tokens_expires_at", "personal_access_tokens", ["expires_at"])
    op.create_index("ix_personal_access_tokens_revoked_at", "personal_access_tokens", ["revoked_at"])


def downgrade() -> None:
    op.drop_index("ix_personal_access_tokens_revoked_at", table_name="personal_access_tokens")
    op.drop_index("ix_personal_access_tokens_expires_at", table_name="personal_access_tokens")
    op.drop_index("ix_personal_access_tokens_owner_created", table_name="personal_access_tokens")
    op.drop_index("ix_personal_access_tokens_owner_id", table_name="personal_access_tokens")
    op.drop_table("personal_access_tokens")
