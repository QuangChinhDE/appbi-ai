"""Drop legacy dataset tables and columns

Removes all Dataset-era tables and related columns.
Dataset concept is fully superseded by DatasetWorkspace (workspace+table model).

Revision ID: 20260320_drop_datasets
Revises: 20260320_perm03
Create Date: 2026-03-20
"""
from alembic import op
import sqlalchemy as sa

revision = '20260320_drop_datasets'
down_revision = '20260320_perm03'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Drop dataset_id FK column from charts (nullable, safe to drop)
    op.drop_column('charts', 'dataset_id')

    # 2. Drop dataset_id FK column from semantic_views (nullable, safe to drop)
    op.drop_column('semantic_views', 'dataset_id')

    # 3. Drop sync_job_runs (FK → datasets, CASCADE would handle, but drop explicitly)
    op.drop_table('sync_job_runs')

    # 4. Drop dataset model sub-tables (order: leaves first)
    op.drop_table('dataset_calculated_columns')
    op.drop_table('dataset_relationships')
    op.drop_table('dataset_tables')
    op.drop_table('dataset_models')

    # 5. Drop datasets (last, after removing all FKs pointing to it)
    op.drop_table('datasets')


def downgrade() -> None:
    # Re-create datasets table
    op.create_table(
        'datasets',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('data_source_id', sa.Integer(), nullable=False),
        sa.Column('sql_query', sa.Text(), nullable=False),
        sa.Column('columns', sa.JSON(), nullable=True),
        sa.Column('transformations', sa.JSON(), nullable=True),
        sa.Column('transformation_version', sa.Integer(), nullable=True),
        sa.Column('materialization', sa.JSON(), nullable=True),
        sa.Column('sync_config', sa.JSON(), nullable=True),
        sa.Column('owner_id', sa.dialects.postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['data_source_id'], ['data_sources.id']),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )

    # Re-add dataset_id to charts
    op.add_column('charts', sa.Column('dataset_id', sa.Integer(), nullable=True))
    op.create_foreign_key(None, 'charts', 'datasets', ['dataset_id'], ['id'])

    # Re-add dataset_id to semantic_views
    op.add_column('semantic_views', sa.Column('dataset_id', sa.Integer(), nullable=True))
    op.create_foreign_key(None, 'semantic_views', 'datasets', ['dataset_id'], ['id'])
