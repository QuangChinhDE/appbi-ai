"""Add the missing Agent Flow unpublish audit action.

Revision ID: 20260815_0050
Revises: 20260815_0049
"""
from alembic import op


revision = "20260815_0050"
down_revision = "20260815_0049"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # PostgreSQL enum values must be added outside the migration transaction.
    with op.get_context().autocommit_block():
        op.execute(
            "ALTER TYPE auditaction "
            "ADD VALUE IF NOT EXISTS 'agent_flow_unpublished'"
        )


def downgrade() -> None:
    # PostgreSQL does not support removing one enum value in place.
    pass
