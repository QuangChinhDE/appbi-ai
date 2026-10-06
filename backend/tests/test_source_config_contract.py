"""Source hardening Phase B — the config chokepoint (F8/F12, F17).

Locks: `type` immutable after create (service + HTTP 400); update = load →
merge → restore masked secrets EXACTLY ONCE → auth-mode rules → validate the
FINAL config → persist atomically; an invalid final config persists nothing;
`config_version` moves only on a connection change; names unique PER OWNER
without consulting other owners; `sync_config`/`sync_jobs` retired.
"""
from __future__ import annotations

import pytest

from source_phase_b_support import OTHER, OWNER, make_db, make_http, no_network, pg_config


@pytest.fixture()
def S(monkeypatch):
    return make_db(monkeypatch)


def _create(S, name="Sales", owner=OWNER, ds_type="postgresql", config=None):
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService
    with S() as s:
        ds = DataSourceCRUDService.create(
            s, DataSourceCreate(name=name, type=ds_type, config=config or pg_config()), owner_id=owner)
        return ds.id, ds.name


def _row(S, ds_id):
    from app.core.crypto import decrypt_config
    from app.models.models import DataSource
    with S() as s:
        ds = s.get(DataSource, ds_id)
        return ds, decrypt_config(dict(ds.config))


# ── type immutability ────────────────────────────────────────────────────────

def test_type_change_is_refused_by_the_service(S):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceConfigError
    ds_id, _ = _create(S)
    with S() as s, pytest.raises(SourceConfigError) as exc:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(type="mysql", config=pg_config()))
    assert exc.value.code == "source_type_immutable"
    ds, cfg = _row(S, ds_id)
    assert ds.type.value == "postgresql" and ds.config_version == 1


def test_type_change_is_refused_over_http_with_a_code(S, monkeypatch):
    no_network(monkeypatch)
    ds_id, _ = _create(S)
    call = make_http(monkeypatch, S, {OWNER: {"data_sources": "edit"}})
    r = call(OWNER, "PUT", f"/datasources/{ds_id}", json={"type": "mysql"})
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["code"] == "source_type_immutable"
    # Same type is accepted (a no-op for the type).
    assert call(OWNER, "PUT", f"/datasources/{ds_id}", json={"type": "postgresql", "name": "Sales2"}).status_code == 200


# ── secrets + merge ──────────────────────────────────────────────────────────

def test_masked_secret_is_restored_exactly_once_on_http_update(S, monkeypatch):
    import app.services.source_lifecycle as lifecycle
    seen = no_network(monkeypatch)
    ds_id, _ = _create(S)
    calls = []
    real = lifecycle.restore_masked_secrets

    def counting(cfg, stored):
        calls.append(1)
        return real(cfg, stored)
    monkeypatch.setattr(lifecycle, "restore_masked_secrets", counting)
    call = make_http(monkeypatch, S, {OWNER: {"data_sources": "edit"}})
    # Same destination + masked secret (S4: a changed destination would refuse).
    r = call(OWNER, "PUT", f"/datasources/{ds_id}",
             json={"config": {**pg_config(), "password": "__stored__"}})
    assert r.status_code == 200, r.text
    assert len(calls) == 1, "masked secrets must be restored exactly once per update"
    ds, cfg = _row(S, ds_id)
    assert cfg["password"] == "pw-A-secret" and cfg["host"] == "db-a.example.com"
    assert seen == []  # nothing connection-relevant changed → no test
    assert r.json()["config"]["password"] == "__stored__"  # never echoed


# ── S4: a stored secret never follows a changed destination ──────────────────

@pytest.mark.parametrize("field,value", [
    ("host", "evil.example.com"), ("port", 6543), ("database", "other"), ("username", "root"),
])
@pytest.mark.parametrize("secret", ["__stored__", "", None])
def test_changed_destination_with_a_masked_secret_requires_the_credential(S, monkeypatch, field, value, secret):
    seen = no_network(monkeypatch)
    ds_id, _ = _create(S)
    call = make_http(monkeypatch, S, {OWNER: {"data_sources": "edit"}})
    cfg = {**pg_config(), field: value}
    if secret is None:
        cfg.pop("password")
    else:
        cfg["password"] = secret
    r = call(OWNER, "PUT", f"/datasources/{ds_id}", json={"config": cfg})
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["code"] == "credential_required"
    assert seen == []  # the stored secret was never sent anywhere
    ds, stored = _row(S, ds_id)
    assert stored == {**pg_config()}
    assert ds.config_version == 1


