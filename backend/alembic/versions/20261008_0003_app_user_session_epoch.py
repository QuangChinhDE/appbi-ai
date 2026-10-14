"""workboard_app_users.session_epoch: revoke a mini-app user's sessions.

A workspace session used to carry the app user's role and context frozen in the
JWT for its whole TTL (default 8h): a PIN reset, deactivation or role change
did nothing until it expired, and logout only cleared one cookie. Sessions now
carry the app user's id and this epoch; every request re-reads the row and a
mismatch ends the session. Additive (default 0); existing sessions lack the
claim and must log in again once. Downgrade drops the column.
"""
from alembic import op
import sqlalchemy as sa

revision = "20261008_0003"
down_revision = "20261008_0002"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("workboard_app_users",
                  sa.Column("session_epoch", sa.Integer, nullable=False, server_default="0"))


def downgrade():
    op.drop_column("workboard_app_users", "session_epoch")
