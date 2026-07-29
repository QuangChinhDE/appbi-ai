"""embed_grants.header: caller-supplied title for an embedded report

POST /integrations/embed/resolve now accepts `header`. Without it the embedded
report showed the managed link's internal name (e.g. "embed:71:a7fa6994") as its
title — an implementation detail in front of a business reader.

The column sits on the GRANT rather than on dashboard_public_links because
managed links are deduped by filter set: two host apps embedding the same data
slice under different titles must not overwrite each other.

Additive + nullable → existing grants keep the old fallback behaviour.

Revision ID: 20260729_0029
Revises: 20260729_0028
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260729_0029"
down_revision = "20260729_0028"
branch_labels = None
depends_on = None

TABLE = "embed_grants"
COLUMN = "header"


def _has_column(table: str, col: str) -> bool:
    try:
        return any(c["name"] == col for c in inspect(op.get_bind()).get_columns(table))
    except Exception:
        return False


def upgrade() -> None:
    if not _has_column(TABLE, COLUMN):
        op.add_column(TABLE, sa.Column(COLUMN, sa.String(length=200), nullable=True))


def downgrade() -> None:
    if _has_column(TABLE, COLUMN):
        op.drop_column(TABLE, COLUMN)
