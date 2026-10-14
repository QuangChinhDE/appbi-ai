"""users.security_stamp: end every session of a user at once.

Access and refresh tokens carry the stamp current at minting (`ss`); a password
change, deactivation or status change rotates it. NULL is a valid stamp for
existing rows (tokens minted for them carry ""), so nothing is backfilled and
no session is ended by the migration itself. (The token-domain cutover that
ships with it ends pre-existing sessions once, by design.)
"""
from alembic import op
import sqlalchemy as sa

revision = "20261007_0002"
down_revision = "20261007_0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("security_stamp", sa.String(64), nullable=True))


def downgrade():
    op.drop_column("users", "security_stamp")
