"""Add google_sheets and manual enum values

Revision ID: 4e9fbd163ff5
Revises: c333ddc99704
Create Date: 2025-12-25 17:49:20.924492

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '4e9fbd163ff5'
down_revision = 'c333ddc99704'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add new enum values to datasourcetype enum
    op.execute("ALTER TYPE datasourcetype ADD VALUE IF NOT EXISTS 'google_sheets'")
    op.execute("ALTER TYPE datasourcetype ADD VALUE IF NOT EXISTS 'manual'")


def downgrade() -> None:
    # Note: PostgreSQL does not support removing enum values
    # You would need to recreate the enum type if you want to downgrade
    pass
