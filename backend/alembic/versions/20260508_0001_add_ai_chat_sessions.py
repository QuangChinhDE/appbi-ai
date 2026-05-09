"""Add ai_chat_sessions table

Revision ID: 20260508_0001
Revises: 20260506_0001
Create Date: 2026-05-08
"""

from alembic import op
import sqlalchemy as sa

revision = "20260508_0001"
down_revision = "20260506_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_chat_sessions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("token", sa.String(200), nullable=False),
        sa.Column("session_key", sa.String(64), nullable=False),
        sa.Column("provider", sa.String(20), nullable=True),
        sa.Column("model", sa.String(120), nullable=True),
        sa.Column("messages", sa.JSON(), nullable=True),
        sa.Column("briefing", sa.JSON(), nullable=True),
        sa.Column("conv_state", sa.JSON(), nullable=True),
        sa.Column("turn_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_ai_chat_sessions_token", "ai_chat_sessions", ["token"])
    op.create_index(
        "ix_ai_chat_sessions_session_key", "ai_chat_sessions", ["session_key"], unique=True
    )
    op.create_index(
        "ix_ai_chat_sessions_token_updated",
        "ai_chat_sessions",
        ["token", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_ai_chat_sessions_token_updated", "ai_chat_sessions")
    op.drop_index("ix_ai_chat_sessions_session_key", "ai_chat_sessions")
    op.drop_index("ix_ai_chat_sessions_token", "ai_chat_sessions")
    op.drop_table("ai_chat_sessions")
