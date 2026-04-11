"""Add context JSON to chat_sessions.

Revision ID: 20260411_0007
Revises: 20260410_0006
Create Date: 2026-04-11
"""
from alembic import op
import sqlalchemy as sa


revision = "20260411_0007"
down_revision = "20260410_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("chat_sessions", sa.Column("context", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("chat_sessions", "context")
