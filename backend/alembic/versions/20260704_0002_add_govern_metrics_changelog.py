"""add govern_metrics + govern_change_log — Knowledge Foundation data-entry

Revision ID: 20260704_0002
Revises: 20260704_0001
Create Date: 2026-07-04

The core of the Govern module as a Knowledge Foundation: a place for a business
to RECORD & MANAGE its management metrics (metrics quản trị doanh nghiệp) and to
LOG how the business domain evolves (change log). Authored data — the accurate
context the AI later reads, instead of guessing from column names.
"""
from alembic import op
import sqlalchemy as sa


revision = "20260704_0002"
down_revision = "20260704_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "govern_metrics",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("definition", sa.String(), nullable=True),
        sa.Column("formula", sa.String(), nullable=True),
        sa.Column("unit", sa.String(length=32), nullable=True),
        sa.Column("grain", sa.String(length=32), nullable=True),
        sa.Column("category", sa.String(length=128), nullable=True),
        sa.Column("direction", sa.String(length=16), nullable=False, server_default="neutral"),
        sa.Column("target_value", sa.Float(), nullable=True),
        sa.Column("target_operator", sa.String(length=8), nullable=True),
        sa.Column("target_value2", sa.Float(), nullable=True),
        sa.Column("owner", sa.String(length=128), nullable=True),
        sa.Column("related_term_fqn", sa.String(length=256), nullable=True),
        sa.Column("dataset_id", sa.Integer(), nullable=True),
        sa.Column("dataset_table_id", sa.Integer(), nullable=True),
        sa.Column("measure_ref", sa.String(length=256), nullable=True),
        sa.Column("synonyms", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="Draft"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("provider", sa.String(length=16), nullable=False, server_default="user"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_govern_metrics_name", "govern_metrics", ["name"], unique=True)
    op.create_index("ix_govern_metrics_dataset_id", "govern_metrics", ["dataset_id"])
    op.create_index("ix_govern_metrics_dataset_table_id", "govern_metrics", ["dataset_table_id"])

    op.create_table(
        "govern_change_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_fqn", sa.String(length=256), nullable=False),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("summary", sa.String(length=512), nullable=True),
        sa.Column("changed_by", sa.String(length=128), nullable=True),
        sa.Column("snapshot", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_govern_change_log_entity_type", "govern_change_log", ["entity_type"])
    op.create_index("ix_govern_change_log_entity_fqn", "govern_change_log", ["entity_fqn"])
    op.create_index("ix_govern_change_log_created_at", "govern_change_log", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_govern_change_log_created_at", table_name="govern_change_log")
    op.drop_index("ix_govern_change_log_entity_fqn", table_name="govern_change_log")
    op.drop_index("ix_govern_change_log_entity_type", table_name="govern_change_log")
    op.drop_table("govern_change_log")
    op.drop_index("ix_govern_metrics_dataset_table_id", table_name="govern_metrics")
    op.drop_index("ix_govern_metrics_dataset_id", table_name="govern_metrics")
    op.drop_index("ix_govern_metrics_name", table_name="govern_metrics")
    op.drop_table("govern_metrics")
