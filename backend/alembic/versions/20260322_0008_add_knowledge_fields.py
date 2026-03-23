"""Add knowledge system fields to workspace tables and chart_metadata.

Revision ID: 20260322_fb01
Revises: 20260321_ai02
Create Date: 2026-03-22

Adds:
  dataset_workspace_tables:
    column_descriptions, common_questions, query_aliases,
    description_source, description_updated_at,
    schema_hash, schema_change_pending

  chart_metadata:
    auto_description, insight_keywords, common_questions,
    query_aliases, description_source, description_updated_at
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = '20260322_fb01'
down_revision = '20260321_ai02'
branch_labels = None
depends_on = None


def upgrade():
    # ── dataset_workspace_tables ────────────────────────────────────────────
    op.add_column('dataset_workspace_tables',
        sa.Column('column_descriptions', JSONB, nullable=True))
    op.add_column('dataset_workspace_tables',
        sa.Column('common_questions', JSONB, nullable=True))
    op.add_column('dataset_workspace_tables',
        sa.Column('query_aliases', JSONB, nullable=True))
    op.add_column('dataset_workspace_tables',
        sa.Column('description_source', sa.String(20), nullable=True))
    op.add_column('dataset_workspace_tables',
        sa.Column('description_updated_at', sa.DateTime(), nullable=True))
    op.add_column('dataset_workspace_tables',
        sa.Column('schema_hash', sa.String(64), nullable=True))
    op.add_column('dataset_workspace_tables',
        sa.Column('schema_change_pending', sa.Boolean(),
                  nullable=True, server_default='false'))

    # ── chart_metadata ──────────────────────────────────────────────────────
    op.add_column('chart_metadata',
        sa.Column('auto_description', sa.Text(), nullable=True))
    op.add_column('chart_metadata',
        sa.Column('insight_keywords', JSONB, nullable=True))
    op.add_column('chart_metadata',
        sa.Column('common_questions', JSONB, nullable=True))
    op.add_column('chart_metadata',
        sa.Column('query_aliases', JSONB, nullable=True))
    op.add_column('chart_metadata',
        sa.Column('description_source', sa.String(20), nullable=True))
    op.add_column('chart_metadata',
        sa.Column('description_updated_at', sa.DateTime(timezone=True),
                  nullable=True))


def downgrade():
    # chart_metadata
    op.drop_column('chart_metadata', 'description_updated_at')
    op.drop_column('chart_metadata', 'description_source')
    op.drop_column('chart_metadata', 'query_aliases')
    op.drop_column('chart_metadata', 'common_questions')
    op.drop_column('chart_metadata', 'insight_keywords')
    op.drop_column('chart_metadata', 'auto_description')

    # dataset_workspace_tables
    op.drop_column('dataset_workspace_tables', 'schema_change_pending')
    op.drop_column('dataset_workspace_tables', 'schema_hash')
    op.drop_column('dataset_workspace_tables', 'description_updated_at')
    op.drop_column('dataset_workspace_tables', 'description_source')
    op.drop_column('dataset_workspace_tables', 'query_aliases')
    op.drop_column('dataset_workspace_tables', 'common_questions')
    op.drop_column('dataset_workspace_tables', 'column_descriptions')
