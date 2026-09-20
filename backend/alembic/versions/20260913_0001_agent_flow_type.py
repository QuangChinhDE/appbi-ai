"""A flow declares which surface it was built for, instead of it being inferred.

WHY A TYPE AND NOT THE BOOLEAN IT REPLACES
------------------------------------------
`direct_chat_enabled` answered "may this also be opened in Chat?" — a permission
question. What the product actually needs is a different one: "which surface was
this flow WRITTEN for?", because the two surfaces hand a flow different things.

    bot   the viewer is anonymous and on a report, so `dashboard_id` and the
          link's filters ALWAYS arrive. A step may assume there is a report.
    chat  the reader is signed in and typing, so only text arrives. Nothing
          supplies "the report", and a step that assumes one reads a field that
          is not there.

That makes cross-assignment a type error rather than a policy violation, which is
why it is now refused on both sides rather than checked on one.

The boolean is DROPPED rather than kept alongside. Two columns describing one fact
is how they come to disagree — and the second reader always finds the stale one.

Revision ID: 20260913_0001
Revises: 20260911_0002
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260913_0001"
down_revision: Union[str, None] = "20260911_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent_brain_versions",
        sa.Column(
            "flow_type",
            sa.String(length=8),
            nullable=False,
            server_default="bot",
        ),
    )
    # EVERY EXISTING FLOW IS A BOT, except the ones already opted into Chat. That
    # is not a guess: the creation path has always seeded `report_read → agent`,
    # so a flow that never opted in was written against a report by construction.
    op.execute(
        "UPDATE agent_brain_versions SET flow_type = 'chat' "
        "WHERE direct_chat_enabled IS TRUE"
    )
    op.drop_column("agent_brain_versions", "direct_chat_enabled")
    op.create_index(
        "ix_agent_brain_versions_flow_type", "agent_brain_versions", ["flow_type"]
    )


def downgrade() -> None:
    op.drop_index("ix_agent_brain_versions_flow_type", table_name="agent_brain_versions")
    op.add_column(
        "agent_brain_versions",
        sa.Column(
            "direct_chat_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.execute(
        "UPDATE agent_brain_versions SET direct_chat_enabled = TRUE "
        "WHERE flow_type = 'chat'"
    )
    op.drop_column("agent_brain_versions", "flow_type")
