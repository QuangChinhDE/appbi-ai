"""dashboard_public_links: draft/published staging for workboard-managed links

Slice 2 (dashboard-link staging). A workboard dashboard screen provisions a
managed DashboardPublicLink per (screen, role). Until now there was ONE shared
set that draft autosave freely GC-deleted/repointed — the exact rows Live users
embed. This adds a ``stage`` dimension so draft autosave only touches
stage='draft' rows while the LIVE runtime resolves stage='published' rows; Publish
promotes draft → published.

Existing managed links are the rows Live currently uses → backfilled to
'published'. A partial unique index on (name, stage) WHERE source='workboard'
lets the draft + published sets coexist without duplicates. Additive;
'user'/'embed_api' links default 'published' (no draft concept).

Revision ID: 20260723_0021
Revises: 20260723_0020
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260723_0021"
down_revision = "20260723_0020"
branch_labels = None
depends_on = None


def _has_column(table: str, col: str) -> bool:
    try:
        return any(c["name"] == col for c in inspect(op.get_bind()).get_columns(table))
    except Exception:
        return False


def upgrade() -> None:
    if not _has_column("dashboard_public_links", "stage"):
        op.add_column(
            "dashboard_public_links",
            sa.Column(
                "stage",
                sa.String(16),
                nullable=False,
                server_default="published",
            ),
        )
    # Existing rows are the current Live set → 'published' (server_default already
    # applies; explicit for any pre-existing NULLs).
    op.execute("UPDATE dashboard_public_links SET stage = 'published' WHERE stage IS NULL")
    op.create_index(
        "ix_dpl_stage",
        "dashboard_public_links",
        ["stage"],
        if_not_exists=True,
    )
    # Managed (workboard) links: one row per (name, stage) so draft + published
    # coexist and sync/promote stay idempotent.
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_dpl_workboard_name_stage
        ON dashboard_public_links (name, stage)
        WHERE source = 'workboard'
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_dpl_workboard_name_stage")
    op.drop_index("ix_dpl_stage", table_name="dashboard_public_links", if_exists=True)
    if _has_column("dashboard_public_links", "stage"):
        op.drop_column("dashboard_public_links", "stage")
