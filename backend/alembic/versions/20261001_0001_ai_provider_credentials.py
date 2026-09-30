"""Agent Flow: stored AI provider credentials.

Creates `ai_provider_credentials` — an encrypted, per-user, shareable key that an
Agent Flow step references by id — and adds `ai_credential` to the resource-share
enum so a key is shared through the same mechanism as a datasource.

Additive only: a new table and a new enum member. No existing row is touched.
Stored flow bodies are NOT rewritten; legacy steps are brought forward on read by
`contract.upgrade_body`.

SELF-CONTAINED — imports nothing from `app`.

Revision ID: 20261001_0001
Revises: 20260930_0001
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261001_0001"
down_revision = "20260930_0001"
branch_labels = None
depends_on = None

_AUDIT_VALUES = (
    "ai_credential_created",
    "ai_credential_updated",
    "ai_credential_deleted",
)


def upgrade() -> None:
    op.create_table(
        "ai_provider_credentials",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("secret_enc", sa.Text(), nullable=False),
        sa.Column("key_hint", sa.String(length=8), nullable=False, server_default=""),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "owner_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_test_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_test_ok", sa.Boolean(), nullable=True),
        sa.Column("last_test_error", sa.String(length=200), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "provider IN ('openai', 'anthropic', 'gemini')",
            name="ck_ai_provider_credentials_provider",
        ),
    )
    op.create_index("ix_ai_provider_credentials_id", "ai_provider_credentials", ["id"])
    op.create_index("ix_ai_provider_credentials_owner", "ai_provider_credentials", ["owner_id"])
    op.create_index(
        "uq_ai_provider_credentials_default",
        "ai_provider_credentials",
        ["owner_id", "provider"],
        unique=True,
        postgresql_where=sa.text("is_default AND deleted_at IS NULL"),
        sqlite_where=sa.text("is_default AND deleted_at IS NULL"),
    )
    op.create_index(
        "uq_ai_provider_credentials_owner_name",
        "ai_provider_credentials",
        ["owner_id", "name"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        sqlite_where=sa.text("deleted_at IS NULL"),
    )

    # Two Postgres enums gain members: the share type, and the audit actions for a
    # key's lifecycle. Outside the transaction (autocommit) and IF NOT EXISTS, as in
    # 20260926_0001 — a value added inside a transaction cannot be used by it, and a
    # database that already ran this on another branch must not fail.
    if op.get_bind().dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'ai_credential'")
        for val in _AUDIT_VALUES:
            op.execute(f"ALTER TYPE auditaction ADD VALUE IF NOT EXISTS '{val}'")


def downgrade() -> None:
    op.drop_index("uq_ai_provider_credentials_owner_name", table_name="ai_provider_credentials")
    op.drop_index("uq_ai_provider_credentials_default", table_name="ai_provider_credentials")
    op.drop_index("ix_ai_provider_credentials_owner", table_name="ai_provider_credentials")
    op.drop_index("ix_ai_provider_credentials_id", table_name="ai_provider_credentials")
    op.drop_table("ai_provider_credentials")
    # The enum members are left in place: Postgres cannot drop one without
    # rebuilding the type, and an unused member is harmless.
