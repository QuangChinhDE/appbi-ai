"""Public links: one token authority, versioned password sessions, retired fields.

1. `dashboard_public_links.auth_version` (additive, NOT NULL DEFAULT 0) — the
   link's security generation. A password session JWT carries it and stops
   verifying when it moves (password set/changed/cleared, active toggled,
   expiry changed).

2. Legacy `dashboards.share_token` is NULLED (DATA CHANGE, deliberate).
   Migration 20260401_0019 copied every legacy token into a 'Default'
   DashboardPublicLink but left the column populated, and the public resolver
   fell back to the column when no ACTIVE link matched. Disabling or deleting
   that link therefore did not revoke the URL — it fell through to the copy and
   kept serving the report with no password, expiry or active flag.

   Since 0019 no UI wrote the column (PublicShareDialog was no longer mounted
   and the client helper was dead code), so a populated value is either the
   surviving copy of a link (active → that link still serves it; disabled or
   deleted → the owner revoked it) or a token minted by a direct API call. None
   is re-created as a link: re-creating one we cannot tell apart from a revoked
   link would be the very resurrection this closes. Owners re-share with a
   public link. The column itself stays (additive rule) and nothing reads it.

3. Retired `max_access_count` / `allowed_ips` (columns kept, no longer mapped).
   Neither was settable through the API or UI. `allowed_ips` was never
   enforced. A link that had already reached its cap is DISABLED here so its
   closed state survives the retirement instead of silently reopening.

Downgrade drops `auth_version` only; nulled tokens are not restored (restoring
them would restore the bypass).

SELF-CONTAINED — imports nothing from `app`.

Revision ID: 20261004_0001
Revises: 20261001_0001
"""
from alembic import op
import sqlalchemy as sa

revision = "20261004_0001"
down_revision = "20261001_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dashboard_public_links",
        sa.Column("auth_version", sa.Integer(), nullable=False, server_default="0"),
    )

    # Keep a capped-out link closed now that the cap is no longer enforced.
    op.execute(
        """
        UPDATE dashboard_public_links
           SET is_active = false
         WHERE max_access_count IS NOT NULL
           AND max_access_count > 0
           AND COALESCE(access_count, 0) >= max_access_count
        """
    )

    op.execute("UPDATE dashboards SET share_token = NULL WHERE share_token IS NOT NULL")


def downgrade() -> None:
    op.drop_column("dashboard_public_links", "auth_version")
