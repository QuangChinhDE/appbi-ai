"""add query_mode, estimated_row_count, estimated_size_bytes to dataset_workspace_tables

Revision ID: 20260403_0001
Revises: 20260401_0021
Create Date: 2026-04-03 10:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20260403_0001"
down_revision = "20260401_0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dataset_workspace_tables",
        sa.Column("query_mode", sa.String(20), nullable=False, server_default="synced"),
    )
    op.add_column(
        "dataset_workspace_tables",
        sa.Column("estimated_row_count", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "dataset_workspace_tables",
        sa.Column("estimated_size_bytes", sa.BigInteger(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dataset_workspace_tables", "estimated_size_bytes")
    op.drop_column("dataset_workspace_tables", "estimated_row_count")
    op.drop_column("dataset_workspace_tables", "query_mode")
