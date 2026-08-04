"""Dataset purpose — separate reporting (may materialize to BigQuery) from
operational/Workboard (live DB, never materialized).

Adds ``datasets.purpose`` and BACKFILLS existing rows by inference (agreed
default): a dataset that any Workboard is bound to → 'operational'; every other
dataset → 'reporting' (backward-compatible — no change to existing dashboards).

Revision ID: 20260810_0040
Revises: 20260807_0036
"""
from alembic import op
import sqlalchemy as sa


revision = "20260810_0040"
# Chain from the COMMITTED head (0036). The 0037–0039 migrations are a concurrent
# session's uncommitted WIP; chaining from them would break the committed tree.
down_revision = "20260807_0036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("datasets", sa.Column("purpose", sa.String(length=20), nullable=True))
    # Infer (SAFE): 'operational' ONLY for a dataset that is bound to a Workboard
    # AND is NOT used for reporting — i.e. not in the publish lifecycle AND not
    # feeding any dashboard chart. This preserves EVERY existing dashboard: a
    # dual-use dataset (Workboard + dashboard) stays 'reporting' so its charts
    # keep their snapshot path; only a pure Workboard DB flips to operational.
    op.execute(
        """
        UPDATE datasets
           SET purpose = 'operational'
         WHERE id IN (SELECT DISTINCT dataset_id FROM workboards WHERE dataset_id IS NOT NULL)
           AND published_generation IS NULL
           AND id NOT IN (
                 SELECT DISTINCT dt.dataset_id
                   FROM dataset_tables dt
                   JOIN charts c ON c.dataset_table_id = dt.id
                   JOIN dashboard_charts dc ON dc.chart_id = c.id
               )
        """
    )
    # Everything else → reporting (keeps current materialize/publish behaviour).
    op.execute("UPDATE datasets SET purpose = 'reporting' WHERE purpose IS NULL")
    op.create_index("ix_datasets_purpose", "datasets", ["purpose"])


def downgrade() -> None:
    op.drop_index("ix_datasets_purpose", table_name="datasets")
    op.drop_column("datasets", "purpose")
