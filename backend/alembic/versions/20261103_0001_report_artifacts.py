"""Report-as-Code: report artifacts and their append-only revisions.

Additive: two new tables. Existing dashboards, charts and public links are untouched.
The artifact points at its draft and published revision; the two foreign keys are
added after both tables exist because the reference is circular.

Revision ID: 20261103_0001
Revises: 20261028_0002
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261103_0001"
down_revision: Union[str, None] = "20261028_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_artifacts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("dataset_id", sa.Integer(), sa.ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("draft_revision_id", sa.Integer(), nullable=True),
        sa.Column("published_revision_id", sa.Integer(), nullable=True),
        sa.Column("public_token", sa.String(length=64), nullable=True),
        sa.Column("public_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("job", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("last_published_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_report_artifacts_id", "report_artifacts", ["id"])
    op.create_index("ix_report_artifacts_dataset_id", "report_artifacts", ["dataset_id"])
    op.create_index("ix_report_artifacts_owner_id", "report_artifacts", ["owner_id"])
    op.create_index("ix_report_artifacts_public_token", "report_artifacts", ["public_token"], unique=True)

    op.create_table(
        "report_artifact_revisions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("artifact_id", sa.Integer(), sa.ForeignKey("report_artifacts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("html", sa.Text(), nullable=False, server_default=""),
        sa.Column("css", sa.Text(), nullable=False, server_default=""),
        sa.Column("js", sa.Text(), nullable=False, server_default=""),
        sa.Column("bindings", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("filters", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("source", sa.String(length=32), nullable=False, server_default="manual"),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("artifact_id", "number", name="uq_report_artifact_revision_number"),
    )
    op.create_index("ix_report_artifact_revisions_id", "report_artifact_revisions", ["id"])
    op.create_index("ix_report_artifact_revisions_artifact_id", "report_artifact_revisions", ["artifact_id"])

    op.create_foreign_key("fk_report_artifacts_draft_revision", "report_artifacts", "report_artifact_revisions",
                          ["draft_revision_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key("fk_report_artifacts_published_revision", "report_artifacts", "report_artifact_revisions",
                          ["published_revision_id"], ["id"], ondelete="SET NULL")

    # Publishing changes what anonymous viewers see; it belongs in the audit trail.
    with op.get_context().autocommit_block():
        for value in ("report_artifact_published", "report_artifact_rolled_back", "report_artifact_deleted"):
            op.execute(f"ALTER TYPE auditaction ADD VALUE IF NOT EXISTS '{value}'")


def downgrade() -> None:
    # Postgres cannot drop an enum value; the three audit values stay (unused).
    op.drop_constraint("fk_report_artifacts_published_revision", "report_artifacts", type_="foreignkey")
    op.drop_constraint("fk_report_artifacts_draft_revision", "report_artifacts", type_="foreignkey")
    op.drop_index("ix_report_artifact_revisions_artifact_id", table_name="report_artifact_revisions")
    op.drop_index("ix_report_artifact_revisions_id", table_name="report_artifact_revisions")
    op.drop_table("report_artifact_revisions")
    op.drop_index("ix_report_artifacts_public_token", table_name="report_artifacts")
    op.drop_index("ix_report_artifacts_owner_id", table_name="report_artifacts")
    op.drop_index("ix_report_artifacts_dataset_id", table_name="report_artifacts")
    op.drop_index("ix_report_artifacts_id", table_name="report_artifacts")
    op.drop_table("report_artifacts")
