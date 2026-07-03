"""add workboard_push_subscriptions (mini-app web push)

Revision ID: 20260703_0002
Revises: 20260703_0001
Create Date: 2026-07-03

One Web Push subscription per (workboard, app-user, device endpoint) so the
mini-app can notify field workers (e.g. record reviewed/approved).
"""
from alembic import op
import sqlalchemy as sa


revision = "20260703_0002"
down_revision = "20260703_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workboard_push_subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "workboard_id",
            sa.Integer(),
            sa.ForeignKey("workboards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("username", sa.String(length=255), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.String(length=255), nullable=False),
        sa.Column("auth", sa.String(length=255), nullable=False),
        sa.Column("user_agent", sa.String(length=500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "workboard_id", "username", "endpoint", name="uq_wb_push_sub"
        ),
    )
    op.create_index(
        "ix_workboard_push_subscriptions_workboard_id",
        "workboard_push_subscriptions",
        ["workboard_id"],
    )
    op.create_index(
        "ix_workboard_push_subscriptions_username",
        "workboard_push_subscriptions",
        ["username"],
    )


def downgrade() -> None:
    op.drop_index("ix_workboard_push_subscriptions_username", table_name="workboard_push_subscriptions")
    op.drop_index("ix_workboard_push_subscriptions_workboard_id", table_name="workboard_push_subscriptions")
    op.drop_table("workboard_push_subscriptions")
