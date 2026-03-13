"""Add all missing enum values

Revision ID: ddc996d23b59
Revises: cea934196b2b
Create Date: 2025-12-26 16:36:15.380427

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'ddc996d23b59'
down_revision = 'cea934196b2b'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add all enum values if they don't exist
    # PostgreSQL's ADD VALUE IF NOT EXISTS was added in PostgreSQL 9.1+
    op.execute("ALTER TYPE datasourcetype ADD VALUE IF NOT EXISTS 'postgresql'")
    op.execute("ALTER TYPE datasourcetype ADD VALUE IF NOT EXISTS 'mysql'")
    op.execute("ALTER TYPE datasourcetype ADD VALUE IF NOT EXISTS 'bigquery'")
    op.execute("ALTER TYPE datasourcetype ADD VALUE IF NOT EXISTS 'google_sheets'")
    op.execute("ALTER TYPE datasourcetype ADD VALUE IF NOT EXISTS 'manual'")


def downgrade() -> None:
    # Note: PostgreSQL does not support removing enum values
    pass
