"""Audit values for privileged authorization actions.

The authz remediation made several actions privileged on their own (dataset
grant/revoke, alert-channel management and the global scan, workspace token
rotation, public-link changes, share edits). Each one is now written to the
audit trail. Additive: new ``auditaction`` enum values, idempotent via
``ADD VALUE IF NOT EXISTS``.

Revision ID: 20261008_0006
Revises: 20261008_0005
"""
from alembic import op

revision = "20261008_0006"
down_revision = "20261008_0005"
branch_labels = None
depends_on = None

_VALUES = [
    "dataset_grant_created",
    "dataset_grant_revoked",
    "alert_channel_created",
    "alert_channel_updated",
    "alert_channel_deleted",
    "alert_channel_tested",
    "observability_global_scan",
    "workspace_token_rotated",
    "public_link_updated",
    "share_updated",
]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        for val in _VALUES:
            op.execute(f"ALTER TYPE auditaction ADD VALUE IF NOT EXISTS '{val}'")


def downgrade() -> None:
    # PostgreSQL cannot drop an enum value. No-op.
    pass
