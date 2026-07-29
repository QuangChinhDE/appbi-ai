"""Refresh-run history for datasets (Sync & Publish / scheduled refresh log).

Adds ``dataset_refresh_runs`` — one row per Sync & Publish / scheduled refresh,
flipped from ``running`` to a terminal status (success / failed / stopped) at
every exit of ``dataset_publish_service._sync_and_publish_blocking``. Powers the
"Refresh history" modal (success/failure + reason). The Dataset's
``last_sync_error`` still holds only the LATEST error; this is the persistent log.

Revision ID: 20260729_0028
Revises: 20260728_0027
"""
from alembic import op
import sqlalchemy as sa


revision = "20260729_0028"
down_revision = "20260728_0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "dataset_refresh_runs",
        sa.Column("id", sa.Integer(), primary_key=True, index=True),
        sa.Column(
            "dataset_id",
            sa.Integer(),
            sa.ForeignKey("datasets.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="running"),
        sa.Column("trigger", sa.String(length=20), nullable=False, server_default="manual"),
        sa.Column("generation", sa.BigInteger(), nullable=True),
        sa.Column("tables_built", sa.Integer(), nullable=True),
        sa.Column("rows_total", sa.BigInteger(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("triggered_by_id", sa.String(length=36), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("duration_ms", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_dataset_refresh_runs_status", "dataset_refresh_runs", ["status"]
    )
    op.create_index(
        "ix_dataset_refresh_runs_created_at", "dataset_refresh_runs", ["created_at"]
    )
    # Common query: latest runs for one dataset (dataset_id + created_at desc).
    op.create_index(
        "ix_dataset_refresh_runs_dataset_created",
        "dataset_refresh_runs",
        ["dataset_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_dataset_refresh_runs_dataset_created", table_name="dataset_refresh_runs")
    op.drop_index("ix_dataset_refresh_runs_created_at", table_name="dataset_refresh_runs")
    op.drop_index("ix_dataset_refresh_runs_status", table_name="dataset_refresh_runs")
    op.drop_table("dataset_refresh_runs")
