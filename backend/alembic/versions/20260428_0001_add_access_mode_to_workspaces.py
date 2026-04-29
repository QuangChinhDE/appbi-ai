"""Add access_mode to workboard_workspaces; relax app_users_config nullability.

Revision ID: 20260428_0001
Revises: 20260425_0003
Create Date: 2026-04-28

A workspace previously assumed every public link required app-user login.
That blocked internal/admin-only mini-apps where AppBI staff already have
a session. We split the two cases explicitly:

* ``access_mode='internal'``  – no app_users table; only AppBI users open
  the workboards. ``app_users_config`` stays empty.
* ``access_mode='public_app_users'`` – workers/foremen log in with PIN
  against a project-owned table. ``app_users_config`` is required.

Backfill rule: workspaces that already populated ``app_users_config`` keep
the public flow; everyone else moves to ``internal`` (the safer default
because no public link gets exposed without explicit opt-in).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260428_0001"
down_revision = "20260425_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workboard_workspaces",
        sa.Column(
            "access_mode",
            sa.String(32),
            nullable=False,
            server_default="internal",
        ),
    )

    # Backfill: any workspace with a non-empty app_users_config keeps the
    # public-login flow; everyone else stays internal.
    op.execute(
        """
        UPDATE workboard_workspaces
        SET access_mode = 'public_app_users'
        WHERE app_users_config IS NOT NULL
          AND app_users_config <> '{}'::jsonb
        """
    )

    # Loosen app_users_config so 'internal' workspaces don't have to carry
    # a fake empty JSON object forever.
    op.alter_column(
        "workboard_workspaces",
        "app_users_config",
        existing_type=postgresql.JSONB(),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "workboard_workspaces",
        "app_users_config",
        existing_type=postgresql.JSONB(),
        nullable=False,
        server_default=sa.text("'{}'::jsonb"),
    )
    op.execute(
        "UPDATE workboard_workspaces SET app_users_config = '{}'::jsonb "
        "WHERE app_users_config IS NULL"
    )
    op.drop_column("workboard_workspaces", "access_mode")
