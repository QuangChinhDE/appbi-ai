"""Snapshot generation + host identity + delayed GC (refactor Phase 4).

Adds to dataset_table_snapshots:
  generation         — one id per refresh batch: a chart resolves the newest
                       COMPLETE generation, so its tables always come from the
                       SAME refresh (no torn half-old/half-new reads mid-rebuild).
  host_datasource_id / host_project / host_location
                     — which BigQuery datasource/project hosts the physical
                       table, recorded at build time (read-time credential/host
                       selection comes from the registry, not re-derived).
  retired_at         — set when the physical table is actually dropped; GC is
                       DELAYED (previous complete generation + grace window are
                       retained) so in-flight queries never read a dropped table.

All additive + nullable — legacy rows keep working via the per-table
is_current fallback.
"""
from alembic import op

revision = "20260717_0014"
down_revision = "20260712_0013"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
        ALTER TABLE dataset_table_snapshots
            ADD COLUMN IF NOT EXISTS generation BIGINT,
            ADD COLUMN IF NOT EXISTS host_datasource_id INTEGER,
            ADD COLUMN IF NOT EXISTS host_project VARCHAR(255),
            ADD COLUMN IF NOT EXISTS host_location VARCHAR(64),
            ADD COLUMN IF NOT EXISTS retired_at TIMESTAMP
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_dts_dataset_generation
            ON dataset_table_snapshots (dataset_id, generation)
        """
    )


def downgrade():
    op.execute("DROP INDEX IF EXISTS idx_dts_dataset_generation")
    op.execute(
        """
        ALTER TABLE dataset_table_snapshots
            DROP COLUMN IF EXISTS generation,
            DROP COLUMN IF EXISTS host_datasource_id,
            DROP COLUMN IF EXISTS host_project,
            DROP COLUMN IF EXISTS host_location,
            DROP COLUMN IF EXISTS retired_at
        """
    )
