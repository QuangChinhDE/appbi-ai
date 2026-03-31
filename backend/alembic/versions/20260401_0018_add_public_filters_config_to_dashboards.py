"""add public_filters_config to dashboards

Revision ID: 20260401_0018
Revises: 20260331_0017
Create Date: 2026-04-01
"""
from alembic import op
import sqlalchemy as sa

revision = "20260401_0018"
down_revision = "20260331_0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column("public_filters_config", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dashboards", "public_filters_config")
