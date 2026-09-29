"""Join the Agent Flow and Dashboard migration lineages.

Both streams branched from 20260914_0002:

    Agent Flow   20260925_0001 skill child runs
                 20260926_0101 skill lifecycle + step budget   (was 20260926_0001)
    Dashboard    20260926_0001 content proposal audit values
                 20260928_0001 canvas -> grid
                 20260929_0001 slicer bar -> grid

No schema change: this revision only gives `alembic upgrade head` one head. A
database that recorded Agent Flow's migration under its old ID is re-labelled first
by app/core/alembic_reconcile.py (from the schema), so both lineages then resolve.

Revision ID: 20260930_0001
Revises: 20260926_0101, 20260929_0001
"""
from typing import Sequence, Union

revision: str = "20260930_0001"
down_revision: Union[str, Sequence[str], None] = ("20260926_0101", "20260929_0001")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
