"""Add 'knowledge_doc' to the resourcetype Postgres enum

The ResourceShare.resource_type column is a Postgres ENUM; registering the new
Python value isn't enough — the DB enum must learn it too, else sharing a
knowledge doc fails with InvalidTextRepresentation.
"""
from alembic import op

revision = "20260707_0011"
down_revision = "20260707_0010"
branch_labels = None
depends_on = None


def upgrade():
    # ALTER TYPE ... ADD VALUE cannot run inside a transaction on older PG; use
    # an autocommit block so it works across versions.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'knowledge_doc'")


def downgrade():
    # Postgres cannot drop an enum value; no-op (harmless to leave in place).
    pass
