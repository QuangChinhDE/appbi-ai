"""add_report_templates_table

Revision ID: 20260414_0001
Revises: 20260413_0001
Create Date: 2026-04-14 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "20260414_0001"
down_revision: Union[str, None] = "20260413_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("page_size", sa.String(20), nullable=False, server_default="A4"),
        sa.Column("orientation", sa.String(20), nullable=False, server_default="portrait"),
        sa.Column("blocks", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column(
            "owner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_report_templates_id", "report_templates", ["id"])
    op.create_index("ix_report_templates_name", "report_templates", ["name"])


def downgrade() -> None:
    op.drop_index("ix_report_templates_name", table_name="report_templates")
    op.drop_index("ix_report_templates_id", table_name="report_templates")
    op.drop_table("report_templates")
