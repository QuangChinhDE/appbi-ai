"""add audit_logs table

Revision ID: 20260401_0022
Revises: 20260401_0021
Create Date: 2026-04-01 13:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

# revision identifiers, used by Alembic.
revision = "20260401_0022"
down_revision = "20260401_0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create enum types
    audit_action = sa.Enum(
        "login_success", "login_failed", "logout", "token_refreshed",
        "password_changed", "permission_denied",
        "user_created", "user_deactivated", "user_permissions_changed",
        "public_link_created", "public_link_accessed", "public_link_deleted",
        "share_created", "share_revoked",
        "datasource_connected", "data_exported",
        name="auditaction",
    )
    audit_severity = sa.Enum("info", "warning", "critical", name="auditseverity")

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("timestamp", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=True),
        sa.Column("ip_address", sa.String(45), nullable=True),
        sa.Column("user_agent", sa.String(512), nullable=True),
        sa.Column("action", audit_action, nullable=False),
        sa.Column("resource_type", sa.String(64), nullable=True),
        sa.Column("resource_id", sa.String(64), nullable=True),
        sa.Column("details", JSONB, nullable=True),
        sa.Column("severity", audit_severity, nullable=False, server_default="info"),
    )
    op.create_index("ix_audit_logs_timestamp", "audit_logs", ["timestamp"])
    op.create_index("ix_audit_logs_user_id", "audit_logs", ["user_id"])
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])


def downgrade() -> None:
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_index("ix_audit_logs_user_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_timestamp", table_name="audit_logs")
    op.drop_table("audit_logs")
    sa.Enum(name="auditaction").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="auditseverity").drop(op.get_bind(), checkfirst=True)
