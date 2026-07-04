"""add ai_bot_knowledge — persistent institutional memory for the AI bot

Revision ID: 20260704_0001
Revises: 20260703_0002
Create Date: 2026-07-04

Durable, per-dashboard knowledge the AI bot accumulates across sessions/days
(concepts, facts, insights, preferences, corrections). Curated candidate →
validated → retired and injected into the system prompt so the bot grows more
domain-aware over time (the "learning employee" loop).
"""
from alembic import op
import sqlalchemy as sa


revision = "20260704_0001"
down_revision = "20260703_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_bot_knowledge",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("dashboard_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False, server_default="fact"),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="candidate"),
        sa.Column("source", sa.String(length=24), nullable=False, server_default="bot_finding"),
        sa.Column("support_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("contradiction_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("dedupe_key", sa.String(length=160), nullable=True),
        sa.Column("superseded_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_ai_bot_knowledge_dashboard_id", "ai_bot_knowledge", ["dashboard_id"])
    op.create_index("ix_ai_bot_knowledge_status", "ai_bot_knowledge", ["status"])
    op.create_index("ix_ai_bot_knowledge_dedupe_key", "ai_bot_knowledge", ["dedupe_key"])
    op.create_index("ix_ai_bot_knowledge_dash_status", "ai_bot_knowledge", ["dashboard_id", "status"])
    op.create_index("ix_ai_bot_knowledge_dash_key", "ai_bot_knowledge", ["dashboard_id", "dedupe_key"])


def downgrade() -> None:
    op.drop_index("ix_ai_bot_knowledge_dash_key", table_name="ai_bot_knowledge")
    op.drop_index("ix_ai_bot_knowledge_dash_status", table_name="ai_bot_knowledge")
    op.drop_index("ix_ai_bot_knowledge_dedupe_key", table_name="ai_bot_knowledge")
    op.drop_index("ix_ai_bot_knowledge_status", table_name="ai_bot_knowledge")
    op.drop_index("ix_ai_bot_knowledge_dashboard_id", table_name="ai_bot_knowledge")
    op.drop_table("ai_bot_knowledge")
