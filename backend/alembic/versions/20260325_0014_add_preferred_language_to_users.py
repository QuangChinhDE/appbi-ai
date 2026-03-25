"""Add preferred language to users.

Revision ID: 20260325_0014
Revises: 20260324_0013
Create Date: 2026-03-25
"""
from alembic import op
import sqlalchemy as sa


revision = "20260325_0014"
down_revision = "20260324_0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("preferred_language", sa.String(length=8), nullable=False, server_default="en"),
    )


def downgrade() -> None:
    op.drop_column("users", "preferred_language")
