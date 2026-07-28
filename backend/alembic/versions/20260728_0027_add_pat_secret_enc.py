"""add personal_access_tokens.secret_enc (reversible reveal)

Stores the token secret reversibly-encrypted (Fernet, key held in app env, never
in the DB) so the owner — and a settings=full admin — can reveal the full token
again after creation. A DB-only leak yields ciphertext only. Nullable: existing
tokens (and deployments with no encryption key) have no secret_enc and cannot be
revealed — they must be rotated/recreated instead.

Revision ID: 20260728_0027
Revises: 20260728_0026
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260728_0027"
down_revision = "20260728_0026"
branch_labels = None
depends_on = None

TABLE = "personal_access_tokens"
COLUMN = "secret_enc"


def _has_column(table: str, column: str) -> bool:
    try:
        insp = inspect(op.get_bind())
        return any(c.get("name") == column for c in insp.get_columns(table))
    except Exception:
        return False


def upgrade() -> None:
    if not _has_column(TABLE, COLUMN):
        op.add_column(TABLE, sa.Column(COLUMN, sa.String(), nullable=True))


def downgrade() -> None:
    if _has_column(TABLE, COLUMN):
        op.drop_column(TABLE, COLUMN)
