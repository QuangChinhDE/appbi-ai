"""AI Analyst sessions: persisted, shareable conversations.

Additive: two new tables and one new `resourcetype` enum member. No existing row
changes. The downgrade drops the two tables; the enum member stays (Postgres has no
`ALTER TYPE ... DROP VALUE`, the same position as 20260914_0002's `chat_thread`).

Revision ID: 20261026_0001
Revises: 20261024_0001
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261026_0001"
down_revision: Union[str, None] = "20261024_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "analyst_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("title", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_active_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_analyst_sessions_id", "analyst_sessions", ["id"])
    op.create_index("ix_analyst_sessions_user_id", "analyst_sessions", ["user_id"])
    op.create_index("ix_analyst_sessions_user_active", "analyst_sessions", ["user_id", "last_active_at"])
    op.create_table(
        "analyst_session_turns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("analyst_sessions.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("turn_id", sa.String(32), nullable=False, unique=True),
        sa.Column("asked_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("question", sa.String(1000), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("dataset_ids", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("refs", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("response", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("session_id", "seq", name="uq_analyst_session_turns_seq"),
    )
    op.create_index("ix_analyst_session_turns_session_id", "analyst_session_turns", ["session_id"])
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'analyst_session'")


def downgrade() -> None:
    op.drop_index("ix_analyst_session_turns_session_id", table_name="analyst_session_turns")
    op.drop_table("analyst_session_turns")
    op.drop_index("ix_analyst_sessions_user_active", table_name="analyst_sessions")
    op.drop_index("ix_analyst_sessions_user_id", table_name="analyst_sessions")
    op.drop_index("ix_analyst_sessions_id", table_name="analyst_sessions")
    op.drop_table("analyst_sessions")
