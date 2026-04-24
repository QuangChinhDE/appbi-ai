"""add team targets to resource shares

Revision ID: 20260424_0002
Revises: 20260424_0001
Create Date: 2026-04-24
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260424_0002"
down_revision = "20260424_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "resource_shares",
        sa.Column("team_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_resource_shares_team_id_teams",
        "resource_shares",
        "teams",
        ["team_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.drop_constraint("uq_resource_shares", "resource_shares", type_="unique")
    op.alter_column("resource_shares", "user_id", existing_type=postgresql.UUID(as_uuid=True), nullable=True)
    op.create_unique_constraint(
        "uq_resource_shares_user",
        "resource_shares",
        ["resource_type", "resource_id", "user_id"],
    )
    op.create_unique_constraint(
        "uq_resource_shares_team",
        "resource_shares",
        ["resource_type", "resource_id", "team_id"],
    )
    op.create_check_constraint(
        "ck_resource_shares_single_target",
        "resource_shares",
        "((user_id IS NOT NULL AND team_id IS NULL) OR (user_id IS NULL AND team_id IS NOT NULL))",
    )


def downgrade() -> None:
    op.drop_constraint("ck_resource_shares_single_target", "resource_shares", type_="check")
    op.drop_constraint("uq_resource_shares_team", "resource_shares", type_="unique")
    op.drop_constraint("uq_resource_shares_user", "resource_shares", type_="unique")
    op.alter_column("resource_shares", "user_id", existing_type=postgresql.UUID(as_uuid=True), nullable=False)
    op.create_unique_constraint(
        "uq_resource_shares",
        "resource_shares",
        ["resource_type", "resource_id", "user_id"],
    )
    op.drop_constraint("fk_resource_shares_team_id_teams", "resource_shares", type_="foreignkey")
    op.drop_column("resource_shares", "team_id")