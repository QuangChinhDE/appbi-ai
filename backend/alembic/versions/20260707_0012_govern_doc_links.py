"""Knowledge docs — explicit doc<->doc wikilinks (Obsidian [[...]])

Stores resolved [[Doc Title]] edges between knowledge docs so the hub becomes a
real, bidirectional knowledge GRAPH (backlinks + graph view) that AI can
traverse as authored — not inferred from shared KPIs/tags. Edges are stored by
id (resolved at save time) so a later title rename doesn't break them.
"""
from alembic import op

revision = "20260707_0012"
down_revision = "20260707_0011"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_doc_links (
            id SERIAL PRIMARY KEY,
            from_doc_id INTEGER NOT NULL,
            to_doc_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT now(),
            CONSTRAINT uq_govern_doc_link UNIQUE (from_doc_id, to_doc_id)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_doc_links_from ON govern_doc_links (from_doc_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_doc_links_to ON govern_doc_links (to_doc_id)")


def downgrade():
    op.execute("DROP TABLE IF EXISTS govern_doc_links")
