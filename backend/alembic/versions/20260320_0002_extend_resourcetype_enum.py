"""Extend resourcetype enum with datasource and chat_session

Revision ID: 20260320_enum02
Revises: 20260320_auth01
Create Date: 2026-03-20
"""
from alembic import op
from sqlalchemy import text

revision = '20260320_enum02'
down_revision = '20260320_auth01'
branch_labels = None
depends_on = None


def upgrade():
    # ALTER TYPE ADD VALUE must run outside a transaction in PostgreSQL.
    connection = op.get_bind()
    connection.execution_options(isolation_level="AUTOCOMMIT")
    connection.execute(text("ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'datasource'"))
    connection.execute(text("ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'chat_session'"))


def downgrade():
    # PostgreSQL does not support removing enum values; intentional no-op.
    pass
