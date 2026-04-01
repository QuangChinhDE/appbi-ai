"""add security columns to dashboard_public_links

Revision ID: 20260401_0021
Revises: 20260401_0020
Create Date: 2026-04-01 12:30:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20260401_0021"
down_revision = "20260401_0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dashboard_public_links", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("dashboard_public_links", sa.Column("password_hash", sa.String(255), nullable=True))
    op.add_column("dashboard_public_links", sa.Column("max_access_count", sa.Integer(), nullable=True))
    op.add_column("dashboard_public_links", sa.Column("allowed_ips", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("dashboard_public_links", "allowed_ips")
    op.drop_column("dashboard_public_links", "max_access_count")
    op.drop_column("dashboard_public_links", "password_hash")
    op.drop_column("dashboard_public_links", "expires_at")
