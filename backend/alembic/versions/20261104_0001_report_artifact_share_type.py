"""Report-as-Code: an AI Vibe Report can be shared (resource_shares.resource_type).

Additive: one new value of the `resourcetype` enum. Existing shares are untouched.

Revision ID: 20261104_0001
Revises: 20261103_0003
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "20261104_0001"
down_revision: Union[str, None] = "20261103_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    # A new enum member cannot be USED in the transaction that adds it.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'report_artifact'")


def downgrade() -> None:
    # Postgres cannot drop an enum value; shares of this type are removed instead.
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("DELETE FROM resource_shares WHERE resource_type = 'report_artifact'")
