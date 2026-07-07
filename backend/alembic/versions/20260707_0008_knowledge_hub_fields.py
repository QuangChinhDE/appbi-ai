"""Knowledge Hub fields — richer doc metadata + AI summary + usage counters

Extends govern_knowledge_docs so a document is an AI-readable knowledge node,
not just markdown:
  • business metadata: business_domain, process_ref, review_date,
    last_verified_at, importance — powers the AI-ready score + review workflow.
  • AI section: ai_summary / ai_keywords generated on save, hash-gated by
    ai_summary_hash (unchanged body → zero LLM calls), user-editable.
  • usage telemetry: view_count/last_viewed_at (doc opened) and
    retrieval_count (RAG/bot pulled this doc's chunks) — powers
    most-viewed / most-retrieved insights for knowledge managers.
"""
from alembic import op

revision = "20260707_0008"
down_revision = "20260704_0007"
branch_labels = None
depends_on = None

_COLS = [
    ("business_domain", "VARCHAR(120)"),
    ("process_ref", "VARCHAR(160)"),
    ("review_date", "DATE"),
    ("last_verified_at", "TIMESTAMP"),
    ("importance", "VARCHAR(12) DEFAULT 'normal'"),
    ("ai_summary", "TEXT"),
    ("ai_keywords", "JSON"),
    ("ai_summary_hash", "VARCHAR(80)"),
    ("view_count", "INTEGER DEFAULT 0"),
    ("last_viewed_at", "TIMESTAMP"),
    ("retrieval_count", "INTEGER DEFAULT 0"),
]


def upgrade():
    for name, ddl in _COLS:
        op.execute(f"ALTER TABLE govern_knowledge_docs ADD COLUMN IF NOT EXISTS {name} {ddl}")


def downgrade():
    for name, _ in reversed(_COLS):
        op.execute(f"ALTER TABLE govern_knowledge_docs DROP COLUMN IF EXISTS {name}")
