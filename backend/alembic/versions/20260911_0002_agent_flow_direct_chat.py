"""Direct Chat: chat threads, a run's thread, and the per-flow opt-in.

Additive only. Nothing existing changes type or nullability, so the public-link
chat path is untouched by this migration.

Revision ID: 20260911_0002
Revises: 20260828_0001
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260911_0002"
down_revision: Union[str, None] = "20260828_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "agent_flow_chat_threads",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("brain_key", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=True),
        sa.Column("session_key", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_active_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("session_key", name="uq_agent_flow_chat_thread_session"),
    )
    op.create_index(
        "ix_agent_flow_chat_threads_id", "agent_flow_chat_threads", ["id"]
    )
    op.create_index(
        "ix_agent_flow_chat_threads_user_id", "agent_flow_chat_threads", ["user_id"]
    )
    op.create_index(
        "ix_agent_flow_chat_threads_brain_key", "agent_flow_chat_threads", ["brain_key"]
    )
    op.create_index(
        "ix_agent_flow_chat_threads_session_key",
        "agent_flow_chat_threads",
        ["session_key"],
    )
    op.create_index(
        "ix_agent_flow_chat_threads_user_active",
        "agent_flow_chat_threads",
        ["user_id", "last_active_at"],
    )

    # The run's thread. `binding_id` and this are mutually exclusive: a run came
    # either from a public link or from a direct chat, never both.
    op.add_column(
        "agent_flow_runs", sa.Column("chat_thread_id", sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        "fk_agent_flow_runs_chat_thread",
        "agent_flow_runs",
        "agent_flow_chat_threads",
        ["chat_thread_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_agent_flow_runs_chat_thread_id", "agent_flow_runs", ["chat_thread_id"]
    )
    op.create_index(
        "ix_agent_flow_runs_thread_time",
        "agent_flow_runs",
        ["chat_thread_id", "created_at"],
    )

    # OFF for every existing flow: they were authored against a report, and the
    # opt-in is the author's statement that this one also works without one.
    op.add_column(
        "agent_brain_versions",
        sa.Column(
            "direct_chat_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("agent_brain_versions", "direct_chat_enabled")
    op.drop_index("ix_agent_flow_runs_thread_time", table_name="agent_flow_runs")
    op.drop_index("ix_agent_flow_runs_chat_thread_id", table_name="agent_flow_runs")
    op.drop_constraint(
        "fk_agent_flow_runs_chat_thread", "agent_flow_runs", type_="foreignkey"
    )
    op.drop_column("agent_flow_runs", "chat_thread_id")
    op.drop_index(
        "ix_agent_flow_chat_threads_user_active", table_name="agent_flow_chat_threads"
    )
    op.drop_index(
        "ix_agent_flow_chat_threads_session_key", table_name="agent_flow_chat_threads"
    )
    op.drop_index(
        "ix_agent_flow_chat_threads_brain_key", table_name="agent_flow_chat_threads"
    )
    op.drop_index(
        "ix_agent_flow_chat_threads_user_id", table_name="agent_flow_chat_threads"
    )
    op.drop_index("ix_agent_flow_chat_threads_id", table_name="agent_flow_chat_threads")
    op.drop_table("agent_flow_chat_threads")
