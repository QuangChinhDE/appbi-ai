"""Workboard workspace + app-user login attempts tables.

Revision ID: 20260425_0003
Revises: 20260425_0002
Create Date: 2026-04-25

A workspace is the public-facing bundle of workboards a non-AppBI user
(worker, foreman) sees behind a single ``/w/{token}`` URL. The schema is
intentionally thin — auth is delegated to a dataset table (see
``app_users_config`` JSONB) so each project picks its own employee table
shape; AppBI never owns the actual user list.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260425_0003"
down_revision = "20260425_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workboard_workspaces",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("slug", sa.String(120), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("icon", sa.String(64), nullable=True),
        sa.Column("token", sa.String(64), nullable=False),
        sa.Column(
            "app_users_config",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "menu_config",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("branding", postgresql.JSONB(), nullable=True),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "session_ttl_seconds",
            sa.Integer(),
            nullable=False,
            server_default="28800",
        ),
        sa.Column(
            "owner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("slug", name="uq_workboard_workspaces_slug"),
        sa.UniqueConstraint("token", name="uq_workboard_workspaces_token"),
    )
    op.create_index("ix_workboard_workspaces_id", "workboard_workspaces", ["id"])
    op.create_index("ix_workboard_workspaces_slug", "workboard_workspaces", ["slug"])
    op.create_index("ix_workboard_workspaces_token", "workboard_workspaces", ["token"])
    op.create_index("ix_workboard_workspaces_owner_id", "workboard_workspaces", ["owner_id"])

    op.create_table(
        "workboard_app_login_attempts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "workspace_id",
            sa.Integer(),
            sa.ForeignKey("workboard_workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("username_attempted", sa.String(255), nullable=False),
        sa.Column("ip_address", sa.String(64), nullable=True),
        sa.Column(
            "success",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "attempted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_workboard_app_login_attempts_id",
        "workboard_app_login_attempts",
        ["id"],
    )
    op.create_index(
        "ix_workboard_app_login_attempts_workspace_id",
        "workboard_app_login_attempts",
        ["workspace_id"],
    )
    op.create_index(
        "ix_workboard_app_login_attempts_attempted_at",
        "workboard_app_login_attempts",
        ["attempted_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_workboard_app_login_attempts_attempted_at",
        table_name="workboard_app_login_attempts",
    )
    op.drop_index(
        "ix_workboard_app_login_attempts_workspace_id",
        table_name="workboard_app_login_attempts",
    )
    op.drop_index(
        "ix_workboard_app_login_attempts_id",
        table_name="workboard_app_login_attempts",
    )
    op.drop_table("workboard_app_login_attempts")

    op.drop_index("ix_workboard_workspaces_owner_id", table_name="workboard_workspaces")
    op.drop_index("ix_workboard_workspaces_token", table_name="workboard_workspaces")
    op.drop_index("ix_workboard_workspaces_slug", table_name="workboard_workspaces")
    op.drop_index("ix_workboard_workspaces_id", table_name="workboard_workspaces")
    op.drop_table("workboard_workspaces")
