"""add_dataset_dictionary

Revision ID: 20260411_0004
Revises: 20260408_0003
Create Date: 2026-04-11 23:20:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "20260411_0004"
down_revision: Union[str, None] = "20260411_0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "datasets",
        sa.Column("dictionary", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "datasets",
        sa.Column("dictionary_updated_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("datasets", "dictionary_updated_at")
    op.drop_column("datasets", "dictionary")