def test_partial_update_changing_only_the_host_requires_the_credential(S):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceConfigError
    ds_id, _ = _create(S)
    with S() as s, pytest.raises(SourceConfigError) as exc:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(config={"host": "evil.example.com"}))
    assert exc.value.code == "credential_required"


def test_changed_destination_with_a_new_secret_is_accepted(S, monkeypatch):
    seen = no_network(monkeypatch)
    ds_id, _ = _create(S)
    call = make_http(monkeypatch, S, {OWNER: {"data_sources": "edit"}})
    r = call(OWNER, "PUT", f"/datasources/{ds_id}",
             json={"config": pg_config(host="db-b.example.com", password="pw-B-new")})
    assert r.status_code == 200, r.text
    assert seen[-1][1]["password"] == "pw-B-new" and seen[-1][1]["host"] == "db-b.example.com"


def test_namespace_change_keeps_the_stored_secret(S):
    """schema_name/default_dataset pick a namespace on the SAME server/project."""
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    ds_id, _ = _create(S)
    with S() as s:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(config={**pg_config(), "password": "__stored__",
                                                                        "schema_name": "mart"}))
    _ds, cfg = _row(S, ds_id)
    assert cfg["password"] == "pw-A-secret" and cfg["schema_name"] == "mart"


def test_destination_fields_have_one_definition():
    import inspect
    import app.api.datasources as api
    from app.services import source_lifecycle
    assert not hasattr(api, "_DESTINATION_FIELDS")
    assert "changed_destination_fields" in inspect.getsource(api.test_draft_data_source_connection)
    assert "host" in source_lifecycle.DESTINATION_FIELDS


def test_router_has_no_second_restore_or_invalidation_path():
    import inspect
    import app.api.datasources as api
    src = inspect.getsource(api.update_data_source) + inspect.getsource(api.create_data_source)
    for forbidden in ("_restore_sensitive_config_fields", "evict_bigquery_client_cache",
                      "invalidate_datasource", "validate_datasource_config", "columns_cache"):
        assert forbidden not in src, forbidden


def test_partial_config_update_merges_with_stored_values(S):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    ds_id, _ = _create(S)
    with S() as s:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(config={"schema_name": "sales"}))
    ds, cfg = _row(S, ds_id)
    assert cfg == {**pg_config(), "schema_name": "sales"}
    assert ds.config_version == 2


def test_invalid_final_config_persists_nothing(S):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceConfigError
    ds_id, _ = _create(S)
    with S() as s, pytest.raises(SourceConfigError) as exc:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(name="Renamed", config={"port": 99999, "password": "new"}))
    assert exc.value.code == "invalid_config"
    ds, cfg = _row(S, ds_id)
    assert ds.name == "Sales" and cfg["port"] == 5432 and ds.config_version == 1


def test_failed_connection_test_persists_nothing(S, monkeypatch):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceConfigError
    ds_id, _ = _create(S)
    no_network(monkeypatch, ok=False)
    with S() as s, pytest.raises(SourceConfigError) as exc:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(config=pg_config(host="db-x.example.com")),
                                     test_connection=True)
    assert exc.value.code == "connection_auth"
    ds, cfg = _row(S, ds_id)
    assert cfg["host"] == "db-a.example.com" and ds.config_version == 1


def test_rename_does_not_bump_config_version(S):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    ds_id, _ = _create(S)
    with S() as s:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(name="Renamed", config=pg_config()))
    ds, _cfg = _row(S, ds_id)
    assert ds.name == "Renamed" and ds.config_version == 1


# ── auth-mode transitions ────────────────────────────────────────────────────

SA_JSON = '{"type": "service_account", "private_key": "STALE-SA-KEY"}'


def test_switch_service_account_to_oauth_does_not_inherit_the_sa_key(S, monkeypatch):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceConfigError
    ds_id, _ = _create(S, ds_type="bigquery", config={"project_id": "p", "credentials_json": SA_JSON})
    # Switching without a fresh Google consent is refused, nothing persisted.
    with S() as s, pytest.raises(SourceConfigError):
        DataSourceCRUDService.update(
            s, ds_id, DataSourceUpdate(config={"project_id": "p", "auth_mode": "google_oauth",
                                               "credentials_json": "__stored__"}))
    _ds, cfg = _row(S, ds_id)
    assert cfg["credentials_json"] == SA_JSON and cfg.get("auth_mode", "service_account") == "service_account"


