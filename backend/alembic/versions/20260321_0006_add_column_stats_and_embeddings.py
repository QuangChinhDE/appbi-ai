"""Add column_stats, auto_description to workspace tables; add resource_embeddings with pgvector.

Revision ID: 20260321_ai01
Revises: 20260321_schema05
Create Date: 2026-03-21
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = '20260321_ai01'
down_revision = '20260321_schema05'
branch_labels = None
depends_on = None


def upgrade():
    # ── Column stats on workspace tables ────────────────────────────────────
    op.add_column('dataset_workspace_tables',
        sa.Column('column_stats', JSONB, nullable=True))
    op.add_column('dataset_workspace_tables',
        sa.Column('auto_description', sa.Text, nullable=True))
    op.add_column('dataset_workspace_tables',
        sa.Column('stats_updated_at', sa.DateTime, nullable=True))

    # ── pgvector extension + resource_embeddings table ───────────────────────
    op.execute('CREATE EXTENSION IF NOT EXISTS vector')

    op.execute("""
        CREATE TABLE IF NOT EXISTS resource_embeddings (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            resource_type VARCHAR(50) NOT NULL,
            resource_id   INTEGER NOT NULL,
            embedding     vector(768),
            source_text   TEXT NOT NULL,
            model_version VARCHAR(100) DEFAULT 'models/text-embedding-004',
            created_at    TIMESTAMP DEFAULT NOW(),
            updated_at    TIMESTAMP DEFAULT NOW(),
            UNIQUE (resource_type, resource_id)
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_embeddings_type
            ON resource_embeddings(resource_type)
    """)

    # IVFFlat index for cosine similarity (requires at least 1 row to build,
    # so we use a conditional create via a DO block)
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE indexname = 'idx_embeddings_cosine'
            ) THEN
                CREATE INDEX idx_embeddings_cosine
                    ON resource_embeddings
                    USING ivfflat (embedding vector_cosine_ops)
                    WITH (lists = 10);
            END IF;
        END$$
    """)


def downgrade():
    op.execute('DROP TABLE IF EXISTS resource_embeddings')
    op.drop_column('dataset_workspace_tables', 'stats_updated_at')
    op.drop_column('dataset_workspace_tables', 'auto_description')
    op.drop_column('dataset_workspace_tables', 'column_stats')
