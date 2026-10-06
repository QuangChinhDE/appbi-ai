"""Source hardening Phase B — provider capabilities (F15) and structured
connection health (F16).

Locks: one capability table; google_docs is non-tabular and refused by every
tabular path (service: SourceNotTabularError; HTTP: 400 code
source_not_tabular) while its own test still works; the DataSource response
exposes capabilities + last health; the connection test returns
{success, status, provider, checks, error_code, message, warnings,
duration_ms, tested_at} from BOTH /test and /test-draft; BigQuery "SELECT 1 ok
but listing fails" is a WARNING with discoverable=failed; errors are classified
by exception type / structured attributes; /test persists the last health and
audits a failure category, never a secret.
"""
from __future__ import annotations

import socket

import pytest

from source_phase_b_support import OWNER, make_db, make_http, pg_config

DOCS_CFG = {"auth_mode": "google_oauth", "google_oauth_credentials": '{"refresh_token": "r"}',
            "google_oauth_email": "a@example.com"}
USERS = {OWNER: {"data_sources": "edit", "datasets": "edit"}}


@pytest.fixture()
def S(monkeypatch):
    return make_db(monkeypatch)


def _source(S, name, ds_type="postgresql", config=None):
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService
    with S() as s:
        return DataSourceCRUDService.create(
            s, DataSourceCreate(name=name, type=ds_type, config=config or pg_config()), owner_id=OWNER).id


# ── capabilities ─────────────────────────────────────────────────────────────

def test_capability_table_covers_every_provider():
    from app.schemas.schemas import DataSourceTypeSchema
    from app.services.source_capabilities import CAPABILITY_KEYS, capabilities_for
    for t in DataSourceTypeSchema:
        caps = capabilities_for(t.value)
        assert set(caps) == set(CAPABILITY_KEYS) and caps["test"] is True, t
    docs = capabilities_for("google_docs")
    assert (docs["tabular"], docs["query"], docs["discover"]) == (False, False, False)
    assert capabilities_for("postgresql")["tabular"] is True
    assert capabilities_for("unknown-provider") == {k: False for k in CAPABILITY_KEYS}


@pytest.mark.parametrize("call", ["list_tables", "schema", "columns", "query", "validate", "infer"])
def test_service_refuses_tabular_operations_on_google_docs(call):
    from app.services.datasource_service import DataSourceConnectionService as C
    from app.services.source_capabilities import SourceNotTabularError
    ops = {
        "list_tables": lambda: C.list_tables("google_docs", DOCS_CFG),
        "schema": lambda: C.get_schema_browser("google_docs", DOCS_CFG),
        "columns": lambda: C.list_columns(1, "google_docs", DOCS_CFG, "t"),
        "query": lambda: C.execute_query("google_docs", DOCS_CFG, "SELECT 1"),
        "validate": lambda: C.validate_user_sql("google_docs", DOCS_CFG, "SELECT 1"),
        "infer": lambda: C.infer_column_types("google_docs", DOCS_CFG, "SELECT 1"),
    }
    with pytest.raises(SourceNotTabularError) as exc:
        ops[call]()
    assert exc.value.code == "source_not_tabular"


def test_http_tabular_paths_refuse_google_docs_with_a_code(S, monkeypatch):
    docs = _source(S, "Docs", "google_docs", DOCS_CFG)
    call = make_http(monkeypatch, S, USERS)
    for method, path, body in (
        ("GET", f"/datasources/{docs}/schema", None),
        ("GET", f"/datasources/{docs}/tables/s/t", None),
        ("POST", "/datasources/query", {"data_source_id": docs, "sql_query": "SELECT 1"}),
        ("POST", "/datasources/validate-sql", {"data_source_id": docs, "sql_query": "SELECT 1"}),
        ("GET", f"/datasets/datasources/{docs}/tables", None),
        ("GET", f"/datasets/datasources/{docs}/tables/columns?table=t", None),
    ):
        r = call(OWNER, method, path, json=body)
        assert r.status_code == 400, (path, r.status_code, r.text)
        assert r.json()["detail"]["code"] == "source_not_tabular", path


def test_response_exposes_capabilities_and_health(S, monkeypatch):
    docs = _source(S, "Docs", "google_docs", DOCS_CFG)
    pg = _source(S, "PG")
    call = make_http(monkeypatch, S, USERS)
    body = {d["id"]: d for d in call(OWNER, "GET", "/datasources/").json()}
    assert body[docs]["capabilities"]["tabular"] is False
    assert body[pg]["capabilities"]["tabular"] is True
    for key in ("config_version", "last_test_status", "last_tested_at", "last_error_code"):
        assert key in body[pg]


# ── classification ───────────────────────────────────────────────────────────

def test_errors_are_classified_by_type_and_attributes():
    from google.api_core import exceptions as gexc
    from google.auth.exceptions import RefreshError

    from app.services.source_errors import classify_source_error as c
    from app.services.source_network_policy import SourceNetworkPolicyError

    class _PgErr(Exception):
        def __init__(self, code):
            super().__init__("x")
            self.pgcode = code
    assert c(_PgErr("28P01")) == "auth"
    assert c(_PgErr("3D000")) == "missing_resource"
    assert c(_PgErr("42501")) == "permission"
    assert c(_PgErr("57014")) == "timeout"
    assert c(gexc.Forbidden("denied")) == "permission"
    assert c(gexc.Forbidden("quotaExceeded: quota")) == "quota"
    assert c(gexc.NotFound("nope")) == "missing_resource"
    assert c(gexc.TooManyRequests("slow down")) == "quota"
    assert c(gexc.BadRequest("Syntax error")) == "query"
    assert c(RefreshError("invalid_grant")) == "auth"
    assert c(SourceNetworkPolicyError("loopback")) == "policy_blocked"
    assert c(socket.timeout()) == "timeout"
    assert c(socket.gaierror("x")) == "network"
    assert c(ValueError("Spreadsheet ID is required")) == "invalid_config"
    import pymysql
    assert c(pymysql.err.OperationalError(1045, "Access denied")) == "auth"
    assert c(pymysql.err.OperationalError(2003, "Can't connect")) == "network"


