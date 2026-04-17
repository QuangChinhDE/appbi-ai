"""add appearance config to dashboard public links

Revision ID: 20260417_0001
Revises: 20260414_0003
Create Date: 2026-04-17
"""

from alembic import op
import sqlalchemy as sa

revision = "20260417_0001"
down_revision = "20260414_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashboard_public_links",
        sa.Column("appearance_config", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dashboard_public_links", "appearance_config")
