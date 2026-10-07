"""Merge the authz remediation and the Source core hardening migration streams.

origin/demo's source hardening (20261006_0002 manual source assets,
20261006_0003 source domain hardening) and security/authz-remediation
(20261007_0001 .. 20261008_0006) both descend from 20261006_0001. Neither stream
is re-parented; this empty revision joins them so there is one head again.

Revision ID: 20261008_0007
Revises: 20261006_0003, 20261008_0006
"""

revision = "20261008_0007"
down_revision = ("20261006_0003", "20261008_0006")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
