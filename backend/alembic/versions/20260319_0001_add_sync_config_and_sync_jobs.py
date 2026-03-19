"""add_sync_config_and_sync_jobs

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2026-03-19 00:00:01.000000

Adds:
  - data_sources.sync_config (JSON) — schedule + per-table strategies + retry + notification
  - sync_jobs table — execution history for datasource syncs
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers
revision: str = 'e4f5a6b7c8d9'
down_revision: Union[str, None] = 'd3e4f5a6b7c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add sync_config to data_sources
    op.add_column('data_sources',
        sa.Column('sync_config', sa.JSON(), nullable=True)
    )

    # Create sync_jobs table
    op.create_table(
        'sync_jobs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('data_source_id', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('mode', sa.String(length=30), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('rows_synced', sa.Integer(), nullable=True),
        sa.Column('rows_failed', sa.Integer(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('triggered_by', sa.String(length=50), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['data_source_id'], ['data_sources.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_sync_jobs_id', 'sync_jobs', ['id'])
    op.create_index('ix_sync_jobs_data_source_id', 'sync_jobs', ['data_source_id'])


def downgrade() -> None:
    op.drop_index('ix_sync_jobs_data_source_id', table_name='sync_jobs')
    op.drop_index('ix_sync_jobs_id', table_name='sync_jobs')
    op.drop_table('sync_jobs')
    op.drop_column('data_sources', 'sync_config')
