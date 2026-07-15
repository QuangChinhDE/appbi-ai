"""Knowledge docs — resource ownership for per-doc sharing/permissions

Adds owner_id so a Knowledge Hub document is an owned resource (like a Dataset):
owner + admin + explicitly-shared users can see/edit it via the shared
resource_shares system. Existing docs are backfilled to the earliest ADMIN user
so nothing is orphaned (admins see everything regardless).
"""
from alembic import op

revision = "20260707_0010"
down_revision = "20260707_0009"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE govern_knowledge_docs ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL")
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_knowledge_docs_owner_id ON govern_knowledge_docs (owner_id)")
    # Backfill: adopt an admin (a user with full Govern access) as owner of
    # pre-existing docs; fall back to the earliest active user. Admins see all
    # regardless, so this only guarantees no doc is left orphaned.
    op.execute(
        """
        UPDATE govern_knowledge_docs
        SET owner_id = COALESCE(
            (SELECT id FROM users
               WHERE status = 'active' AND (permissions->>'govern') = 'full'
               ORDER BY created_at ASC, id ASC LIMIT 1),
            (SELECT id FROM users
               WHERE status = 'active'
               ORDER BY created_at ASC, id ASC LIMIT 1)
        )
        WHERE owner_id IS NULL
        """
    )


def downgrade():
    op.execute("DROP INDEX IF EXISTS ix_govern_knowledge_docs_owner_id")
    op.execute("ALTER TABLE govern_knowledge_docs DROP COLUMN IF EXISTS owner_id")
