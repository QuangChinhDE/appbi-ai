"""add NINE_BOX chart type

Revision ID: 20260623_0002
Revises: 20260623_0001
Create Date: 2026-06-23
"""
from typing import Sequence, Union

from alembic import op


revision: str = "20260623_0002"
down_revision: Union[str, None] = "20260623_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # NINE_BOX — talent / BCG 3×3 grid chart (scatter-family). Native PG enum
    # needs the value added before any chart row can reference it.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE charttype ADD VALUE IF NOT EXISTS 'NINE_BOX'")


def downgrade() -> None:
    # PostgreSQL enum values cannot be removed without recreating the type.
    pass
