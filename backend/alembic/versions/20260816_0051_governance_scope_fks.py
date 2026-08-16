"""Enforce governance scope and semantic-binding references.

Revision ID: 20260816_0051
Revises: 20260815_0050
"""
from alembic import op


revision = "20260816_0051"
down_revision = "20260815_0050"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Preserve the governance record while clearing pointers whose target was
    # removed before relational validation existed.
    op.execute(
        "UPDATE govern_metric_bindings SET dataset_id = NULL "
        "WHERE dataset_id IS NOT NULL AND NOT EXISTS "
        "(SELECT 1 FROM datasets d WHERE d.id = govern_metric_bindings.dataset_id)"
    )
    op.execute(
        "UPDATE govern_metric_bindings SET dataset_table_id = NULL "
        "WHERE dataset_table_id IS NOT NULL AND NOT EXISTS "
        "(SELECT 1 FROM dataset_tables t WHERE t.id = govern_metric_bindings.dataset_table_id)"
    )
    op.execute(
        "UPDATE govern_metrics SET dataset_id = NULL "
        "WHERE dataset_id IS NOT NULL AND NOT EXISTS "
        "(SELECT 1 FROM datasets d WHERE d.id = govern_metrics.dataset_id)"
    )
    op.execute(
        "UPDATE govern_metrics SET dataset_table_id = NULL "
        "WHERE dataset_table_id IS NOT NULL AND NOT EXISTS "
        "(SELECT 1 FROM dataset_tables t WHERE t.id = govern_metrics.dataset_table_id)"
    )
    op.execute(
        "UPDATE govern_data_caveats SET dataset_id = NULL "
        "WHERE dataset_id IS NOT NULL AND NOT EXISTS "
        "(SELECT 1 FROM datasets d WHERE d.id = govern_data_caveats.dataset_id)"
    )

    op.create_foreign_key("fk_metric_binding_dataset", "govern_metric_bindings", "datasets", ["dataset_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key("fk_metric_binding_table", "govern_metric_bindings", "dataset_tables", ["dataset_table_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key("fk_govern_metric_dataset", "govern_metrics", "datasets", ["dataset_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key("fk_govern_metric_table", "govern_metrics", "dataset_tables", ["dataset_table_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key("fk_govern_caveat_dataset", "govern_data_caveats", "datasets", ["dataset_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    op.drop_constraint("fk_govern_caveat_dataset", "govern_data_caveats", type_="foreignkey")
    op.drop_constraint("fk_govern_metric_table", "govern_metrics", type_="foreignkey")
    op.drop_constraint("fk_govern_metric_dataset", "govern_metrics", type_="foreignkey")
    op.drop_constraint("fk_metric_binding_table", "govern_metric_bindings", type_="foreignkey")
    op.drop_constraint("fk_metric_binding_dataset", "govern_metric_bindings", type_="foreignkey")
