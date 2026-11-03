"""Report-as-Code: AI Bot turns of report public links.

Additive: one new table, the report-link twin of public_answer_turns (same columns,
same constraints), so the one Answer Core turn runner (answer_core/public_turn.py)
records a report link's questions under a foreign key that names that link.

Revision ID: 20261103_0003
Revises: 20261103_0002
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261103_0003"
down_revision: Union[str, None] = "20261103_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_answer_turns",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("link_id", sa.Integer(), sa.ForeignKey("report_artifact_public_links.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("conversation_key", sa.String(length=64), nullable=False),
        sa.Column("turn_id", sa.String(length=32), nullable=False),
        sa.Column("idempotency_key", sa.String(length=64), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("envelope", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("plan", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("usd", sa.Float(), nullable=True),
        sa.Column("rating", sa.String(length=8), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("turn_id", name="uq_report_answer_turns_turn_id"),
        sa.UniqueConstraint("link_id", "idempotency_key", name="uq_report_answer_turns_link_idem"),
    )
    op.create_index("ix_report_answer_turns_conversation", "report_answer_turns",
                    ["link_id", "conversation_key", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_report_answer_turns_conversation", table_name="report_answer_turns")
    op.drop_table("report_answer_turns")
