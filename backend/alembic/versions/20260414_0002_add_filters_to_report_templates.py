"""add_filters_to_report_templates

Revision ID: 20260414_0002
Revises: 20260414_0001
Create Date: 2026-04-14 00:01:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260414_0002"
down_revision: Union[str, None] = "20260414_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "report_templates",
        sa.Column("filters", sa.JSON(), nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("report_templates", "filters")
