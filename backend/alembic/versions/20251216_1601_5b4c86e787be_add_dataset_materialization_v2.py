"""add_dataset_materialization_v2

Revision ID: 5b4c86e787be
Revises: 0ee8a79aceb0
Create Date: 2025-12-16 16:01:48.264245

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '5b4c86e787be'
down_revision = '0ee8a79aceb0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add materialization column for v2
    op.add_column('datasets', sa.Column('materialization', sa.JSON(), nullable=True))
    
    # Update transformation_version default to 2
    op.execute("UPDATE datasets SET transformation_version = 2 WHERE transformation_version IS NULL OR transformation_version = 1")


def downgrade() -> None:
    # Remove materialization column
    op.drop_column('datasets', 'materialization')
    
    # Revert transformation_version to 1
    op.execute("UPDATE datasets SET transformation_version = 1")
