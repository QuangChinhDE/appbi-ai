"""Add generation state fields for AI descriptions.

Revision ID: 20260324_0012
Revises: 20260323_0011
Create Date: 2026-03-24
"""
from alembic import op
import sqlalchemy as sa


revision = "20260324_0012"
down_revision = "20260323_0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dataset_workspace_tables",
        sa.Column("generation_status", sa.String(length=20), nullable=True, server_default="idle"),
    )
    op.add_column(
        "dataset_workspace_tables",
        sa.Column("generation_error", sa.Text(), nullable=True),
    )
    op.add_column(
        "dataset_workspace_tables",
        sa.Column("generation_requested_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "dataset_workspace_tables",
        sa.Column("generation_finished_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "dataset_workspace_tables",
        sa.Column("stale_reason", sa.Text(), nullable=True),
    )

    op.add_column(
        "chart_metadata",
        sa.Column("generation_status", sa.String(length=20), nullable=True, server_default="idle"),
    )
    op.add_column(
        "chart_metadata",
        sa.Column("generation_error", sa.Text(), nullable=True),
    )
    op.add_column(
        "chart_metadata",
        sa.Column("generation_requested_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "chart_metadata",
        sa.Column("generation_finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "chart_metadata",
        sa.Column("stale_reason", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chart_metadata", "stale_reason")
    op.drop_column("chart_metadata", "generation_finished_at")
    op.drop_column("chart_metadata", "generation_requested_at")
    op.drop_column("chart_metadata", "generation_error")
    op.drop_column("chart_metadata", "generation_status")

    op.drop_column("dataset_workspace_tables", "stale_reason")
    op.drop_column("dataset_workspace_tables", "generation_finished_at")
    op.drop_column("dataset_workspace_tables", "generation_requested_at")
    op.drop_column("dataset_workspace_tables", "generation_error")
    op.drop_column("dataset_workspace_tables", "generation_status")
