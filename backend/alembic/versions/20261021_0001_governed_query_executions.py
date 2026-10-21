"""governed_query_executions: the durable audit ledger of governed reads (PR-1E)

Every query the Governed Query Service runs gets a row written and COMMITTED
before the warehouse sees anything (status `running`), then finalized. If that
first write fails, the query is refused (spec I-7). See
app/models/governed_query_execution.py for the field-by-field contract.

Additive: one new table, its constraints and indexes. Nothing existing is read,
changed or backfilled.

Append-only for the application: the migration REVOKEs DELETE and TRUNCATE on
this table from the least-privilege `appbi_app` role (the table owner keeps
them). That is an owner-level statement, not a superuser one; it is guarded the
same way 20260809_0048 guards its grants, so an environment without `appbi_app`
is unaffected.

DOWNGRADE REFUSES WHILE THE TABLE HOLDS ROWS. Audit records are evidence and
outlive the code that wrote them; removing them is a separate, explicitly
approved data operation, never a side effect of rolling a release back. Rolling
the CODE back leaves this table and its rows in place.

Revision ID: 20261021_0001
Revises: 20261015_0002
Create Date: 2026-10-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision: str = "20261021_0001"
down_revision: Union[str, None] = "20261015_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "governed_query_executions"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("query_id", sa.String(64), primary_key=True),
        sa.Column("run_id", sa.String(64), nullable=True),
        sa.Column("user_id", UUID(as_uuid=True), nullable=True),
        sa.Column("principal_kind", sa.String(16), nullable=False),
        sa.Column("surface", sa.String(32), nullable=False),
        sa.Column("relation_kind", sa.String(32), nullable=True),
        sa.Column("relation_id", sa.Integer(), nullable=True),
        sa.Column("dataset_ids", JSONB, nullable=True),
        sa.Column("datasource_id", sa.Integer(), nullable=True),
        sa.Column("dialect", sa.String(32), nullable=True),
        sa.Column("sql_fingerprint", sa.String(64), nullable=True),
        sa.Column("policy_fingerprint", sa.String(64), nullable=True),
        sa.Column("bounds", JSONB, nullable=True),
        sa.Column("reserved_bq_bytes", sa.BigInteger(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("refusal_code", sa.String(64), nullable=True),
        sa.Column("rows_returned", sa.Integer(), nullable=True),
        sa.Column("bytes_processed", sa.BigInteger(), nullable=True),
        sa.Column("worker_id", sa.String(128), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancel_requested_by", UUID(as_uuid=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('running', 'ok', 'refused', 'error', 'cancelled', 'timeout', 'abandoned')",
            name="ck_gqe_status",
        ),
        sa.CheckConstraint("(status = 'running') = (finished_at IS NULL)", name="ck_gqe_terminal_has_finish"),
    )
    op.create_index("ix_gqe_user_started", TABLE, ["user_id", "started_at"])
    op.create_index("ix_gqe_run", TABLE, ["run_id"])
    op.create_index("ix_gqe_running_worker", TABLE, ["worker_id"],
                    postgresql_where=sa.text("status = 'running'"))
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'appbi_app') THEN
                REVOKE DELETE, TRUNCATE ON {TABLE} FROM appbi_app;
            END IF;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE '{TABLE}: could not revoke DELETE/TRUNCATE from appbi_app; the ledger is append-only by code only.';
        END $$
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    # Lock first: a still-running old-code worker could insert between a plain
    # count and the DROP. ACCESS EXCLUSIVE holds until the downgrade commits.
    bind.execute(sa.text(f"LOCK TABLE {TABLE} IN ACCESS EXCLUSIVE MODE"))
    rows = bind.execute(sa.text(f"SELECT count(*) FROM {TABLE}")).scalar() or 0
    if rows:
        raise RuntimeError(
            f"Refusing to drop {TABLE}: it holds {rows} audit record(s). Audit records outlive the code "
            "that wrote them; rolling a release back is code-only. Removing them is a separate, explicitly "
            "approved data operation."
        )
    op.drop_index("ix_gqe_running_worker", table_name=TABLE)
    op.drop_index("ix_gqe_run", table_name=TABLE)
    op.drop_index("ix_gqe_user_started", table_name=TABLE)
    op.drop_table(TABLE)
