"""Per-document control over what may leave for an external embedding provider

Embedding a document means sending its full text, chunk by chunk, to a third
party. Until now that happened for every document with no switch and no record,
so the question an auditor actually asks — "did our salary policy leave the
building?" — had no answer anywhere in the system.

Two columns and one table:
  * `allow_external_embedding` — a per-document veto. Off means the document is
    never sent, and is therefore never retrievable by AI. That is the honest
    trade, and it is stated as such in the UI rather than failing quietly.
  * `sensitivity` — a label to reason with (`internal` by default, `confidential`,
    `restricted`). Advisory today; it is what a future org-wide policy will bind
    to, and labelling after the fact is far harder than labelling at write time.
  * `govern_doc_egress_log` — one row per transfer, not per chunk: what document,
    how many characters, to which provider and model, why, and who triggered it.

Revision ID: 20260809_0049
Revises: 20260809_0048
"""
import sqlalchemy as sa
from alembic import op

revision = "20260809_0049"
down_revision = "20260809_0048"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
        ALTER TABLE govern_knowledge_docs
            ADD COLUMN IF NOT EXISTS allow_external_embedding BOOLEAN NOT NULL DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS sensitivity VARCHAR(16) NOT NULL DEFAULT 'internal'
        """
    )

    op.create_table(
        "govern_doc_egress_log",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("doc_id", sa.Integer, nullable=False, index=True),
        sa.Column("doc_title", sa.String(300), nullable=True),
        sa.Column("sensitivity", sa.String(16), nullable=True),
        # 'embedding' = document text sent for indexing. Kept open for the query
        # side, which also leaves the building but at a very different volume.
        sa.Column("purpose", sa.String(24), nullable=False, server_default="embedding"),
        sa.Column("provider", sa.String(64), nullable=True),
        sa.Column("model", sa.String(100), nullable=True),
        sa.Column("chunks_sent", sa.Integer, nullable=False, server_default="0"),
        sa.Column("chars_sent", sa.Integer, nullable=False, server_default="0"),
        sa.Column("outcome", sa.String(16), nullable=False, server_default="sent"),
        sa.Column("triggered_by", sa.String(128), nullable=True),
        sa.Column("occurred_at", sa.DateTime, server_default=sa.func.now()),
    )
    op.create_index(
        "idx_govern_doc_egress_doc_time", "govern_doc_egress_log", ["doc_id", "occurred_at"]
    )


def downgrade():
    op.drop_index("idx_govern_doc_egress_doc_time", table_name="govern_doc_egress_log")
    op.drop_table("govern_doc_egress_log")
    op.execute(
        """
        ALTER TABLE govern_knowledge_docs
            DROP COLUMN IF EXISTS sensitivity,
            DROP COLUMN IF EXISTS allow_external_embedding
        """
    )
