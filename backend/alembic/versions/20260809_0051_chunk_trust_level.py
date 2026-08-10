"""Every chunk carries how much its origin can be trusted

A knowledge base that feeds agents does not merely store data — it stores text
that will later be read as context, and context is one careless prompt away from
being read as instruction. A document crawled from a public web page is written
by whoever controls that page. Ingest it once and every future agent reads it.

So each chunk records where it came from, derived from the document's source and
maintained by the same trigger that maintains the other labels — a writer cannot
declare its own content trustworthy:

    authored  — typed into AppBI by a person here
    uploaded  — extracted from a file a person here uploaded
    linked    — a Google Doc in the organisation's own workspace
    external  — crawled from a public page; contents are not ours

This is labelling, not filtering. Stripping "suspicious" phrases from ingested
text would be a guess that fails both ways: it mangles legitimate documents and
misses anything phrased differently. Telling the consumer exactly what it is
holding is the honest primitive, and it is the one a reader can act on.

Revision ID: 20260809_0051
Revises: 20260809_0050
"""
from alembic import op

revision = "20260809_0051"
down_revision = "20260809_0050"
branch_labels = None
depends_on = None

_TRUST_SQL = """
    CASE COALESCE(src, '')
        WHEN 'web'        THEN 'external'
        WHEN 'google_doc' THEN 'linked'
        WHEN 'file'       THEN 'uploaded'
        ELSE 'authored'
    END
"""


def upgrade():
    op.execute(
        "ALTER TABLE govern_doc_chunk "
        "ADD COLUMN IF NOT EXISTS trust VARCHAR(16) NOT NULL DEFAULT 'authored'"
    )
    op.execute(
        """
        UPDATE govern_doc_chunk c
           SET trust = CASE COALESCE(d.source_type, '')
                           WHEN 'web'        THEN 'external'
                           WHEN 'google_doc' THEN 'linked'
                           WHEN 'file'       THEN 'uploaded'
                           ELSE 'authored'
                       END
          FROM govern_knowledge_docs d
         WHERE d.id = c.doc_id
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_govern_doc_chunk_trust ON govern_doc_chunk (trust)")

    # Fold trust into the existing label trigger so all three derived columns
    # are maintained in one place and cannot disagree with each other.
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION govern_doc_chunk_label() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE s VARCHAR(16); sp VARCHAR(128); src VARCHAR(24);
        BEGIN
            SELECT status, space, source_type INTO s, sp, src
              FROM govern_knowledge_docs WHERE id = NEW.doc_id;
            IF s IS NULL THEN
                RAISE EXCEPTION 'govern_doc_chunk: doc_id % does not exist', NEW.doc_id;
            END IF;
            NEW.doc_status := s;
            NEW.space := sp;
            NEW.trust := {_TRUST_SQL};
            RETURN NEW;
        END $$
        """
    )

    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION govern_doc_relabel_chunks() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE src VARCHAR(24);
        BEGIN
            IF NEW.status IS DISTINCT FROM OLD.status
               OR NEW.space IS DISTINCT FROM OLD.space
               OR NEW.source_type IS DISTINCT FROM OLD.source_type THEN
                src := NEW.source_type;
                UPDATE govern_doc_chunk
                   SET doc_status = NEW.status, space = NEW.space, trust = {_TRUST_SQL}
                 WHERE doc_id = NEW.id;
            END IF;
            RETURN NEW;
        END $$
        """
    )


def downgrade():
    op.execute("DROP INDEX IF EXISTS idx_govern_doc_chunk_trust")
    op.execute("ALTER TABLE govern_doc_chunk DROP COLUMN IF EXISTS trust")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION govern_doc_chunk_label() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE s VARCHAR(16); sp VARCHAR(128);
        BEGIN
            SELECT status, space INTO s, sp FROM govern_knowledge_docs WHERE id = NEW.doc_id;
            IF s IS NULL THEN
                RAISE EXCEPTION 'govern_doc_chunk: doc_id % does not exist', NEW.doc_id;
            END IF;
            NEW.doc_status := s; NEW.space := sp;
            RETURN NEW;
        END $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION govern_doc_relabel_chunks() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.status IS DISTINCT FROM OLD.status OR NEW.space IS DISTINCT FROM OLD.space THEN
                UPDATE govern_doc_chunk SET doc_status = NEW.status, space = NEW.space
                 WHERE doc_id = NEW.id;
            END IF;
            RETURN NEW;
        END $$
        """
    )
