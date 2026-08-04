"""P1-01: evidence ledger — one row per tool call the assistant makes

Turns "the answer sounds right" into "the answer is checkable": every figure the
assistant prints must trace to a row here, and through it to the chart, the
filter set and the moment the data was read.

Also adds two verification columns to ai_chat_turn_logs so coverage can be
trended per turn without joining the (retention-limited) evidence table.

Both are additive and inert until INTELLIGENCE_EVIDENCE_ENABLED is turned on.

Revision ID: 20260804_0033
Revises: 20260803_0032
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260804_0033"
down_revision = "20260803_0032"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    try:
        return name in inspect(op.get_bind()).get_table_names()
    except Exception:
        return False


def _has_column(table: str, col: str) -> bool:
    try:
        return any(c["name"] == col for c in inspect(op.get_bind()).get_columns(table))
    except Exception:
        return False


def upgrade() -> None:
    if not _has_table("ai_evidence"):
        op.create_table(
            "ai_evidence",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("run_ref", sa.String(length=64), nullable=False),
            sa.Column("node_key", sa.String(length=64), nullable=True),
            sa.Column("dashboard_id", sa.Integer(), nullable=False),
            sa.Column("link_token", sa.String(length=200), nullable=True),
            sa.Column("session_key", sa.String(length=64), nullable=True),
            sa.Column("tool_name", sa.String(length=64), nullable=False),
            sa.Column("args_hash", sa.String(length=64), nullable=False),
            sa.Column("source_ref", sa.JSON(), nullable=True),
            sa.Column("filter_hash", sa.String(length=64), nullable=True),
            sa.Column("numbers", sa.JSON(), nullable=False),
            sa.Column("payload_digest", sa.JSON(), nullable=True),
            sa.Column("row_count", sa.Integer(), nullable=True),
            sa.Column("truncated", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("ok", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )
        # Verifier reads every row of one turn.
        op.create_index("ix_ai_evidence_run", "ai_evidence", ["run_ref"])
        # Retention sweep + per-dashboard analytics.
        op.create_index(
            "ix_ai_evidence_dash_created", "ai_evidence", ["dashboard_id", "created_at"]
        )
        op.create_index("ix_ai_evidence_created_at", "ai_evidence", ["created_at"])

    for col, coltype in (
        ("verification_coverage", sa.Float()),
        ("verification_unmatched", sa.Integer()),
    ):
        if _has_table("ai_chat_turn_logs") and not _has_column("ai_chat_turn_logs", col):
            op.add_column("ai_chat_turn_logs", sa.Column(col, coltype, nullable=True))


def downgrade() -> None:
    for col in ("verification_coverage", "verification_unmatched"):
        if _has_table("ai_chat_turn_logs") and _has_column("ai_chat_turn_logs", col):
            op.drop_column("ai_chat_turn_logs", col)
    if _has_table("ai_evidence"):
        for idx in (
            "ix_ai_evidence_created_at",
            "ix_ai_evidence_dash_created",
            "ix_ai_evidence_run",
        ):
            try:
                op.drop_index(idx, table_name="ai_evidence")
            except Exception:
                pass
        op.drop_table("ai_evidence")
