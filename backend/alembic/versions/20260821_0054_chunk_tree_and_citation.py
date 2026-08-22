"""Every chunk records the section it came from, so a passage can be cited

Two changes that only make sense together.

CITATION. `chunk_index` could say "the fourth chunk", which is not an answer to
"where does this come from". `heading_path`, `page` and `block_kind` are what a
citation is made of, and they are recorded at index time because reconstructing
them from a re-chunked document later is guesswork.

SMALL TO BIG. A chunk sized for search is too small to reason from, and one sized
for reasoning is too vague to search. So chunks stay small and precise, and
`section_index` groups the ones that belong to the same heading — the retriever
returns the passage that matched AND the section around it.

WHY THERE IS NO SECTION ROW, AND NO AST TABLE
---------------------------------------------
The first attempt stored the section as its own row (`level` 0, never embedded)
with children pointing at it. It worked, and then it turned out to be storing the
same prose twice: for a short section the parent row was byte-identical to its one
child. Suppressing those exposed the real shape of the thing — a section has no
text of its own. Its text IS its children, concatenated.

So a section is not a row. It is a KEY: `section_index` is stable within a
document, and the section's content is assembled at read time from the chunks
that share it. Nothing is duplicated, sections cannot drift from their children,
and there is no second table holding document text that would need its own copy
of the status/space/trust labels and row-level policy.

`section_index` rather than grouping on `heading_path` because a document may
repeat a heading, and two different sections that happen to share a title must not
merge into one context.

`token_count` replaces character length as the sizing unit: the same 850-character
budget is a very different amount of content in Vietnamese than in English.

Existing rows keep working — `section_index` defaults to 0 and `heading_path` to
NULL, so they remain searchable exactly as before until the queue re-indexes them.

Revision ID: 20260821_0054
Revises: 20260821_0053
"""
from alembic import op

revision = "20260821_0054"
down_revision = "20260821_0053"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE govern_doc_chunk
            ADD COLUMN IF NOT EXISTS section_index INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS heading_path TEXT NULL,
            ADD COLUMN IF NOT EXISTS block_kind VARCHAR(16) NOT NULL DEFAULT 'prose',
            ADD COLUMN IF NOT EXISTS page INTEGER NULL,
            ADD COLUMN IF NOT EXISTS token_count INTEGER NOT NULL DEFAULT 0
        """
    )
    # The read pattern this exists for: given a chunk that matched, fetch the rest
    # of its section in one indexed lookup.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_govern_doc_chunk_section
            ON govern_doc_chunk (doc_id, section_index, chunk_index)
        """
    )
    # Backfill so the column never lies about existing rows; the re-index replaces
    # these with the chunker's own numbers.
    op.execute(
        "UPDATE govern_doc_chunk SET token_count = GREATEST(1, ROUND(length(content) / 3.1))"
        " WHERE token_count = 0"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_govern_doc_chunk_section")
    op.execute(
        """
        ALTER TABLE govern_doc_chunk
            DROP COLUMN IF EXISTS token_count,
            DROP COLUMN IF EXISTS page,
            DROP COLUMN IF EXISTS block_kind,
            DROP COLUMN IF EXISTS heading_path,
            DROP COLUMN IF EXISTS section_index
        """
    )
