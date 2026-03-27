"""Add current_step column to agent_report_specs.

Revision ID: 20260326_0015
Revises: 20260325_0014
Create Date: 2026-03-26
"""
from alembic import op
import sqlalchemy as sa


revision = "20260326_0015"
down_revision = "20260325_0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_report_specs",
        sa.Column("current_step", sa.String(length=30), nullable=False, server_default="select"),
    )


def downgrade() -> None:
    op.drop_column("agent_report_specs", "current_step")
