"""analyst_feedback.reason: the Internal AI Preview triage classes.

Widens ck_analyst_feedback_reason to a SUPERSET: wrong_metric, wrong_dataset and
wrong_interpretation are added; every value allowed before stays allowed (older
clients still post wrong_metric_or_source). No row changes. The downgrade refuses
while any row uses a new value, rather than deleting or rewriting feedback.

Revision ID: 20261024_0001
Revises: 20261023_0001
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261024_0001"
down_revision: Union[str, None] = "20261023_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD = ("correct", "wrong_metric_or_source", "wrong_filter", "incorrect_number",
       "unsupported_but_answerable", "ux_issue")
ADDED = ("wrong_metric", "wrong_dataset", "wrong_interpretation")


def _check(values) -> str:
    return "reason IS NULL OR reason IN (" + ", ".join(f"'{r}'" for r in values) + ")"


def upgrade() -> None:
    op.drop_constraint("ck_analyst_feedback_reason", "analyst_feedback", type_="check")
    op.create_check_constraint("ck_analyst_feedback_reason", "analyst_feedback", _check(OLD + ADDED))


def downgrade() -> None:
    used = op.get_bind().execute(sa.text(
        "SELECT count(*) FROM analyst_feedback WHERE reason IN ("
        + ", ".join(f"'{r}'" for r in ADDED) + ")")).scalar()
    if used:
        raise RuntimeError(f"{used} feedback rows use a preview reason; refusing to narrow the constraint "
                           "(that would require deleting or rewriting feedback)")
    op.drop_constraint("ck_analyst_feedback_reason", "analyst_feedback", type_="check")
    op.create_check_constraint("ck_analyst_feedback_reason", "analyst_feedback", _check(OLD))
