"""widen workboard_auto_number_sequences.bucket 32 -> 128

Scoped auto-number rules (``AutoNumberConfig.scope_columns`` / ``date_column``)
append a ``"|s|<sha256>"`` digest of the scope-column values to the reset-period
key so each distinct scope counts independently. That no longer fits the old
32-char ``bucket`` column, so widen it to 128.

Fully backward-compatible: existing (unscoped) buckets are short strings that
remain valid, and the widening never rewrites or invalidates any row.

Revision ID: 20260728_0026
Revises: 20260727_0025
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260728_0026"
down_revision = "20260727_0025"
branch_labels = None
depends_on = None

TABLE = "workboard_auto_number_sequences"
COLUMN = "bucket"


def _column_type_len(table: str, column: str):
    try:
        insp = inspect(op.get_bind())
        for col in insp.get_columns(table):
            if col.get("name") == column:
                return getattr(col.get("type"), "length", None)
    except Exception:
        return None
    return None


def upgrade() -> None:
    # No-op if the table is absent or the column is already wide enough.
    length = _column_type_len(TABLE, COLUMN)
    if length is not None and length >= 128:
        return
    op.alter_column(
        TABLE,
        COLUMN,
        existing_type=sa.String(length=32),
        type_=sa.String(length=128),
        existing_nullable=False,
    )


def downgrade() -> None:
    # Narrowing could truncate scoped buckets — refuse rather than corrupt.
    op.alter_column(
        TABLE,
        COLUMN,
        existing_type=sa.String(length=128),
        type_=sa.String(length=32),
        existing_nullable=False,
    )
