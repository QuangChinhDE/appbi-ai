"""governed_query_executions.consent_nonce: a drop-filter consent runs once (PR-1F)

A user's consent to answer with a filter dropped is a signed, expiring token
bound to one user and one exact query. Its nonce is written on the execution's
ledger row in the same transaction as `begin`; a partial UNIQUE index makes a
second use of the same consent fail instead of running again.

Additive: one nullable column and one partial unique index. No existing row is
read, changed or backfilled (every existing row keeps NULL, which the index
ignores). The index is built non-concurrently: a brief SHARE lock blocks
ledger writes while it scans; the table is new this release, so the scan is short.

DOWNGRADE REFUSES while any row carries a consent nonce: that column is audit
evidence of what a person accepted. Rolling the CODE back leaves it in place.

Revision ID: 20261021_0002
Revises: 20261021_0001
Create Date: 2026-10-21
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261021_0002"
down_revision: Union[str, None] = "20261021_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "governed_query_executions"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("consent_nonce", sa.String(64), nullable=True))
    op.create_index("uq_gqe_consent_nonce", TABLE, ["consent_nonce"], unique=True,
                    postgresql_where=sa.text("consent_nonce IS NOT NULL"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(f"LOCK TABLE {TABLE} IN ACCESS EXCLUSIVE MODE"))
    used = bind.execute(sa.text(f"SELECT count(*) FROM {TABLE} WHERE consent_nonce IS NOT NULL")).scalar()
    if used:
        raise RuntimeError(
            f"refusing to downgrade 20261021_0002: {used} ledger row(s) record a user's consent. "
            "Removing that evidence is a separate, approved data operation."
        )
    op.drop_index("uq_gqe_consent_nonce", table_name=TABLE)
    op.drop_column(TABLE, "consent_nonce")
