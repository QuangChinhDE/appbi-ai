"""add_filters_config_to_dashboard

Revision ID: aaf8bd9404e0
Revises: 8d615faf5069
Create Date: 2025-12-11 13:40:37.943617

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'aaf8bd9404e0'
down_revision = '8d615faf5069'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add filters_config JSON column to dashboards table
    op.add_column('dashboards', sa.Column('filters_config', sa.JSON(), nullable=True))


def downgrade() -> None:
    # Remove filters_config column
    op.drop_column('dashboards', 'filters_config')