def test_switch_oauth_to_service_account_drops_the_google_token(S):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    ds_id, _ = _create(S, ds_type="bigquery", config={
        "project_id": "p", "auth_mode": "google_oauth",
        "google_oauth_credentials": '{"refresh_token": "rt-A"}', "google_oauth_email": "a@x.com",
        "google_oauth_user_id": str(OWNER)})
    new_sa = '{"type": "service_account", "private_key": "NEW"}'
    with S() as s:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(config={
            "project_id": "p", "auth_mode": "service_account", "credentials_json": new_sa,
            "google_oauth_credentials": "__stored__"}))
    ds, cfg = _row(S, ds_id)
    assert cfg["auth_mode"] == "service_account" and cfg["credentials_json"] == new_sa
    for k in ("google_oauth_credentials", "google_oauth_email", "google_oauth_user_id", "google_pending_id"):
        assert k not in cfg, k
    assert ds.config_version == 2


def test_same_mode_oauth_update_keeps_the_sources_own_credential(S):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    ds_id, _ = _create(S, ds_type="bigquery", config={
        "project_id": "p", "auth_mode": "google_oauth",
        "google_oauth_credentials": '{"refresh_token": "rt-A"}', "google_oauth_email": "a@x.com"})
    with S() as s:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(config={
            "project_id": "p", "auth_mode": "google_oauth", "default_dataset": "sales"}))
    _ds, cfg = _row(S, ds_id)
    assert cfg["google_oauth_credentials"] == '{"refresh_token": "rt-A"}' and cfg["default_dataset"] == "sales"


# ── provider schemas keep what connectors read ───────────────────────────────

def test_provider_schemas_do_not_drop_keys_connectors_need():
    from app.schemas.datasource_config import validate_datasource_config as v
    assert v("postgresql", {**pg_config(), "schema": "mart"})["schema"] == "mart"
    bq = v("bigquery", {"project_id": "p", "auth_mode": "google_oauth", "google_pending_id": "h",
                        "google_oauth_credentials": "c", "google_oauth_scopes": ["s"]})
    assert bq["google_pending_id"] == "h" and bq["google_oauth_credentials"] == "c"
    assert bq["google_oauth_scopes"] == ["s"]
    assert "default_dataset" not in bq  # absent optional stays absent (exclude_none)


# ── names: unique per owner ──────────────────────────────────────────────────

def test_same_name_is_allowed_for_two_owners_and_suffixed_within_one(S):
    _id1, n1 = _create(S, name="Sales", owner=OWNER)
    _id2, n2 = _create(S, name="Sales", owner=OTHER)
    _id3, n3 = _create(S, name="Sales", owner=OWNER)
    assert (n1, n2, n3) == ("Sales", "Sales", "Sales (1)")


def test_name_resolution_does_not_consult_other_owners(S):
    from app.services.datasource_crud_service import DataSourceCRUDService
    _create(S, name="Secret Project", owner=OTHER)
    with S() as s:
        assert DataSourceCRUDService._resolve_unique_name(s, "Secret Project", owner_id=OWNER) == "Secret Project"


def test_owner_name_unique_index_is_declared():
    from app.models.models import DataSource
    idx = {i.name: i for i in DataSource.__table__.indexes}
    assert idx["uq_data_sources_owner_name"].unique
    assert [c.name for c in idx["uq_data_sources_owner_name"].columns] == ["owner_id", "name"]
    assert idx["uq_data_sources_ownerless_name"].unique
    assert not DataSource.__table__.c.name.unique


# ── retired legacy ───────────────────────────────────────────────────────────

def test_sync_config_and_sync_jobs_are_retired():
    import app.models as models
    from app.models.models import DataSource
    assert "sync_config" not in DataSource.__table__.c
    assert not hasattr(models, "SyncJob")
    assert "config_version" in DataSource.__table__.c


