"""workboard_op_log idempotency table for offline submit replay

Revision ID: 20260622_0001
Revises: 20260613_0001
Create Date: 2026-06-22
"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260622_0001"
down_revision: Union[str, None] = "20260613_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workboard_op_log",
        sa.Column("op_id", sa.String(length=64), primary_key=True),
        sa.Column("workboard_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_workboard_op_log_workboard_id", "workboard_op_log", ["workboard_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_workboard_op_log_workboard_id", table_name="workboard_op_log")
    op.drop_table("workboard_op_log")
