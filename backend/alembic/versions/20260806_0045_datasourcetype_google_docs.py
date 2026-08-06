"""Add 'google_docs' to the datasourcetype enum

`data_sources.type` is a Postgres ENUM, so a new Python enum member is not
enough — inserting or filtering by 'google_docs' fails with
InvalidTextRepresentation until the type itself knows the value.

Separate from 0044 on purpose: Postgres refuses to USE a newly added enum value
in the same transaction that added it, so this stands alone and nothing here
references the value.

Revision ID: 20260806_0045
Revises: 20260806_0044
"""
from alembic import op

revision = "20260806_0045"
down_revision = "20260806_0044"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TYPE datasourcetype ADD VALUE IF NOT EXISTS 'google_docs'")


def downgrade():
    # Postgres cannot drop a value from an enum; leaving it is harmless because
    # nothing selects it once the feature is gone.
    pass
