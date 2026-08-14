"""Join the two migration branches so `alembic upgrade head` has one target.

WHY THIS EXISTS
---------------
The history had forked before today: `20260811_0041` chains off
`20260810_0040`, while `20260810_0052` chains off `20260809_0051`. Two heads,
and the container's entrypoint runs `alembic upgrade head` on every start — so
the moment a second head became reachable, startup failed with "Multiple head
revisions are present" and the backend went into a restart loop.

A merge revision is the standard remedy and the least invasive one: it performs
NO schema operations. It only records that both lines are now one, so `head`
resolves to a single revision again.

WHAT THIS DOES NOT FIX
----------------------
Whether this database has actually RUN the operations on either branch. It has
not: it was stamped at `20260810_0052` while carrying tables created by
`20260811_0041` and `20260812_0042`, which means the schema here was built
outside alembic at some point. That is a real deployment-consistency problem and
it is not something a merge can decide — running the unapplied revisions against
a database that already has their tables is a separate, deliberate operation.

SELF-CONTAINED — imports nothing from `app`.

Revision ID: 20260813_0044
Revises: 20260810_0052, 20260813_0043
"""

revision = "20260813_0044"
down_revision = ("20260810_0052", "20260813_0043")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Nothing to do — a merge only rejoins the graph."""


def downgrade() -> None:
    """Nothing to undo."""
