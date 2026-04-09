"""add_dataset_calendar_dimension

Revision ID: 20260408_0003
Revises: 20260404_0002
Create Date: 2026-04-08 11:30:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "20260408_0003"
down_revision: Union[str, None] = "20260404_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


DEFAULT_DISABLED_CALENDAR_SETTINGS = """
{
  "calendar_dimension": {
    "enabled": false,
    "start_date": "2000-01-01",
    "end_date": "2100-12-31",
    "timezone": "UTC",
    "week_start_day": "monday",
    "fiscal_year_start_month": 1,
    "auto_join_temporal_columns": true
  }
}
"""


def upgrade() -> None:
    op.add_column(
        "datasets",
        sa.Column("settings", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.execute(
        f"""
        UPDATE datasets
        SET settings = '{DEFAULT_DISABLED_CALENDAR_SETTINGS}'::jsonb
        WHERE settings IS NULL
        """
    )
    op.alter_column("dataset_tables", "datasource_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM dataset_tables WHERE source_kind = 'generated_calendar'")
    op.alter_column("dataset_tables", "datasource_id", existing_type=sa.Integer(), nullable=False)
    op.drop_column("datasets", "settings")
