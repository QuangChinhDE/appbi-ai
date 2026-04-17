"""make chart names unique per owner

Revision ID: 20260417_0002
Revises: 20260417_0001
Create Date: 2026-04-17
"""

from alembic import op
import sqlalchemy as sa


revision = "20260417_0002"
down_revision = "20260417_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("ix_charts_name", table_name="charts")
    op.create_index("ix_charts_name", "charts", ["name"], unique=False)
    op.create_index(
        "uq_charts_owner_name_ci",
        "charts",
        [sa.text("owner_id"), sa.text("lower(btrim(name))")],
        unique=True,
        postgresql_where=sa.text("owner_id IS NOT NULL"),
    )
    op.create_index(
        "uq_charts_name_ci_null_owner",
        "charts",
        [sa.text("lower(btrim(name))")],
        unique=True,
        postgresql_where=sa.text("owner_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_charts_name_ci_null_owner", table_name="charts")
    op.drop_index("uq_charts_owner_name_ci", table_name="charts")
    op.drop_index("ix_charts_name", table_name="charts")
    op.create_index("ix_charts_name", "charts", ["name"], unique=True)