def _load_migration_0003():
    import importlib.util
    import pathlib
    path = (pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
            / "20261006_0003_source_domain_hardening.py")
    spec = importlib.util.spec_from_file_location("mig_20261006_0003", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_migration_0003_retires_sync_storage_without_losing_data():
    """S9: upgrade keeps every sync_jobs row and every non-null sync_config."""
    import json

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import create_engine, text

    mig = _load_migration_0003()
    engine = create_engine("sqlite://")
    with engine.begin() as c:
        c.execute(text("CREATE TABLE data_sources (id INTEGER PRIMARY KEY, name VARCHAR(255), "
                       "owner_id CHAR(36), sync_config JSON)"))
        c.execute(text("CREATE UNIQUE INDEX ix_data_sources_name ON data_sources (name)"))
        c.execute(text("CREATE TABLE sync_jobs (id INTEGER PRIMARY KEY, data_source_id INTEGER NOT NULL "
                       "REFERENCES data_sources(id) ON DELETE CASCADE, status VARCHAR(20))"))
        c.execute(text("CREATE INDEX ix_sync_jobs_id ON sync_jobs (id)"))
        c.execute(text("CREATE INDEX ix_sync_jobs_data_source_id ON sync_jobs (data_source_id)"))
        c.execute(text("INSERT INTO data_sources VALUES (1, 'a', NULL, :cfg), (2, 'b', NULL, NULL)"),
                  {"cfg": json.dumps({"schedule": "daily"})})
        c.execute(text("INSERT INTO sync_jobs VALUES (10, 1, 'success'), (11, 2, 'failed')"))
        with Operations.context(MigrationContext.configure(c)):
            mig.upgrade()
        jobs = c.execute(text("SELECT id, data_source_id, status FROM sync_jobs_retired ORDER BY id")).all()
        cfgs = c.execute(text("SELECT datasource_id, sync_config FROM data_source_sync_config_retired")).all()
        cols = [r[1] for r in c.execute(text("PRAGMA table_info(data_sources)")).all()]
    assert [tuple(j) for j in jobs] == [(10, 1, "success"), (11, 2, "failed")]
    assert len(cfgs) == 1 and cfgs[0][0] == 1 and json.loads(cfgs[0][1]) == {"schedule": "daily"}
    assert "sync_config" not in cols


def test_migration_0003_downgrade_restores_from_the_retired_storage():
    import inspect
    src = inspect.getsource(_load_migration_0003().downgrade)
    assert "data_source_sync_config_retired" in src and "sync_jobs_retired" in src
    assert "drop_table(\"sync_jobs" not in src


# ── optimistic concurrency (no lock across the connection test) ─────────────

def test_update_interleaved_during_the_test_is_a_conflict_not_an_overwrite(S, monkeypatch):
    """B's snapshot is taken before A rotates the password; A commits while B's
    connection test runs → B gets source_conflict, A's password survives."""
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.source_lifecycle import SourceConfigError
    import app.services.datasource_crud_service as crud
    ds_id, _ = _create(S)
    inval = []
    monkeypatch.setattr(crud, "invalidate_source", lambda *a, **k: inval.append(1) or {})
    fired = []

    def test_then_a_commits(ds_type, config):
        if not fired:
            fired.append(1)
            with S() as s2:  # A: rotate the password (its own test passes)
                DataSourceCRUDService.update(s2, ds_id, DataSourceUpdate(config=pg_config(password="pw-ROTATED")),
                                             test_connection=True)
        return True, "ok"
    monkeypatch.setattr(DataSourceConnectionService, "test_connection", staticmethod(test_then_a_commits))
    with S() as s, pytest.raises(SourceConfigError) as exc:  # B: namespace change + masked secret (a port change with a masked secret is refused by S4)
        DataSourceCRUDService.update(
            s, ds_id, DataSourceUpdate(config={**pg_config(), "schema_name": "mart", "password": "__stored__"}),
            test_connection=True)
    assert exc.value.code == "source_conflict" and exc.value.status_code == 409
    ds, cfg = _row(S, ds_id)
    assert cfg["password"] == "pw-ROTATED" and "schema_name" not in cfg and ds.config_version == 2
    assert inval == [1]  # A only


def test_failed_test_changes_nothing_and_invalidates_nothing(S, monkeypatch):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.source_lifecycle import SourceConfigError
    import app.services.datasource_crud_service as crud
    ds_id, _ = _create(S)
    inval = []
    monkeypatch.setattr(crud, "invalidate_source", lambda *a, **k: inval.append(1) or {})
    no_network(monkeypatch, ok=False)
    with S() as s, pytest.raises(SourceConfigError):
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(name="Renamed", config=pg_config(host="db-x.example.com")),
                                     test_connection=True)
    ds, cfg = _row(S, ds_id)
    assert (ds.name, cfg["host"], ds.config_version, inval) == ("Sales", "db-a.example.com", 1, [])


