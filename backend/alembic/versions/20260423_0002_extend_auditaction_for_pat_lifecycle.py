"""extend auditaction enum for PAT lifecycle

Revision ID: 20260423_0002
Revises: 20260423_0001
Create Date: 2026-04-23
"""
from alembic import op


revision = "20260423_0002"
down_revision = "20260423_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for value in (
        "personal_access_token_created",
        "personal_access_token_updated",
        "personal_access_token_revoked",
        "personal_access_token_deleted",
    ):
        op.execute(
            f"ALTER TYPE auditaction ADD VALUE IF NOT EXISTS '{value}'"
        )


def downgrade() -> None:
    # PostgreSQL enum values cannot be removed safely in-place.
    pass