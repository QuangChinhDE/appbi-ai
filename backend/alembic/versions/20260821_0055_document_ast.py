"""The document AST becomes a table, and chunks become a projection of it

WHY THIS EXISTS, AFTER I ARGUED IT SHOULD NOT
---------------------------------------------
The previous design put the structural facts (section, heading path, page) on the
CHUNK and called that enough, on the grounds that a separate table would store the
same prose twice. Two things proved that reasoning too cheap:

  * Changing the chunker meant RE-EXTRACTING every document. The chunker version
    moved three times in one session, and each move re-parsed every source — which
    for a scanned PDF means running OCR again. Extraction is the expensive half and
    it has nothing to do with how the text is later divided.
  * `chunk_id` is regenerated on every re-index, so a citation recorded in an
    answer pointed at nothing afterwards. Citations that do not survive a re-chunk
    are not citations.

So: extraction produces an AST ONCE per document version; chunking is a projection
of the AST; and a citation anchors to `(doc_id, source_version, ordinal)`, which a
re-chunk does not touch.

The duplication objection was real and is accepted deliberately: a chunk may merge
several blocks and must hold its own embeddable, indexable text. One copy, for a
stated reason. The permission objection was not a reason to skip the table — it is
work, and it is done here: blocks carry the same `doc_status`/`space`/`trust`
labels, maintained by the same triggers, under the same row-level policy.

ANCHORED TO THE PUBLISHED VERSION
---------------------------------
Retrieval serves `published_body()` — the published snapshot, or the working body
for a document that never published. `source_version` records which one an AST was
built from (0 = working body), so the AST cannot silently describe a version nobody
published. Only the live version's AST is kept; a superseded one is replaced, since
re-publishing legitimately changes the document.

STRUCTURED EXTRACTION IS PRESERVED
----------------------------------
`govern_doc_source_files.extracted_blocks` keeps what the PDF extractor actually
saw — bounding boxes, column order, figure regions — instead of only the markdown
it was flattened into. The flattening still happens (the editor and the version
snapshots are markdown), but the rich form is no longer thrown away, because
layout and figures cannot be recovered from flattened text.
`extracted_body_hash` records the markdown those blocks produced, so if an author
EDITS the extracted text the structured form is known to be stale and the AST is
built from what they actually published.

Revision ID: 20260821_0055
Revises: 20260821_0054
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260821_0055"
down_revision = "20260821_0054"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "govern_doc_block",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("doc_id", sa.Integer, nullable=False),
        # 0 = the working body (a document that never published explicitly).
        sa.Column("source_version", sa.Integer, nullable=False, server_default="0"),
        # Document order, and the stable half of a citation.
        sa.Column("ordinal", sa.Integer, nullable=False),
        sa.Column("parent_id", sa.Integer, nullable=True),
        sa.Column("kind", sa.String(16), nullable=False, server_default="paragraph"),
        # Heading depth for a section; 0 for everything else.
        sa.Column("level", sa.SmallInteger, nullable=False, server_default="0"),
        sa.Column("text", sa.Text, nullable=False, server_default=""),
        sa.Column("heading_path", sa.Text, nullable=True),
        sa.Column("page", sa.Integer, nullable=True),
        # {x0, y0, x1, y1} in PDF user space. Null for sources that have no
        # geometry — a Google Doc has structure but no page coordinates, and
        # pretending otherwise would make citations claim precision they lack.
        sa.Column("bbox", postgresql.JSONB, nullable=True),
        # The header row(s) of a table, kept separately so ANY fragment of it can
        # be re-headed. A table row without its header is a list of numbers whose
        # columns nobody can name.
        sa.Column("table_header", sa.Text, nullable=True),
        sa.Column("meta", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("token_count", sa.Integer, nullable=False, server_default="0"),
        # Same governance labels as the chunk table, same triggers, same policy.
        sa.Column("doc_status", sa.String(16), nullable=False, server_default="Draft"),
        sa.Column("space", sa.String(128), nullable=False, server_default="Chung"),
        sa.Column("trust", sa.String(16), nullable=False, server_default="authored"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )
    op.execute(
        """
        ALTER TABLE govern_doc_block
            ADD CONSTRAINT uq_govern_block_ordinal
            UNIQUE (doc_id, source_version, ordinal)
        """
    )
    op.execute(
        """
        ALTER TABLE govern_doc_block
            ADD CONSTRAINT ck_govern_block_kind
            CHECK (kind IN ('page','section','paragraph','list','table','figure',
                            'caption','code','quote'))
        """
    )
    op.execute(
        """
        ALTER TABLE govern_doc_block
            ADD CONSTRAINT fk_govern_block_parent
            FOREIGN KEY (parent_id) REFERENCES govern_doc_block (id) ON DELETE CASCADE
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_govern_block_doc "
        "ON govern_doc_block (doc_id, source_version, ordinal)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_govern_block_parent ON govern_doc_block (parent_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_govern_block_kind ON govern_doc_block (kind)"
    )

    # ── the same labelling machinery the chunk table uses ────────────────────
    op.execute(
        """
        CREATE OR REPLACE FUNCTION govern_doc_block_label() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE s VARCHAR(16); sp VARCHAR(128); src VARCHAR(24);
        BEGIN
            SELECT status, space, source_type INTO s, sp, src
              FROM govern_knowledge_docs WHERE id = NEW.doc_id;
            IF s IS NULL THEN
                RAISE EXCEPTION 'govern_doc_block: doc_id % does not exist', NEW.doc_id;
            END IF;
            NEW.doc_status := s;
            NEW.space := sp;
            NEW.trust := CASE COALESCE(src, '')
                             WHEN 'web'        THEN 'external'
                             WHEN 'google_doc' THEN 'linked'
                             WHEN 'file'       THEN 'uploaded'
                             ELSE 'authored'
                         END;
            RETURN NEW;
        END $$
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_govern_doc_block_label ON govern_doc_block")
    op.execute(
        """
        CREATE TRIGGER trg_govern_doc_block_label
            BEFORE INSERT OR UPDATE OF doc_id ON govern_doc_block
            FOR EACH ROW EXECUTE FUNCTION govern_doc_block_label()
        """
    )
    # A document's status or space changing must re-label its blocks too, or the
    # policy below starts filtering on a label that is out of date.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION govern_doc_relabel_chunks() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE src VARCHAR(24); newtrust VARCHAR(16);
        BEGIN
            IF NEW.status IS DISTINCT FROM OLD.status
               OR NEW.space IS DISTINCT FROM OLD.space
               OR NEW.source_type IS DISTINCT FROM OLD.source_type THEN
                src := NEW.source_type;
                newtrust := CASE COALESCE(src, '')
                                WHEN 'web'        THEN 'external'
                                WHEN 'google_doc' THEN 'linked'
                                WHEN 'file'       THEN 'uploaded'
                                ELSE 'authored'
                            END;
                UPDATE govern_doc_chunk
                   SET doc_status = NEW.status, space = NEW.space, trust = newtrust
                 WHERE doc_id = NEW.id;
                UPDATE govern_doc_block
                   SET doc_status = NEW.status, space = NEW.space, trust = newtrust
                 WHERE doc_id = NEW.id;
            END IF;
            RETURN NEW;
        END $$
        """
    )

    # ── row-level security, same shape as the chunk table ──────────────────
    op.execute("ALTER TABLE govern_doc_block ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE govern_doc_block FORCE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS govern_doc_block_read ON govern_doc_block")
    op.execute(
        """
        CREATE POLICY govern_doc_block_read ON govern_doc_block
            FOR SELECT
            USING (
                doc_status = 'Published'
                OR current_setting('appbi.chunk_scope', true) = 'authoring'
            )
        """
    )
    op.execute("CREATE POLICY govern_doc_block_insert ON govern_doc_block FOR INSERT WITH CHECK (true)")
    op.execute("CREATE POLICY govern_doc_block_update ON govern_doc_block FOR UPDATE USING (true) WITH CHECK (true)")
    op.execute("CREATE POLICY govern_doc_block_delete ON govern_doc_block FOR DELETE USING (true)")
    # Grant to appbi_app ONLY when the role exists. It is provisioned
    # conditionally by 0048 (skipped when the DB account lacks CREATEROLE, e.g. a
    # managed Postgres), so an unconditional GRANT here crash-loops the whole
    # boot with "role appbi_app does not exist". Guard on existence + swallow a
    # privilege error, mirroring 0048 — RLS just stays inert until a DBA
    # provisions the role. See [[migration_privileged_op_managed_pg]].
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'appbi_app') THEN
                GRANT SELECT, INSERT, UPDATE, DELETE ON govern_doc_block TO appbi_app;
                GRANT USAGE, SELECT ON SEQUENCE govern_doc_block_id_seq TO appbi_app;
            END IF;
        EXCEPTION
            WHEN insufficient_privilege OR undefined_object THEN
                RAISE NOTICE 'appbi_app grants on govern_doc_block skipped (role/privilege absent); RLS stays inert until a DBA provisions appbi_app.';
        END $$
        """
    )

    # ── the chunk points at the blocks it covers ────────────────────────────
    op.execute(
        """
        ALTER TABLE govern_doc_chunk
            ADD COLUMN IF NOT EXISTS source_version INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS block_from INTEGER NULL,
            ADD COLUMN IF NOT EXISTS block_to INTEGER NULL
        """
    )

    # ── the document tracks its AST separately from its vectors ─────────────
    #
    # Two gates, because they invalidate for different reasons: the source
    # changing invalidates the AST, and the chunker or model changing invalidates
    # only the vectors. Conflating them is what made every chunker change
    # re-run OCR.
    op.execute(
        """
        ALTER TABLE govern_knowledge_docs
            ADD COLUMN IF NOT EXISTS ast_hash VARCHAR(80) NULL,
            ADD COLUMN IF NOT EXISTS ast_version INTEGER NULL
        """
    )

    # ── structured extraction survives the flattening ──────────────────────
    op.execute(
        """
        ALTER TABLE govern_doc_source_files
            ADD COLUMN IF NOT EXISTS extracted_blocks JSONB NULL,
            ADD COLUMN IF NOT EXISTS extracted_body_hash VARCHAR(80) NULL
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE govern_doc_source_files
            DROP COLUMN IF EXISTS extracted_body_hash,
            DROP COLUMN IF EXISTS extracted_blocks
        """
    )
    op.execute(
        """
        ALTER TABLE govern_knowledge_docs
            DROP COLUMN IF EXISTS ast_version,
            DROP COLUMN IF EXISTS ast_hash
        """
    )
    op.execute(
        """
        ALTER TABLE govern_doc_chunk
            DROP COLUMN IF EXISTS block_to,
            DROP COLUMN IF EXISTS block_from,
            DROP COLUMN IF EXISTS source_version
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION govern_doc_relabel_chunks() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE src VARCHAR(24);
        BEGIN
            IF NEW.status IS DISTINCT FROM OLD.status
               OR NEW.space IS DISTINCT FROM OLD.space
               OR NEW.source_type IS DISTINCT FROM OLD.source_type THEN
                src := NEW.source_type;
                UPDATE govern_doc_chunk
                   SET doc_status = NEW.status, space = NEW.space,
                       trust = CASE COALESCE(src, '')
                                   WHEN 'web'        THEN 'external'
                                   WHEN 'google_doc' THEN 'linked'
                                   WHEN 'file'       THEN 'uploaded'
                                   ELSE 'authored'
                               END
                 WHERE doc_id = NEW.id;
            END IF;
            RETURN NEW;
        END $$
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_govern_doc_block_label ON govern_doc_block")
    op.execute("DROP FUNCTION IF EXISTS govern_doc_block_label()")
    op.drop_table("govern_doc_block")
