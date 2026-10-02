"""Core Product Certification — durable contracts for the non-AI product
experience (UI/UX ↔ backend ↔ data state). One file, one fix per test, named
for the user-visible contract. Browser evidence lives in e2e/; these lock the
backend truth those journeys depend on.
"""
from __future__ import annotations

import pytest

from app.services.source_errors import describe_source_error


# ── M1 Datasource — an unreadable source is not an empty source ──────────────

def test_a_source_that_cannot_be_read_reports_the_cause_not_emptiness():
    """Browser (M1): after a datasource credential was rotated at the source,
    the table picker said "No tables found" — an empty source, the wrong action.
    The backend returned a bare 500 "Failed to list tables." Now every source
    browse carries the driver's own reason, so the UI can tell the user whether
    to fix a credential, a permission, the network or the config."""
    exc = Exception('connection to server at "127.0.0.1", port 55499 failed: '
                    'FATAL: password authentication failed for user "src_reader"')
    msg = describe_source_error(exc, {})
    assert "password authentication failed" in msg
    assert "src_reader" in msg          # the actionable part survives
    assert len(msg) <= 400


def test_the_source_error_never_echoes_a_secret_value():
    """The reason is shown in the UI: it must never carry the source's own
    password / key, even when the driver put it in the message."""
    secret = "sup3r-s3cret-passw0rd-value"
    cfg = {"host": "db", "username": "u", "password": secret}
    exc = Exception(f'FATAL: password "{secret}" rejected; dsn=host=db password={secret}')
    msg = describe_source_error(exc, cfg)
    assert secret not in msg
    assert "••••" in msg


def test_a_private_key_in_a_source_error_is_scrubbed():
    cfg = {"service_account_json": {"private_key": "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----"}}
    exc = Exception("auth failed with key -----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----")
    msg = describe_source_error(exc, cfg)
    assert "BEGIN PRIVATE KEY" not in msg
    assert "ABC" not in msg


def test_an_empty_source_error_is_not_an_exception():
    assert describe_source_error(None, {}) == "NoneType" or describe_source_error(None, {}) == ""
    # A bare exception class still yields something a person can read.
    assert describe_source_error(ValueError(), {}) == "ValueError"


# ── M2 Dataset — a Query Table refuses anything that is not a read ───────────

@pytest.mark.parametrize("sql", [
    "DROP TABLE orders",
    "DELETE FROM orders",
    "UPDATE orders SET amount = 0",
    "INSERT INTO orders VALUES (1)",
    "TRUNCATE orders",
])
def test_a_query_table_refuses_a_non_select(sql):
    """A Query Table is read-only. Anything that is not SELECT / WITH is refused
    before it reaches the source, and the refusal carries a reason the UI shows.
    (The browser bug this guards against was the reverse: an INVALID read was
    accepted silently because the UI ignored {valid:false}; see the e2e spec.)"""
    from app.services.query_validator import QueryValidator, QueryValidationError

    with pytest.raises(QueryValidationError) as ei:
        QueryValidator.validate_and_clean(sql)
    assert str(ei.value), "a refusal must explain itself"


def test_a_query_table_accepts_a_plain_select():
    from app.services.query_validator import QueryValidator
    cleaned = QueryValidator.validate_and_clean("SELECT id, region FROM orders")
    assert "select" in cleaned.lower()
