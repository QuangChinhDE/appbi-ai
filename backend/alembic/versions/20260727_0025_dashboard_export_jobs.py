"""dashboard_export_jobs: server-side PDF render queue

Backs the export-job API + the ``pdf-worker`` container. A job row is the unit of
work (claimed with FOR UPDATE SKIP LOCKED), the progress feed the browser polls,
the audit record of who exported which slice, and the retention handle for the
rendered file.

Additive: no existing table is touched, and the client-side exporter keeps
working when no worker is deployed.

Revision ID: 20260727_0025
Revises: 20260723_0024
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

revision = "20260727_0025"
down_revision = "20260723_0024"
branch_labels = None
depends_on = None

TABLE = "dashboard_export_jobs"


def _has_table(name: str) -> bool:
    try:
        return inspect(op.get_bind()).has_table(name)
    except Exception:
        return False


def upgrade() -> None:
    if _has_table(TABLE):
        return
    op.create_table(
        TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "dashboard_id",
            sa.Integer(),
            sa.ForeignKey("dashboards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("link_token", sa.String(length=128), nullable=True),
        sa.Column(
            "requested_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("requester_ip", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="queued"),
        sa.Column("params", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("progress", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("progress_message", sa.String(length=255), nullable=True),
        sa.Column("warnings", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("file_path", sa.Text(), nullable=True),
        sa.Column("file_size", sa.Integer(), nullable=True),
        sa.Column("page_count", sa.Integer(), nullable=True),
        sa.Column("download_secret", sa.String(length=64), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_dashboard_export_jobs_dashboard_id", TABLE, ["dashboard_id"])
    op.create_index("ix_dashboard_export_jobs_link_token", TABLE, ["link_token"])
    op.create_index("ix_dashboard_export_jobs_status", TABLE, ["status"])
    op.create_index("ix_dashboard_export_jobs_expires_at", TABLE, ["expires_at"])
    op.create_index("ix_export_jobs_status_created", TABLE, ["status", "created_at"])
    op.create_index("ix_export_jobs_link_created", TABLE, ["link_token", "created_at"])
    op.create_index("ix_export_jobs_requested_by_created", TABLE, ["requested_by", "created_at"])


def downgrade() -> None:
    if _has_table(TABLE):
        op.drop_table(TABLE)
