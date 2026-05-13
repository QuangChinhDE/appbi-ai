"""add workboard_sync_runs

Revision ID: 20260513_0001
Revises: 20260511_0001
Create Date: 2026-05-13
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "20260513_0001"
down_revision: Union[str, None] = "20260511_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workboard_sync_runs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("run_id", sa.String(32), nullable=False),
        sa.Column("group_id", sa.String(32), nullable=False),
        sa.Column(
            "workboard_id",
            sa.Integer(),
            sa.ForeignKey("workboards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("screen_id", sa.String(64), nullable=False),
        sa.Column("block_index", sa.Integer(), nullable=False),
        sa.Column("trigger_id", sa.String(64), nullable=False),
        sa.Column("webhook_id", sa.String(64), nullable=False),
        sa.Column("webhook_url", sa.String(2048), nullable=False),
        sa.Column("webhook_name", sa.String(160), nullable=True),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "cancel_requested",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("total_rows", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_batches", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "completed_batches", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "failed_batches", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("last_response_status", sa.Integer(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("response_excerpt", postgresql.JSONB(), nullable=True),
        sa.Column(
            "triggered_by_app_user_id",
            sa.Integer(),
            sa.ForeignKey("workboard_app_users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "triggered_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("run_id", name="uq_workboard_sync_runs_run_id"),
    )
    op.create_index(
        "ix_workboard_sync_runs_workboard_created",
        "workboard_sync_runs",
        ["workboard_id", "created_at"],
    )
    op.create_index(
        "ix_workboard_sync_runs_group_id",
        "workboard_sync_runs",
        ["group_id"],
    )
    op.create_index(
        "ix_workboard_sync_runs_status",
        "workboard_sync_runs",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index("ix_workboard_sync_runs_status", table_name="workboard_sync_runs")
    op.drop_index("ix_workboard_sync_runs_group_id", table_name="workboard_sync_runs")
    op.drop_index(
        "ix_workboard_sync_runs_workboard_created",
        table_name="workboard_sync_runs",
    )
    op.drop_table("workboard_sync_runs")
