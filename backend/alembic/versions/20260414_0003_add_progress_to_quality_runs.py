"""add progress columns to dataset_quality_runs

Revision ID: 20260414_0003
Revises: 20260414_0002
Create Date: 2026-04-14
"""
from alembic import op
import sqlalchemy as sa

revision = "20260414_0003"
down_revision = "20260414_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dataset_quality_runs",
        sa.Column("progress_done", sa.Integer(), nullable=True),
    )
    op.add_column(
        "dataset_quality_runs",
        sa.Column("progress_total", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dataset_quality_runs", "progress_total")
    op.drop_column("dataset_quality_runs", "progress_done")
