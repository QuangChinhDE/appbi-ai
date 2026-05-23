"""add semantic_models.settings + dataset_tables.miniapp_share

Revision ID: 20260522_0001
Revises: 20260520_0001
Create Date: 2026-05-22

Phase-16 — relationship review + workboard access audit.

`semantic_models.settings` (JSON, nullable) stores model-level config:
  - `rejected_auto_joins`: list of {from_view, to_view, from_columns,
    to_columns} tombstones the builder declined during the "Review
    suggestions" flow. The generator skips these on subsequent runs so
    auto-detected joins don't keep coming back after the user dismissed
    them. A "Reset rejections" button clears the list.

`dataset_tables.miniapp_share` (Boolean, default False) marks a table as
"public reference data" inside a workboard. When True, the workboard
access audit treats the table as `shared` mode even when it has no
`miniapp_user` column and no chain to a per-user fact table. Without this
flag we cannot distinguish "this dim should be public" from "this dim is
mis-wired and will silently leak data".
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260522_0001"
down_revision: Union[str, None] = "20260520_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "semantic_models",
        sa.Column("settings", sa.JSON(), nullable=True),
    )
    op.add_column(
        "dataset_tables",
        sa.Column(
            "miniapp_share",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("dataset_tables", "miniapp_share")
    op.drop_column("semantic_models", "settings")
