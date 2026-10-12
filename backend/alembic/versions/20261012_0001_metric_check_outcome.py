"""monitored_metrics: the outcome of the metric's last check

An anomaly incident may only recover on EVIDENCE that the metric is normal: a
check that ran and found nothing. Before, ``check_metric`` returned ``[]`` both
for "ran, normal" and for "could not query the source", so a source down for
days quietly auto-resolved an open anomaly.

Additive, nullable: existing metrics read "never checked" until their next run.

Revision ID: 20261012_0001
Revises: 20261008_0008
Create Date: 2026-10-12
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20261012_0001"
down_revision: Union[str, None] = "20261008_0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("monitored_metrics", sa.Column("last_checked_at", sa.DateTime(), nullable=True))
    # ok | anomaly | error | insufficient
    op.add_column("monitored_metrics", sa.Column("last_check_status", sa.String(16), nullable=True))
    op.add_column("monitored_metrics", sa.Column("last_check_error", sa.Text(), nullable=True))
    # When the metric last ran clean (status ok): the recovery evidence.
    op.add_column("monitored_metrics", sa.Column("last_ok_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("monitored_metrics", "last_ok_at")
    op.drop_column("monitored_metrics", "last_check_error")
    op.drop_column("monitored_metrics", "last_check_status")
    op.drop_column("monitored_metrics", "last_checked_at")
