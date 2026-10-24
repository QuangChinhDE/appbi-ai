"""analyst_feedback.reason: what was wrong (or right) with an Analyst answer.

Additive: one nullable column on a table only this feature writes; existing rows
keep NULL (an up/down verdict without a reason stays valid).

Revision ID: 20261023_0001
Revises: 20261022_0001
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261023_0001"
down_revision: Union[str, None] = "20261022_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

REASONS = ("correct", "wrong_metric_or_source", "wrong_filter", "incorrect_number",
           "unsupported_but_answerable", "ux_issue")


def upgrade() -> None:
    op.add_column("analyst_feedback", sa.Column("reason", sa.String(40), nullable=True))
    op.create_check_constraint(
        "ck_analyst_feedback_reason", "analyst_feedback",
        "reason IS NULL OR reason IN (" + ", ".join(f"'{r}'" for r in REASONS) + ")")


def downgrade() -> None:
    op.drop_constraint("ck_analyst_feedback_reason", "analyst_feedback", type_="check")
    op.drop_column("analyst_feedback", "reason")