def test_stale_client_config_version_is_409_over_http(S, monkeypatch):
    no_network(monkeypatch)
    ds_id, _ = _create(S)
    call = make_http(monkeypatch, S, {OWNER: {"data_sources": "edit"}})
    r = call(OWNER, "PUT", f"/datasources/{ds_id}", json={"config": pg_config(host="db-b.example.com"),
                                                           "config_version": 1})
    assert r.status_code == 200 and r.json()["config_version"] == 2, r.text
    r = call(OWNER, "PUT", f"/datasources/{ds_id}", json={"name": "Stale", "config_version": 1})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "source_conflict"
    ds, cfg = _row(S, ds_id)
    assert ds.name == "Sales" and cfg["host"] == "db-b.example.com"


def test_connection_test_timeouts_are_bounded_and_named(monkeypatch):
    import app.services.datasource_service as svc
    assert 0 < svc.CONNECTION_TEST_CONNECT_TIMEOUT_S <= 10
    assert 0 < svc.CONNECTION_TEST_API_TIMEOUT_S <= 30
    assert 1 <= svc.CONNECTION_TEST_SHEETS_ATTEMPTS <= 2
    seen = {}
    monkeypatch.setattr(svc, "_pg_connect", lambda **kw: seen.setdefault("pg", kw) and (_ for _ in ()).throw(OSError("x")))
    monkeypatch.setattr(svc, "_mysql_connect", lambda **kw: seen.setdefault("my", kw) and (_ for _ in ()).throw(OSError("x")))
    svc.DataSourceConnectionService._test_postgresql({"host": "h"})
    svc.DataSourceConnectionService._test_mysql({"host": "h"})
    assert seen["pg"]["connect_timeout"] == svc.CONNECTION_TEST_CONNECT_TIMEOUT_S
    assert seen["my"]["connect_timeout"] == svc.CONNECTION_TEST_CONNECT_TIMEOUT_S

    calls = []

    class Job:
        def result(self, timeout=None):
            calls.append(("result", timeout))

    class Client:
        def query(self, q, timeout=None):
            calls.append(("query", timeout))
            return Job()

        def list_datasets(self, max_results=None, timeout=None):
            calls.append(("list_datasets", timeout))
            return [1]

        def close(self):
            pass
    monkeypatch.setattr(svc, "_build_bigquery_client", lambda cfg: Client())
    monkeypatch.setattr(svc, "_bq_client_is_cached", lambda cfg, c: True)
    assert svc.DataSourceConnectionService._test_bigquery({"project_id": "p"})[0]
    assert calls and all(t == svc.CONNECTION_TEST_API_TIMEOUT_S for _, t in calls), calls

    class Conn:
        max_attempts = None

        def test_connection(self, sid):
            seen["sheets_attempts"] = self.max_attempts
            return False
    monkeypatch.setattr(svc, "create_google_sheets_connector", lambda cfg: Conn())
    svc.DataSourceConnectionService._test_google_sheets({"spreadsheet_id": "x"})
    assert seen["sheets_attempts"] == svc.CONNECTION_TEST_SHEETS_ATTEMPTS


# ── create-time connection test is the source's first health ─────────────────

def test_create_with_a_connection_test_records_health(S, monkeypatch):
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService
    no_network(monkeypatch, ok=True)
    with S() as s:
        ds = DataSourceCRUDService.create(s, DataSourceCreate(name="H", type="postgresql", config=pg_config()),
                                          owner_id=OWNER, test_connection=True)
        ds_id = ds.id
    row, _cfg = _row(S, ds_id)
    assert row.last_test_status == "ok"
    assert row.last_tested_at is not None and row.last_error_code is None


def test_create_without_a_connection_test_records_no_health(S):
    ds_id, _ = _create(S)
    row, _cfg = _row(S, ds_id)
    assert row.last_test_status is None and row.last_tested_at is None


def test_update_that_retests_records_the_new_health(S, monkeypatch):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    ds_id, _ = _create(S)
    no_network(monkeypatch, ok=True)
    with S() as s:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(config=pg_config(host="db-b.example.com")),
                                     test_connection=True)
    row, _cfg = _row(S, ds_id)
    assert row.last_test_status == "ok" and row.last_tested_at is not None
