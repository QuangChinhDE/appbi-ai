"""add workboards module

Revision ID: 20260425_0001
Revises: 20260424_0003
Create Date: 2026-04-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "20260425_0001"
down_revision: Union[str, None] = "20260424_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Extend the resourcetype enum so resource_shares can target workboards.
    connection = op.get_bind()
    connection.execute(
        text("ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'workboard'")
    )

    op.create_table(
        "workboards",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("slug", sa.String(120), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("icon", sa.String(64), nullable=True),
        sa.Column(
            "dataset_id",
            sa.Integer(),
            sa.ForeignKey("datasets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "primary_table_id",
            sa.Integer(),
            sa.ForeignKey("dataset_tables.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "primary_key_columns",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "lookup_tables",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "layout_json",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "write_mode",
            sa.String(20),
            nullable=False,
            server_default="direct",
        ),
        sa.Column("optimistic_lock_column", sa.String(120), nullable=True),
        sa.Column(
            "is_published",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "version",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
        sa.Column("settings", postgresql.JSONB(), nullable=True),
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
        sa.UniqueConstraint("slug", name="uq_workboards_slug"),
    )
    op.create_index("ix_workboards_id", "workboards", ["id"])
    op.create_index("ix_workboards_name", "workboards", ["name"])
    op.create_index("ix_workboards_slug", "workboards", ["slug"])
    op.create_index("ix_workboards_dataset_id", "workboards", ["dataset_id"])
    op.create_index(
        "ix_workboards_primary_table_id", "workboards", ["primary_table_id"]
    )
    op.create_index("ix_workboards_owner_id", "workboards", ["owner_id"])

    op.create_table(
        "workboard_submissions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "workboard_id",
            sa.Integer(),
            sa.ForeignKey("workboards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("table_name", sa.String(500), nullable=False),
        sa.Column("row_pk", postgresql.JSONB(), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=True),
        sa.Column(
            "validation_warnings",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "user_id",
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
    )
    op.create_index(
        "ix_workboard_submissions_id", "workboard_submissions", ["id"]
    )
    op.create_index(
        "ix_workboard_submissions_workboard_id",
        "workboard_submissions",
        ["workboard_id"],
    )
    op.create_index(
        "ix_workboard_submissions_user_id",
        "workboard_submissions",
        ["user_id"],
    )
    op.create_index(
        "ix_workboard_submissions_created_at",
        "workboard_submissions",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_workboard_submissions_created_at", table_name="workboard_submissions"
    )
    op.drop_index(
        "ix_workboard_submissions_user_id", table_name="workboard_submissions"
    )
    op.drop_index(
        "ix_workboard_submissions_workboard_id",
        table_name="workboard_submissions",
    )
    op.drop_index(
        "ix_workboard_submissions_id", table_name="workboard_submissions"
    )
    op.drop_table("workboard_submissions")

    op.drop_index("ix_workboards_owner_id", table_name="workboards")
    op.drop_index("ix_workboards_primary_table_id", table_name="workboards")
    op.drop_index("ix_workboards_dataset_id", table_name="workboards")
    op.drop_index("ix_workboards_slug", table_name="workboards")
    op.drop_index("ix_workboards_name", table_name="workboards")
    op.drop_index("ix_workboards_id", table_name="workboards")
    op.drop_table("workboards")

    # PostgreSQL does not support removing enum values; intentional no-op.
