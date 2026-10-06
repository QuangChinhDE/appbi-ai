"""Source hardening — Gate 0 security contracts (docs/features/source-core-hardening/spec.md).

One test per audit finding / adversarial case:

F1  the read-only SQL gate lexes literals before comments, refuses multiple
    statements, INTO, transaction control and dangerous functions;
F2  Postgres identifiers only via psycopg2.sql.Identifier / one quoting helper;
F4  outbound network policy (loopback, link-local, metadata, private, rebinding);
F6  the Query Runner path is READ ONLY, row-capped server-side, reports truncation;
F14 BigQuery jobs carry maximum_bytes_billed, also when the dry run fails;
F11 a connection test never closes the shared cached BigQuery client;
F5  the platform GCP credential is refused for a project outside the allow-list;
F17 encryption fails closed outside dev/test; logs carry no SQL text.
"""
from __future__ import annotations

import logging
import socket

import pytest
from psycopg2 import sql as pg_sql

import app.services.datasource_service as ds_mod
import app.services.source_network_policy as netpol
from app.core.config import settings
from app.services.sql_validator import validate_select_only


# ── F1: SQL gate ─────────────────────────────────────────────────────────────

REFUSED_SQL = [
    # the audit repro: a comment marker inside a literal hid the second statement
    ("SELECT '--', 1; DROP TABLE x", None),
    ("SELECT '/*', 1; DROP TABLE x; -- */", None),
    ("SELECT 1; DROP TABLE x", None),
    ("SELECT 1; SELECT 2", None),
    ("SELECT 1; COMMIT", None),
    ("SELECT 1;\nROLLBACK;", None),
    ("SELECT 1; BEGIN", None),
    ("SELECT 1; SET search_path TO evil", None),
    ("SET statement_timeout = 0", None),
    ("COMMIT", None),
    ("SELECT * INTO new_table FROM t", None),
    ("SELECT * FROM t INTO OUTFILE '/tmp/x'", "mysql"),
    ("SELECT * FROM t INTO DUMPFILE '/tmp/x'", "mysql"),
    ("SELECT a INTO @v FROM t", "mysql"),
    ("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", None),
    ("WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM u", None),
    ("WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i", None),
    ("SELECT dblink('host=x', 'select 1')", None),
    ("SELECT * FROM dblink_exec('x', 'drop table t')", None),
    ("SELECT set_config('search_path', 'evil', false)", None),
    ("SELECT pg_read_file('/etc/passwd')", None),
    ("SELECT pg_catalog.pg_read_file('/etc/passwd')", None),
    ('SELECT "pg_read_file"(\'/etc/passwd\')', "postgresql"),
    ('SELECT pg_catalog."lo_import"(\'/etc/passwd\')', "postgresql"),
    ("SELECT pg_ls_dir('.')", None),
    ("SELECT lo_import('/etc/passwd')", None),
    ("SELECT lo_export(1, '/tmp/x')", None),
    ("SELECT pg_sleep(100)", None),
    ("SELECT pg_sleep /* x */ (100)", None),
    ("SELECT SLEEP(100)", "mysql"),
    ("SELECT LOAD_FILE('/etc/passwd')", "mysql"),
    ("SELECT * FROM read_csv('/etc/passwd')", "manual"),
    ("SELECT * FROM '/etc/passwd'", "manual"),
    ("SELECT 1 /*! ; DROP TABLE x */", "mysql"),
    # postgres dollar quoting must not hide a second statement in MySQL/BigQuery
    ("SELECT $a$; DROP TABLE x; $a$", "mysql"),
    # a backslash is an escape in MySQL, NOT in standard Postgres strings
    ("SELECT 'a\\'; DROP TABLE x; --'", "postgresql"),
    # # is a comment in MySQL but an operator in Postgres
    ("SELECT 1 # ; DROP TABLE x", "postgresql"),
    ("SELECT 'unterminated", None),
    ("SELECT 1 /* unterminated", None),
    ("DELETE FROM t", None),
    ("   ", None),
    ("SELECT 1\x00; DROP TABLE x", None),
]


