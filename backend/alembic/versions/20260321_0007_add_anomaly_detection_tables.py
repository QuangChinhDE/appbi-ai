"""Add monitored_metrics and anomaly_alerts tables for Phase 4 proactive intelligence.

Revision ID: 20260321_ai02
Revises: 20260321_ai01
Create Date: 2026-03-21
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = '20260321_ai02'
down_revision = '20260321_ai01'
branch_labels = None
depends_on = None


def upgrade():
    # ── monitored_metrics: user-defined metrics to watch ────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS monitored_metrics (
            id SERIAL PRIMARY KEY,
            workspace_table_id INTEGER NOT NULL
                REFERENCES dataset_workspace_tables(id) ON DELETE CASCADE,
            metric_column VARCHAR(200) NOT NULL,
            aggregation VARCHAR(20) NOT NULL DEFAULT 'sum',
            time_column VARCHAR(200),
            dimension_columns JSONB DEFAULT '[]',
            check_frequency VARCHAR(20) NOT NULL DEFAULT 'daily',
            threshold_z_score FLOAT NOT NULL DEFAULT 2.0,
            is_active BOOLEAN NOT NULL DEFAULT true,
            owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_monitored_metrics_table
            ON monitored_metrics(workspace_table_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_monitored_metrics_owner
            ON monitored_metrics(owner_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_monitored_metrics_active
            ON monitored_metrics(is_active)
    """)

    # ── anomaly_alerts: detected anomalies ──────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS anomaly_alerts (
            id SERIAL PRIMARY KEY,
            monitored_metric_id INTEGER NOT NULL
                REFERENCES monitored_metrics(id) ON DELETE CASCADE,
            detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
            current_value FLOAT NOT NULL,
            expected_value FLOAT NOT NULL,
            z_score FLOAT NOT NULL,
            change_pct FLOAT NOT NULL,
            dimension_values JSONB,
            severity VARCHAR(20) NOT NULL DEFAULT 'info',
            is_read BOOLEAN NOT NULL DEFAULT false,
            explanation TEXT
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_metric
            ON anomaly_alerts(monitored_metric_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_detected
            ON anomaly_alerts(detected_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_unread
            ON anomaly_alerts(is_read)
    """)


def downgrade():
    op.execute("DROP TABLE IF EXISTS anomaly_alerts CASCADE")
    op.execute("DROP TABLE IF EXISTS monitored_metrics CASCADE")
