"""Dashboards: authored Tablet / Phone layouts (published state).

`dashboards.responsive_layouts` (additive, nullable JSONB). NULL — and any
page/breakpoint absent from the document — means AUTO: the tablet and phone
layouts keep being derived from the desktop layout at render time, exactly as
before this revision. No backfill: nothing derived is ever materialised, so
every existing report renders as it did.

A present entry is a complete CUSTOM layout of one page at one breakpoint
("md" = tablet, "xs" = phone) in the 36-column grid. Only Publish (and
dashboard duplication) writes the column; authors edit their draft in
`draft_snapshot.user_responsive_layouts`. See docs/responsive-dashboard-layouts.md.

Downgrade drops the column (authored device layouts are lost; reports fall
back to AUTO, which is what older code renders anyway).

SELF-CONTAINED — imports nothing from `app`.

Revision ID: 20261006_0001
Revises: 20261004_0001
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261006_0001"
down_revision = "20261004_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column("responsive_layouts", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dashboards", "responsive_layouts")
