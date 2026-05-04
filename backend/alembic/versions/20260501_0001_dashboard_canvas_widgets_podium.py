"""dashboard canvas mode + widgets + PODIUM chart type

Revision ID: 20260501_0001
Revises: 20260429_0001
Create Date: 2026-05-01

Adds the schema needed for the dashboard upgrade:

* ``dashboards.layout_mode`` — "grid" (default, current behavior) or "canvas".
* ``dashboards.theme_config`` — dashboard-level theme tokens (dark/light, accent…).
* ``dashboards.canvas_config`` — canvas geometry when ``layout_mode = canvas``.
* ``dashboard_charts.widget_type`` — discriminator: chart/text/countdown/…
* ``dashboard_charts.widget_config`` — per-widget config blob.
* ``dashboard_charts.chart_id`` is now nullable (non-chart widgets carry no chart).
* ``charttype`` enum gains the ``PODIUM`` value.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260501_0001"
down_revision: Union[str, None] = "20260429_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column("layout_mode", sa.String(length=16), nullable=False, server_default="grid"),
    )
    op.add_column(
        "dashboards",
        sa.Column("theme_config", postgresql.JSON(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "dashboards",
        sa.Column("canvas_config", postgresql.JSON(astext_type=sa.Text()), nullable=True),
    )

    op.add_column(
        "dashboard_charts",
        sa.Column("widget_type", sa.String(length=32), nullable=False, server_default="chart"),
    )
    op.add_column(
        "dashboard_charts",
        sa.Column("widget_config", postgresql.JSON(astext_type=sa.Text()), nullable=True),
    )
    op.alter_column(
        "dashboard_charts",
        "chart_id",
        existing_type=sa.Integer(),
        nullable=True,
    )

    # Postgres rejects ALTER TYPE … ADD VALUE inside a transaction block,
    # which is alembic's default. Run it in an autocommit block.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE charttype ADD VALUE IF NOT EXISTS 'PODIUM'")


def downgrade() -> None:
    op.alter_column(
        "dashboard_charts",
        "chart_id",
        existing_type=sa.Integer(),
        nullable=False,
    )
    op.drop_column("dashboard_charts", "widget_config")
    op.drop_column("dashboard_charts", "widget_type")

    op.drop_column("dashboards", "canvas_config")
    op.drop_column("dashboards", "theme_config")
    op.drop_column("dashboards", "layout_mode")

    # PostgreSQL cannot remove a single enum value without recreating the type.
