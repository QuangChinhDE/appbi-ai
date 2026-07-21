"""embed integration: clients, grants, nonces + public-link filter_hash

Machine-to-machine embedding: external systems mint short-lived, rotating
opaque embed links (Bearer-token request) that resolve to a managed, deduped
DashboardPublicLink without exposing that link's own token.

Revision ID: 20260720_0017
Revises: 20260719_0016
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "20260720_0017"
down_revision = "20260719_0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Managed-link dedup key on the existing public-links table (additive).
    op.add_column(
        "dashboard_public_links",
        sa.Column("filter_hash", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "ix_dashboard_public_links_filter_hash",
        "dashboard_public_links",
        ["filter_hash"],
    )
    # Partial unique: one link per (dashboard, filter set) for embed-API links.
    op.create_index(
        "uq_public_link_embed_dedupe",
        "dashboard_public_links",
        ["dashboard_id", "filter_hash"],
        unique=True,
        postgresql_where=sa.text("source = 'embed_api' AND filter_hash IS NOT NULL"),
    )

    # 2. Trusted external systems (Bearer-token clients; only token_hash stored).
    op.create_table(
        "integration_clients",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("allowed_dashboards", sa.JSON(), nullable=True),
        sa.Column("allowed_ips", sa.JSON(), nullable=True),
        sa.Column("allowed_origins", sa.JSON(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("max_ttl_seconds", sa.Integer(), nullable=False, server_default="3600"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_integration_clients_token_hash", "integration_clients", ["token_hash"], unique=True)

    # 3. Rotating opaque embed grants (only the hash is stored).
    op.create_table(
        "embed_grants",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("link_id", sa.Integer(), sa.ForeignKey("dashboard_public_links.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("client_id", UUID(as_uuid=True), sa.ForeignKey("integration_clients.id", ondelete="SET NULL"), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("use_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_embed_grants_token_hash", "embed_grants", ["token_hash"], unique=True)
    op.create_index("ix_embed_grants_link_id", "embed_grants", ["link_id"])
    op.create_index("ix_embed_grants_expires_at", "embed_grants", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_embed_grants_expires_at", table_name="embed_grants")
    op.drop_index("ix_embed_grants_link_id", table_name="embed_grants")
    op.drop_index("ix_embed_grants_token_hash", table_name="embed_grants")
    op.drop_table("embed_grants")

    op.drop_index("ix_integration_clients_token_hash", table_name="integration_clients")
    op.drop_table("integration_clients")

    op.drop_index("uq_public_link_embed_dedupe", table_name="dashboard_public_links")
    op.drop_index("ix_dashboard_public_links_filter_hash", table_name="dashboard_public_links")
    op.drop_column("dashboard_public_links", "filter_hash")
