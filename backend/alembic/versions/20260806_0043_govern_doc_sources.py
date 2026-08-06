"""Govern knowledge doc — external sources + configurable embedding + run history

Lets a govern_knowledge_docs row be populated from an external source (a
connected Google Docs account, an uploaded PDF/DOCX/XLSX file, or a crawled
web page) instead of only hand-typed, and makes the embedding step
configurable/observable instead of a hardcoded black box:

  • govern_knowledge_docs gains source_type/source_config/sync_schedule/
    last_synced_at/last_sync_status (the "Source & Sync" tab) and
    chunk_strategy/chunk_size/chunk_overlap/embedding_model (the "Embedding"
    tab, previously hardcoded constants in govern_doc_embeddings.py).
  • govern_doc_source_files holds the CURRENT uploaded file blob only —
    content history is already fully covered by govern_knowledge_doc_versions
    (a re-upload -> new extracted body -> new doc save -> new version, same
    as a hand edit), so this is a plain doc_id-keyed upsert, not a versioned
    blob table.
  • govern_doc_runs is a unified sync+embed run log (today embed_doc()'s
    result string is computed then thrown away) so the new "History" tab has
    something real to show alongside the existing version history.

Revision ID: 20260806_0043
Revises: 20260812_0042
"""
from alembic import op

revision = "20260806_0043"
down_revision = "20260812_0042"
branch_labels = None
depends_on = None

_COLS = [
    ("source_type", "VARCHAR(24)"),
    ("source_config", "JSON NOT NULL DEFAULT '{}'"),
    ("sync_schedule", "JSON"),
    ("last_synced_at", "TIMESTAMP"),
    ("last_sync_status", "VARCHAR(16)"),
    ("chunk_strategy", "VARCHAR(16) NOT NULL DEFAULT 'paragraph'"),
    ("chunk_size", "INTEGER NOT NULL DEFAULT 850"),
    ("chunk_overlap", "INTEGER NOT NULL DEFAULT 0"),
    ("embedding_model", "VARCHAR(100)"),
]


def upgrade():
    for name, ddl in _COLS:
        op.execute(f"ALTER TABLE govern_knowledge_docs ADD COLUMN IF NOT EXISTS {name} {ddl}")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_doc_source_files (
            doc_id              INTEGER PRIMARY KEY REFERENCES govern_knowledge_docs(id) ON DELETE CASCADE,
            filename            VARCHAR(255) NOT NULL,
            content_type        VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
            byte_size           INTEGER NOT NULL DEFAULT 0,
            data                BYTEA NOT NULL,
            extracted_text_hash VARCHAR(64),
            uploaded_by         UUID REFERENCES users(id) ON DELETE SET NULL,
            uploaded_at         TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_doc_runs (
            id           SERIAL PRIMARY KEY,
            doc_id       INTEGER NOT NULL REFERENCES govern_knowledge_docs(id) ON DELETE CASCADE,
            run_type     VARCHAR(16) NOT NULL,
            trigger      VARCHAR(16) NOT NULL DEFAULT 'manual',
            status       VARCHAR(16) NOT NULL,
            detail       VARCHAR(512),
            stats        JSON,
            started_at   TIMESTAMP NOT NULL DEFAULT NOW(),
            finished_at  TIMESTAMP,
            triggered_by VARCHAR(128)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_govern_doc_runs_doc ON govern_doc_runs(doc_id, started_at DESC)")


def downgrade():
    op.execute("DROP INDEX IF EXISTS idx_govern_doc_runs_doc")
    op.execute("DROP TABLE IF EXISTS govern_doc_runs")
    op.execute("DROP TABLE IF EXISTS govern_doc_source_files")
    for name, _ in reversed(_COLS):
        op.execute(f"ALTER TABLE govern_knowledge_docs DROP COLUMN IF EXISTS {name}")
