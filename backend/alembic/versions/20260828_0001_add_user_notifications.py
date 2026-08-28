"""add user_notifications

Server-side per-user notification feed. Replaces the frontend-only
localStorage store, which had no server backing and no way for background
events (observability incidents, snapshot failures, invites) to reach the
user — only admin-configured alert channels ever saw them.

Revision ID: 20260828_0001
Revises: 20260821_0055
Create Date: 2026-08-28
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260828_0001"
down_revision: Union[str, None] = "20260821_0055"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_notifications",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("level", sa.String(length=20), nullable=False, server_default="info"),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("link", sa.String(length=500), nullable=True),
        sa.Column("source", sa.String(length=40), nullable=True),
        sa.Column("dedup_key", sa.String(length=160), nullable=True),
        sa.Column("read", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_user_notifications_user_id", "user_notifications", ["user_id"])
    op.create_index("ix_user_notifications_dedup_key", "user_notifications", ["dedup_key"])
    op.create_index("ix_user_notifications_created_at", "user_notifications", ["created_at"])
    op.create_index("ix_user_notification_user_read", "user_notifications", ["user_id", "read"])


def downgrade() -> None:
    op.drop_table("user_notifications")
