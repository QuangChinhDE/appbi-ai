"""Source domain hardening (Phase B): config version, last health, owner-scoped
names, retire DataSource.sync_config / sync_jobs, source audit actions.

Upgrade:
  * data_sources.config_version INTEGER NOT NULL DEFAULT 1 — bumped on every
    connection-affecting change; caches/clients keyed on it go stale explicitly.
  * data_sources.last_test_status / last_tested_at / last_error_code — the
    persisted result of the latest connection test (health badge).
  * Name uniqueness moves from global to per owner: the global unique index
    `ix_data_sources_name` is replaced by a NON-unique `ix_data_sources_name`,
    a unique `uq_data_sources_owner_name (owner_id, name) WHERE owner_id IS NOT NULL`
    and a unique `uq_data_sources_ownerless_name (name) WHERE owner_id IS NULL`
    (rows whose owner was deleted keep the old global rule among themselves).
    No dedupe needed on upgrade: the previous global index already guaranteed
    uniqueness, which implies uniqueness per owner.
  * Retires (NOT drops) the legacy sync storage, which has zero readers/writers
    in backend, frontend, scripts and MCP (Dataset owns sync). Nothing is lost:
    table `sync_jobs` is renamed `sync_jobs_retired` (rows kept), and every
    non-null `data_sources.sync_config` is copied into the new table
    `data_source_sync_config_retired(datasource_id, sync_config)` before the
    column is dropped.
  * New audit actions (Postgres enum members, added outside the transaction).

Downgrade re-adds `sync_config` filled from `data_source_sync_config_retired`,
renames `sync_jobs_retired` back to `sync_jobs` (rows intact), restores the global unique name index — renaming, deterministically,
any name that became duplicated across owners to "<name> (#<id>)" first so the
index can be built — and drops the new columns. Enum members stay (Postgres
cannot drop them; unused members are harmless).

SELF-CONTAINED — imports nothing from `app`.

Revision ID: 20261006_0003
Revises: 20261006_0002
"""
from alembic import op
import sqlalchemy as sa

revision = "20261006_0003"
down_revision = "20261006_0002"
branch_labels = None
depends_on = None

_AUDIT_VALUES = (
    "datasource_created",
    "datasource_config_changed",
    "datasource_auth_mode_changed",
    "datasource_test_failed",
    "datasource_deleted",
    "datasource_delete_blocked",
)


def _rename_sync_job_indexes(old_prefix: str, new_prefix: str) -> None:
    """Index names are not renamed with the table; keep them matching so a
    future `sync_jobs` cannot collide with the retired table's indexes."""
    if op.get_bind().dialect.name != "postgresql":
        return
    for suffix in ("_id", "_data_source_id"):
        op.execute(f"ALTER INDEX IF EXISTS {old_prefix}{suffix} RENAME TO {new_prefix}{suffix}")


def upgrade() -> None:
    op.add_column(
        "data_sources",
        sa.Column("config_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column("data_sources", sa.Column("last_test_status", sa.String(16), nullable=True))
    op.add_column("data_sources", sa.Column("last_tested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("data_sources", sa.Column("last_error_code", sa.String(32), nullable=True))

    op.drop_index("ix_data_sources_name", table_name="data_sources")
    op.create_index("ix_data_sources_name", "data_sources", ["name"], unique=False)
    op.create_index(
        "uq_data_sources_owner_name", "data_sources", ["owner_id", "name"], unique=True,
        postgresql_where=sa.text("owner_id IS NOT NULL"),
        sqlite_where=sa.text("owner_id IS NOT NULL"),
    )
    op.create_index(
        "uq_data_sources_ownerless_name", "data_sources", ["name"], unique=True,
        postgresql_where=sa.text("owner_id IS NULL"),
        sqlite_where=sa.text("owner_id IS NULL"),
    )

    # Retire, never destroy: keep sync_jobs rows and every non-null sync_config.
    op.rename_table("sync_jobs", "sync_jobs_retired")
    _rename_sync_job_indexes("ix_sync_jobs", "ix_sync_jobs_retired")
    op.create_table(
        "data_source_sync_config_retired",
        sa.Column("datasource_id", sa.Integer(), nullable=False),
        sa.Column("sync_config", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["datasource_id"], ["data_sources.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("datasource_id"),
    )
    op.execute(
        "INSERT INTO data_source_sync_config_retired (datasource_id, sync_config) "
        "SELECT id, sync_config FROM data_sources WHERE sync_config IS NOT NULL"
    )
    op.drop_column("data_sources", "sync_config")

    if op.get_bind().dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        for val in _AUDIT_VALUES:
            op.execute(f"ALTER TYPE auditaction ADD VALUE IF NOT EXISTS '{val}'")


def downgrade() -> None:
    op.add_column("data_sources", sa.Column("sync_config", sa.JSON(), nullable=True))
    op.execute(
        "UPDATE data_sources SET sync_config = ("
        "SELECT r.sync_config FROM data_source_sync_config_retired r "
        "WHERE r.datasource_id = data_sources.id) "
        "WHERE id IN (SELECT datasource_id FROM data_source_sync_config_retired)"
    )
    op.drop_table("data_source_sync_config_retired")
    _rename_sync_job_indexes("ix_sync_jobs_retired", "ix_sync_jobs")
    op.rename_table("sync_jobs_retired", "sync_jobs")

    op.drop_index("uq_data_sources_ownerless_name", table_name="data_sources")
    op.drop_index("uq_data_sources_owner_name", table_name="data_sources")
    op.drop_index("ix_data_sources_name", table_name="data_sources")
    # Names may now repeat across owners; keep the lowest id's name, suffix the rest.
    op.execute(
        """
        UPDATE data_sources AS d
           SET name = LEFT(d.name, 240) || ' (#' || d.id || ')'
         WHERE EXISTS (
               SELECT 1 FROM data_sources o
                WHERE o.name = d.name AND o.id < d.id)
        """
    )
    op.create_index("ix_data_sources_name", "data_sources", ["name"], unique=True)

    op.drop_column("data_sources", "last_error_code")
    op.drop_column("data_sources", "last_tested_at")
    op.drop_column("data_sources", "last_test_status")
    op.drop_column("data_sources", "config_version")
