"""Remove the AI Flow module.

The module is being rebuilt from scratch, so its code is gone and these tables
have no reader left. Dropping them here rather than leaving them behind: an empty
table with no model is worse than no table — the next person reads it as a feature
that exists, and a rebuilt module would inherit a schema nobody chose.

WHY THE FIVE MIGRATIONS THAT CREATED THEM ARE STILL IN THE TREE
--------------------------------------------------------------
0034 through 0038 built this module up. Deleting those files would be tidier to
read and wrong to ship: every database already stamped at one of them would fail
`alembic upgrade head` with "Can't locate revision", including the demo database
sitting at 0038 right now. Migrations are an append-only ledger — the module was
added, then it was removed, and that is what the chain should say.

Nothing is preserved. There is no down-migration data path: the flows, runs and
model policies described a design that was rejected, and recreating empty tables
on downgrade is the honest inverse of dropping them.
"""
from alembic import op

revision = "20260810_0039"
down_revision = "20260809_0038"
branch_labels = None
depends_on = None


#: Order matters: ai_node_runs references ai_runs.
_TABLES = ("ai_node_runs", "ai_runs", "ai_flow_versions", "ai_model_policies")


def upgrade() -> None:
    for table in _TABLES:
        # IF EXISTS because a database created after the module was deleted never
        # ran 0034 against live code paths — and a migration that only works on
        # one history is a migration that breaks a fresh deploy.
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")


def downgrade() -> None:
    # Deliberately empty. The tables belong to a module that no longer exists, so
    # there is nothing meaningful to restore; re-running 0034–0038 forward is the
    # only path that would recreate them, and that design was discarded.
    pass
