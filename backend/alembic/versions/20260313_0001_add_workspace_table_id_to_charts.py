"""add_workspace_table_id_to_charts

Revision ID: a1b2c3d4e5f6
Revises: ddc996d23b59
Create Date: 2026-03-13 00:00:01.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = 'ddc996d23b59'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Make dataset_id nullable
    op.alter_column('charts', 'dataset_id', nullable=True)

    # 2. Add workspace_table_id column (nullable FK to dataset_workspace_tables)
    op.add_column(
        'charts',
        sa.Column('workspace_table_id', sa.Integer(), sa.ForeignKey('dataset_workspace_tables.id', ondelete='SET NULL'), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('charts', 'workspace_table_id')
    op.alter_column('charts', 'dataset_id', nullable=False)
