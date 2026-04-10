"""add_dashboard_pages_config

Revision ID: 20260409_0004
Revises: 20260408_0003
Create Date: 2026-04-09 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "20260409_0004"
down_revision: Union[str, None] = "20260408_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


DEFAULT_PAGES_CONFIG = """
[
  {
    "id": "page-1",
    "name": "Page 1"
  }
]
"""


def upgrade() -> None:
    op.add_column(
        "dashboards",
        sa.Column("pages_config", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.execute(
        f"""
        UPDATE dashboards
        SET pages_config = '{DEFAULT_PAGES_CONFIG}'::jsonb
        WHERE pages_config IS NULL
        """
    )


def downgrade() -> None:
    op.drop_column("dashboards", "pages_config")
