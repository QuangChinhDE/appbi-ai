"""ai_chat_turn_logs — per-turn telemetry for the Dashboard AI Bot

Revision ID: 20260623_0001
Revises: 20260622_0001
Create Date: 2026-06-23
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260623_0001"
down_revision: Union[str, None] = "20260622_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_chat_turn_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("token", sa.String(length=200), nullable=False),
        sa.Column("session_key", sa.String(length=64), nullable=True),
        sa.Column("mode", sa.String(length=20), nullable=True),
        sa.Column("routed", sa.String(length=20), nullable=True),
        sa.Column("provider", sa.String(length=20), nullable=True),
        sa.Column("model", sa.String(length=120), nullable=True),
        sa.Column("question", sa.Text(), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rounds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("usd", sa.Float(), nullable=True),
        sa.Column("tools_used", sa.JSON(), nullable=True),
        sa.Column("web_searched", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("had_answer", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("errored", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_ai_chat_turn_logs_token", "ai_chat_turn_logs", ["token"])
    op.create_index("ix_ai_chat_turn_logs_session_key", "ai_chat_turn_logs", ["session_key"])
    op.create_index(
        "ix_ai_chat_turn_logs_token_created", "ai_chat_turn_logs", ["token", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_ai_chat_turn_logs_token_created", table_name="ai_chat_turn_logs")
    op.drop_index("ix_ai_chat_turn_logs_session_key", table_name="ai_chat_turn_logs")
    op.drop_index("ix_ai_chat_turn_logs_token", table_name="ai_chat_turn_logs")
    op.drop_table("ai_chat_turn_logs")
