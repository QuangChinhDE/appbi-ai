"""observability readiness: delivery ledger, scan runs, one open incident per key

- observability_alert_deliveries : one row per (incident, channel) - the delivery
  state that used to live in ONE ``last_error`` per channel, so a failed send had
  no record of its own and a healthy channel re-sent every open incident.
- observability_scan_runs        : every scan (scheduled / manual, global /
  dataset) with its outcome, so a scanner that stopped or failed is visible.
- ux_observability_incident_open_key : at most one unresolved incident per
  dedup_key. Existing duplicates are MERGED first, never deleted: the oldest
  unresolved incident is kept, every later one is resolved with
  ``detail.merged_into`` / ``detail.merged_at`` so its history stays readable.
  Merging resolves rows directly in SQL - no notification is sent.

Revision ID: 20261008_0008
Revises: 20261008_0007
Create Date: 2026-10-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20261008_0008"
down_revision: Union[str, None] = "20261008_0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_AUDIT_VALUES = [
    "observability_dataset_scan",
    "observability_incident_action",
    "observability_baseline_accepted",
    "observability_monitor_changed",
]


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            for val in _AUDIT_VALUES:
                op.execute(f"ALTER TYPE auditaction ADD VALUE IF NOT EXISTS '{val}'")

    op.create_table(
        "observability_alert_deliveries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("incident_id", sa.Integer(),
                  sa.ForeignKey("observability_incidents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("channel_id", sa.Integer(),
                  sa.ForeignKey("observability_alert_channels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("next_attempt_at", sa.DateTime(), nullable=True),
        sa.Column("sent_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("incident_id", "channel_id", name="uq_obs_delivery_incident_channel"),
    )
    op.create_index("ix_obs_delivery_status_due", "observability_alert_deliveries",
                    ["status", "next_attempt_at"])
    op.create_index("ix_obs_delivery_channel", "observability_alert_deliveries", ["channel_id"])

    op.create_table(
        "observability_scan_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("scope", sa.String(16), nullable=False),          # global | dataset
        sa.Column("dataset_id", sa.Integer(),
                  sa.ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True),
        sa.Column("trigger", sa.String(16), nullable=False),        # schedule | manual
        sa.Column("triggered_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),         # running|succeeded|partial|failed
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("counts", postgresql.JSONB(), nullable=True),
        sa.Column("errors", postgresql.JSONB(), nullable=True),
    )
    op.create_index("ix_obs_scan_runs_started", "observability_scan_runs", ["started_at"])

    # Merge duplicate unresolved incidents (keep the oldest per key).
    op.execute(
        """
        WITH ranked AS (
            SELECT id, dedup_key,
                   FIRST_VALUE(id) OVER (PARTITION BY dedup_key ORDER BY first_seen_at, id) AS keep_id,
                   ROW_NUMBER()    OVER (PARTITION BY dedup_key ORDER BY first_seen_at, id) AS rn
            FROM observability_incidents
            WHERE status <> 'resolved'
        )
        UPDATE observability_incidents i
           SET status = 'resolved',
               resolved_at = now() AT TIME ZONE 'utc',
               detail = (CASE WHEN jsonb_typeof(i.detail) = 'object' THEN i.detail ELSE '{}'::jsonb END)
                        || jsonb_build_object('merged_into', r.keep_id,
                                              'merged_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                              'merged_reason', 'duplicate open incident for the same check')
          FROM ranked r
         WHERE i.id = r.id AND r.rn > 1
        """
    )
    op.create_index(
        "ux_observability_incident_open_key", "observability_incidents", ["dedup_key"],
        unique=True, postgresql_where=sa.text("status <> 'resolved'"),
    )


def downgrade() -> None:
    # Merged duplicates stay resolved (their detail records what they merged into).
    op.drop_index("ux_observability_incident_open_key", table_name="observability_incidents")
    op.drop_index("ix_obs_scan_runs_started", table_name="observability_scan_runs")
    op.drop_table("observability_scan_runs")
    op.drop_index("ix_obs_delivery_channel", table_name="observability_alert_deliveries")
    op.drop_index("ix_obs_delivery_status_due", table_name="observability_alert_deliveries")
    op.drop_table("observability_alert_deliveries")