@pytest.mark.parametrize("sql,dialect", REFUSED_SQL)
def test_sql_gate_refuses_adversarial_statement(sql, dialect):
    with pytest.raises(ValueError) as ei:
        validate_select_only(sql, dialect)
    assert str(ei.value)


ALLOWED_SQL = [
    ("SELECT 1", None),
    ("select * from orders;", None),
    ("select * from orders; -- trailing comment", None),
    ("SELECT 1;;  ", None),
    ("WITH a AS (SELECT 1 AS x) SELECT * FROM a", None),
    ("(SELECT 1) UNION ALL (SELECT 2)", None),
    ("SELECT '--' AS dashes, 'a;b' AS semi, '/*' AS c FROM t", None),
    ("SELECT 'DROP TABLE x; DELETE' AS text_mentions_keywords", None),
    ('SELECT "update", "delete", "Order Date" FROM "my;table"', "postgresql"),
    ("SELECT `delete`, `my;col` FROM `proj.ds.t`", "bigquery"),
    ("SELECT REPLACE(name, 'a', 'b') FROM t", None),
    ("SELECT * REPLACE (UPPER(name) AS name) FROM `p.d.t`", "bigquery"),
    ("SELECT $$it's; DROP$$ AS x", "postgresql"),
    ("SELECT $tag$ ; COMMIT $tag$ AS x", "postgresql"),
    ("SELECT E'it\\'s; DROP' AS x", "postgresql"),
    ("SELECT 'it''s; DROP' AS x", None),
    ("SELECT 'it\\'s; DROP' AS x", "mysql"),
    ("SELECT '''multi; DROP''' AS x", "bigquery"),
    ("SELECT CAST(a AS CHAR CHARACTER SET utf8) FROM t", "mysql"),
    ("SELECT created_at, inserted_by, updated_at, settings FROM t", None),
    ("SELECT a FROM t WHERE b = %s", "postgresql"),
]


@pytest.mark.parametrize("sql,dialect", ALLOWED_SQL)
def test_sql_gate_allows_legitimate_reads(sql, dialect):
    validate_select_only(sql, dialect)


def test_query_validator_used_by_validate_sql_still_refuses_writes():
    from app.services.query_validator import QueryValidator, QueryValidationError
    with pytest.raises(QueryValidationError):
        QueryValidator.validate_and_clean("SELECT 1; DROP TABLE x")


# ── F2: identifiers ──────────────────────────────────────────────────────────

class _RecCursor:
    def __init__(self, rows=None, description=(("a",),)):
        self.executed = []
        self.rows = list(rows or [])
        self.description = [(d[0],) for d in description]
        self.fetchmany_arg = None
        self.fetchall_called = False

    def execute(self, query, params=None):
        self.executed.append((query, params))

    def fetchmany(self, n):
        self.fetchmany_arg = n
        return self.rows[:n]

    def fetchall(self):
        self.fetchall_called = True
        return list(self.rows)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _RecConn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.readonly = None
        self.closed = False
        self.autocommit = False

    def set_session(self, readonly=None, **_):
        self.readonly = readonly

    def cursor(self, *a, **k):
        return self._cursor

    def rollback(self):
        pass

    def close(self):
        self.closed = True


def test_search_path_is_set_through_sql_identifier_never_interpolated():
    cur = _RecCursor()
    ds_mod._pg_set_search_path(cur, 'sales; DROP TABLE x, "odd"')
    stmt, _ = cur.executed[0]
    assert isinstance(stmt, pg_sql.Composed)
    idents = [p for p in stmt.seq[1].seq if isinstance(p, pg_sql.Identifier)]
    assert [i.strings[0] for i in idents] == ["sales; DROP TABLE x", '"odd"']


@pytest.mark.parametrize("bad", ["", " , ", "a,,b", "x" * 64, "a\x00b"])
def test_invalid_schema_name_is_refused(bad):
    with pytest.raises(ValueError):
        ds_mod.validate_pg_schema_name(bad)


