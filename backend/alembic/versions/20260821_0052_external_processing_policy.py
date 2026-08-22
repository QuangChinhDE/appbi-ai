"""One per-document policy for everything that leaves the building

`allow_external_embedding` was a boolean about ONE outbound call. The roadmap adds
three more — OCR, figure/chart description, and (if a cross-encoder is ever hosted)
reranking — and a boolean named after embedding cannot govern them. A document
marked "must not leave" would have had its page images sent to a vision model
while its text was correctly withheld, which is worse than no control because the
screen said the control was on.

So the boolean becomes a policy with three levels, and the old column is DROPPED
rather than kept in sync:

    none       nothing about this document is sent anywhere. It is unreachable by
               AI, and the UI says so instead of failing quietly.
    embedding  text may be embedded (the current default, and what every existing
               row means). OCR and vision are refused.
    full       any external processing is allowed, including OCR and figure
               description, which send page images rather than prose.

Two columns would mean two sources of truth and a migration that never finishes;
readers are moved in the same change.

Revision ID: 20260821_0052
Revises: 20260816_0051
"""
import sqlalchemy as sa
from alembic import op

revision = "20260821_0052"
down_revision = "20260816_0051"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE govern_knowledge_docs
            ADD COLUMN IF NOT EXISTS external_processing VARCHAR(16)
                NOT NULL DEFAULT 'embedding'
        """
    )
    # Carry the existing decision across. FALSE was the deliberate "do not send
    # this" and must land on 'none'; everything else keeps today's behaviour.
    op.execute(
        """
        UPDATE govern_knowledge_docs
           SET external_processing = CASE
                 WHEN allow_external_embedding IS FALSE THEN 'none'
                 ELSE 'embedding'
               END
        """
    )
    op.execute(
        """
        ALTER TABLE govern_knowledge_docs
            ADD CONSTRAINT ck_govern_docs_external_processing
            CHECK (external_processing IN ('none', 'embedding', 'full'))
        """
    )
    op.execute("ALTER TABLE govern_knowledge_docs DROP COLUMN IF EXISTS allow_external_embedding")

    # The egress log already had `purpose`; it now carries values other than
    # 'embedding', so index the pair an audit actually asks for.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_govern_doc_egress_purpose
            ON govern_doc_egress_log (purpose, occurred_at)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_govern_doc_egress_purpose")
    op.execute(
        """
        ALTER TABLE govern_knowledge_docs
            ADD COLUMN IF NOT EXISTS allow_external_embedding BOOLEAN NOT NULL DEFAULT TRUE
        """
    )
    op.execute(
        """
        UPDATE govern_knowledge_docs
           SET allow_external_embedding = (external_processing <> 'none')
        """
    )
    op.execute(
        "ALTER TABLE govern_knowledge_docs "
        "DROP CONSTRAINT IF EXISTS ck_govern_docs_external_processing"
    )
    op.execute("ALTER TABLE govern_knowledge_docs DROP COLUMN IF EXISTS external_processing")
