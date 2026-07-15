"""add govern_knowledge_docs — the Knowledge Hub (Cẩm nang tri thức)

Revision ID: 20260704_0003
Revises: 20260704_0002
Create Date: 2026-07-04

Rich-text knowledge articles organized into spaces + a page tree, so a business
can record how its whole reporting system works (onboarding "kho tàng"), with
metrics/glossary/dashboards riding along as related links. Versioned + audited.
"""
from alembic import op
import sqlalchemy as sa


revision = "20260704_0003"
down_revision = "20260704_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "govern_knowledge_docs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("slug", sa.String(length=255), nullable=True),
        sa.Column("space", sa.String(length=128), nullable=False, server_default="Chung"),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("doc_type", sa.String(length=32), nullable=False, server_default="article"),
        sa.Column("summary", sa.String(length=512), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("related_metrics", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("related_terms", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("related_dashboard_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("related_dataset_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="Draft"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("owner", sa.String(length=128), nullable=True),
        sa.Column("provider", sa.String(length=16), nullable=False, server_default="user"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_govern_knowledge_docs_slug", "govern_knowledge_docs", ["slug"])
    op.create_index("ix_govern_knowledge_docs_space", "govern_knowledge_docs", ["space"])
    op.create_index("ix_govern_knowledge_docs_parent_id", "govern_knowledge_docs", ["parent_id"])


def downgrade() -> None:
    op.drop_index("ix_govern_knowledge_docs_parent_id", table_name="govern_knowledge_docs")
    op.drop_index("ix_govern_knowledge_docs_space", table_name="govern_knowledge_docs")
    op.drop_index("ix_govern_knowledge_docs_slug", table_name="govern_knowledge_docs")
    op.drop_table("govern_knowledge_docs")
