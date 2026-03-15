"""add_missing_chart_type_enum_values

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-03-15 00:00:02.000000

Adds chart type enum values that exist in the ChartType model but were never
added to the PostgreSQL charttype enum via a migration:
  TABLE, AREA, STACKED_BAR, GROUPED_BAR, SCATTER, KPI
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'd3e4f5a6b7c8'
down_revision: Union[str, None] = 'c2d3e4f5a6b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE charttype ADD VALUE IF NOT EXISTS 'TABLE'")
    op.execute("ALTER TYPE charttype ADD VALUE IF NOT EXISTS 'AREA'")
    op.execute("ALTER TYPE charttype ADD VALUE IF NOT EXISTS 'STACKED_BAR'")
    op.execute("ALTER TYPE charttype ADD VALUE IF NOT EXISTS 'GROUPED_BAR'")
    op.execute("ALTER TYPE charttype ADD VALUE IF NOT EXISTS 'SCATTER'")
    op.execute("ALTER TYPE charttype ADD VALUE IF NOT EXISTS 'KPI'")


def downgrade() -> None:
    # PostgreSQL does not support removing individual enum values without
    # recreating the type — downgrade is intentionally a no-op.
    pass
