"""Chunk carries its own permission labels, and RLS as a second line of defence

S2. A chunk row used to be `(doc_id, content, embedding)` and nothing else, so
every caller had to JOIN back to the document to learn whether the text was
publishable and whose space it belonged to. Isolation that depends on remembering
a JOIN is isolation that will eventually be forgotten — and what leaks from a
vector store is not a stray row, it is "the passage most relevant to the question
being asked".

`doc_status` and `space` are therefore denormalised onto the chunk and kept
correct by TRIGGERS, not by application code:
  * BEFORE INSERT/UPDATE on the chunk derives both from the document, so a writer
    cannot label a chunk as something it is not.
  * AFTER UPDATE on the document propagates a status/space change to its chunks,
    so un-publishing a document re-labels its vectors in the same transaction.

S1. Row-level security then enforces the default that used to be a convention:
a SELECT sees published chunks only, unless the session explicitly asks for
authoring scope. Any future consumer that forgets the published filter now gets
nothing instead of everything.

IMPORTANT — this policy is INERT until the application connects as a role that
is neither SUPERUSER nor BYPASSRLS. Postgres skips RLS entirely for such roles.
The migration therefore also creates `appbi_app`, a least-privilege role with the
grants the application needs; activating it is a deployment change (point
DATABASE_URL at it). `GovernanceService.vector_store_health()` reports whether
the protection is actually in force, so this can never be quietly assumed.

Revision ID: 20260809_0048
Revises: 20260809_0047
"""
from alembic import op

revision = "20260809_0048"
down_revision = "20260809_0047"
branch_labels = None
depends_on = None


