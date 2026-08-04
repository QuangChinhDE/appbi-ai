"""Flow Studio: flow metadata (description / owner / tags)

Needed by the review flow: a reviewer deciding on a publish wants to know what
the flow is for and who owns it, and the list screen needs something to filter
on beyond the key.

Additive and nullable — existing rows keep working untouched.

Revision ID: 20260807_0036
Revises: 20260806_0035
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260807_0036"
down_revision = "20260806_0035"
branch_labels = None
depends_on = None

COLUMNS = (
    ("description", sa.Text()),
    ("owner", sa.String(length=128)),
    ("tags", sa.JSON()),
)


def _has_column(table: str, col: str) -> bool:
    try:
        return any(c["name"] == col for c in inspect(op.get_bind()).get_columns(table))
    except Exception:
        return False


def _has_table(name: str) -> bool:
    try:
        return name in inspect(op.get_bind()).get_table_names()
    except Exception:
        return False


def upgrade() -> None:
    if not _has_table("ai_flow_versions"):
        return
    for col, coltype in COLUMNS:
        if not _has_column("ai_flow_versions", col):
            op.add_column("ai_flow_versions", sa.Column(col, coltype, nullable=True))
    # Existing rows get an empty tag list so the API never has to cope with NULL.
    op.execute("UPDATE ai_flow_versions SET tags = '[]'::json WHERE tags IS NULL")


def downgrade() -> None:
    if not _has_table("ai_flow_versions"):
        return
    for col, _ in COLUMNS:
        if _has_column("ai_flow_versions", col):
            op.drop_column("ai_flow_versions", col)
