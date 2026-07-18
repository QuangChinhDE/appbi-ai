"""dataset composition: parent-dataset reference columns on dataset_tables

Dataset-on-Dataset composition (Phase-2). A DatasetTable with source_kind
"dataset" references ONE published table of a parent dataset; it carries no
data of its own. These two nullable columns record WHICH parent table it points
at. The lineage edge + pinned parent generation live in dataset_dependencies
(created in 20260718_0015). Purely additive — existing rows get NULLs.

Revision ID: 20260719_0016
Revises: 20260718_0015
"""
from alembic import op
import sqlalchemy as sa


revision = "20260719_0016"
down_revision = "20260718_0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("dataset_tables") as batch:
        batch.add_column(sa.Column("parent_dataset_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("parent_dataset_table_id", sa.Integer(), nullable=True))
    op.create_index(
        "ix_dataset_tables_parent_dataset_id", "dataset_tables", ["parent_dataset_id"]
    )
    # FKs with RESTRICT so a parent dataset/table cannot be deleted out from
    # under a composing child (delete is blocked with a clear message instead).
    op.create_foreign_key(
        "fk_dataset_tables_parent_dataset", "dataset_tables", "datasets",
        ["parent_dataset_id"], ["id"], ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_dataset_tables_parent_table", "dataset_tables", "dataset_tables",
        ["parent_dataset_table_id"], ["id"], ondelete="RESTRICT",
    )


def downgrade() -> None:
    op.drop_constraint("fk_dataset_tables_parent_table", "dataset_tables", type_="foreignkey")
    op.drop_constraint("fk_dataset_tables_parent_dataset", "dataset_tables", type_="foreignkey")
    op.drop_index("ix_dataset_tables_parent_dataset_id", table_name="dataset_tables")
    with op.batch_alter_table("dataset_tables") as batch:
        batch.drop_column("parent_dataset_table_id")
        batch.drop_column("parent_dataset_id")
