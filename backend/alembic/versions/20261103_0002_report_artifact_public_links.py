"""Report-as-Code: named public links (password, expiry, locked filters, appearance).

Additive: one new table. Every report whose single legacy link was ON is carried over
as one link with THE SAME token, so a URL already shared keeps working. A legacy token
whose link was OFF is not carried over (it stays revoked); after this migration the
public side resolves tokens only through this table, so `report_artifacts.public_token`
/ `public_enabled` are retired (kept, never read) and nothing can fall back to them.

Revision ID: 20261103_0002
Revises: 20261103_0001
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261103_0002"
down_revision: Union[str, None] = "20261103_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_artifact_public_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("artifact_id", sa.Integer(), sa.ForeignKey("report_artifacts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("filters_config", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("appearance_config", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("password_hash", sa.String(length=255), nullable=True),
        sa.Column("auth_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("access_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_accessed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_report_artifact_public_links_id", "report_artifact_public_links", ["id"])
    op.create_index("ix_report_artifact_public_links_artifact_id", "report_artifact_public_links", ["artifact_id"])
    op.create_index("ix_report_artifact_public_links_token", "report_artifact_public_links", ["token"], unique=True)
    op.execute(
        "INSERT INTO report_artifact_public_links (artifact_id, name, token, created_by) "
        "SELECT id, 'Liên kết công khai', public_token, owner_id FROM report_artifacts "
        "WHERE public_enabled = true AND public_token IS NOT NULL"
    )


def downgrade() -> None:
    # A link revoked (disabled or deleted) after the upgrade must stay revoked on the
    # old single-token code: switch off every legacy flag that no active link backs.
    op.execute(
        "UPDATE report_artifacts SET public_enabled = false WHERE public_enabled = true AND NOT EXISTS ("
        "SELECT 1 FROM report_artifact_public_links l WHERE l.artifact_id = report_artifacts.id "
        "AND l.is_active = true AND l.token = report_artifacts.public_token)"
    )
    op.drop_index("ix_report_artifact_public_links_token", table_name="report_artifact_public_links")
    op.drop_index("ix_report_artifact_public_links_artifact_id", table_name="report_artifact_public_links")
    op.drop_index("ix_report_artifact_public_links_id", table_name="report_artifact_public_links")
    op.drop_table("report_artifact_public_links")
