"""add_dataset_quality_tables

Revision ID: 20260413_0001
Revises: 20260411_0004
Create Date: 2026-04-13 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "20260413_0001"
down_revision: Union[str, None] = "20260411_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -------------------------------------------------------------------
    # dataset_quality_rules
    # One row = one expectation on a table or column of a dataset.
    # -------------------------------------------------------------------
    op.create_table(
        "dataset_quality_rules",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "dataset_id",
            sa.Integer(),
            sa.ForeignKey("datasets.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "table_id",
            sa.Integer(),
            sa.ForeignKey("dataset_tables.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # null column_name  → table-level rule
        sa.Column("column_name", sa.String(255), nullable=True),
        # dimension: completeness | validity | uniqueness | consistency | timeliness | accuracy
        sa.Column("dimension", sa.String(50), nullable=False),
        # rule_type within that dimension, e.g. "not_null", "accepted_values", "freshness_days"
        sa.Column("rule_type", sa.String(80), nullable=False),
        # human-readable label (auto-generated or user-edited)
        sa.Column("name", sa.String(255), nullable=False),
        # flexible config stored as JSONB — contents depend on rule_type
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
            server_default="{}",
        ),
        sa.Column("severity", sa.String(20), nullable=False, server_default="warning"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_dataset_quality_rules_id"),
        "dataset_quality_rules",
        ["id"],
        unique=False,
    )

    # -------------------------------------------------------------------
    # dataset_quality_runs
    # One row = one full quality-check execution for a dataset.
    # -------------------------------------------------------------------
    op.create_table(
        "dataset_quality_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "dataset_id",
            sa.Integer(),
            sa.ForeignKey("datasets.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # queued | running | completed | failed
        sa.Column("status", sa.String(20), nullable=False, server_default="queued"),
        # overall % of rules that passed (0-100, rounded)
        sa.Column("score", sa.Float(), nullable=True),
        # per-rule results: { "<rule_id>": { "passed": bool, "rows_checked": int,
        #                                    "rows_failed": int, "detail": str } }
        sa.Column(
            "results",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("triggered_by_id", sa.String(36), nullable=True),  # user UUID
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_dataset_quality_runs_id"),
        "dataset_quality_runs",
        ["id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_dataset_quality_runs_id"), table_name="dataset_quality_runs"
    )
    op.drop_table("dataset_quality_runs")
    op.drop_index(
        op.f("ix_dataset_quality_rules_id"), table_name="dataset_quality_rules"
    )
    op.drop_table("dataset_quality_rules")