def test_quoted_table_names_escape_their_quote_character():
    assert ds_mod.pg_ident('s"x', 't') == '"s""x"."t"'
    assert ds_mod.mysql_ident("d`x", "t") == "`d``x`.`t`"
    with pytest.raises(ValueError):
        ds_mod.bq_table_ref("p", "d`; DROP", "t")


def test_fetch_table_data_quotes_hostile_table_names(monkeypatch):
    seen = {}

    def fake_pg(config, sql, limit=None, **k):
        seen["sql"] = sql
        return ["a"], []

    monkeypatch.setattr(ds_mod.DataSourceConnectionService, "_execute_postgresql", staticmethod(fake_pg))
    ds_mod.DataSourceConnectionService.fetch_table_data(
        "postgresql", {"host": "h"}, 'pub"lic', 'orders"; DROP TABLE x; --', limit=5,
    )
    assert seen["sql"] == 'SELECT * FROM "pub""lic"."orders""; DROP TABLE x; --" LIMIT 5'


# ── F4: outbound network policy ──────────────────────────────────────────────

@pytest.fixture()
def strict_network(monkeypatch):
    monkeypatch.setattr(settings, "SOURCE_ALLOW_PRIVATE_NETWORK", False, raising=False)
    monkeypatch.setattr(settings, "ALLOWED_PRIVATE_SOURCE_CIDRS", "", raising=False)
    return monkeypatch


def _fake_dns(monkeypatch, mapping):
    def fake_getaddrinfo(host, port, *a, **k):
        if host not in mapping:
            raise socket.gaierror("no such host")
        out = []
        for ip in mapping[host]:
            fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
            out.append((fam, socket.SOCK_STREAM, 6, "", (ip, port or 0)))
        return out
    monkeypatch.setattr(netpol.socket, "getaddrinfo", fake_getaddrinfo)


@pytest.mark.parametrize("host", [
    "127.0.0.1", "127.8.8.8", "::1", "localhost-literal-skip",
    "169.254.169.254", "fd00:ec2::254", "metadata.google.internal",
    "10.1.2.3", "172.16.5.5", "192.168.1.10", "100.64.0.1", "fc00::1",
    "0.0.0.0", "::", "224.0.0.1", "240.0.0.1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
])
def test_network_policy_refuses_internal_destinations(strict_network, host):
    if host == "localhost-literal-skip":
        _fake_dns(strict_network, {"localhost": ["127.0.0.1"]})
        host = "localhost"
    with pytest.raises(netpol.SourceNetworkPolicyError):
        netpol.resolve_and_check(host, 5432)


def test_network_policy_allows_public_address(strict_network):
    assert netpol.resolve_and_check("8.8.8.8", 5432) == "8.8.8.8"


def test_allowed_cidr_opens_only_that_private_range(strict_network):
    strict_network.setattr(settings, "ALLOWED_PRIVATE_SOURCE_CIDRS", "10.20.0.0/16", raising=False)
    assert netpol.resolve_and_check("10.20.3.4", 5432) == "10.20.3.4"
    with pytest.raises(netpol.SourceNetworkPolicyError):
        netpol.resolve_and_check("10.21.0.1", 5432)
    with pytest.raises(netpol.SourceNetworkPolicyError):
        netpol.resolve_and_check("127.0.0.1", 5432)  # loopback is not "private"


def test_metadata_and_link_local_stay_refused_even_when_allowlisted(strict_network):
    strict_network.setattr(settings, "ALLOWED_PRIVATE_SOURCE_CIDRS", "169.254.0.0/16,0.0.0.0/0", raising=False)
    strict_network.setattr(settings, "SOURCE_ALLOW_PRIVATE_NETWORK", True, raising=False)
    with pytest.raises(netpol.SourceNetworkPolicyError):
        netpol.resolve_and_check("169.254.169.254", 80)
    with pytest.raises(netpol.SourceNetworkPolicyError):
        netpol.resolve_and_check("169.254.1.1", 80)


