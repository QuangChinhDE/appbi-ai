"""Workboard media store — binary attachments referenced by URL from any store.

Creates `workboard_media`: image/file/signature/audio binaries uploaded from a
mini-app form live here in the app DB; the business store (Google Sheets,
Postgres, …) only holds a short URL to the row. This is what lets an operational
dataset backed by Google Sheets carry images at all — a Sheets cell caps at
50,000 chars and cannot hold a base64 blob.

SELF-CONTAINED — imports nothing from `app`.

Revision ID: 20260812_0042
Revises: 20260811_0041
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260812_0042"
down_revision = "20260811_0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workboard_media",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("workboard_id", sa.Integer(), nullable=True),
        sa.Column(
            "content_type",
            sa.String(length=120),
            nullable=False,
            server_default="application/octet-stream",
        ),
        sa.Column("filename", sa.String(length=255), nullable=True),
        sa.Column("byte_size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["workboard_id"], ["workboards.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "ix_workboard_media_workboard_id", "workboard_media", ["workboard_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_workboard_media_workboard_id", table_name="workboard_media")
    op.drop_table("workboard_media")
