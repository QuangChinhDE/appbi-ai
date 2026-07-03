"""add observability alert channels

Completes Incident alerting: where to send a notification when a new incident
opens (email / Slack / webhook), severity-gated and optionally dataset-scoped.

Revision ID: 20260630_0002
Revises: 20260630_0001
Create Date: 2026-06-30
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260630_0002"
down_revision: Union[str, None] = "20260630_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "observability_alert_channels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("target", sa.Text(), nullable=False),
        sa.Column("min_severity", sa.String(length=20), nullable=False, server_default="warning"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id", ondelete="CASCADE"), nullable=True),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("last_sent_at", sa.DateTime(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_observability_alert_channels_dataset_id", "observability_alert_channels", ["dataset_id"])


def downgrade() -> None:
    op.drop_table("observability_alert_channels")
