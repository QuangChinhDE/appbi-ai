"""A conversation becomes a shareable resource.

Revision ID: 20260914_0002
Revises: 20260914_0001
Create Date: 2026-09-14

`resource_shares.resource_type` is a NATIVE Postgres enum (`resourcetype`), so a
new member is DDL, not data. Postgres 12+ allows `ALTER TYPE … ADD VALUE` inside a
transaction as long as the new value is not USED in that same transaction — this
migration only declares it, so it commits cleanly under Alembic's transaction.

`IF NOT EXISTS` because a deployment that ran this once and was then rebuilt from
an image already carrying the value must not fail on the second pass.

There is no down leg that removes it: Postgres has no `ALTER TYPE … DROP VALUE`.
Rolling back the code leaves an unused member in the type, which is inert — the
same position the older `chat_session` member has been in all along.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "20260914_0002"
down_revision: Union[str, None] = "20260914_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # SQLite (the test fallback) stores the enum as text; nothing to declare.
        return
    op.execute("ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'chat_thread'")


def downgrade() -> None:
    # Postgres cannot remove an enum member. Left in place on purpose: an unused
    # value costs nothing, and rewriting the type would mean rewriting every
    # column that uses it.
    pass
