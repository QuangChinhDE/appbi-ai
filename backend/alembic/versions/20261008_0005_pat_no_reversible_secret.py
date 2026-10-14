"""Personal access tokens: no reversible copy of the secret (decision Q4).

`secret_enc` kept every PAT secret Fernet-encrypted so owners - and admins, for
ANY user - could reveal the full bearer token again. Plaintext now exists only
in the create / rotate response; authentication uses the HMAC hash only.
This clears every stored encrypted copy. Existing tokens keep working.
IRREVERSIBLE by design: the downgrade cannot restore the encrypted copies
(re-reveal stays unavailable; owners rotate to get a new secret).
"""
from alembic import op

revision = "20261008_0005"
down_revision = "20261008_0004"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("UPDATE personal_access_tokens SET secret_enc = NULL WHERE secret_enc IS NOT NULL")


def downgrade():
    pass  # the encrypted copies were destroyed on purpose; nothing to restore
