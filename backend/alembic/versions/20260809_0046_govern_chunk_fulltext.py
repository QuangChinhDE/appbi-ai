"""Full-text index on doc chunks — hybrid (vector + keyword) retrieval

Pure vector search misses exact tokens: a query for "Quy II/2026" scored 0.351
and returned a chunk that does not contain the phrase at all. Embeddings encode
meaning, not literal strings, so codes, dates, IDs and product names are exactly
what they are worst at.

The `simple` text-search config is deliberate: it does NO stemming and no
language-specific stopword removal, which is what we want for Vietnamese plus
identifiers like "v2", "31/12/2025", "Scope". A stemming config would mangle
those and, for Vietnamese, Postgres has no bundled dictionary anyway.

Revision ID: 20260809_0046
Revises: 20260806_0045
"""
from alembic import op

revision = "20260809_0046"
down_revision = "20260806_0045"
branch_labels = None
depends_on = None


def upgrade():
    # Vietnamese is written with diacritics but searched without them: the doc
    # says "Quý II/2026" and the user types "Quy II/2026". Under `simple` those
    # are two different tokens, so the keyword half of hybrid search would miss
    # the very phrase it exists to find. unaccent folds both to "quy".
    op.execute("CREATE EXTENSION IF NOT EXISTS unaccent")

    # unaccent() is only STABLE (its dictionary can be reloaded), so Postgres
    # refuses it in an index expression. Wrapping the 2-arg form — which pins
    # the dictionary explicitly — lets us honestly declare IMMUTABLE.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION appbi_unaccent(text) RETURNS text
            LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
            AS $$ SELECT public.unaccent('public.unaccent', $1) $$
        """
    )

    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_govern_doc_chunk_fts
            ON govern_doc_chunk
            USING GIN (to_tsvector('simple', appbi_unaccent(content)))
        """
    )


def downgrade():
    op.execute("DROP INDEX IF EXISTS idx_govern_doc_chunk_fts")
    op.execute("DROP FUNCTION IF EXISTS appbi_unaccent(text)")
