"""Drop the dead module_permissions table (a misleading second SSOT).

Runtime module entitlements live ONLY in users.permissions (read by
core.dependencies._normalize_permissions). The module_permissions table and its
model (6 legacy keys, no `full`) were read and written by nothing - verified by
search over backend/app, scripts and frontend before this migration - but a
reader of the schema could take them for the permission model.

Data-preserving: every row (if any) is archived as JSON into
authz_impact_reports (name 'module_permissions_archive') before the drop.
Downgrade recreates the table with its original definition (20260320_0003)
and restores the archived rows. The enum types are kept (dropping them is not
needed and would complicate the downgrade).
"""
from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ENUM as PG_ENUM, UUID

revision = "20261008_0004"
down_revision = "20261008_0003"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    rows = [dict(r) for r in conn.execute(sa.text(
        "SELECT id, user_id::text AS user_id, module::text AS module, permission::text AS permission, "
        "updated_by::text AS updated_by, updated_at::text AS updated_at FROM module_permissions"
    )).mappings()]
    conn.execute(sa.text(
        "INSERT INTO authz_impact_reports (name, payload) VALUES ('module_permissions_archive', cast(:p AS jsonb))"
    ), {"p": json.dumps({"rows": rows, "count": len(rows)})})
    print(f"[authz] module_permissions archived ({len(rows)} rows) and dropped")
    op.drop_table("module_permissions")


def downgrade():
    op.create_table(
        "module_permissions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("module", PG_ENUM(name="module_enum", create_type=False), nullable=False),
        sa.Column("permission", PG_ENUM(name="module_permission_level_enum", create_type=False),
                  nullable=False, server_default="none"),
        sa.Column("updated_by", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "module", name="uq_module_permission"),
    )
    conn = op.get_bind()
    payload = conn.execute(sa.text(
        "SELECT payload FROM authz_impact_reports WHERE name = 'module_permissions_archive' ORDER BY id DESC LIMIT 1"
    )).scalar()
    for r in (payload or {}).get("rows", []):
        conn.execute(sa.text(
            "INSERT INTO module_permissions (id, user_id, module, permission, updated_by, updated_at) "
            "VALUES (:id, cast(:user_id AS uuid), cast(:module AS module_enum), "
            "cast(:permission AS module_permission_level_enum), cast(:updated_by AS uuid), cast(:updated_at AS timestamptz))"
        ), r)
