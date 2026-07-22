"""workboards: draft/published separation (published snapshot columns)

Adds the minimum production-safe Draft → Publish lifecycle to ``workboards``:

  * ``published_layout_json`` (JSONB, nullable) — the immutable LIVE snapshot
    the public runtime serves. ``layout_json`` stays the mutable DRAFT the
    builder/autosave writes. NULL ⇒ never published ⇒ runtime refuses to serve.
  * ``published_version`` (int, nullable) — the draft ``version`` captured at
    publish time. draft ``version`` > ``published_version`` ⇒ unpublished changes.
  * ``published_at`` (timestamptz, nullable) — when the last publish happened.

Backfill: every currently-published board (``is_published = true``) gets its
existing ``layout_json`` promoted into ``published_layout_json`` so live apps
keep serving exactly what they serve today — the change is invisible until the
next edit-then-publish cycle. Additive + backward-compatible; each step guarded
so it is safe to re-run.

Revision ID: 20260722_0019
Revises: 20260721_0018
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import JSONB

revision = "20260722_0019"
down_revision = "20260721_0018"
branch_labels = None
depends_on = None


def _insp():
    return inspect(op.get_bind())


def _has_column(table: str, col: str) -> bool:
    try:
        return any(c["name"] == col for c in _insp().get_columns(table))
    except Exception:
        return False


def upgrade() -> None:
    if not _has_column("workboards", "published_layout_json"):
        op.add_column(
            "workboards",
            sa.Column("published_layout_json", JSONB(), nullable=True),
        )
    if not _has_column("workboards", "published_version"):
        op.add_column(
            "workboards",
            sa.Column("published_version", sa.Integer(), nullable=True),
        )
    if not _has_column("workboards", "published_at"):
        op.add_column(
            "workboards",
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        )

    # Backfill currently-published boards so the live runtime keeps serving what
    # it serves today. Only touch rows that haven't been backfilled yet.
    op.execute(
        """
        UPDATE workboards
           SET published_layout_json = layout_json,
               published_version     = COALESCE(version, 1),
               published_at          = COALESCE(updated_at, now())
         WHERE is_published = true
           AND published_layout_json IS NULL
        """
    )


def downgrade() -> None:
    for col in ("published_at", "published_version", "published_layout_json"):
        if _has_column("workboards", col):
            op.drop_column("workboards", col)
