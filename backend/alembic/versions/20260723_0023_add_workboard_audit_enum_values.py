"""Add missing workboard_* values to the ``auditaction`` PostgreSQL enum.

The Python ``AuditAction`` enum defines
workboard_created/updated/deleted/published/unpublished plus
row_inserted/updated/deleted, but the PostgreSQL ``auditaction`` enum TYPE was
never migrated to include any of them. Because audit writes are best-effort
(``audit_service.audit`` catches and swallows the error), every workboard audit
event — including the security-relevant Publish / Unpublish Live-state
transitions — has been silently discarded at the DB layer
(``DataError: invalid input value for enum auditaction: "workboard_published"``).

This backfills the enum so those events persist. Idempotent via
``ADD VALUE IF NOT EXISTS``.

Revision ID: 20260723_0023
Revises: 20260723_0022
"""
from alembic import op

revision = "20260723_0023"
down_revision = "20260723_0022"
branch_labels = None
depends_on = None

# Keep in sync with the workboard members of app.models.audit_log.AuditAction.
_WORKBOARD_ACTIONS = [
    "workboard_created",
    "workboard_updated",
    "workboard_deleted",
    "workboard_published",
    "workboard_unpublished",
    "workboard_row_inserted",
    "workboard_row_updated",
    "workboard_row_deleted",
]


def upgrade() -> None:
    # ALTER TYPE ... ADD VALUE cannot run inside a transaction block and then be
    # used within it, so run each statement in an autocommit block. IF NOT
    # EXISTS makes this safe to re-run and safe when some values already exist.
    with op.get_context().autocommit_block():
        for val in _WORKBOARD_ACTIONS:
            op.execute(f"ALTER TYPE auditaction ADD VALUE IF NOT EXISTS '{val}'")


def downgrade() -> None:
    # PostgreSQL cannot DROP a value from an enum type. No-op.
    pass
