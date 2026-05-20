"""add dashboard draft_snapshot

Revision ID: 20260520_0001
Revises: 20260515_0001
Create Date: 2026-05-20

Phase-15.56 — draft / publish workflow for dashboards.

The editor writes pending edits into `draft_snapshot` (a single JSON
column overlaying name / description / filters_config / pages_config /
layout_mode / theme_config / canvas_config / public_filters_config and
a serialized dashboard_charts list). Public viewers continue reading
the live columns + the live dashboard_charts rows.

When the editor clicks "Save / Publish", the BE applies the snapshot
onto the live columns + reconciles dashboard_charts, then clears the
column. Discard simply clears the column.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260520_0001"
down_revision: Union[str, None] = "20260515_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Single nullable JSON column. NULL means "no pending draft —
    # editor sees the live state". Non-null means "user has unsaved
    # changes; editor sees the snapshot, public viewer still sees live."
    op.add_column(
        "dashboards",
        sa.Column("draft_snapshot", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dashboards", "draft_snapshot")
