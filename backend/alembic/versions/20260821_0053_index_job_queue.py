"""Indexing becomes a queued job instead of work done inside a save

Embedding ran SYNCHRONOUSLY inside the request that saved a document — three call
sites: two in `upsert_knowledge_doc`/`publish_version` and one in `sync_doc`. Nine
documents made that invisible. It does not survive the roadmap:

  * contextual + parent/child chunking roughly triples the vectors per document,
  * every change to the chunking configuration invalidates the hash for the WHOLE
    library at once, so a re-index is a bulk operation, not an incident,
  * a 500-chunk document is 500 provider calls, and an HTTP request will time out
    long before it finishes — leaving the document half-indexed with no record
    that anything was left undone.

One row per document, not per request: `doc_id` is UNIQUE and enqueueing UPSERTS.
Saving a document ten times while the worker is busy must leave one job to do,
not ten — and the tenth save's reason is the one that matters.

`state` is deliberately small. 'queued' and 'running' are what the UI shows
instead of pretending a document is indexed; 'error' keeps `attempts` and the
message so a failure is visible rather than retried forever in silence.

Revision ID: 20260821_0053
Revises: 20260821_0052
"""
import sqlalchemy as sa
from alembic import op

revision = "20260821_0053"
down_revision = "20260821_0052"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "govern_doc_index_job",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("doc_id", sa.Integer, nullable=False, unique=True),
        # Why this document is in the queue, for the audit and for the screen:
        # 'save' | 'publish' | 'source_sync' | 'manual' | 'repair' | 'config'
        sa.Column("reason", sa.String(24), nullable=False, server_default="save"),
        sa.Column("state", sa.String(12), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("error", sa.String(512), nullable=True),
        sa.Column("result", sa.JSON, nullable=True),
        sa.Column("requested_by", sa.String(128), nullable=True),
        sa.Column("queued_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime, nullable=True),
        sa.Column("finished_at", sa.DateTime, nullable=True),
    )
    op.execute(
        """
        ALTER TABLE govern_doc_index_job
            ADD CONSTRAINT ck_govern_index_job_state
            CHECK (state IN ('queued', 'running', 'done', 'error'))
        """
    )
    # The worker's only question: what is waiting, oldest first.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_govern_index_job_pending
            ON govern_doc_index_job (state, queued_at)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_govern_index_job_pending")
    op.drop_table("govern_doc_index_job")
