"""personal_access_tokens: session-bound tokens

A token minted for a connection (e.g. Claude MCP) should end when its owner's
security stamp rotates: password change, admin status change, deactivation.
``bound_to_session`` opts a token in; ``bound_security_stamp`` is the stamp it
was bound to ("" when the user had none).

Additive: every existing token reads bound_to_session=false and keeps working
exactly as before. No token is revoked or modified.

Revision ID: 20261014_0001
Revises: 20261012_0001
Create Date: 2026-10-14
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20261014_0001"
down_revision: Union[str, None] = "20261012_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "personal_access_tokens",
        sa.Column("bound_to_session", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "personal_access_tokens",
        sa.Column("bound_security_stamp", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("personal_access_tokens", "bound_security_stamp")
    op.drop_column("personal_access_tokens", "bound_to_session")