def test_allow_private_switch_never_opens_loopback(strict_network):
    strict_network.setattr(settings, "SOURCE_ALLOW_PRIVATE_NETWORK", True, raising=False)
    assert netpol.resolve_and_check("10.0.0.5", 5432) == "10.0.0.5"
    with pytest.raises(netpol.SourceNetworkPolicyError):
        netpol.resolve_and_check("127.0.0.1", 5432)


def test_hostname_resolving_to_a_bad_address_is_refused(strict_network):
    _fake_dns(strict_network, {"db.attacker.example": ["169.254.169.254"]})
    with pytest.raises(netpol.SourceNetworkPolicyError):
        netpol.resolve_and_check("db.attacker.example", 5432)


def test_mixed_a_and_aaaa_answers_with_one_bad_candidate_are_refused(strict_network):
    _fake_dns(strict_network, {"mixed.example": ["93.184.216.34", "::1"]})
    with pytest.raises(netpol.SourceNetworkPolicyError):
        netpol.resolve_and_check("mixed.example", 5432)
    _fake_dns(strict_network, {"mixed2.example": ["2606:2800:220:1::1", "10.0.0.1"]})
    with pytest.raises(netpol.SourceNetworkPolicyError):
        netpol.resolve_and_check("mixed2.example", 5432)


def test_all_public_candidates_return_the_checked_ip(strict_network):
    _fake_dns(strict_network, {"ok.example": ["2606:2800:220:1::1", "93.184.216.34"]})
    assert netpol.resolve_and_check("ok.example", 5432) == "93.184.216.34"


def test_pg_connect_pins_hostaddr_and_keeps_hostname(strict_network):
    _fake_dns(strict_network, {"pg.example": ["93.184.216.34"]})
    seen = {}
    strict_network.setattr(ds_mod.psycopg2, "connect", lambda **kw: seen.update(kw) or _RecConn(_RecCursor()))
    ds_mod._pg_connect(host="pg.example", port=5432, database="d", user="u", password="p")
    assert seen["host"] == "pg.example" and seen["hostaddr"] == "93.184.216.34"


def test_pg_and_mysql_connect_refuse_before_the_driver_is_called(strict_network):
    called = []
    strict_network.setattr(ds_mod.psycopg2, "connect", lambda **kw: called.append(kw))
    strict_network.setattr(ds_mod.pymysql, "connect", lambda **kw: called.append(kw))
    for host in ("127.0.0.1", "169.254.169.254", "10.0.0.1"):
        ok, _msg = ds_mod.DataSourceConnectionService.test_connection(
            "postgresql", {"host": host, "port": 5432, "database": "d", "username": "u", "password": "p"})
        assert ok is False
        ok, _msg = ds_mod.DataSourceConnectionService.test_connection(
            "mysql", {"host": host, "port": 3306, "database": "d", "username": "u", "password": "p"})
        assert ok is False
    assert called == []


def test_mysql_connects_to_the_checked_ip(strict_network):
    _fake_dns(strict_network, {"my.example": ["93.184.216.34"]})
    seen = {}
    strict_network.setattr(ds_mod.pymysql, "connect", lambda **kw: seen.update(kw) or _RecConn(_RecCursor()))
    ds_mod._mysql_connect(host="my.example", port=3306)
    assert seen["host"] == "93.184.216.34"


# ── F6: Query Runner path ────────────────────────────────────────────────────

def _public_pg(monkeypatch, rows):
    monkeypatch.setattr(netpol, "resolve_and_check", lambda host, port=None: "93.184.216.34")
    cur = _RecCursor(rows=rows)
    conn = _RecConn(cur)
    monkeypatch.setattr(ds_mod.psycopg2, "connect", lambda **kw: conn)
    return conn, cur


def test_query_runner_is_read_only_capped_and_reports_truncation(monkeypatch):
    monkeypatch.setattr(settings, "SOURCE_QUERY_MAX_ROWS", 3, raising=False)
    conn, cur = _public_pg(monkeypatch, rows=[(i,) for i in range(10)])
    out = ds_mod.DataSourceConnectionService.execute_user_query(
        "postgresql", {"host": "pg.example", "database": "d", "username": "u"},
        "SELECT a FROM t LIMIT 10000000", limit=10_000_000,
    )
    assert conn.readonly is True
    assert cur.fetchmany_arg == 4 and not cur.fetchall_called
    assert out["truncated"] is True and out["row_limit"] == 3 and len(out["data"]) == 3


