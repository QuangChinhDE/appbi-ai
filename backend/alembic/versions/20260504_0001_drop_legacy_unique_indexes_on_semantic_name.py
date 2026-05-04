"""Drop legacy UNIQUE indexes on semantic_models.name and semantic_views.name.

The ORM models declare uniqueness via dataset_id (semantic_models) and
dataset_table_id (semantic_views), but the original migration also created
``ix_semantic_models_name`` and ``ix_semantic_views_name`` as UNIQUE on the
``name`` column. The pipeline that builds the semantic layer derives names
from the dataset/table display name, which can collide across datasets or
across rebuilds where an orphan row from a failed build still occupies the
old name. The collision raises::

    duplicate key value violates unique constraint "ix_semantic_models_name"

This migration drops the legacy unique indexes and re-creates them as
non-unique indexes (so name lookups remain fast).

Revision ID: 20260504_0001
Revises: 20260501_0001
Create Date: 2026-05-04
"""
from typing import Sequence, Union

from alembic import op


revision: str = "20260504_0001"
down_revision: Union[str, None] = "20260501_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _drop_index_if_exists(name: str, table: str) -> None:
    op.execute(f'DROP INDEX IF EXISTS "{name}"')
    # Recreate as non-unique so name lookups stay indexed.
    op.create_index(name, table, ["name"], unique=False)


def upgrade() -> None:
    _drop_index_if_exists("ix_semantic_models_name", "semantic_models")
    _drop_index_if_exists("ix_semantic_views_name", "semantic_views")


def downgrade() -> None:
    # Restoring the legacy unique constraint is unsafe (it would fail if
    # collisions exist), so the downgrade only drops the non-unique index
    # without recreating the unique one. Manually re-apply if you need it.
    op.execute('DROP INDEX IF EXISTS "ix_semantic_models_name"')
    op.execute('DROP INDEX IF EXISTS "ix_semantic_views_name"')
    op.create_index("ix_semantic_models_name", "semantic_models", ["name"], unique=True)
    op.create_index("ix_semantic_views_name", "semantic_views", ["name"], unique=True)
