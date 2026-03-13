"""add_source_kind_and_query

Revision ID: 6e9cb7ed72f6
Revises: 1c9e2d9e5ccf
Create Date: 2025-12-18 15:32:32.179887

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '6e9cb7ed72f6'
down_revision = '1c9e2d9e5ccf'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add source_kind column with default value
    op.add_column('dataset_workspace_tables', 
        sa.Column('source_kind', sa.String(50), nullable=False, server_default='physical_table'))
    
    # Add source_query column
    op.add_column('dataset_workspace_tables',
        sa.Column('source_query', sa.Text(), nullable=True))
    
    # Make source_table_name nullable (since sql_query tables won't have it)
    op.alter_column('dataset_workspace_tables', 'source_table_name',
        existing_type=sa.String(500),
        nullable=True)


def downgrade() -> None:
    # Remove added columns
    op.drop_column('dataset_workspace_tables', 'source_query')
    op.drop_column('dataset_workspace_tables', 'source_kind')
    
    # Restore source_table_name as non-nullable
    op.alter_column('dataset_workspace_tables', 'source_table_name',
        existing_type=sa.String(500),
        nullable=False)
