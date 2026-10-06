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
  * DESTRUCTIVE (declared): drops `data_sources.sync_config` and table
    `sync_jobs`. Both have zero readers/writers in backend, frontend, scripts
    and MCP (Dataset owns sync). Their content is lost on upgrade.
  * New audit actions (Postgres enum members, added outside the transaction).

Downgrade recreates `sync_config` and `sync_jobs` EMPTY (data is not
recoverable), restores the global unique name index — renaming, deterministically,
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

    op.drop_index("ix_sync_jobs_data_source_id", table_name="sync_jobs")
    op.drop_index("ix_sync_jobs_id", table_name="sync_jobs")
    op.drop_table("sync_jobs")
    op.drop_column("data_sources", "sync_config")

    if op.get_bind().dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        for val in _AUDIT_VALUES:
            op.execute(f"ALTER TYPE auditaction ADD VALUE IF NOT EXISTS '{val}'")


def downgrade() -> None:
    op.add_column("data_sources", sa.Column("sync_config", sa.JSON(), nullable=True))
    op.create_table(
        "sync_jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("data_source_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("mode", sa.String(length=30), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rows_synced", sa.Integer(), nullable=True),
        sa.Column("rows_failed", sa.Integer(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("triggered_by", sa.String(length=50), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_sync_jobs_id", "sync_jobs", ["id"])
    op.create_index("ix_sync_jobs_data_source_id", "sync_jobs", ["data_source_id"])

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
