"""add advanced Explore chart types

Revision ID: 20260506_0001
Revises: 20260504_0001
Create Date: 2026-05-06
"""
from typing import Sequence, Union

from alembic import op


revision: str = "20260506_0001"
down_revision: Union[str, None] = "20260504_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


NEW_CHART_TYPES = (
    "DONUT",
    "RADAR",
    "POLAR_AREA",
    "MATRIX",
    "BUBBLE",
    "HEATMAP",
    "TREEMAP",
    "FUNNEL",
    "GAUGE",
    "WATERFALL",
    "MAP_POINT",
    "MAP_REGION",
    "BOXPLOT",
    "BULLET",
    "SANKEY",
    "SUNBURST",
    "RIBBON",
    "TIMELINE",
    "WORD_CLOUD",
)


def upgrade() -> None:
    with op.get_context().autocommit_block():
        for chart_type in NEW_CHART_TYPES:
            op.execute(f"ALTER TYPE charttype ADD VALUE IF NOT EXISTS '{chart_type}'")


def downgrade() -> None:
    # PostgreSQL enum values cannot be removed without recreating the type.
    pass