def test_query_runner_not_truncated_when_under_cap(monkeypatch):
    monkeypatch.setattr(settings, "SOURCE_QUERY_MAX_ROWS", 100, raising=False)
    _public_pg(monkeypatch, rows=[(1,), (2,)])
    out = ds_mod.DataSourceConnectionService.execute_user_query(
        "postgresql", {"host": "pg.example"}, "SELECT a FROM t", limit=50,
    )
    assert out["truncated"] is False and out["row_limit"] == 50 and len(out["data"]) == 2


def test_mysql_query_runs_in_a_read_only_transaction(monkeypatch):
    monkeypatch.setattr(netpol, "resolve_and_check", lambda host, port=None: "93.184.216.34")
    cur = _RecCursor(rows=[(1,)])
    monkeypatch.setattr(ds_mod.pymysql, "connect", lambda **kw: _RecConn(cur))
    ds_mod.DataSourceConnectionService.execute_user_query("mysql", {"host": "my.example"}, "SELECT a FROM t")
    assert cur.executed[0][0] == "START TRANSACTION READ ONLY"


def test_validate_sql_never_runs_the_statement_in_full(monkeypatch):
    conn, cur = _public_pg(monkeypatch, rows=[(1,)])
    ds_mod.DataSourceConnectionService.validate_user_sql("postgresql", {"host": "pg.example"}, "SELECT a FROM big;")
    final = cur.executed[-1][0]
    assert final.startswith("SELECT * FROM (") and final.rstrip().endswith("LIMIT 0")
    assert conn.readonly is True


def test_validate_sql_on_bigquery_is_a_dry_run(monkeypatch):
    calls = []
    monkeypatch.setattr(ds_mod.DataSourceConnectionService, "_estimate_bigquery_bytes",
                        staticmethod(lambda cfg, sql: calls.append(sql) or 0))
    monkeypatch.setattr(ds_mod.DataSourceConnectionService, "_execute_bigquery",
                        staticmethod(lambda *a, **k: pytest.fail("validate must not execute")))
    ds_mod.DataSourceConnectionService.validate_user_sql("bigquery", {"project_id": "p"}, "SELECT 1")
    assert calls == ["SELECT 1"]


def test_internal_execution_is_not_row_capped(monkeypatch):
    """The Query Runner cap must not leak into analytical/dataset execution."""
    monkeypatch.setattr(settings, "SOURCE_QUERY_MAX_ROWS", 2, raising=False)
    _conn, cur = _public_pg(monkeypatch, rows=[(i,) for i in range(5)])
    cols, data, _ = ds_mod.DataSourceConnectionService.execute_query(
        "postgresql", {"host": "pg.example"}, "SELECT a FROM t")
    assert len(data) == 5 and cur.fetchall_called


# ── F14 / F11: BigQuery ──────────────────────────────────────────────────────

class _BQJob:
    def __init__(self):
        self.schema = []

    def result(self, timeout=None, max_results=None):
        self.max_results = max_results
        return self

    def __iter__(self):
        return iter([])


class _BQClient:
    def __init__(self):
        self.calls = []
        self.closed = False

    def query(self, sql, job_config=None):
        self.calls.append((sql, job_config))
        return _BQJob()

    def list_datasets(self, max_results=None):
        return [object()]

    def close(self):
        self.closed = True


def test_bigquery_job_carries_maximum_bytes_billed_even_when_dry_run_is_ambiguous(monkeypatch):
    client = _BQClient()
    monkeypatch.setattr(ds_mod, "_build_bigquery_client", lambda cfg: client)
    monkeypatch.setattr(ds_mod, "_bq_client_is_cached", lambda cfg, c: True)

    def ambiguous(cfg, sql):
        raise RuntimeError("Column name x is ambiguous")
    monkeypatch.setattr(ds_mod.DataSourceConnectionService, "_estimate_bigquery_bytes", staticmethod(ambiguous))
    monkeypatch.setattr(settings, "BQ_MAX_BYTES_BILLED", 12345, raising=False)
    ds_mod.DataSourceConnectionService.execute_user_query("bigquery", {"project_id": "p"}, "SELECT 1")
    _sql, job_config = client.calls[-1]
    assert job_config is not None and job_config.maximum_bytes_billed == 12345


