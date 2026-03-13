"""add_dataset_workspaces_table_based

Revision ID: 47dbcbad6090
Revises: 8c62e7348ffc
Create Date: 2025-12-18 10:57:34.448499

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '47dbcbad6090'
down_revision = '8c62e7348ffc'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create dataset_workspaces table
    op.create_table(
        'dataset_workspaces',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_dataset_workspaces_id'), 'dataset_workspaces', ['id'], unique=False)
    
    # Create dataset_workspace_tables table
    op.create_table(
        'dataset_workspace_tables',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('workspace_id', sa.Integer(), nullable=False),
        sa.Column('datasource_id', sa.Integer(), nullable=False),
        sa.Column('source_table_name', sa.String(), nullable=False),
        sa.Column('display_name', sa.String(), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=True),
        sa.Column('transformations', postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.Column('columns_cache', postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.Column('sample_cache', postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['datasource_id'], ['data_sources.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['workspace_id'], ['dataset_workspaces.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_dataset_workspace_tables_id'), 'dataset_workspace_tables', ['id'], unique=False)


def downgrade() -> None:
    # Drop tables in reverse order
    op.drop_index(op.f('ix_dataset_workspace_tables_id'), table_name='dataset_workspace_tables')
    op.drop_table('dataset_workspace_tables')
    op.drop_index(op.f('ix_dataset_workspaces_id'), table_name='dataset_workspaces')
    op.drop_table('dataset_workspaces')
