"""Add source column to dashboard_public_links

Workboard mini-apps can embed dashboards as screens (kind='dashboard'). The
workboard backend provisions one DashboardPublicLink per distinct app_user
role on the workboard, with the link's filters_config built from the screen's
role_filter_mapping (value = app_user.role). ``source`` distinguishes those
managed links from links a user explicitly created via the Dashboard share
dialog so the share UI can hide them and the workboard delete hook can GC
them.

Values: ``'user'`` (default, manually created) | ``'workboard'`` (auto-managed).

Revision ID: 20260511_0001
Revises: 20260508_0001
Create Date: 2026-05-11
"""

from alembic import op
import sqlalchemy as sa

revision = "20260511_0001"
down_revision = "20260508_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashboard_public_links",
        sa.Column("source", sa.String(length=20), nullable=False, server_default="user"),
    )
    op.create_index(
        "ix_dashboard_public_links_source",
        "dashboard_public_links",
        ["source"],
    )


def downgrade() -> None:
    op.drop_index("ix_dashboard_public_links_source", table_name="dashboard_public_links")
    op.drop_column("dashboard_public_links", "source")
