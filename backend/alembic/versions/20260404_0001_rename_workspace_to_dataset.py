"""Rename dataset_workspaces → datasets, dataset_workspace_tables → dataset_tables.

Clean up legacy naming: the "workspace" concept is now simply "dataset".
Also merges ResourceType.WORKSPACE into DATASET and Module.WORKSPACE into DATASET.

Revision ID: 20260404_0001
Revises: 20260403_0002
"""
from alembic import op
import sqlalchemy as sa

revision = "20260404_0001"
down_revision = "20260403_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Rename tables ──────────────────────────────────────────────
    op.rename_table("dataset_workspaces", "datasets")
    op.rename_table("dataset_workspace_tables", "dataset_tables")

    # ── 2. Rename FK column in dataset_tables ─────────────────────────
    # workspace_id → dataset_id
    op.alter_column("dataset_tables", "workspace_id", new_column_name="dataset_id")

    # ── 3. Rename FK column in semantic_views ─────────────────────────
    # workspace_table_id → dataset_table_id
    op.alter_column("semantic_views", "workspace_table_id", new_column_name="dataset_table_id")

    # ── 4. Rename FK column in semantic_models ────────────────────────
    # workspace_id → dataset_id
    op.alter_column("semantic_models", "workspace_id", new_column_name="dataset_id")

    # ── 5. Rename FK column in monitored_metrics ──────────────────────
    # workspace_table_id → dataset_table_id
    op.alter_column("monitored_metrics", "workspace_table_id", new_column_name="dataset_table_id")

    # ── 5b. Rename FK column in charts ────────────────────────────────
    # workspace_table_id → dataset_table_id
    op.alter_column("charts", "workspace_table_id", new_column_name="dataset_table_id")

    # ── 6. Update resource_shares: WORKSPACE → DATASET ────────────────
    op.execute(sa.text(
        "UPDATE resource_shares SET resource_type = 'dataset' WHERE resource_type = 'workspace'"
    ))

    # ── 7. Update module_permissions: workspace → dataset ─────────────
    op.execute(sa.text(
        "UPDATE module_permissions SET module = 'dataset' WHERE module = 'workspace'"
    ))

    # ── 8. Rename "workspaces" key in users.permissions JSONB ────────
    op.execute(sa.text(
        "UPDATE users SET permissions = permissions - 'workspaces' "
        "|| jsonb_build_object('datasets', permissions->'workspaces') "
        "WHERE permissions ? 'workspaces'"
    ))

    # ── 9. Rename unique constraints ──────────────────────────────────
    op.execute(sa.text(
        "ALTER INDEX IF EXISTS ix_dataset_workspace_tables_workspace_id "
        "RENAME TO ix_dataset_tables_dataset_id"
    ))
    op.execute(sa.text(
        "ALTER INDEX IF EXISTS ix_dataset_workspace_tables_datasource_id "
        "RENAME TO ix_dataset_tables_datasource_id"
    ))
    op.execute(sa.text(
        "ALTER TABLE semantic_views "
        "RENAME CONSTRAINT uq_semantic_views_workspace_table_id "
        "TO uq_semantic_views_dataset_table_id"
    ))
    op.execute(sa.text(
        "ALTER TABLE semantic_models "
        "RENAME CONSTRAINT uq_semantic_models_workspace_id "
        "TO uq_semantic_models_dataset_id"
    ))


def downgrade() -> None:
    # Reverse all renames
    op.execute(sa.text(
        "ALTER TABLE semantic_models "
        "RENAME CONSTRAINT uq_semantic_models_dataset_id "
        "TO uq_semantic_models_workspace_id"
    ))
    op.execute(sa.text(
        "ALTER TABLE semantic_views "
        "RENAME CONSTRAINT uq_semantic_views_dataset_table_id "
        "TO uq_semantic_views_workspace_table_id"
    ))
    op.execute(sa.text(
        "ALTER INDEX IF EXISTS ix_dataset_tables_datasource_id "
        "RENAME TO ix_dataset_workspace_tables_datasource_id"
    ))
    op.execute(sa.text(
        "ALTER INDEX IF EXISTS ix_dataset_tables_dataset_id "
        "RENAME TO ix_dataset_workspace_tables_workspace_id"
    ))

    op.execute(sa.text(
        "UPDATE module_permissions SET module = 'workspace' WHERE module = 'dataset'"
    ))
    op.execute(sa.text(
        "UPDATE resource_shares SET resource_type = 'workspace' WHERE resource_type = 'dataset'"
    ))

    # Revert users.permissions JSONB key
    op.execute(sa.text(
        "UPDATE users SET permissions = permissions - 'datasets' "
        "|| jsonb_build_object('workspaces', permissions->'datasets') "
        "WHERE permissions ? 'datasets'"
    ))

    op.alter_column("charts", "dataset_table_id", new_column_name="workspace_table_id")
    op.alter_column("monitored_metrics", "dataset_table_id", new_column_name="workspace_table_id")
    op.alter_column("semantic_models", "dataset_id", new_column_name="workspace_id")
    op.alter_column("semantic_views", "dataset_table_id", new_column_name="workspace_table_id")
    op.alter_column("dataset_tables", "dataset_id", new_column_name="workspace_id")

    op.rename_table("dataset_tables", "dataset_workspace_tables")
    op.rename_table("datasets", "dataset_workspaces")
