"""add_horizontal_bar_and_bar_line_chart_types

Revision ID: 20260404_0002
Revises: 20260404_0001
Create Date: 2026-04-04 14:20:00.000000
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "20260404_0002"
down_revision: Union[str, None] = "20260404_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE charttype ADD VALUE IF NOT EXISTS 'HORIZONTAL_BAR'")
    op.execute("ALTER TYPE charttype ADD VALUE IF NOT EXISTS 'BAR_LINE'")


def downgrade() -> None:
    # PostgreSQL does not support removing individual enum values without
    # recreating the type, so downgrade is intentionally a no-op.
    pass