def test_bigquery_internal_default_path_is_also_bounded(monkeypatch):
    client = _BQClient()
    monkeypatch.setattr(ds_mod, "_build_bigquery_client", lambda cfg: client)
    monkeypatch.setattr(ds_mod, "_bq_client_is_cached", lambda cfg, c: True)
    monkeypatch.setattr(ds_mod.DataSourceConnectionService, "_estimate_bigquery_bytes", staticmethod(lambda c, s: 1))
    monkeypatch.setattr(settings, "BQ_MAX_BYTES_BILLED", 999, raising=False)
    ds_mod.DataSourceConnectionService._execute_bigquery({"project_id": "p"}, "SELECT 1")
    assert client.calls[-1][1].maximum_bytes_billed == 999


def test_bigquery_test_connection_never_closes_a_cached_client(monkeypatch):
    client = _BQClient()
    monkeypatch.setattr(ds_mod, "_build_bigquery_client", lambda cfg: client)
    monkeypatch.setattr(ds_mod, "_bq_client_is_cached", lambda cfg, c: True)
    ok, _ = ds_mod.DataSourceConnectionService.test_connection("bigquery", {"project_id": "p"})
    assert ok is True and client.closed is False
    owned = _BQClient()
    monkeypatch.setattr(ds_mod, "_build_bigquery_client", lambda cfg: owned)
    monkeypatch.setattr(ds_mod, "_bq_client_is_cached", lambda cfg, c: False)
    ds_mod.DataSourceConnectionService.test_connection("bigquery", {"project_id": "p"})
    assert owned.closed is True


def test_user_endpoints_expose_no_cost_check_bypass():
    from app.schemas.schemas import QueryExecuteRequest, SqlValidateRequest
    for model in (QueryExecuteRequest, SqlValidateRequest):
        assert not any("cost" in f or "skip" in f for f in model.model_fields)


# ── F5: platform GCP credential ──────────────────────────────────────────────

def test_platform_gcp_credential_refused_outside_allowed_projects(monkeypatch):
    monkeypatch.setattr(settings, "GCP_SERVICE_ACCOUNT_JSON", '{"type":"service_account"}', raising=False)
    monkeypatch.setattr(settings, "PLATFORM_GCP_ALLOWED_PROJECTS", "allowed-proj", raising=False)
    with pytest.raises(ds_mod.PlatformCredentialNotAllowed):
        ds_mod._resolve_gcp_credentials_json({"project_id": "victim-proj"})
    assert ds_mod._resolve_gcp_credentials_json({"project_id": "allowed-proj"})
    # an admin-approved target works; the marker only counts for that exact target
    approved = {"project_id": "x", ds_mod.PLATFORM_GCP_APPROVAL_FIELD: "x"}
    assert ds_mod._resolve_gcp_credentials_json(approved)
    with pytest.raises(ds_mod.PlatformCredentialNotAllowed):
        ds_mod._resolve_gcp_credentials_json({"project_id": "y", ds_mod.PLATFORM_GCP_APPROVAL_FIELD: "x"})
    # the source's own credential is never affected
    assert ds_mod._resolve_gcp_credentials_json({"project_id": "victim-proj", "credentials_json": "{}"}) == "{}"


def test_platform_gcp_credential_disabled_when_no_allowlist(monkeypatch):
    monkeypatch.setattr(settings, "GCP_SERVICE_ACCOUNT_JSON", '{"type":"service_account"}', raising=False)
    monkeypatch.setattr(settings, "PLATFORM_GCP_ALLOWED_PROJECTS", "", raising=False)
    with pytest.raises(ds_mod.PlatformCredentialNotAllowed):
        ds_mod._resolve_gcp_credentials_json({"project_id": "any"})
    with pytest.raises(ds_mod.PlatformCredentialNotAllowed):
        ds_mod._resolve_gcp_credentials_json({"spreadsheet_id": "sheet"})


