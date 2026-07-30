"""Embed origin allowlist: restrict which sites may iframe an embed link

Two additive columns:

* ``personal_access_tokens.embed_allowed_origins`` — the DECLARATION. A host app
  states its domains once (on any /integrations/embed/resolve call, or an admin
  sets it) and every link that token mints afterwards is bound to them.
* ``embed_grants.allowed_origins`` — a SNAPSHOT taken when the link is minted, so
  the guard that runs on every iframe load is a single row read by token, and an
  already-issued link keeps the policy it was issued under.

Both nullable → NULL/[] means unrestricted, i.e. exactly today's behaviour.
Enforcement only exists for tokens that opted in by declaring origins.

Revision ID: 20260730_0031
Revises: 20260729_0030
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql

revision = "20260730_0031"
down_revision = "20260729_0030"
branch_labels = None
depends_on = None

COLUMNS = (
    ("personal_access_tokens", "embed_allowed_origins"),
    ("embed_grants", "allowed_origins"),
)


def _has_column(table: str, col: str) -> bool:
    try:
        return any(c["name"] == col for c in inspect(op.get_bind()).get_columns(table))
    except Exception:
        return False


def upgrade() -> None:
    for table, col in COLUMNS:
        if not _has_column(table, col):
            op.add_column(table, sa.Column(col, postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    for table, col in COLUMNS:
        if _has_column(table, col):
            op.drop_column(table, col)
