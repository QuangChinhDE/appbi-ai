"""add govern_doc_asset_links — link dashboards/datasets/terms into knowledge docs

Revision ID: 20260704_0005
Revises: 20260704_0004
Create Date: 2026-07-04

A knowledge doc can embed reporting assets via {{dashboard:id}} / {{dataset:id}}
/ {{term:fqn}} tokens; these edges make Govern the comprehensive onboarding view
of the whole reporting system (reports + data + metrics + terms + narrative).
"""
from alembic import op
import sqlalchemy as sa


revision = "20260704_0005"
down_revision = "20260704_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "govern_doc_asset_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("doc_id", sa.Integer(), nullable=False),
        sa.Column("asset_type", sa.String(length=24), nullable=False),
        sa.Column("asset_ref", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.UniqueConstraint("doc_id", "asset_type", "asset_ref", name="uq_doc_asset_link"),
    )
    op.create_index("ix_govern_doc_asset_links_doc_id", "govern_doc_asset_links", ["doc_id"])
    op.create_index("ix_govern_doc_asset_links_asset_type", "govern_doc_asset_links", ["asset_type"])
    op.create_index("ix_govern_doc_asset_links_asset_ref", "govern_doc_asset_links", ["asset_ref"])


def downgrade() -> None:
    op.drop_index("ix_govern_doc_asset_links_asset_ref", table_name="govern_doc_asset_links")
    op.drop_index("ix_govern_doc_asset_links_asset_type", table_name="govern_doc_asset_links")
    op.drop_index("ix_govern_doc_asset_links_doc_id", table_name="govern_doc_asset_links")
    op.drop_table("govern_doc_asset_links")
