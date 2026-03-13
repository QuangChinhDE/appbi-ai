"""add_dataset_transformations

Revision ID: 0ee8a79aceb0
Revises: aaf8bd9404e0
Create Date: 2025-12-16 15:26:52.877393

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '0ee8a79aceb0'
down_revision = 'aaf8bd9404e0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add transformations column (JSON)
    op.add_column('datasets', sa.Column('transformations', sa.JSON(), nullable=True))
    
    # Add transformation_version column (INTEGER)
    op.add_column('datasets', sa.Column('transformation_version', sa.Integer(), nullable=True, server_default='1'))


def downgrade() -> None:
    # Remove columns
    op.drop_column('datasets', 'transformation_version')
    op.drop_column('datasets', 'transformations')
