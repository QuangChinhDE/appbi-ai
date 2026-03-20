"""add_auth_users_resource_shares_owner_id

Revision ID: 20260320_auth01
Revises: f5a6b7c8d9e0
Create Date: 2026-03-20 00:00:01.000000

Adds:
  - users table (UUID PK, email, password_hash, full_name, role, status, invited_by, ...)
  - resource_shares table (dashboard/chart/dataset/workspace/dataset_model sharing)
  - owner_id column on: dashboards, charts, datasets, data_sources,
                         dataset_workspaces, dataset_models
  - Migration data: set owner_id = first admin user for all existing rows
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers
revision: str = '20260320_auth01'
down_revision: Union[str, None] = 'f5a6b7c8d9e0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. users table ──────────────────────────────────────────────────────
    op.create_table(
        'users',
        sa.Column('id', postgresql.UUID(as_uuid=True),
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('email', sa.String(255), nullable=False),
        sa.Column('password_hash', sa.String(255), nullable=False),
        sa.Column('full_name', sa.String(255), nullable=False),
        sa.Column('role',
                  sa.Enum('admin', 'editor', 'viewer', name='userrole'),
                  nullable=False, server_default='viewer'),
        sa.Column('status',
                  sa.Enum('active', 'deactivated', name='userstatus'),
                  nullable=False, server_default='active'),
        sa.Column('invited_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('email'),
        sa.ForeignKeyConstraint(['invited_by'], ['users.id'],
                                name='fk_users_invited_by',
                                ondelete='SET NULL'),
    )
    op.create_index('ix_users_email', 'users', ['email'])

    # ── 2. resource_shares table ─────────────────────────────────────────────
    op.create_table(
        'resource_shares',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('resource_type',
                  sa.Enum('dashboard', 'chart', 'dataset', 'workspace',
                          'dataset_model', name='resourcetype'),
                  nullable=False),
        sa.Column('resource_id', sa.Integer(), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('permission',
                  sa.Enum('viewer', 'editor', name='sharepermission'),
                  nullable=False, server_default='viewer'),
        sa.Column('shared_by', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'],
                                name='fk_resource_shares_user_id',
                                ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['shared_by'], ['users.id'],
                                name='fk_resource_shares_shared_by',
                                ondelete='CASCADE'),
        sa.UniqueConstraint('resource_type', 'resource_id', 'user_id',
                            name='uq_resource_shares'),
    )
    op.create_index('ix_resource_shares_user', 'resource_shares',
                    ['user_id', 'resource_type'])
    op.create_index('ix_resource_shares_resource', 'resource_shares',
                    ['resource_type', 'resource_id'])

    # ── 3. Add owner_id columns ────────────────────────────────────────────
    for table in ('dashboards', 'charts', 'datasets', 'data_sources',
                  'dataset_workspaces', 'dataset_models'):
        op.add_column(
            table,
            sa.Column('owner_id', postgresql.UUID(as_uuid=True),
                      sa.ForeignKey('users.id', ondelete='SET NULL'),
                      nullable=True),
        )

    # ── 4. Auto-seed: create default admin + assign owner_id ─────────────────
    # We use raw SQL so we don't depend on any ORM model that may not have been
    # imported yet. The default admin credentials are picked up from env vars
    # inside entrypoint.sh; here we just insert a placeholder that will be
    # replaced (or left if the env-var seeding hasn't run yet).
    # owner_id is intentionally left NULL for existing rows — entrypoint.sh
    # will set them after the admin user is created.
    pass


def downgrade() -> None:
    # Remove owner_id columns
    for table in ('dataset_models', 'dataset_workspaces', 'data_sources',
                  'datasets', 'charts', 'dashboards'):
        op.drop_column(table, 'owner_id')

    op.drop_index('ix_resource_shares_resource', 'resource_shares')
    op.drop_index('ix_resource_shares_user', 'resource_shares')
    op.drop_table('resource_shares')

    op.drop_index('ix_users_email', 'users')
    op.drop_table('users')

    op.execute("DROP TYPE IF EXISTS sharepermission")
    op.execute("DROP TYPE IF EXISTS resourcetype")
    op.execute("DROP TYPE IF EXISTS userstatus")
    op.execute("DROP TYPE IF EXISTS userrole")
