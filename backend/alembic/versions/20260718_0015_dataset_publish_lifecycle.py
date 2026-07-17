"""Dataset publish lifecycle + dataset grants + composition lineage (Phase 1).

Additive + nullable → LEGACY datasets keep the old live/opt-in-snapshot
behaviour (publish_state NULL). The published-only gate applies ONLY to a
dataset explicitly taken through Sync & Publish.

  datasets: publish_state, published_generation, published_at,
            published_design_fingerprint, last_sync_error, security_scope
  dataset_grants:       per-Dataset access verbs (view/explore/build/reshare/edit/manage)
  dataset_dependencies: Dataset-on-Dataset lineage w/ pinned parent generation
"""
from alembic import op

revision = "20260718_0015"
down_revision = "20260717_0014"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
        ALTER TABLE datasets
            ADD COLUMN IF NOT EXISTS publish_state VARCHAR(24),
            ADD COLUMN IF NOT EXISTS published_generation BIGINT,
            ADD COLUMN IF NOT EXISTS published_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS published_design_fingerprint VARCHAR(64),
            ADD COLUMN IF NOT EXISTS last_sync_error TEXT,
            ADD COLUMN IF NOT EXISTS security_scope VARCHAR(64)
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_datasets_publish_state ON datasets (publish_state)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_grants (
            id SERIAL PRIMARY KEY,
            dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
            verb VARCHAR(16) NOT NULL DEFAULT 'view',
            granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT now(),
            CONSTRAINT ck_dataset_grants_single_target
                CHECK ((user_id IS NOT NULL AND team_id IS NULL) OR (user_id IS NULL AND team_id IS NOT NULL)),
            CONSTRAINT uq_dataset_grants_user UNIQUE (dataset_id, user_id),
            CONSTRAINT uq_dataset_grants_team UNIQUE (dataset_id, team_id)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_dataset_grants_dataset ON dataset_grants (dataset_id)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_dependencies (
            id SERIAL PRIMARY KEY,
            child_dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            parent_dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            parent_generation BIGINT,
            materialized BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMP DEFAULT now(),
            CONSTRAINT uq_dataset_dependency UNIQUE (child_dataset_id, parent_dataset_id),
            CONSTRAINT ck_dataset_dependency_no_self CHECK (child_dataset_id <> parent_dataset_id)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_dataset_deps_child ON dataset_dependencies (child_dataset_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_dataset_deps_parent ON dataset_dependencies (parent_dataset_id)")


def downgrade():
    op.execute("DROP TABLE IF EXISTS dataset_dependencies")
    op.execute("DROP TABLE IF EXISTS dataset_grants")
    op.execute("DROP INDEX IF EXISTS idx_datasets_publish_state")
    op.execute(
        """
        ALTER TABLE datasets
            DROP COLUMN IF EXISTS publish_state,
            DROP COLUMN IF EXISTS published_generation,
            DROP COLUMN IF EXISTS published_at,
            DROP COLUMN IF EXISTS published_design_fingerprint,
            DROP COLUMN IF EXISTS last_sync_error,
            DROP COLUMN IF EXISTS security_scope
        """
    )
