"""dashboards.import_idempotency_key: a repeated HTML-import build returns the first

POST /dashboards/import-html/build was not idempotent: a retried request (a
client timeout, an MCP tool call replayed) created a second dashboard named
"Name (2)" with a second set of charts. The build now accepts an
``idempotency_key``; the dashboard it created carries it, and a repeat by the
same owner with the same key returns that dashboard.

A column on the dashboard rather than a key inside an existing JSON config:
``canvas_config`` / ``theme_config`` are served, duplicated and exported, so a
key there would be copied onto every duplicate; and only a unique index makes
two concurrent repeats unable to both create.

Additive, nullable: every existing dashboard reads NULL (no key). Partial
unique index on (owner_id, import_idempotency_key) where the key is set.

Revision ID: 20261014_0001
Revises: 20261012_0001
Create Date: 2026-10-14
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20261014_0001"
down_revision: Union[str, None] = "20261012_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("dashboards", sa.Column("import_idempotency_key", sa.String(128), nullable=True))
    op.create_index(
        "uq_dashboards_owner_import_key",
        "dashboards",
        ["owner_id", "import_idempotency_key"],
        unique=True,
        postgresql_where=sa.text("import_idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_dashboards_owner_import_key", table_name="dashboards")
    op.drop_column("dashboards", "import_idempotency_key")
