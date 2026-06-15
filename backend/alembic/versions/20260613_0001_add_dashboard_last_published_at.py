"""add dashboards.last_published_at

Revision ID: 20260613_0001
Revises: 20260528_0001
Create Date: 2026-06-13

Phase-B17 — optimistic-concurrency guard for the Build editor. Two people can
edit the same dashboard; the one who publishes second must not silently clobber
the first. We version the PUBLISHED state with `last_published_at` (set only by
POST /publish, NOT by draft saves — draft writes bump `updated_at` and would
otherwise produce false conflicts). The FE captures this on load and sends it
back on publish; the BE 409s if it advanced (someone else published meanwhile).

NULL = never published via this path; first publish sets it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260613_0001"
down_revision: Union[str, None] = "20260528_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column("last_published_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dashboards", "last_published_at")
