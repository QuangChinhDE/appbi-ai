"""Backfill blank workboard slugs so legacy boards are shareable.

The public Cổng menu resolves a workboard by its ``slug`` — see
``_resolve_workboard_for_workspace`` (``in_menu = (wb.slug or "") in
configured_slugs``). A board with a NULL/blank slug can never match a menu
entry, so it 404s in the portal even when ``is_published=True``.

Boards created before slug auto-generation — or flipped to ``is_published`` by
the old ``create_public_link`` path that never generated one — carry a blank
slug and are unreachable. This backfills a unique slug for every such board
using the SAME generator the app uses at create/publish
(``WorkboardService.build_unique_slug``), so they become shareable without a
manual fix. Data-only + idempotent (a second run finds no blank slugs).

Revision ID: 20260723_0022
Revises: 20260723_0021
"""
from alembic import op
from sqlalchemy import text
from sqlalchemy.orm import Session

revision = "20260723_0022"
down_revision = "20260723_0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    blanks = bind.execute(
        text(
            "SELECT id FROM workboards "
            "WHERE slug IS NULL OR btrim(slug) = '' "
            "ORDER BY id"
        )
    ).fetchall()
    if not blanks:
        return

    # Reuse the app's slug generator (single source of truth) so backfilled
    # slugs match exactly what create/publish would produce, and its DB-backed
    # de-dupe keeps them unique. Runs on a Session bound to THIS migration's
    # connection so each freshly assigned slug is visible to the next lookup.
    from app.modules.workboards.models import Workboard
    from app.modules.workboards.services.crud_service import WorkboardService

    session = Session(bind=bind)
    try:
        for (wid,) in blanks:
            wb = session.get(Workboard, wid)
            if wb is None or (wb.slug or "").strip():
                continue
            wb.slug = WorkboardService.build_unique_slug(
                session, wb.name, exclude_id=wb.id
            )
            session.add(wb)
            session.flush()
    finally:
        session.close()


def downgrade() -> None:
    # Slugs are content, not schema — there is nothing to reverse and no way to
    # know which slugs were blank before. No-op.
    pass
