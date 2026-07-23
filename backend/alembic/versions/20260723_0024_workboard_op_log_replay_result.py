"""Persist Workboard idempotency replay results for offline dependencies.

Revision ID: 20260723_0024
Revises: 20260723_0023
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260723_0024"
down_revision = "20260723_0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("workboard_op_log", sa.Column("screen_id", sa.String(length=255), nullable=True))
    op.add_column("workboard_op_log", sa.Column("actor_key", sa.String(length=255), nullable=True))
    op.add_column(
        "workboard_op_log",
        sa.Column("request_fingerprint", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "workboard_op_log",
        sa.Column("result_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workboard_op_log", "result_payload")
    op.drop_column("workboard_op_log", "request_fingerprint")
    op.drop_column("workboard_op_log", "actor_key")
    op.drop_column("workboard_op_log", "screen_id")
