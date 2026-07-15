"""Govern knowledge docs — version-level publishing

A document can now have a specific version marked as "published/live" that is
independent of the latest working draft: v1 can stay published while v2 is an
in-progress draft. `published_version` points at the live version; the RAG /
public consumption path reads that version's body (not the latest draft).

Backfill: any doc already flagged status='Published' has its current `version`
adopted as the published one, so existing live docs keep serving unchanged.
"""
from alembic import op

revision = "20260707_0009"
down_revision = "20260707_0008"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE govern_knowledge_docs ADD COLUMN IF NOT EXISTS published_version INTEGER")
    op.execute("UPDATE govern_knowledge_docs SET published_version = version WHERE status = 'Published' AND published_version IS NULL")


def downgrade():
    op.execute("ALTER TABLE govern_knowledge_docs DROP COLUMN IF EXISTS published_version")
