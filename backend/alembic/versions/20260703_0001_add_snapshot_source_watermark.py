"""add source_watermark to dataset_table_snapshots (perf #5 change-driven refresh)

Revision ID: 20260703_0001
Revises: 20260702_0001
Create Date: 2026-07-03

Stores MAX(last_modified_time) of the source tables a snapshot read at build
time, so a later render can detect SOURCE-DATA changes cheaply (metadata only,
no scan) and rebuild only when the data actually changed.
"""
from alembic import op
import sqlalchemy as sa


revision = "20260703_0001"
down_revision = "20260702_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dataset_table_snapshots",
        sa.Column("source_watermark", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dataset_table_snapshots", "source_watermark")
