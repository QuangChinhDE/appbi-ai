"""Per-data-source Google connections — staging table for the consent handshake

A Google connection now belongs to a DATA SOURCE, not to the AppBI user, so two
sources can read through two different Google accounts (BigQuery on the company
account, a Sheet shared by a partner, a Google Docs connection for a team).

The consent popup finishes BEFORE a new data source has an id, so the callback
parks the freshly granted credential here and hands the opener a short-lived
`pending_id`. Saving the data source consumes that row and moves the credential
into the source's own (encrypted) config. Rows are single-use and short-lived —
an abandoned connect attempt just expires.

Revision ID: 20260806_0044
Revises: 20260806_0043
"""
from alembic import op

revision = "20260806_0044"
down_revision = "20260806_0043"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS google_oauth_pending (
            id          UUID PRIMARY KEY,
            user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
            email       VARCHAR(255) NOT NULL,
            credentials TEXT NOT NULL,
            scopes      JSON,
            created_at  TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_google_oauth_pending_user ON google_oauth_pending(user_id, created_at DESC)")


def downgrade():
    op.execute("DROP INDEX IF EXISTS idx_google_oauth_pending_user")
    op.execute("DROP TABLE IF EXISTS google_oauth_pending")
