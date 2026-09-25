"""Audit values for AI Design content proposals.

A content proposal changes what a tile SAYS (its sort order, its title), so
accepting or rejecting one is recorded. Additive: two new ``auditaction``
enum values, idempotent via ``ADD VALUE IF NOT EXISTS``.

Revision ID: 20260926_0001
Revises: 20260914_0002
"""
from alembic import op

revision = "20260926_0001"
down_revision = "20260914_0002"
branch_labels = None
depends_on = None

_VALUES = [
    "dashboard_content_proposal_accepted",
    "dashboard_content_proposal_rejected",
]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        for val in _VALUES:
            op.execute(f"ALTER TYPE auditaction ADD VALUE IF NOT EXISTS '{val}'")


def downgrade() -> None:
    # PostgreSQL cannot drop an enum value. No-op.
    pass