# ── structured test results ──────────────────────────────────────────────────

class _Query:
    def result(self):
        return []


class _BQ:
    def __init__(self, list_error=None, query_error=None):
        self.list_error, self.query_error = list_error, query_error

    def query(self, _sql):
        if self.query_error:
            raise self.query_error
        return _Query()

    def list_datasets(self, **_k):
        if self.list_error:
            raise self.list_error
        return [object()]

    def list_tables(self, *_a, **_k):
        return self.list_datasets()

    def close(self):
        pass


def test_bigquery_query_ok_but_listing_fails_is_a_warning(monkeypatch):
    from google.api_core import exceptions as gexc

    import app.services.datasource_service as dsm
    from app.services.source_health import run_connection_test
    monkeypatch.setattr(dsm, "_build_bigquery_client",
                        lambda cfg: _BQ(list_error=gexc.Forbidden("bigquery.datasets.list denied")))
    r = run_connection_test("bigquery", {"project_id": "p"})
    assert r["success"] is True and r["status"] == "warning"
    assert r["checks"] == {"auth": "ok", "reachable": "ok", "queryable": "ok", "discoverable": "failed"}
    assert r["error_code"] == "permission" and r["warnings"]
    assert r["provider"] == "bigquery" and isinstance(r["duration_ms"], int) and r["tested_at"]


def test_bigquery_full_success_and_query_failure(monkeypatch):
    from google.api_core import exceptions as gexc

    import app.services.datasource_service as dsm
    from app.services.source_health import run_connection_test
    monkeypatch.setattr(dsm, "_build_bigquery_client", lambda cfg: _BQ())
    ok = run_connection_test("bigquery", {"project_id": "p"})
    assert ok["status"] == "ok" and set(ok["checks"].values()) == {"ok"} and ok["error_code"] is None
    monkeypatch.setattr(dsm, "_build_bigquery_client",
                        lambda cfg: _BQ(query_error=gexc.Unauthenticated("token revoked")))
    bad = run_connection_test("bigquery", {"project_id": "p"})
    assert bad["success"] is False and bad["status"] == "error" and bad["error_code"] == "auth"
    assert bad["checks"]["auth"] == "failed"


def test_policy_refusal_is_policy_blocked(monkeypatch):
    from app.core.config import settings
    from app.services.source_health import run_connection_test
    monkeypatch.setattr(settings, "SOURCE_ALLOW_PRIVATE_NETWORK", False, raising=False)
    monkeypatch.setattr(settings, "ALLOWED_PRIVATE_SOURCE_CIDRS", "", raising=False)
    r = run_connection_test("postgresql", pg_config(host="169.254.169.254"))
    assert r["status"] == "error" and r["error_code"] == "policy_blocked"
    assert r["checks"]["reachable"] == "failed"


def test_saved_test_persists_health_and_audits_failure_without_secrets(S, monkeypatch):
    import app.services.datasource_service as dsm
    from app.models.audit_log import AuditLog
    from app.models.models import DataSource
    secret = "pw-A-secret"
    pg = _source(S, "PG", config=pg_config(password=secret))

    class _PgErr(Exception):
        pgcode = "28P01"

    def boom(**_kw):
        raise _PgErr(f"password authentication failed for user analyst password={secret}")
    monkeypatch.setattr(dsm, "_pg_connect", boom)
    call = make_http(monkeypatch, S, USERS)
    r = call(OWNER, "POST", f"/datasources/{pg}/test")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is False and body["status"] == "error" and body["error_code"] == "auth"
    assert body["checks"]["auth"] == "failed" and secret not in r.text
    with S() as s:
        row = s.get(DataSource, pg)
        assert (row.last_test_status, row.last_error_code) == ("error", "auth") and row.last_tested_at
        audits = s.query(AuditLog).filter(AuditLog.action == "datasource_test_failed").all()
        assert len(audits) == 1 and audits[0].details["error_code"] == "auth"
        assert secret not in str(audits[0].details)
    listed = {d["id"]: d for d in call(OWNER, "GET", "/datasources/").json()}
    assert listed[pg]["last_test_status"] == "error"


def test_draft_test_is_structured_and_reuses_stored_secret_when_editing(S, monkeypatch):
    import app.services.datasource_service as dsm
    pg = _source(S, "PG")
    seen = {}

    class _Conn:
        def close(self):
            pass

    monkeypatch.setattr(dsm, "_pg_connect", lambda **kw: seen.update(kw) or _Conn())
    call = make_http(monkeypatch, S, USERS)
    r = call(OWNER, "POST", "/datasources/test-draft",
             json={"type": "postgresql", "config": {**pg_config(), "password": ""}, "data_source_id": pg})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok" and body["checks"]["auth"] == "ok" and body["provider"] == "postgresql"
    assert seen["password"] == "pw-A-secret"
    assert "pw-A-secret" not in r.text


def test_config_change_resets_stale_health(S, monkeypatch):
    from app.models.models import DataSource
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    pg = _source(S, "PG")
    with S() as s:
        row = s.get(DataSource, pg)
        row.last_test_status, row.last_error_code = "error", "auth"
        s.commit()
        DataSourceCRUDService.update(s, pg, DataSourceUpdate(config={"password": "new-pw"}))
        row = s.get(DataSource, pg)
        assert row.last_test_status is None and row.last_error_code is None
