"""A stable numeric identity per flow, for links.

WHY A COLUMN AND NOT `MIN(id)`
------------------------------
`agent_brain_versions.id` is a per-VERSION key: a flow with five saves has five
of them, and the newest changes on every save, so it cannot be what a link points
at. The obvious cheap substitute — "the smallest id sharing this brain_key" —
computes the same answer right up until somebody deletes v1, at which point every
link ever shared for that flow silently opens a different flow or 404s.

Storing it removes that class of failure entirely: assigned once, carried by every
later version of the same key, and unaffected by deleting any version.

`brain_key` remains the identity everything server-side uses (shares, bindings,
runs, permissions). This is an ALIAS for the address bar, resolved back to the key
on the way in — so nothing downstream has to learn about it.

Backfill uses MIN(id) per key, which is exact at this moment because no version
has been deleted between the two statements in the same transaction, and is frozen
from here on because it is written down.
"""
from alembic import op
import sqlalchemy as sa

revision = "20260814_0045"
down_revision = "20260813_0044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_brain_versions",
        sa.Column("flow_id", sa.Integer(), nullable=True),
    )
    op.execute(
        """
        UPDATE agent_brain_versions AS v
           SET flow_id = s.first_id
          FROM (SELECT brain_key, MIN(id) AS first_id
                  FROM agent_brain_versions
                 GROUP BY brain_key) AS s
         WHERE v.brain_key = s.brain_key
        """
    )
    op.create_index(
        "ix_agent_brain_flow_id", "agent_brain_versions", ["flow_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_agent_brain_flow_id", table_name="agent_brain_versions")
    op.drop_column("agent_brain_versions", "flow_id")
