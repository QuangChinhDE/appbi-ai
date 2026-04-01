"""add dashboard_public_links table

Revision ID: 20260401_0019
Revises: 20260401_0018
Create Date: 2026-04-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "20260401_0019"
down_revision = "20260401_0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "dashboard_public_links",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("dashboard_id", sa.Integer(), sa.ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("token", sa.String(64), nullable=False),
        sa.Column("filters_config", sa.JSON(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("access_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("last_accessed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_dashboard_public_links_token", "dashboard_public_links", ["token"], unique=True)
    op.create_index("ix_dashboard_public_links_dashboard_id", "dashboard_public_links", ["dashboard_id"])

    # Migrate existing share_token → new table
    op.execute("""
        INSERT INTO dashboard_public_links (dashboard_id, name, token, filters_config, is_active, access_count, created_by, created_at, updated_at)
        SELECT id, 'Default', share_token, COALESCE(public_filters_config, '[]'::json), true, 0, owner_id, created_at, NOW()
        FROM dashboards
        WHERE share_token IS NOT NULL
    """)


def downgrade() -> None:
    op.drop_index("ix_dashboard_public_links_dashboard_id", table_name="dashboard_public_links")
    op.drop_index("ix_dashboard_public_links_token", table_name="dashboard_public_links")
    op.drop_table("dashboard_public_links")
