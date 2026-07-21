"""embed: switch M2M auth from HMAC integration-clients to PAT

Converts the schema created by 20260720_0017 (HMAC integration clients) to the
PAT-authenticated model:
  * embed_grants records the minting user (`created_by` -> users) instead of an
    integration client (`client_id`).
  * the HMAC-only tables `integration_clients` and `integration_nonces` are
    dropped (PAT auth needs no client registry or replay-nonce store).

`dashboard_public_links.filter_hash` (added by 0017) is kept as-is — both the
HMAC and PAT flows use it to dedupe managed embed links.

Each step is guarded by an existence check so this migration is safe to run on
a DB already at 0017-HMAC state (report-demo) as well as on a fresh build.

Revision ID: 20260721_0018
Revises: 20260720_0017
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import UUID

revision = "20260721_0018"
down_revision = "20260720_0017"
branch_labels = None
depends_on = None


def _insp():
    return inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return _insp().has_table(name)


def _has_column(table: str, col: str) -> bool:
    try:
        return any(c["name"] == col for c in _insp().get_columns(table))
    except Exception:
        return False


def upgrade():
    # embed_grants: created_by (PAT user) replaces client_id (HMAC client).
    if _has_table("embed_grants"):
        if not _has_column("embed_grants", "created_by"):
            op.add_column(
                "embed_grants",
                sa.Column(
                    "created_by",
                    UUID(as_uuid=True),
                    sa.ForeignKey("users.id", ondelete="SET NULL"),
                    nullable=True,
                ),
            )
        if _has_column("embed_grants", "client_id"):
            # In Postgres dropping the column also drops its FK constraint.
            op.drop_column("embed_grants", "client_id")

    # HMAC-only tables are unused under PAT auth.
    if _has_table("integration_nonces"):
        op.drop_table("integration_nonces")
    if _has_table("integration_clients"):
        op.drop_table("integration_clients")


def downgrade():
    # Recreate the HMAC structures (best-effort; grant/client data is not restored).
    if not _has_table("integration_clients"):
        op.create_table(
            "integration_clients",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("key_id", sa.String(length=64), nullable=False),
            sa.Column("secret_enc", sa.String(length=512), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("allowed_dashboards", sa.JSON(), nullable=True),
            sa.Column("allowed_ips", sa.JSON(), nullable=True),
            sa.Column("allowed_origins", sa.JSON(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("max_ttl_seconds", sa.Integer(), nullable=False, server_default="3600"),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_integration_clients_key_id", "integration_clients", ["key_id"], unique=True)

    if not _has_table("integration_nonces"):
        op.create_table(
            "integration_nonces",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("client_id", UUID(as_uuid=True), nullable=False),
            sa.Column("nonce", sa.String(length=128), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.UniqueConstraint("client_id", "nonce", name="uq_integration_nonce_client_nonce"),
        )
        op.create_index("ix_integration_nonces_client_id", "integration_nonces", ["client_id"])
        op.create_index("ix_integration_nonces_expires_at", "integration_nonces", ["expires_at"])

    if _has_table("embed_grants"):
        if not _has_column("embed_grants", "client_id"):
            op.add_column(
                "embed_grants",
                sa.Column(
                    "client_id",
                    UUID(as_uuid=True),
                    sa.ForeignKey("integration_clients.id", ondelete="SET NULL"),
                    nullable=True,
                ),
            )
        if _has_column("embed_grants", "created_by"):
            op.drop_column("embed_grants", "created_by")
