"""add dataset_quality_schedules + run trigger metadata

Revision ID: 20260422_0001
Revises: 20260421_0001
Create Date: 2026-04-22
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260422_0001"
down_revision = "20260421_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # dataset_quality_schedules — one automation config per dataset.
    # ------------------------------------------------------------------
    op.create_table(
        "dataset_quality_schedules",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "dataset_id",
            sa.Integer(),
            sa.ForeignKey("datasets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="false"),
        # "manual" (disabled) or "schedule"
        sa.Column("type", sa.String(20), nullable=False, server_default="manual"),
        sa.Column("cron", sa.String(120), nullable=True),
        sa.Column("timezone", sa.String(80), nullable=False, server_default="UTC"),
        sa.Column(
            "recipient_email",
            sa.String(320),
            nullable=True,
            comment="Primary email to receive the quality report after each scheduled run.",
        ),
        sa.Column(
            "cc_emails",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            server_default="[]",
        ),
        sa.Column("notify_on_success", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("notify_on_failure", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_status", sa.String(20), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("next_run_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_by_id",
            sa.String(36),
            nullable=True,
            comment="User UUID of the owner that created/updated this schedule.",
        ),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("dataset_id", name="uq_dataset_quality_schedules_dataset_id"),
    )
    op.create_index(
        op.f("ix_dataset_quality_schedules_id"),
        "dataset_quality_schedules",
        ["id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_dataset_quality_schedules_enabled"),
        "dataset_quality_schedules",
        ["enabled"],
        unique=False,
    )

    # ------------------------------------------------------------------
    # dataset_quality_runs — remember where each run came from.
    # ------------------------------------------------------------------
    op.add_column(
        "dataset_quality_runs",
        sa.Column(
            "trigger_source",
            sa.String(20),
            nullable=False,
            server_default="manual",
        ),
    )
    op.add_column(
        "dataset_quality_runs",
        sa.Column(
            "schedule_id",
            sa.Integer(),
            sa.ForeignKey("dataset_quality_schedules.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        op.f("ix_dataset_quality_runs_schedule_id"),
        "dataset_quality_runs",
        ["schedule_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_dataset_quality_runs_schedule_id"), table_name="dataset_quality_runs")
    op.drop_column("dataset_quality_runs", "schedule_id")
    op.drop_column("dataset_quality_runs", "trigger_source")

    op.drop_index(op.f("ix_dataset_quality_schedules_enabled"), table_name="dataset_quality_schedules")
    op.drop_index(op.f("ix_dataset_quality_schedules_id"), table_name="dataset_quality_schedules")
    op.drop_table("dataset_quality_schedules")
