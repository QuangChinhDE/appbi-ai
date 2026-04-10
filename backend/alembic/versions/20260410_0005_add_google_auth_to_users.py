"""add_google_auth_to_users

Revision ID: 20260410_0005
Revises: 20260409_0004
Create Date: 2026-04-10 21:30:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260410_0005"
down_revision: Union[str, None] = "20260409_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DUMMY_BCRYPT_HASH = "$2b$12$KIXBKl9Xv5iyYFiC.gEuQuT3s.d6OM2nqYbJt6n4PjNn2YGFQbZxO"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("auth_provider", sa.String(length=32), nullable=False, server_default="password"),
    )
    op.add_column(
        "users",
        sa.Column("google_sub", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("avatar_url", sa.String(length=1024), nullable=True),
    )
    op.alter_column(
        "users",
        "password_hash",
        existing_type=sa.String(length=255),
        nullable=True,
    )
    op.create_index("ix_users_google_sub", "users", ["google_sub"], unique=True)


def downgrade() -> None:
    op.execute(
        f"UPDATE users SET password_hash = '{_DUMMY_BCRYPT_HASH}' WHERE password_hash IS NULL"
    )
    op.drop_index("ix_users_google_sub", table_name="users")
    op.alter_column(
        "users",
        "password_hash",
        existing_type=sa.String(length=255),
        nullable=False,
    )
    op.drop_column("users", "avatar_url")
    op.drop_column("users", "google_sub")
    op.drop_column("users", "auth_provider")
