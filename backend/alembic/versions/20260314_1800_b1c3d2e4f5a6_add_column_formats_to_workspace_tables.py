"""add column_formats to workspace tables

Revision ID: b1c3d2e4f5a6
Revises: a064bf26d7e1
Create Date: 2026-03-14 18:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSON

revision = 'b1c3d2e4f5a6'
down_revision = 'a064bf26d7e1'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'dataset_workspace_tables',
        sa.Column('column_formats', JSON, nullable=True)
    )


def downgrade():
    op.drop_column('dataset_workspace_tables', 'column_formats')
