"""workboards: published_runtime_config snapshot (non-layout deployment boundary)

Slice 2 of the Draft/Published isolation. Adds a typed, versioned
``published_runtime_config`` JSONB that freezes the NON-layout Live config at
Publish so the public runtime stops reading the mutable workboard columns:

  {schema_version, binding{dataset_id, primary_table_id, primary_key_columns,
   lookup_tables}, write{write_mode, optimistic_lock_column},
   integrations{webhooks}}

Backfills every currently-published board from its present mutable columns so
existing Live apps are isolated immediately (not only on their next Publish).
Additive + backward-compatible; the resolver falls back to the live columns when
this is NULL, so nothing breaks pre-backfill.

Revision ID: 20260723_0020
Revises: 20260722_0019
"""
import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import JSONB

revision = "20260723_0020"
down_revision = "20260722_0019"
branch_labels = None
depends_on = None


def _has_column(table: str, col: str) -> bool:
    try:
        return any(c["name"] == col for c in inspect(op.get_bind()).get_columns(table))
    except Exception:
        return False


def upgrade() -> None:
    if not _has_column("workboards", "published_runtime_config"):
        op.add_column(
            "workboards",
            sa.Column("published_runtime_config", JSONB(), nullable=True),
        )

    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, dataset_id, primary_table_id, primary_key_columns, "
            "lookup_tables, write_mode, optimistic_lock_column, settings "
            "FROM workboards "
            "WHERE is_published = true AND published_runtime_config IS NULL"
        )
    ).mappings().all()

    for r in rows:
        settings = r["settings"] if isinstance(r["settings"], dict) else {}
        webhooks = settings.get("webhooks")
        cfg = {
            "schema_version": 1,
            "binding": {
                "dataset_id": r["dataset_id"],
                "primary_table_id": r["primary_table_id"],
                "primary_key_columns": list(r["primary_key_columns"] or []),
                "lookup_tables": list(r["lookup_tables"] or []),
            },
            "write": {
                "write_mode": r["write_mode"],
                "optimistic_lock_column": r["optimistic_lock_column"],
            },
            "integrations": {
                "webhooks": webhooks if isinstance(webhooks, list) else [],
            },
        }
        conn.execute(
            sa.text(
                "UPDATE workboards SET published_runtime_config = CAST(:cfg AS jsonb) "
                "WHERE id = :id"
            ),
            {"cfg": json.dumps(cfg), "id": r["id"]},
        )


def downgrade() -> None:
    if _has_column("workboards", "published_runtime_config"):
        op.drop_column("workboards", "published_runtime_config")
