"""reserved revision placeholder

Revision ID: 20260414_0001
Revises: 20260413_0001
Create Date: 2026-04-14 00:00:00.000000
"""
from typing import Sequence, Union


revision: str = "20260414_0001"
down_revision: Union[str, None] = "20260413_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass