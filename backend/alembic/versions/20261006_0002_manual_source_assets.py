"""Manual sources: file assets table (Parquet-backed uploaded sheets).

Additive: creates `manual_source_assets`. Existing manual sources keep their
inline `config['sheets'][*]['rows']` and keep reading through the legacy path;
they are moved to assets lazily (on update) or explicitly by
`python -m app.scripts.migrate_manual_sources_to_assets`. No data migration here
(file writes inside a schema migration are not transactional).

Downgrade drops the table. Sources already converted to assets then lose their
data reference — run downgrade only before any source was converted.

SELF-CONTAINED — imports nothing from `app`.

Revision ID: 20261006_0002
Revises: 20261006_0001
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261006_0002"
down_revision = "20261006_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "manual_source_assets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "datasource_id", sa.Integer(),
            sa.ForeignKey("data_sources.id", ondelete="CASCADE"), nullable=True,
        ),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("sheet_name", sa.String(255), nullable=False),
        sa.Column("storage_key", sa.String(255), nullable=False, unique=True),
        sa.Column("original_filename", sa.String(255), nullable=True),
        sa.Column("media_type", sa.String(100), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("columns", sa.JSON(), nullable=False),
        sa.Column("row_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_manual_source_assets_datasource_id", "manual_source_assets", ["datasource_id"])
    op.create_index("ix_manual_source_assets_owner_id", "manual_source_assets", ["owner_id"])
    op.create_index("ix_manual_source_assets_expires_at", "manual_source_assets", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_manual_source_assets_expires_at", table_name="manual_source_assets")
    op.drop_index("ix_manual_source_assets_owner_id", table_name="manual_source_assets")
    op.drop_index("ix_manual_source_assets_datasource_id", table_name="manual_source_assets")
    op.drop_table("manual_source_assets")
