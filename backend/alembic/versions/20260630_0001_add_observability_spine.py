"""add observability spine (monitors + checks + incidents)

Unifies the data-observability pillars on top of the existing Quality and
Anomaly engines:
  - observability_monitors  : freshness/volume/schema checks per dataset table
  - observability_checks    : time-series snapshot history of each monitor run
  - observability_incidents : ONE lifecycle store for breaches from any detector
                              (quality | anomaly | freshness | volume | schema)

Revision ID: 20260630_0001
Revises: 20260629_0001
Create Date: 2026-06-30
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260630_0001"
down_revision: Union[str, None] = "20260629_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "observability_monitors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("dataset_table_id", sa.Integer(), sa.ForeignKey("dataset_tables.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("severity", sa.String(length=20), nullable=False, server_default="warning"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_status", sa.String(length=20), nullable=True),
        sa.Column("last_value", sa.Float(), nullable=True),
        sa.Column("last_detail", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(), nullable=True),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_observability_monitors_dataset_id", "observability_monitors", ["dataset_id"])
    op.create_index("ix_observability_monitors_dataset_table_id", "observability_monitors", ["dataset_table_id"])

    op.create_table(
        "observability_checks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("monitor_id", sa.Integer(), sa.ForeignKey("observability_monitors.id", ondelete="CASCADE"), nullable=False),
        sa.Column("checked_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("value", sa.Float(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="ok"),
        sa.Column("detail", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_index("ix_observability_checks_monitor_id", "observability_checks", ["monitor_id"])
    op.create_index("ix_observability_checks_checked_at", "observability_checks", ["checked_at"])

    op.create_table(
        "observability_incidents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("dataset_table_id", sa.Integer(), sa.ForeignKey("dataset_tables.id", ondelete="SET NULL"), nullable=True),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column("pillar", sa.String(length=20), nullable=False),
        sa.Column("dedup_key", sa.String(length=120), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("detail", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("severity", sa.String(length=20), nullable=False, server_default="warning"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="open"),
        sa.Column("first_seen_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("acknowledged_at", sa.DateTime(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_observability_incidents_dataset_id", "observability_incidents", ["dataset_id"])
    op.create_index("ix_observability_incident_dedup", "observability_incidents", ["dedup_key"])
    op.create_index("ix_observability_incident_dedup_status", "observability_incidents", ["dedup_key", "status"])


def downgrade() -> None:
    op.drop_table("observability_incidents")
    op.drop_table("observability_checks")
    op.drop_table("observability_monitors")
