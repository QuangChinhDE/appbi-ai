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


def test_a_calculated_table_over_postgres_emits_valid_sql():
    """Browser (M2 Calculated Table): creating a calculated table over a
    PostgreSQL source failed with "Unknown dialect 'postgresql'. Did you mean
    postgres?" — the alias rewrite passed AppBI's dialect name straight to
    sqlglot, whose Postgres dialect is "postgres". The rewrite must map it."""
    from app.services.dataset_table_sql_service import (
        rewrite_dataset_table_aliases_in_sql, _to_sqlglot_dialect,
    )

    assert _to_sqlglot_dialect("postgresql") == "postgres"
    assert _to_sqlglot_dialect("bigquery") == "bigquery"   # unchanged
    assert _to_sqlglot_dialect("mysql") == "mysql"

    out = rewrite_dataset_table_aliases_in_sql(
        "SELECT * FROM orders WHERE region = 'North'",
        {"orders": "dataset_table_42"},
        output_dialect="postgresql",
    )
    assert "dataset_table_42" in out      # the alias was rewritten (no exception)


# ── M3 Execution mode — a dataset mixing engines is flagged before a chart fails

def test_live_execution_engines_flags_a_mixed_engine_dataset():
    """Browser (M3): adding a MySQL table to a live PostgreSQL dataset refused
    EVERY chart (one chart runs on one engine) while the dataset still read
    "Live". The publish payload now reports live_executable=False and names the
    engines, so the UI warns before a chart fails."""
    from types import SimpleNamespace
    import app.services.dataset_publish_service as pub

    class _DS:
        def __init__(self, id, name, type_):
            self.id, self.name, self.type = id, name, SimpleNamespace(value=type_)

    def table(tid, dsid, kind="physical_table", enabled=True):
        return SimpleNamespace(id=tid, datasource_id=dsid, source_kind=kind, enabled=enabled)

    class _Q:
        def __init__(self, rows): self._rows = rows
        def filter(self, *a, **k): return self
        def all(self): return self._rows

    class _DB:
        def __init__(self, tables, sources): self._t, self._s = tables, sources
        def query(self, model):
            name = getattr(model, "__name__", str(model))
            if "DatasetTable" in name: return _Q(self._t)
            return _Q(self._s)

    pg = _DS(1, "Shop PG", "postgresql")
    my = _DS(2, "Targets MySQL", "mysql")
    # one engine → executable
    db1 = _DB([table(1, 1), table(2, 1)], [pg])
    labels, ok = pub._live_execution_engines(db1, 99)
    assert ok is True and len(labels) == 1

    # two engines → not executable, both named
    db2 = _DB([table(1, 1), table(2, 2)], [pg, my])
    labels2, ok2 = pub._live_execution_engines(db2, 99)
    assert ok2 is False
    assert any("postgresql" in x for x in labels2) and any("mysql" in x for x in labels2)

    # calculated / composed tables (no datasource) do not count
    db3 = _DB([table(1, 1), table(9, None, kind="derived_table")], [pg])
    _, ok3 = pub._live_execution_engines(db3, 99)
    assert ok3 is True
