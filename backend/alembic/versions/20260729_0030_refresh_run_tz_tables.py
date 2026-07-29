"""Refresh-run: per-run timezone + per-table breakdown.

Adds ``timezone`` (the zone the run's schedule ran in, or the user's browser
zone for a manual run) and ``tables`` (JSONB per-table breakdown
``[{table_id, name, rows, build_ms}]``) to ``dataset_refresh_runs`` so the
history modal can show timestamps in the right zone and a per-table detail on
a successful run.

Revision ID: 20260729_0030
Revises: 20260729_0029
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "20260729_0030"
down_revision = "20260729_0029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dataset_refresh_runs", sa.Column("timezone", sa.String(length=64), nullable=True))
    op.add_column("dataset_refresh_runs", sa.Column("tables", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("dataset_refresh_runs", "tables")
    op.drop_column("dataset_refresh_runs", "timezone")
