"""Fix resource_shares.resource_id column type from INTEGER to VARCHAR.

The original migration created resource_id as INTEGER, but the SQLAlchemy
model declares it as String. The column must be VARCHAR to support both
integer resource IDs (dashboards, charts, workspaces, datasources) and
UUID-string resource IDs (chat_sessions).

Without this fix, filter_by_visibility() crashes with:
  operator does not exist: character varying = integer

Revision ID: 20260323_fix01
Revises: 20260322_fb02
Create Date: 2026-03-23
"""
from alembic import op
from sqlalchemy import text

revision = '20260323_fix01'
down_revision = '20260322_fb02'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # Drop dependent index and unique constraint before altering column type
    conn.execute(text("DROP INDEX IF EXISTS ix_resource_shares_resource"))
    conn.execute(text("ALTER TABLE resource_shares DROP CONSTRAINT IF EXISTS uq_resource_shares"))

    # Change column type INTEGER → VARCHAR, casting existing integer values to text
    conn.execute(text(
        "ALTER TABLE resource_shares "
        "ALTER COLUMN resource_id TYPE VARCHAR USING resource_id::varchar"
    ))

    # Recreate index and constraint
    conn.execute(text(
        "CREATE INDEX ix_resource_shares_resource "
        "ON resource_shares (resource_type, resource_id)"
    ))
    conn.execute(text(
        "ALTER TABLE resource_shares "
        "ADD CONSTRAINT uq_resource_shares "
        "UNIQUE (resource_type, resource_id, user_id)"
    ))


def downgrade() -> None:
    conn = op.get_bind()

    conn.execute(text("DROP INDEX IF EXISTS ix_resource_shares_resource"))
    conn.execute(text("ALTER TABLE resource_shares DROP CONSTRAINT IF EXISTS uq_resource_shares"))

    # Cast back to INTEGER — will fail if any non-numeric values exist (e.g. UUIDs)
    conn.execute(text(
        "ALTER TABLE resource_shares "
        "ALTER COLUMN resource_id TYPE INTEGER USING resource_id::integer"
    ))

    conn.execute(text(
        "CREATE INDEX ix_resource_shares_resource "
        "ON resource_shares (resource_type, resource_id)"
    ))
    conn.execute(text(
        "ALTER TABLE resource_shares "
        "ADD CONSTRAINT uq_resource_shares "
        "UNIQUE (resource_type, resource_id, user_id)"
    ))
