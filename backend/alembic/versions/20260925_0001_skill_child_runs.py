"""A run can be the child of another run; a step records what it could see.

WHY
---
A Skill is a published flow invoked by another flow — as an Agent capability, a
Skill step, or inside a coordinator lane — and it runs as a REAL run of its own:
its own row, its own steps, its own version. A debugger then has to answer
"which run, which step and which capability created this child?", so the child
carries its parent explicitly:

    parent_run_key   the parent's `run_key` — known the moment the parent turn
                     starts, so a child that finishes mid-turn can record itself
                     before the parent's row exists, and the link survives a
                     parent turn the viewer abandoned
    parent_step_key  the node in the parent that invoked it
    invoked_as       agent_capability | skill_node | coordinator_lane

NULL on every existing row, which is exactly what they are: top-level runs.

`agent_flow_run_steps.capability_trace` is an Agent step's capability view —
granted, eligible, shown per round, discovered, invoked, rejected — the data
behind "What the AI sees" for a run that already happened. NULL for every other
node type and every existing row.

Additive only: three nullable string columns, one nullable JSONB column, one index.

Revision ID: 20260925_0001
Revises: 20260914_0002
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260925_0001"
down_revision: Union[str, None] = "20260914_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("agent_flow_runs", sa.Column("parent_run_key", sa.String(length=64), nullable=True))
    op.add_column("agent_flow_runs", sa.Column("parent_step_key", sa.String(length=64), nullable=True))
    op.add_column("agent_flow_runs", sa.Column("invoked_as", sa.String(length=24), nullable=True))
    op.create_index("ix_agent_flow_runs_parent_run_key", "agent_flow_runs", ["parent_run_key"])
    op.add_column(
        "agent_flow_run_steps",
        sa.Column("capability_trace", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_flow_run_steps", "capability_trace")
    op.drop_index("ix_agent_flow_runs_parent_run_key", table_name="agent_flow_runs")
    op.drop_column("agent_flow_runs", "invoked_as")
    op.drop_column("agent_flow_runs", "parent_step_key")
    op.drop_column("agent_flow_runs", "parent_run_key")
