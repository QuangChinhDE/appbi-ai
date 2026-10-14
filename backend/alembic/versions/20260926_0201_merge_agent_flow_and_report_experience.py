"""Join Agent Flow's line and the Report Experience line so `head` is one target.

WHY THIS EXISTS
---------------
Both streams branch off `20260914_0002`. Agent Flow (merged into demo first)
ends at `20260926_0101`; Report Experience adds `20260926_0001` (content proposal
audit values). Without a merge, demo would carry two heads the moment this
branch lands, and the entrypoint's `alembic upgrade head` would refuse to start.

It performs NO schema operations — it only records that both lines are one. The
later Report Studio revisions (`20260928_0001`, `20260929_0001`) keep their
parents; they are joined again by `20260930_0001` on that branch. Re-parenting
them onto this merge instead would let a database already at `20260929_0001`
skip Agent Flow's migrations.

Rollback: `alembic downgrade -1` is ambiguous at a merge point. Name the target:
`alembic downgrade 20260926_0101` leaves Agent Flow's line, undoing Report
Experience's; `alembic downgrade 20260926_0001` does the reverse.

SELF-CONTAINED — imports nothing from `app`.

Revision ID: 20260926_0201
Revises: 20260926_0101, 20260926_0001
"""

revision = "20260926_0201"
down_revision = ("20260926_0101", "20260926_0001")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Nothing to do — a merge only rejoins the graph."""


def downgrade() -> None:
    """Nothing to undo."""
