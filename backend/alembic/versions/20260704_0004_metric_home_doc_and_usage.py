"""metric home_doc + govern_metric_usage — metrics live inside docs (SSOT + lineage)

Revision ID: 20260704_0004
Revises: 20260704_0003
Create Date: 2026-07-04

A managed metric is DEFINED in one knowledge doc (home_doc_id) and REUSED in
others via {{metric:slug}} tokens, tracked as usage edges. Enables lineage
("defined at X, reused at Y") + impact analysis, with a single source of truth.
"""
from alembic import op
import sqlalchemy as sa


revision = "20260704_0004"
down_revision = "20260704_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("govern_metrics", sa.Column("home_doc_id", sa.Integer(), nullable=True))
    op.add_column("govern_metrics", sa.Column("anchor", sa.String(length=128), nullable=True))
    op.create_index("ix_govern_metrics_home_doc_id", "govern_metrics", ["home_doc_id"])

    op.create_table(
        "govern_metric_usage",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("metric_id", sa.Integer(), nullable=False),
        sa.Column("doc_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("metric_id", "doc_id", name="uq_metric_usage"),
    )
    op.create_index("ix_govern_metric_usage_metric_id", "govern_metric_usage", ["metric_id"])
    op.create_index("ix_govern_metric_usage_doc_id", "govern_metric_usage", ["doc_id"])


def downgrade() -> None:
    op.drop_index("ix_govern_metric_usage_doc_id", table_name="govern_metric_usage")
    op.drop_index("ix_govern_metric_usage_metric_id", table_name="govern_metric_usage")
    op.drop_table("govern_metric_usage")
    op.drop_index("ix_govern_metrics_home_doc_id", table_name="govern_metrics")
    op.drop_column("govern_metrics", "anchor")
    op.drop_column("govern_metrics", "home_doc_id")
