"""Reconcile users and resource_shares schema with current models.

- users: add permissions JSONB column, drop legacy role column + userrole enum
- resource_shares.permission: rename enum values viewer→view, editor→edit

Revision ID: 20260321_schema05
Revises: 20260320_drop_datasets
Create Date: 2026-03-21
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import JSONB

revision = '20260321_schema05'
down_revision = '20260320_drop_datasets'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # ── 1. Add permissions JSONB to users (DEFAULT empty dict) ───────────────
    op.add_column('users', sa.Column(
        'permissions', JSONB, nullable=False,
        server_default=sa.text("'{}'::jsonb"),
    ))

    # ── 2. Drop legacy role column + userrole enum ───────────────────────────
    # Guard: only drop if the column actually exists (idempotent)
    conn.execute(text("""
        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name='users' AND column_name='role'
            ) THEN
                ALTER TABLE users DROP COLUMN role;
            END IF;
        END $$
    """))
    conn.execute(text("""
        DROP TYPE IF EXISTS userrole
    """))

    # ── 3. Rename sharepermission enum values viewer→view, editor→edit ───────
    # PostgreSQL 10+ supports ALTER TYPE ... RENAME VALUE — clean, no temp column needed.
    conn.execute(text(
        "ALTER TYPE sharepermission RENAME VALUE 'viewer' TO 'view'"
    ))
    conn.execute(text(
        "ALTER TYPE sharepermission RENAME VALUE 'editor' TO 'edit'"
    ))


def downgrade() -> None:
    conn = op.get_bind()

    # Reverse sharepermission rename
    conn.execute(text(
        "ALTER TYPE sharepermission RENAME VALUE 'view' TO 'viewer'"
    ))
    conn.execute(text(
        "ALTER TYPE sharepermission RENAME VALUE 'edit' TO 'editor'"
    ))

    # Restore role column
    conn.execute(text(
        "CREATE TYPE userrole AS ENUM ('admin', 'editor', 'viewer')"
    ))
    op.add_column('users', sa.Column(
        'role', sa.Enum('admin', 'editor', 'viewer', name='userrole'),
        nullable=False, server_default='viewer'
    ))

    # Drop permissions column
    op.drop_column('users', 'permissions')
