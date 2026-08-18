"""Materialize the embedding profile on every knowledge document.

Revision ID: 20260815_0049
Revises: 20260815_0048
"""
from alembic import op
import sqlalchemy as sa


revision = "20260815_0049"
down_revision = "20260815_0048"
branch_labels = None
depends_on = None


DEFAULT_MODEL = "text-embedding-3-small"


def upgrade() -> None:
    # Preserve an explicit document selection. For legacy null/blank rows, use
    # the dominant stored chunk label before falling back to today's default.
    op.execute(
        f"""
        UPDATE govern_knowledge_docs d
           SET embedding_model = COALESCE(
               NULLIF(btrim(d.embedding_model), ''),
               (
                   SELECT c.model_version
                     FROM govern_doc_chunk c
                    WHERE c.doc_id = d.id
                      AND c.model_version IS NOT NULL
                      AND btrim(c.model_version) <> ''
                    GROUP BY c.model_version
                    ORDER BY count(*) DESC, c.model_version
                    LIMIT 1
               ),
               '{DEFAULT_MODEL}'
           )
        """
    )
    # Legacy chunk dedup could relabel a reused vector with a newly selected
    # model. Keep the rows for rollback/inspection, but invalidate their hashes:
    # retrieval accepts only v2 hashes and the next backfill performs a full
    # rebuild without reusing a vector whose true model cannot be proven.
    op.execute(
        """
        UPDATE govern_knowledge_docs d
           SET embedded_hash = NULL
         WHERE EXISTS (
             SELECT 1 FROM govern_doc_chunk c WHERE c.doc_id = d.id
         )
        """
    )
    op.alter_column(
        "govern_knowledge_docs",
        "embedding_model",
        nullable=False,
        server_default=sa.text(f"'{DEFAULT_MODEL}'"),
    )
    op.create_index(
        "ix_govern_doc_chunk_model_doc",
        "govern_doc_chunk",
        ["model_version", "doc_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_govern_doc_chunk_model_doc", table_name="govern_doc_chunk")
    op.alter_column(
        "govern_knowledge_docs",
        "embedding_model",
        nullable=True,
        server_default=None,
    )
