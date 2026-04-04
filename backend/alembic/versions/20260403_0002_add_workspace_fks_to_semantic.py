"""Add workspace FKs to semantic tables

Revision ID: 20260403_0002
Revises: 20260403_0001
Create Date: 2026-04-03

Links semantic_views to workspace tables and semantic_models to workspaces.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers
revision = "20260403_0002"
down_revision = "20260403_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add workspace_table_id to semantic_views (nullable FK)
    op.add_column(
        "semantic_views",
        sa.Column("workspace_table_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_semantic_views_workspace_table_id",
        "semantic_views",
        "dataset_workspace_tables",
        ["workspace_table_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_semantic_views_workspace_table_id",
        "semantic_views",
        ["workspace_table_id"],
    )

    # Add workspace_id to semantic_models (nullable FK)
    op.add_column(
        "semantic_models",
        sa.Column("workspace_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_semantic_models_workspace_id",
        "semantic_models",
        "dataset_workspaces",
        ["workspace_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_semantic_models_workspace_id",
        "semantic_models",
        ["workspace_id"],
    )

    # Drop unique constraint on name columns (use raw SQL to handle IF EXISTS)
    conn = op.get_bind()
    conn.execute(sa.text(
        "ALTER TABLE semantic_views DROP CONSTRAINT IF EXISTS semantic_views_name_key"
    ))
    conn.execute(sa.text(
        "ALTER TABLE semantic_models DROP CONSTRAINT IF EXISTS semantic_models_name_key"
    ))

    # Add unique constraints on workspace FKs (1 view per table, 1 model per workspace)
    op.create_unique_constraint(
        "uq_semantic_views_workspace_table_id",
        "semantic_views",
        ["workspace_table_id"],
    )
    op.create_unique_constraint(
        "uq_semantic_models_workspace_id",
        "semantic_models",
        ["workspace_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_semantic_models_workspace_id", "semantic_models", type_="unique")
    op.drop_constraint("fk_semantic_models_workspace_id", "semantic_models", type_="foreignkey")
    op.drop_index("ix_semantic_models_workspace_id", table_name="semantic_models")
    op.drop_column("semantic_models", "workspace_id")

    op.drop_constraint("uq_semantic_views_workspace_table_id", "semantic_views", type_="unique")
    op.drop_constraint("fk_semantic_views_workspace_table_id", "semantic_views", type_="foreignkey")
    op.drop_index("ix_semantic_views_workspace_table_id", table_name="semantic_views")
    op.drop_column("semantic_views", "workspace_table_id")
