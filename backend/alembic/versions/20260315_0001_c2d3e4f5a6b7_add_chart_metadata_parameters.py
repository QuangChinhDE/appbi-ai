"""add_chart_metadata_and_parameters

Revision ID: c2d3e4f5a6b7
Revises: b1c3d2e4f5a6
Create Date: 2026-03-15 00:00:01.000000

Adds:
  - chart_metadata table (semantic/business layer for charts)
  - chart_parameters table (parameter definition for chart templates)
  - dashboard_charts.parameters column (runtime parameter values per instance)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c2d3e4f5a6b7'
down_revision: Union[str, None] = 'b1c3d2e4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- chart_metadata ---
    op.create_table(
        'chart_metadata',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('chart_id', sa.Integer(), nullable=False),
        sa.Column('domain', sa.String(length=100), nullable=True),
        sa.Column('intent', sa.String(length=100), nullable=True),
        sa.Column('metrics', sa.JSON(), nullable=True),
        sa.Column('dimensions', sa.JSON(), nullable=True),
        sa.Column('tags', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['chart_id'], ['charts.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('chart_id'),
    )
    op.create_index(op.f('ix_chart_metadata_id'), 'chart_metadata', ['id'], unique=False)
    op.create_index(op.f('ix_chart_metadata_chart_id'), 'chart_metadata', ['chart_id'], unique=True)

    # --- chart_parameters ---
    op.create_table(
        'chart_parameters',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('chart_id', sa.Integer(), nullable=False),
        sa.Column('parameter_name', sa.String(length=100), nullable=False),
        sa.Column('parameter_type', sa.String(length=50), nullable=False),
        sa.Column('column_mapping', sa.JSON(), nullable=True),
        sa.Column('default_value', sa.String(length=255), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['chart_id'], ['charts.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_chart_parameters_id'), 'chart_parameters', ['id'], unique=False)
    op.create_index(op.f('ix_chart_parameters_chart_id'), 'chart_parameters', ['chart_id'], unique=False)

    # --- dashboard_charts.parameters ---
    op.add_column(
        'dashboard_charts',
        sa.Column('parameters', sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('dashboard_charts', 'parameters')

    op.drop_index(op.f('ix_chart_parameters_chart_id'), table_name='chart_parameters')
    op.drop_index(op.f('ix_chart_parameters_id'), table_name='chart_parameters')
    op.drop_table('chart_parameters')

    op.drop_index(op.f('ix_chart_metadata_chart_id'), table_name='chart_metadata')
    op.drop_index(op.f('ix_chart_metadata_id'), table_name='chart_metadata')
    op.drop_table('chart_metadata')
