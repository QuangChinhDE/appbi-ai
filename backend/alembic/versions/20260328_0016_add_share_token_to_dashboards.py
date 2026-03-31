"""add share_token to dashboards

Revision ID: 20260328_0016
Revises: 20260326_0015
Create Date: 2026-03-28
"""
from alembic import op
import sqlalchemy as sa

revision = "20260328_0016"
down_revision = "20260326_0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column("share_token", sa.String(64), nullable=True, unique=True),
    )
    op.create_index("ix_dashboards_share_token", "dashboards", ["share_token"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_dashboards_share_token", table_name="dashboards")
    op.drop_column("dashboards", "share_token")