# ── F17: encryption + logs ───────────────────────────────────────────────────

def test_encrypt_value_never_stores_plaintext_outside_dev(monkeypatch):
    import app.core.crypto as crypto
    monkeypatch.setattr(settings, "DATASOURCE_ENCRYPTION_KEY", "", raising=False)
    monkeypatch.setattr(settings, "ENVIRONMENT", "production", raising=False)
    with pytest.raises(crypto.EncryptionNotConfiguredError):
        crypto.encrypt_value("s3cret")
    monkeypatch.setattr(settings, "DATASOURCE_ENCRYPTION_KEY", "not-a-fernet-key", raising=False)
    with pytest.raises(crypto.EncryptionNotConfiguredError):
        crypto.encrypt_config({"password": "s3cret"})
    monkeypatch.setattr(settings, "ENVIRONMENT", "test", raising=False)
    assert crypto.encrypt_value("s3cret") == "s3cret"


@pytest.mark.parametrize("key", ["", "not-a-fernet-key"])
def test_production_startup_fails_on_missing_or_invalid_key(monkeypatch, key):
    from app.core import config as cfg
    monkeypatch.setattr(settings, "ENVIRONMENT", "production", raising=False)
    monkeypatch.setattr(settings, "SECRET_KEY", "a-real-secret-key-value-for-this-test-only", raising=False)
    monkeypatch.setattr(settings, "AUTH_GOOGLE_ENABLED", False, raising=False)
    monkeypatch.setattr(settings, "DATASOURCE_ENCRYPTION_KEY", key, raising=False)
    with pytest.raises(RuntimeError, match="DATASOURCE_ENCRYPTION_KEY"):
        cfg.validate_security_settings()


def test_production_startup_accepts_a_valid_key(monkeypatch):
    from cryptography.fernet import Fernet
    from app.core import config as cfg
    monkeypatch.setattr(settings, "ENVIRONMENT", "production", raising=False)
    monkeypatch.setattr(settings, "SECRET_KEY", "a-real-secret-key-value-for-this-test-only", raising=False)
    monkeypatch.setattr(settings, "AUTH_GOOGLE_ENABLED", False, raising=False)
    monkeypatch.setattr(settings, "DATASOURCE_ENCRYPTION_KEY", Fernet.generate_key().decode(), raising=False)
    cfg.validate_security_settings()


def test_failed_query_logs_no_sql_text(monkeypatch, caplog):
    marker = "zz_private_column_marker"
    monkeypatch.setattr(netpol, "resolve_and_check", lambda host, port=None: "93.184.216.34")

    def boom(**kw):
        raise RuntimeError("server closed the connection")
    monkeypatch.setattr(ds_mod.psycopg2, "connect", boom)
    caplog.set_level(logging.DEBUG)
    with pytest.raises(Exception):
        ds_mod.DataSourceConnectionService.execute_query(
            "postgresql", {"host": "pg.example"}, f"SELECT {marker} FROM t")
    assert "Query execution failed" in caplog.text
    assert marker not in caplog.text


def test_bigquery_failure_logs_no_sql_text(monkeypatch, caplog):
    marker = "zz_private_bq_marker"

    class _Failing(_BQClient):
        def query(self, sql, job_config=None):
            raise RuntimeError("Syntax error: unexpected keyword")

    monkeypatch.setattr(ds_mod, "_build_bigquery_client", lambda cfg: _Failing())
    monkeypatch.setattr(ds_mod, "_bq_client_is_cached", lambda cfg, c: True)
    caplog.set_level(logging.DEBUG)
    with pytest.raises(Exception):
        ds_mod.DataSourceConnectionService._execute_bigquery(
            {"project_id": "p"}, f"SELECT {marker}", skip_cost_check=True)
    assert marker not in caplog.text
