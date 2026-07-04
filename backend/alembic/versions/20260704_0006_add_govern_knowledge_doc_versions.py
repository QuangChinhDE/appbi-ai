"""add govern_knowledge_doc_versions — lock business-doc history over time

Revision ID: 20260704_0006
Revises: 20260704_0005
Create Date: 2026-07-04

Immutable per-version snapshots of a knowledge/business document, so the
evolution of the business write-up is preserved and any past version can be
viewed/restored (the historical record the AI can also mine).
"""
from alembic import op
import sqlalchemy as sa


revision = "20260704_0006"
down_revision = "20260704_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "govern_knowledge_doc_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doc_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("space", sa.String(length=128), nullable=True),
        sa.Column("doc_type", sa.String(length=32), nullable=True),
        sa.Column("summary", sa.String(length=512), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=True),
        sa.Column("change_note", sa.String(length=512), nullable=True),
        sa.Column("changed_by", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("doc_id", "version", name="uq_doc_version"),
    )
    op.create_index("ix_govern_kdoc_versions_doc_id", "govern_knowledge_doc_versions", ["doc_id"])
    op.create_index("ix_govern_kdoc_versions_created_at", "govern_knowledge_doc_versions", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_govern_kdoc_versions_created_at", table_name="govern_knowledge_doc_versions")
    op.drop_index("ix_govern_kdoc_versions_doc_id", table_name="govern_knowledge_doc_versions")
    op.drop_table("govern_knowledge_doc_versions")
