"""Add Google OAuth data-access fields to users

Revision ID: 20260410_0006
Revises: 20260410_0005
Create Date: 2026-04-10 12:30:00
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "20260410_0006"
down_revision = "20260410_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("google_oauth_email", sa.String(length=255), nullable=True))
    op.add_column("users", sa.Column("google_oauth_credentials", sa.Text(), nullable=True))
    op.add_column(
        "users",
        sa.Column(
            "google_oauth_scopes",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column("users", sa.Column("google_oauth_connected_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "google_oauth_connected_at")
    op.drop_column("users", "google_oauth_scopes")
    op.drop_column("users", "google_oauth_credentials")
    op.drop_column("users", "google_oauth_email")
