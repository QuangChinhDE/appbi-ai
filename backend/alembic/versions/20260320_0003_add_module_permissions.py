"""Add module_permissions table for permission matrix.

Revision ID: 20260320_perm03
Revises: 20260320_enum02
Create Date: 2026-03-20
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import UUID, ENUM as PG_ENUM

revision = '20260320_perm03'
down_revision = '20260320_enum02'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # Create enum types via PostgreSQL DO blocks — fully idempotent and safe
    # inside Alembic's transaction context on PostgreSQL 12+.
    # Using PG_ENUM(create_type=False) in the column tells SQLAlchemy NOT to
    # auto-create the type again during op.create_table().
    conn.execute(text("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'module_enum') THEN
                CREATE TYPE module_enum AS ENUM
                    ('datasource', 'dataset', 'workspace', 'chart',
                     'dashboard', 'chat', 'explore');
            END IF;
        END $$
    """))
    conn.execute(text("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'module_permission_level_enum') THEN
                CREATE TYPE module_permission_level_enum AS ENUM ('none', 'view', 'edit');
            END IF;
        END $$
    """))

    op.create_table(
        'module_permissions',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('module', PG_ENUM(name='module_enum', create_type=False), nullable=False),
        sa.Column('permission', PG_ENUM(name='module_permission_level_enum', create_type=False), nullable=False, server_default='none'),
        sa.Column('updated_by', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint('user_id', 'module', name='uq_module_permission'),
    )


def downgrade() -> None:
    op.drop_table('module_permissions')
    sa.Enum(name='module_permission_level_enum').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='module_enum').drop(op.get_bind(), checkfirst=True)
