"""add is_draft flag to datasets

Revision ID: 20260421_0001
Revises: 20260417_0002
Create Date: 2026-04-21
"""

from alembic import op
import sqlalchemy as sa


revision = "20260421_0001"
down_revision = "20260417_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "datasets",
        sa.Column(
            "is_draft",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.create_index(
        "ix_datasets_is_draft",
        "datasets",
        ["is_draft"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_datasets_is_draft", table_name="datasets")
    op.drop_column("datasets", "is_draft")
