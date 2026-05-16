"""add workboard_auto_number_sequences

Revision ID: 20260515_0001
Revises: 20260513_0001
Create Date: 2026-05-15
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260515_0001"
down_revision: Union[str, None] = "20260513_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workboard_auto_number_sequences",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "workboard_id",
            sa.Integer(),
            sa.ForeignKey("workboards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("column_name", sa.String(120), nullable=False),
        sa.Column("bucket", sa.String(32), nullable=False),
        sa.Column("next_value", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "workboard_id",
            "column_name",
            "bucket",
            name="uq_wb_auto_number_sequence",
        ),
    )
    op.create_index(
        "ix_wb_auto_number_workboard",
        "workboard_auto_number_sequences",
        ["workboard_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_wb_auto_number_workboard",
        table_name="workboard_auto_number_sequences",
    )
    op.drop_table("workboard_auto_number_sequences")
