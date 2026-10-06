"""Source hardening — permission contracts through the REAL routing + auth stack.

Spec (docs/features/source-core-hardening/spec.md, permission mapping):

  saved-source retest  POST /datasources/{id}/test    object edit
  draft config test    POST /datasources/test-draft   module edit; a stored secret
                       only with object edit, same type, identical destination
  raw SQL              /query, /validate-sql           object edit
  Sheets mutations     /datasources/{id}/gsheets/*     object full

Every request goes through the real FastAPI router, the real `module_floor`, the
real session-JWT auth dependency and the real object-permission resolution
(ownership + ResourceShare) on in-memory SQLite. Only the outbound driver/
connector is replaced, so nothing here reaches a network.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core import get_db
from app.core.database import Base
from app.models.models import DataSource
from app.models.resource_share import ResourceShare
from app.models.revoked_token import RevokedToken
from app.models.team import Team, TeamMembership
from app.models.user import User, UserStatus


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


TABLES = [User.__table__, RevokedToken.__table__, Team.__table__, TeamMembership.__table__,
          ResourceShare.__table__, DataSource.__table__]

OWNER = uuid.UUID("aaaaaaaa-0000-0000-0000-00000000000f")    # object full (owner, module edit)
EDITOR = uuid.UUID("aaaaaaaa-0000-0000-0000-00000000000e")   # object edit (share)
VIEWER = uuid.UUID("aaaaaaaa-0000-0000-0000-00000000000b")   # object view (share)
STRANGER = uuid.UUID("aaaaaaaa-0000-0000-0000-00000000000a")  # module edit, no relation
MODVIEW = uuid.UUID("aaaaaaaa-0000-0000-0000-00000000000c")  # module view only
ADMIN = uuid.UUID("aaaaaaaa-0000-0000-0000-0000000000ad")    # settings full

STORED_SECRET = "STORED-pg-secret-9f3a"
PG_ID, SHEET_ID = 1, 2
PG_CONFIG = {"host": "db.example.com", "port": 5432, "database": "sales", "username": "analyst",
             "password": STORED_SECRET, "schema_name": "public"}
SHEET_CONFIG = {"spreadsheet_id": "sheet-abc", "credentials_json": '{"k": "STORED-sheet-secret"}'}


@pytest.fixture()
def env(monkeypatch):
    import app.api.datasources as api
    import app.services.datasource_service as ds_mod
    from app.api.auth import create_access_token
    from app.core.config import settings

    monkeypatch.setattr(settings, "ENVIRONMENT", "test", raising=False)
    saved = []
    for table in TABLES:
        for col in table.columns:
            sd = col.server_default
            if sd is not None and "::" in str(getattr(sd, "arg", "")):
                saved.append((col, sd))
                col.server_default = None
    engine = create_engine("sqlite://", future=True, connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    try:
        Base.metadata.create_all(engine, tables=TABLES)
    finally:
        for col, sd in saved:
            col.server_default = sd
    S = sessionmaker(bind=engine, future=True)

    def _db():
        s = S()
        try:
            yield s
        finally:
            s.close()

    monkeypatch.setattr(api._limiter, "enabled", False)
    app = FastAPI()
    app.state.limiter = api._limiter
    app.include_router(api.router)
    app.dependency_overrides[get_db] = _db

    users = {
        OWNER: {"data_sources": "edit"}, EDITOR: {"data_sources": "edit"},
        VIEWER: {"data_sources": "edit"}, STRANGER: {"data_sources": "edit"},
        MODVIEW: {"data_sources": "view"}, ADMIN: {"settings": "full"},
    }
    tokens = {}
    with S() as s:
        for uid, perms in users.items():
            s.add(User(id=uid, email=f"{uid}@example.com", full_name=str(uid), password_hash="x",
                       status=UserStatus.ACTIVE, permissions=dict(perms), google_oauth_scopes=[]))
        s.add(DataSource(id=PG_ID, name="pg", type="postgresql", config=dict(PG_CONFIG), owner_id=OWNER))
        s.add(DataSource(id=SHEET_ID, name="sheet", type="google_sheets", config=dict(SHEET_CONFIG),
                         owner_id=OWNER))
        for rid in (PG_ID, SHEET_ID):
            s.add(ResourceShare(resource_type="datasource", resource_id=str(rid), user_id=EDITOR,
                                permission="edit", shared_by=OWNER))
            s.add(ResourceShare(resource_type="datasource", resource_id=str(rid), user_id=VIEWER,
                                permission="view", shared_by=OWNER))
        s.commit()
        for uid in users:
            tokens[uid] = create_access_token(s.get(User, uid))

    # Outbound boundary only: record what a connection test would have used.
    tested = []

    def fake_test_connection(ds_type, config):
        from app.core.crypto import decrypt_config
        tested.append((ds_type, decrypt_config(config)))
        return True, "Connection successful"
    monkeypatch.setattr(api.DataSourceConnectionService, "test_connection", staticmethod(fake_test_connection))

    # Query path: real execute_user_query / validate_user_sql / validator /
    # read-only executor; only the driver is replaced.
    import app.services.source_network_policy as netpol
    monkeypatch.setattr(netpol, "resolve_and_check", lambda host, port=None: "93.184.216.34")

    class _Cur:
        description = [("a",)]

        def execute(self, *a, **k):
            pass

        def fetchmany(self, n):
            return [(1,)][:n]

        def fetchall(self):
            return [(1,)]

        def close(self):
            pass

    class _Conn:
        def set_session(self, **k):
            pass

        def cursor(self, *a, **k):
            return _Cur()

        def close(self):
            pass
    monkeypatch.setattr(ds_mod.psycopg2, "connect", lambda **kw: _Conn())

    class _Sheets:
        def __getattr__(self, name):
            return lambda *a, **k: {"ok": True}
    import app.services.google_sheets_connector as gsc
    monkeypatch.setattr(gsc, "create_google_sheets_connector", lambda cfg: _Sheets())

    client = TestClient(app, raise_server_exceptions=False)

    def call(uid, method, path, **kw):
        client.cookies.clear()
        return client.request(method, path, headers={"Authorization": f"Bearer {tokens[uid]}"}, **kw)

    return call, tested, S


LEVEL_USER = {"none": STRANGER, "view": VIEWER, "edit": EDITOR, "full": OWNER}


def _ok(resp) -> bool:
    return 200 <= resp.status_code < 300


# ── permission matrix ────────────────────────────────────────────────────────

@pytest.mark.parametrize("level,allowed", [("none", False), ("view", False), ("edit", True), ("full", True)])
def test_raw_query_requires_object_edit(env, level, allowed):
    call, _t, _S = env
    r = call(LEVEL_USER[level], "POST", "/datasources/query", json={"data_source_id": PG_ID, "sql_query": "SELECT a FROM t"})
    assert _ok(r) is allowed, r.text
    if allowed:
        body = r.json()
        assert body["truncated"] is False and body["row_count"] == 1
    else:
        assert r.status_code == 403


@pytest.mark.parametrize("level,allowed", [("none", False), ("view", False), ("edit", True), ("full", True)])
def test_validate_sql_requires_object_edit(env, level, allowed):
    call, _t, _S = env
    r = call(LEVEL_USER[level], "POST", "/datasources/validate-sql", json={"data_source_id": PG_ID, "sql_query": "SELECT a FROM t"})
    assert _ok(r) is allowed, r.text
    if allowed:
        assert r.json()["valid"] is True


@pytest.mark.parametrize("level,allowed", [("none", False), ("view", False), ("edit", True), ("full", True)])
def test_saved_retest_requires_object_edit(env, level, allowed):
    call, tested, _S = env
    r = call(LEVEL_USER[level], "POST", f"/datasources/{PG_ID}/test")
    assert _ok(r) is allowed, r.text
    assert bool(tested) is allowed


@pytest.mark.parametrize("level,allowed", [("none", False), ("view", False), ("edit", False), ("full", True)])
@pytest.mark.parametrize("method,path,body", [
    ("POST", "/datasources/{id}/gsheets/sheets", {"sheet_name": "New"}),
    ("POST", "/datasources/{id}/gsheets/Sheet1/rows", {"values": {"a": 1}}),
    ("POST", "/datasources/{id}/gsheets/Sheet1/rows/batch", {"rows": [{"a": 1}]}),
    ("POST", "/datasources/{id}/gsheets/Sheet1/import-csv", {"csv_data": "a\n1"}),
    ("PATCH", "/datasources/{id}/gsheets/Sheet1/rows", {"pk": {"a": 1}, "values": {"a": 2}}),
    ("DELETE", "/datasources/{id}/gsheets/Sheet1/rows", {"pk": {"a": 1}}),
    ("PATCH", "/datasources/{id}/gsheets/Sheet1/headers", {"old_name": "a", "new_name": "b"}),
    ("PATCH", "/datasources/{id}/gsheets/Sheet1", {"new_name": "Renamed"}),
    ("DELETE", "/datasources/{id}/gsheets/Sheet1/rows/all", None),
])
def test_sheets_mutations_require_object_full(env, level, allowed, method, path, body):
    call, _t, _S = env
    kw = {"json": body} if body is not None else {}
    r = call(LEVEL_USER[level], method, path.format(id=SHEET_ID), **kw)
    if allowed:
        assert r.status_code < 300, r.text
    else:
        assert r.status_code == 403, r.text


@pytest.mark.parametrize("level", ["view", "edit", "full"])
def test_sheets_read_stays_object_view(env, level):
    call, _t, _S = env
    assert call(LEVEL_USER[level], "GET", f"/datasources/{SHEET_ID}/gsheets/sheets").status_code != 403


def test_the_old_ambiguous_test_endpoint_is_gone(env):
    call, tested, _S = env
    r = call(OWNER, "POST", "/datasources/test", json={"type": "postgresql", "config": {}, "data_source_id": PG_ID})
    assert r.status_code in (404, 405, 422)
    assert tested == []


# ── saved retest takes everything from the row ───────────────────────────────

def test_editor_saved_retest_uses_only_the_persisted_row(env):
    call, tested, _S = env
    r = call(EDITOR, "POST", f"/datasources/{PG_ID}/test",
             json={"type": "mysql", "config": {"host": "attacker.example", "password": ""}})
    assert r.status_code == 200
    ds_type, cfg = tested[-1]
    assert ds_type == "postgresql"
    assert cfg["host"] == "db.example.com" and cfg["password"] == STORED_SECRET
    assert STORED_SECRET not in r.text


# ── draft test ───────────────────────────────────────────────────────────────

def _draft(call, uid, config, ds_type="postgresql", ds_id=PG_ID):
    body = {"type": ds_type, "config": config}
    if ds_id is not None:
        body["data_source_id"] = ds_id
    return call(uid, "POST", "/datasources/test-draft", json=body)


@pytest.mark.parametrize("change", [
    {"host": "attacker.example"}, {"database": "other_db"}, {},
])
def test_viewer_cannot_reuse_a_stored_secret_through_the_draft_test(env, change):
    call, tested, _S = env
    cfg = {**PG_CONFIG, "password": "__stored__", **change}
    assert _draft(call, VIEWER, cfg).status_code == 403
    assert tested == []


def test_viewer_cannot_reuse_a_stored_secret_with_a_changed_type(env):
    call, tested, _S = env
    assert _draft(call, VIEWER, {**PG_CONFIG, "password": ""}, ds_type="mysql").status_code == 403
    assert tested == []


def test_no_access_user_cannot_use_another_sources_id(env):
    call, tested, _S = env
    assert _draft(call, STRANGER, {**PG_CONFIG, "password": ""}).status_code == 403
    assert tested == []


def test_module_view_user_cannot_run_a_draft_test(env):
    call, tested, _S = env
    assert _draft(call, MODVIEW, {**PG_CONFIG, "password": "x"}, ds_id=None).status_code == 403
    assert tested == []


@pytest.mark.parametrize("field,value", [
    ("host", "attacker.example"), ("port", 6543), ("database", "other_db"),
    ("username", "postgres"), ("schema_name", "private"),
])
def test_masked_secret_with_a_changed_destination_is_refused(env, field, value):
    call, tested, _S = env
    for masked in ("__stored__", ""):
        r = _draft(call, EDITOR, {**PG_CONFIG, "password": masked, field: value})
        assert r.status_code == 400, r.text
    assert tested == []


def test_masked_secret_with_a_changed_type_is_refused(env):
    call, tested, _S = env
    r = _draft(call, OWNER, {**PG_CONFIG, "password": "__stored__"}, ds_type="mysql")
    assert r.status_code == 400
    assert tested == []


def test_masked_secret_with_identical_destination_reuses_the_stored_secret(env):
    call, tested, _S = env
    r = _draft(call, EDITOR, {**PG_CONFIG, "password": "__stored__"})
    assert r.status_code == 200, r.text
    assert tested[-1][1]["password"] == STORED_SECRET
    assert STORED_SECRET not in r.text


def test_editor_draft_with_a_new_credential_tests_only_that_credential(env):
    call, tested, _S = env
    r = _draft(call, EDITOR, {**PG_CONFIG, "host": "new-host.example", "password": "brand-new-pw"})
    assert r.status_code == 200, r.text
    assert tested[-1][1]["host"] == "new-host.example"
    assert tested[-1][1]["password"] == "brand-new-pw"


def test_draft_without_a_source_id_treats_a_masked_secret_as_no_secret(env):
    call, tested, _S = env
    r = _draft(call, STRANGER, {**PG_CONFIG, "password": "__stored__"}, ds_id=None)
    assert r.status_code == 200
    assert "password" not in tested[-1][1]


# ── secrets never leave the server ───────────────────────────────────────────

def test_source_read_masks_secrets(env):
    call, _t, _S = env
    for uid in (OWNER, EDITOR, VIEWER):
        r = call(uid, "GET", f"/datasources/{PG_ID}")
        assert r.status_code == 200
        assert STORED_SECRET not in r.text and "STORED-sheet-secret" not in r.text
        assert r.json()["config"]["password"] == "__stored__"


# ── F5: platform GCP credential at save time ─────────────────────────────────

@pytest.fixture()
def platform_sa(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "GCP_SERVICE_ACCOUNT_JSON", '{"type": "service_account"}', raising=False)
    monkeypatch.setattr(settings, "PLATFORM_GCP_ALLOWED_PROJECTS", "allowed-proj", raising=False)


def _create_bq(call, uid, project, name):
    return call(uid, "POST", "/datasources/", json={
        "name": name, "type": "bigquery",
        "config": {"project_id": project, "auth_mode": "service_account",
                   "platform_gcp_admin_approved_target": project},
    })


def test_non_admin_cannot_attach_the_platform_credential_to_an_unlisted_project(env, platform_sa):
    call, tested, _S = env
    r = _create_bq(call, OWNER, "victim-proj", "bq1")
    assert r.status_code == 400, r.text
    assert tested == []


def test_non_admin_may_use_the_platform_credential_for_an_allowed_project(env, platform_sa):
    call, _t, S = env
    r = _create_bq(call, OWNER, "allowed-proj", "bq2")
    assert r.status_code == 201, r.text
    with S() as s:
        cfg = s.get(DataSource, r.json()["id"]).config
    # the request could not stamp the admin-approval marker itself
    assert "platform_gcp_admin_approved_target" not in cfg


def test_admin_approval_is_recorded_for_the_exact_project(env, platform_sa):
    call, _t, S = env
    with S() as s:
        u = s.get(User, ADMIN)
        u.permissions = {"settings": "full", "data_sources": "full"}
        s.commit()
    r = _create_bq(call, ADMIN, "special-proj", "bq3")
    assert r.status_code == 201, r.text
    with S() as s:
        cfg = s.get(DataSource, r.json()["id"]).config
    assert cfg["platform_gcp_admin_approved_target"] == "special-proj"


# ── S2 / S3: a sql_query dataset table runs arbitrary SQL → object edit ──────

import source_phase_b_support as _pb  # noqa: E402

_SQ_VIEWER = uuid.UUID("cccccccc-0000-0000-0000-00000000000b")
_SQ_EDITOR = uuid.UUID("cccccccc-0000-0000-0000-00000000000e")


@pytest.fixture()
def sq_env(monkeypatch):
    import app.api.datasets as datasets_api
    from app.models.dataset import Dataset, DatasetTable
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService

    S = _pb.make_db(monkeypatch)
    _pb.no_network(monkeypatch)
    perms = {"data_sources": "edit", "datasets": "edit"}
    call = _pb.make_http(monkeypatch, S, {_pb.OWNER: perms, _SQ_VIEWER: perms, _SQ_EDITOR: perms})
    previews = []
    monkeypatch.setattr(datasets_api, "_preview_live_table_draft",
                        lambda ds, draft: previews.append(draft.source_query) or ([], []))
    with S() as s:
        src = DataSourceCRUDService.create(
            s, DataSourceCreate(name="pg", type="postgresql", config=_pb.pg_config()), owner_id=_pb.OWNER).id
    with S() as s:
        for uid, level in ((_SQ_VIEWER, "view"), (_SQ_EDITOR, "edit")):
            s.add(ResourceShare(resource_type="datasource", resource_id=str(src), user_id=uid,
                                permission=level, shared_by=_pb.OWNER))
        datasets, tables = {}, {}
        for uid in (_SQ_VIEWER, _SQ_EDITOR):
            d = Dataset(name=f"d-{uid}", owner_id=uid)
            s.add(d)
            s.flush()
            t = DatasetTable(dataset_id=d.id, datasource_id=src, source_kind="sql_query",
                             source_query="SELECT 1 AS a", display_name="q")
            s.add(t)
            s.flush()
            datasets[uid], tables[uid] = d.id, t.id
        s.commit()
    return call, src, datasets, tables, previews


def test_viewer_cannot_add_a_sql_query_table_on_a_source(sq_env):
    call, src, datasets, _t, previews = sq_env
    r = call(_SQ_VIEWER, "POST", f"/datasets/{datasets[_SQ_VIEWER]}/tables",
             json={"datasource_id": src, "source_kind": "sql_query",
                   "source_query": "SELECT * FROM pg_shadow", "display_name": "x"})
    assert r.status_code == 403, r.text
    assert previews == []


def test_viewer_may_still_add_a_physical_table(sq_env):
    call, src, datasets, _t, _p = sq_env
    r = call(_SQ_VIEWER, "POST", f"/datasets/{datasets[_SQ_VIEWER]}/tables",
             json={"datasource_id": src, "source_kind": "physical_table",
                   "source_table_name": "public.orders", "display_name": "orders"})
    assert r.status_code < 300, r.text


def test_editor_may_add_a_sql_query_table(sq_env):
    call, src, datasets, _t, previews = sq_env
    r = call(_SQ_EDITOR, "POST", f"/datasets/{datasets[_SQ_EDITOR]}/tables",
             json={"datasource_id": src, "source_kind": "sql_query",
                   "source_query": "SELECT 2 AS a", "display_name": "x2"})
    assert r.status_code < 300, r.text
    assert previews and "SELECT 2" in previews[-1]


def test_viewer_cannot_change_the_sql_of_an_existing_sql_query_table(sq_env):
    call, _src, datasets, tables, previews = sq_env
    r = call(_SQ_VIEWER, "PUT", f"/datasets/{datasets[_SQ_VIEWER]}/tables/{tables[_SQ_VIEWER]}",
             json={"source_query": "SELECT * FROM pg_shadow"})
    assert r.status_code == 403, r.text
    assert previews == []


def test_viewer_may_rename_a_sql_query_table_without_touching_its_sql(sq_env):
    call, _src, datasets, tables, previews = sq_env
    r = call(_SQ_VIEWER, "PUT", f"/datasets/{datasets[_SQ_VIEWER]}/tables/{tables[_SQ_VIEWER]}",
             json={"display_name": "renamed"})
    assert r.status_code < 300, r.text
    assert previews == []


def test_editor_may_change_the_sql_of_a_sql_query_table(sq_env):
    call, _src, datasets, tables, previews = sq_env
    r = call(_SQ_EDITOR, "PUT", f"/datasets/{datasets[_SQ_EDITOR]}/tables/{tables[_SQ_EDITOR]}",
             json={"source_query": "SELECT 3 AS a"})
    assert r.status_code < 300, r.text
    assert previews and "SELECT 3" in previews[-1]
