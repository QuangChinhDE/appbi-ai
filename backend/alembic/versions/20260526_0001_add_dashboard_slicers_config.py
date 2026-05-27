"""add dashboard slicers_config

Revision ID: 20260526_0001
Revises: 20260522_0001
Create Date: 2026-05-26

Phase-A of filter rework (branch feature/filter-pbi-rework).

`slicers_config` is a new JSON column on `dashboards` that stores
slicer-visual entries separately from `filters_config`. The split lets
the UI render slicers as canvas blocks and filters as pane entries
without inferring the role from a single mixed list.

NULL or [] means "no slicers" — existing dashboards default to empty
and authors promote filters to slicers via the new UI. There is no
automatic backfill from `filters_config`.

See docs/filter-semantics.md for the full spec.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260526_0001"
down_revision: Union[str, None] = "20260522_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column("slicers_config", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dashboards", "slicers_config")
