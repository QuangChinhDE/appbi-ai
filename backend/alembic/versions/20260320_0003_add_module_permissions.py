"""Add module_permissions table for permission matrix.

Revision ID: 20260320_perm03
Revises: 20260320_enum02
Create Date: 2026-03-20
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '20260320_perm03'
down_revision = '20260320_enum02'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create enums
    module_enum = sa.Enum(
        'datasource', 'dataset', 'workspace', 'chart', 'dashboard', 'chat', 'explore',
        name='module_enum',
    )
    module_enum.create(op.get_bind(), checkfirst=True)

    perm_level_enum = sa.Enum(
        'none', 'view', 'edit',
        name='module_permission_level_enum',
    )
    perm_level_enum.create(op.get_bind(), checkfirst=True)

    op.create_table(
        'module_permissions',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('module', module_enum, nullable=False),
        sa.Column('permission', perm_level_enum, nullable=False, server_default='none'),
        sa.Column('updated_by', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint('user_id', 'module', name='uq_module_permission'),
    )


def downgrade() -> None:
    op.drop_table('module_permissions')
    sa.Enum(name='module_permission_level_enum').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='module_enum').drop(op.get_bind(), checkfirst=True)
