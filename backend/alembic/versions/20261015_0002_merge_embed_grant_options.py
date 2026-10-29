"""merge: embed_grants.display_options (hotfix, also on master) into demo's chain

20261015_0001 hangs off 20261012_0001 so it can ship to master unchanged; this
joins it with demo's 20261014_0002. No schema change.

Revision ID: 20261015_0002
Revises: 20261014_0002, 20261015_0001
Create Date: 2026-10-15
"""
from typing import Sequence, Union


revision: str = "20261015_0002"
down_revision: Union[str, Sequence[str], None] = ("20261014_0002", "20261015_0001")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
