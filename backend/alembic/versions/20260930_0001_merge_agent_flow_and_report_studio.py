"""Join the combined Agent Flow + Report Experience line with Report Studio's.

WHY THIS EXISTS
---------------
`20260926_0201` (PR #6) joined Agent Flow's `20260926_0101` with Report
Experience's `20260926_0001`. Report Studio's own revisions,
`20260928_0001` (canvas -> grid) and `20260929_0001` (slicer bar -> grid),
descend from `20260926_0001`, so this branch has two heads without a second
merge. This revision performs NO schema operations.

Why not re-parent `20260928_0001` onto `20260926_0201` instead: a database
that already ran Report Studio up to `20260929_0001` would then read as past
Agent Flow's migrations and never run them. A merge keeps every recorded
database's position true.

Rollback: `alembic downgrade -1` is ambiguous at a merge point. Name the target:
`alembic downgrade 20260926_0201` undoes Report Studio's two data migrations
(their downgrades restore the rows they marked) and keeps Agent Flow's line.

SELF-CONTAINED — imports nothing from `app`.

Revision ID: 20260930_0001
Revises: 20260926_0201, 20260929_0001
"""

revision = "20260930_0001"
down_revision = ("20260926_0201", "20260929_0001")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Nothing to do — a merge only rejoins the graph."""


def downgrade() -> None:
    """Nothing to undo."""
