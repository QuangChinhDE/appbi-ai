"""analyst_feedback: a person's up/down verdict on an Analyst answer (dogfood).

Additive: one new table, no change to any existing table.

Revision ID: 20261022_0001
Revises: 20261021_0002
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261022_0001"
down_revision: Union[str, None] = "20261021_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "analyst_feedback",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("turn_id", sa.String(32), nullable=False),
        sa.Column("verdict", sa.String(8), nullable=False),
        sa.Column("comment", sa.String(1000), nullable=True),
        sa.Column("rc_sha", sa.String(40), nullable=True),
        sa.CheckConstraint("verdict IN ('up', 'down')", name="ck_analyst_feedback_verdict"),
    )
    op.create_index("ix_analyst_feedback_user_id", "analyst_feedback", ["user_id"])
    op.create_index("ix_analyst_feedback_turn_id", "analyst_feedback", ["turn_id"])


def downgrade() -> None:
    op.drop_index("ix_analyst_feedback_turn_id", table_name="analyst_feedback")
    op.drop_index("ix_analyst_feedback_user_id", table_name="analyst_feedback")
    op.drop_table("analyst_feedback")
