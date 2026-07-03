"""add dataset_table_snapshots (near-realtime snapshot materialization)

Registry for the Dashboard-perf #5 snapshot layer: each row is a physical flat
table materializing ONE dataset table's resolved output. Charts read the flat
snapshot instead of re-running the heavy source pipeline. Exactly one row per
table is `is_current` (partial-unique index); an atomic pointer flip swaps
versions with no torn reads.

Revision ID: 20260702_0001
Revises: 20260630_0002
Create Date: 2026-07-02
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260702_0001"
down_revision: Union[str, None] = "20260630_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "dataset_table_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("dataset_id", sa.Integer(), nullable=False),
        sa.Column("dataset_table_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.BigInteger(), nullable=False),
        sa.Column("physical_ref", sa.Text(), nullable=False),
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("row_count", sa.BigInteger(), nullable=True),
        sa.Column("build_ms", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="building"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("built_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["dataset_table_id"], ["dataset_tables.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "ix_dataset_table_snapshots_dataset_id",
        "dataset_table_snapshots", ["dataset_id"],
    )
    op.create_index(
        "ix_dataset_table_snapshots_dataset_table_id",
        "dataset_table_snapshots", ["dataset_table_id"],
    )
    op.create_index(
        "ix_dataset_table_snapshots_is_current",
        "dataset_table_snapshots", ["is_current"],
    )
    # At most ONE current snapshot per table — the atomic version pointer.
    op.create_index(
        "uq_dataset_table_snapshots_current",
        "dataset_table_snapshots", ["dataset_table_id"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )


def downgrade() -> None:
    op.drop_index("uq_dataset_table_snapshots_current", table_name="dataset_table_snapshots")
    op.drop_index("ix_dataset_table_snapshots_is_current", table_name="dataset_table_snapshots")
    op.drop_index("ix_dataset_table_snapshots_dataset_table_id", table_name="dataset_table_snapshots")
    op.drop_index("ix_dataset_table_snapshots_dataset_id", table_name="dataset_table_snapshots")
    op.drop_table("dataset_table_snapshots")
