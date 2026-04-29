"""Per-workboard app_users_config + flip new-workspace default to public_app_users.

Revision ID: 20260428_0002
Revises: 20260428_0001
Create Date: 2026-04-28

The previous design pinned ``app_users_config`` to the workspace, which meant
every mini-app inside a workspace had to share one user table. That broke the
"each mini-app = one dataset = one database" model — vertical-specific user
tables (nurses vs. drivers vs. teachers) couldn't coexist in one workspace.

This migration:

1. Adds ``workboards.app_users_config`` (JSONB, nullable). When set, it
   overrides the workspace-level config for that workboard's login flow,
   menu visibility, and RLS identity.
2. Flips the workspace ``access_mode`` server-default from ``'internal'`` to
   ``'public_app_users'`` so newly-created workspaces default to a real
   end-user login flow. Existing rows keep their stored value.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260428_0002"
down_revision = "20260428_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workboards",
        sa.Column(
            "app_users_config",
            postgresql.JSONB(),
            nullable=True,
        ),
    )

    op.alter_column(
        "workboard_workspaces",
        "access_mode",
        existing_type=sa.String(32),
        existing_nullable=False,
        server_default="public_app_users",
    )


def downgrade() -> None:
    op.alter_column(
        "workboard_workspaces",
        "access_mode",
        existing_type=sa.String(32),
        existing_nullable=False,
        server_default="internal",
    )
    op.drop_column("workboards", "app_users_config")
