"""A Skill version can be stopped; a step records where its budget went.

WHY
---
Pinning makes a published parent run the EXACT Skill version it was published
with — reproducibility. It must not also mean "runs forever whatever happens to
it": a version with a security, data-access, compliance or logic defect has to be
stoppable without rewriting every parent that pinned it, and without silently
moving them to a newer version. So a version carries a LIFECYCLE, separate from
its publication `status` (draft | published | archived), and checked at every
invocation:

    lifecycle            NULL / active | deprecated | disabled
                         deprecated  existing pins keep running, with a notice;
                                     nothing new may pin it
                         disabled    refused at invocation, pinned or not
    lifecycle_reason     why — shown to whoever hits the refusal
    lifecycle_by / _at   who changed it, and when

The version body is untouched: a stopped version is still readable, so its
history (and every run that used it) stays explainable.

`agent_flow_run_steps.budget` is a step's budget ledger: model/tool calls spent,
what it had available when it started, and what it was made to leave for the
steps after it.

Additive only: four nullable columns on `agent_brain_versions`, one nullable
JSONB column on `agent_flow_run_steps`. NULL on every existing row means exactly
what those rows are: active versions, steps recorded before ledgers existed.

Revision ID: 20260926_0001
Revises: 20260925_0001
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260926_0001"
down_revision: Union[str, None] = "20260925_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("agent_brain_versions", sa.Column("lifecycle", sa.String(length=16), nullable=True))
    op.add_column("agent_brain_versions", sa.Column("lifecycle_reason", sa.Text(), nullable=True))
    op.add_column("agent_brain_versions", sa.Column("lifecycle_by", sa.String(length=255), nullable=True))
    op.add_column(
        "agent_brain_versions",
        sa.Column("lifecycle_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_flow_run_steps",
        sa.Column("budget", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_flow_run_steps", "budget")
    op.drop_column("agent_brain_versions", "lifecycle_at")
    op.drop_column("agent_brain_versions", "lifecycle_by")
    op.drop_column("agent_brain_versions", "lifecycle_reason")
    op.drop_column("agent_brain_versions", "lifecycle")
