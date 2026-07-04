"""govern doc chunks — pgvector RAG for knowledge docs

Adds:
  • govern_doc_chunk: per-chunk text + 768-dim embedding (pgvector, cosine ivfflat)
    so the AI bot retrieves the MOST RELEVANT passages of a long business doc
    instead of a truncated summary blurb.
  • govern_knowledge_docs.embedded_hash: sha256(body)+model of the last embedded
    body, so re-saving an unchanged doc costs ZERO embedding calls (hash-gated).

Reuses the pgvector extension + 768-dim convention already established by
resource_embeddings (Cloud SQL for PostgreSQL supports pgvector natively).
"""
from alembic import op

revision = "20260704_0007"
down_revision = "20260704_0006"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_doc_chunk (
            id            SERIAL PRIMARY KEY,
            doc_id        INTEGER NOT NULL,
            chunk_index   INTEGER NOT NULL DEFAULT 0,
            content       TEXT NOT NULL,
            content_hash  VARCHAR(64) NOT NULL,
            embedding     vector(768),
            model_version VARCHAR(100),
            created_at    TIMESTAMP DEFAULT NOW()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_govern_doc_chunk_doc ON govern_doc_chunk(doc_id)")
    # IVFFlat cosine index (mirrors resource_embeddings); guard so it only builds once.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_govern_doc_chunk_cosine') THEN
                CREATE INDEX idx_govern_doc_chunk_cosine
                    ON govern_doc_chunk USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
            END IF;
        END$$
        """
    )
    op.execute("ALTER TABLE govern_knowledge_docs ADD COLUMN IF NOT EXISTS embedded_hash VARCHAR(80)")


def downgrade():
    op.execute("ALTER TABLE govern_knowledge_docs DROP COLUMN IF EXISTS embedded_hash")
    op.execute("DROP TABLE IF EXISTS govern_doc_chunk")
