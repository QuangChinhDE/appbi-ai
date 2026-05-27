"""add dashboard slicer_cluster_layout

Revision ID: 20260526_0002
Revises: 20260526_0001
Create Date: 2026-05-26

Phase-G of the filter rework (PBI-parity v2).

`slicer_cluster_layout` stores cluster-level metadata for the slicer
canvas block: position (x/y/w/h or pixel geometry), layout direction
(horizontal / vertical / grid), gap, and optional border/background.

NULL means "use the default top-bar auto-stacked layout" — keeps
backward compat for pre-Phase-G dashboards. Authors opt in by
dragging/resizing the cluster on canvas.

Image children (logos) live as additional entries inside
`slicers_config` with `type='image'` — no schema migration needed for
those; the FE/BE just learn to render and skip them as filters.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260526_0002"
down_revision: Union[str, None] = "20260526_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column("slicer_cluster_layout", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dashboards", "slicer_cluster_layout")