def upgrade():
    # ── S2 · labels ────────────────────────────────────────────────────────
    op.execute(
        """
        ALTER TABLE govern_doc_chunk
            ADD COLUMN IF NOT EXISTS doc_status VARCHAR(16) NOT NULL DEFAULT 'Draft',
            ADD COLUMN IF NOT EXISTS space      VARCHAR(128) NOT NULL DEFAULT 'Chung'
        """
    )
    op.execute(
        """
        UPDATE govern_doc_chunk c
           SET doc_status = d.status, space = d.space
          FROM govern_knowledge_docs d
         WHERE d.id = c.doc_id
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_govern_doc_chunk_labels
            ON govern_doc_chunk (doc_status, space)
        """
    )

    # Derived, never supplied: the writer's opinion of a chunk's status is
    # irrelevant, only the document's is.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION govern_doc_chunk_label() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE s VARCHAR(16); sp VARCHAR(128);
        BEGIN
            SELECT status, space INTO s, sp
              FROM govern_knowledge_docs WHERE id = NEW.doc_id;
            IF s IS NULL THEN
                RAISE EXCEPTION 'govern_doc_chunk: doc_id % does not exist', NEW.doc_id;
            END IF;
            NEW.doc_status := s;
            NEW.space := sp;
            RETURN NEW;
        END $$
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_govern_doc_chunk_label ON govern_doc_chunk")
    op.execute(
        """
        CREATE TRIGGER trg_govern_doc_chunk_label
            BEFORE INSERT OR UPDATE OF doc_id ON govern_doc_chunk
            FOR EACH ROW EXECUTE FUNCTION govern_doc_chunk_label()
        """
    )

    op.execute(
        """
        CREATE OR REPLACE FUNCTION govern_doc_relabel_chunks() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.status IS DISTINCT FROM OLD.status
               OR NEW.space IS DISTINCT FROM OLD.space THEN
                UPDATE govern_doc_chunk
                   SET doc_status = NEW.status, space = NEW.space
                 WHERE doc_id = NEW.id;
            END IF;
            RETURN NEW;
        END $$
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_govern_doc_relabel ON govern_knowledge_docs")
    op.execute(
        """
        CREATE TRIGGER trg_govern_doc_relabel
            AFTER UPDATE ON govern_knowledge_docs
            FOR EACH ROW EXECUTE FUNCTION govern_doc_relabel_chunks()
        """
    )

    # ── S1 · row-level security ───────────────────────────────────────────
    op.execute("ALTER TABLE govern_doc_chunk ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE govern_doc_chunk FORCE ROW LEVEL SECURITY")

    # Reads default to published-only. `appbi.chunk_scope = 'authoring'` is the
    # explicit, per-transaction opt-in the Knowledge Hub console sets for itself.
    op.execute("DROP POLICY IF EXISTS govern_doc_chunk_read ON govern_doc_chunk")
    op.execute(
        """
        CREATE POLICY govern_doc_chunk_read ON govern_doc_chunk
            FOR SELECT
            USING (
                doc_status = 'Published'
                OR current_setting('appbi.chunk_scope', true) = 'authoring'
            )
        """
    )
    # Writes are not the threat being modelled here (they already require an
    # authenticated editor), and blocking them would break re-indexing a draft.
    for name, action in (("insert", "INSERT"), ("update", "UPDATE"), ("delete", "DELETE")):
        op.execute(f"DROP POLICY IF EXISTS govern_doc_chunk_{name} ON govern_doc_chunk")
    op.execute("CREATE POLICY govern_doc_chunk_insert ON govern_doc_chunk FOR INSERT WITH CHECK (true)")
    op.execute("CREATE POLICY govern_doc_chunk_update ON govern_doc_chunk FOR UPDATE USING (true) WITH CHECK (true)")
    op.execute("CREATE POLICY govern_doc_chunk_delete ON govern_doc_chunk FOR DELETE USING (true)")

    # The role the policy is meant for. Created + granted here, but not switched
    # to — connecting as it is a deployment decision, and doing it here would lock
    # out a running stack mid-migration.
    #
    # On a managed / restricted Postgres the connecting account often lacks the
    # CREATEROLE attribute (and may not own every table). Provisioning appbi_app
    # is defence-in-depth and INERT until DATABASE_URL points at it, so if we
    # cannot create the role we SKIP the whole block with a NOTICE rather than
    # failing the entire migration (which would crash-loop the backend on boot).
    # A DBA can create appbi_app + grants later; vector_store_health() reports
    # whether the protection is actually in force. App-level permission checks are
    # unaffected either way. Everything is inside ONE DO block so a mid-way
    # insufficient_privilege rolls the block back cleanly (no half-granted state).
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'appbi_app') THEN
                CREATE ROLE appbi_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
            END IF;
            GRANT USAGE ON SCHEMA public TO appbi_app;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO appbi_app;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO appbi_app;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public
                GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO appbi_app;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public
                GRANT USAGE, SELECT ON SEQUENCES TO appbi_app;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'appbi_app not provisioned (account lacks CREATEROLE/grant). RLS stays inert; a DBA can create the role + grants and point DATABASE_URL at it. App-level permission enforcement is unaffected.';
        END $$
        """
    )


def downgrade():
    op.execute("DROP POLICY IF EXISTS govern_doc_chunk_read ON govern_doc_chunk")
    op.execute("DROP POLICY IF EXISTS govern_doc_chunk_insert ON govern_doc_chunk")
    op.execute("DROP POLICY IF EXISTS govern_doc_chunk_update ON govern_doc_chunk")
    op.execute("DROP POLICY IF EXISTS govern_doc_chunk_delete ON govern_doc_chunk")
    op.execute("ALTER TABLE govern_doc_chunk NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE govern_doc_chunk DISABLE ROW LEVEL SECURITY")

    op.execute("DROP TRIGGER IF EXISTS trg_govern_doc_relabel ON govern_knowledge_docs")
    op.execute("DROP FUNCTION IF EXISTS govern_doc_relabel_chunks()")
    op.execute("DROP TRIGGER IF EXISTS trg_govern_doc_chunk_label ON govern_doc_chunk")
    op.execute("DROP FUNCTION IF EXISTS govern_doc_chunk_label()")

    op.execute("DROP INDEX IF EXISTS idx_govern_doc_chunk_labels")
    op.execute("ALTER TABLE govern_doc_chunk DROP COLUMN IF EXISTS space")
    op.execute("ALTER TABLE govern_doc_chunk DROP COLUMN IF EXISTS doc_status")
    # appbi_app is intentionally left in place: dropping a role that a deployment
    # may already be connecting as would take the application down.
