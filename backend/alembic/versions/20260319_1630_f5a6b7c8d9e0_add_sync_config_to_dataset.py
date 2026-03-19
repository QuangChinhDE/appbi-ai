"""add_sync_config_to_dataset_and_sync_job_runs

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-03-19 16:30:00.000000

Design change:
  - sync_config moves from DataSource level → Dataset level (ADR-001)
  - New table sync_job_runs linked to dataset_id (replaces sync_jobs for new workflow)
  - sync_jobs table kept for backward compat (existing Source-level sync history)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'f5a6b7c8d9e0'
down_revision: Union[str, None] = 'e4f5a6b7c8d9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add sync_config to datasets (not data_sources — see ADR-001)
    op.add_column('datasets',
        sa.Column('sync_config', sa.JSON(), nullable=True)
    )

    # Create sync_job_runs table (Dataset-level sync history)
    op.create_table(
        'sync_job_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('dataset_id', sa.Integer(), nullable=False),
        sa.Column('triggered_by', sa.String(length=50), nullable=True),
        sa.Column('mode', sa.String(length=50), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='running'),
        sa.Column('rows_pulled', sa.Integer(), nullable=True),
        sa.Column('duration_seconds', sa.Float(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['dataset_id'], ['datasets.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_sync_job_runs_id', 'sync_job_runs', ['id'])
    op.create_index('ix_sync_job_runs_dataset_id', 'sync_job_runs', ['dataset_id'])


def downgrade() -> None:
    op.drop_index('ix_sync_job_runs_dataset_id', table_name='sync_job_runs')
    op.drop_index('ix_sync_job_runs_id', table_name='sync_job_runs')
    op.drop_table('sync_job_runs')
    op.drop_column('datasets', 'sync_config')
