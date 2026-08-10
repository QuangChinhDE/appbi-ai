"""Vector index: ivfflat -> HNSW, and make the embedding model explicit

K1. The old index was `ivfflat (embedding vector_cosine_ops) WITH (lists=10)`.
Two problems, both of which fail SILENTLY — the query still succeeds, it just
stops returning the right rows:

  * ivfflat learns its centroids WHEN THE INDEX IS BUILT and never re-learns.
    This index was created against an almost-empty table, so the centroids
    describe nothing. As the table grows the partitioning stays wrong.
  * `lists=10` with the default `ivfflat.probes = 1` scans one tenth of the
    vectors. Recall drops as rows are added, with no error anywhere.

HNSW has no training step, so it cannot be poisoned by being built early, and
its recall is governed by `hnsw.ef_search` at QUERY time — a knob we can raise
later without rebuilding. m=16 / ef_construction=64 are pgvector's defaults and
are the right starting point for a store of this size.

K2. `model_version` becomes NOT NULL. Cosine distance between vectors from two
different models is a meaningless number that still sorts, so a mixed index
degrades ranking without ever raising. Making the column mandatory is what lets
the read path filter to one model instead of trusting that nobody switched.

Revision ID: 20260809_0047
Revises: 20260809_0046
"""
from alembic import op

revision = "20260809_0047"
down_revision = "20260809_0046"
branch_labels = None
depends_on = None


def upgrade():
    # Any pre-existing row without a model predates the per-doc model setting,
    # when the only model in use was the OpenAI small one.
    op.execute(
        """
        UPDATE govern_doc_chunk
           SET model_version = 'text-embedding-3-small'
         WHERE model_version IS NULL OR btrim(model_version) = ''
        """
    )
    op.execute("ALTER TABLE govern_doc_chunk ALTER COLUMN model_version SET NOT NULL")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_govern_doc_chunk_model
            ON govern_doc_chunk (model_version)
        """
    )

    op.execute("DROP INDEX IF EXISTS idx_govern_doc_chunk_cosine")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_govern_doc_chunk_hnsw
            ON govern_doc_chunk
            USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
        """
    )


def downgrade():
    op.execute("DROP INDEX IF EXISTS idx_govern_doc_chunk_hnsw")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_govern_doc_chunk_cosine
            ON govern_doc_chunk
            USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = 10)
        """
    )
    op.execute("DROP INDEX IF EXISTS idx_govern_doc_chunk_model")
    op.execute("ALTER TABLE govern_doc_chunk ALTER COLUMN model_version DROP NOT NULL")
