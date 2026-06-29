"""add native governance catalog tables (glossary + classification)

Replaces the external OpenMetadata store for the Govern module with AppBI-native
tables. FQN = "<parent>.<child>" mirrors OM so measure tag/term refs keep working.

Revision ID: 20260629_0001
Revises: 20260623_0002
Create Date: 2026-06-29
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260629_0001"
down_revision: Union[str, None] = "20260623_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "glossaries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("provider", sa.String(length=16), nullable=False, server_default="user"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("name", name="uq_glossaries_name"),
    )
    op.create_index("ix_glossaries_name", "glossaries", ["name"])

    op.create_table(
        "glossary_terms",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("glossary_id", sa.Integer(), sa.ForeignKey("glossaries.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("synonyms", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="Approved"),
        sa.Column("provider", sa.String(length=16), nullable=False, server_default="user"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("glossary_id", "name", name="uq_glossary_term_name"),
    )
    op.create_index("ix_glossary_terms_glossary_id", "glossary_terms", ["glossary_id"])

    op.create_table(
        "classifications",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("mutually_exclusive", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("provider", sa.String(length=16), nullable=False, server_default="user"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("name", name="uq_classifications_name"),
    )
    op.create_index("ix_classifications_name", "classifications", ["name"])

    op.create_table(
        "classification_tags",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("classification_id", sa.Integer(), sa.ForeignKey("classifications.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("provider", sa.String(length=16), nullable=False, server_default="user"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("classification_id", "name", name="uq_classification_tag_name"),
    )
    op.create_index("ix_classification_tags_classification_id", "classification_tags", ["classification_id"])


def downgrade() -> None:
    op.drop_table("classification_tags")
    op.drop_table("classifications")
    op.drop_table("glossary_terms")
    op.drop_table("glossaries")
