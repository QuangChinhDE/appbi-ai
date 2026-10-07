"""Workboard import may only target Sources the caller can see (audit F6).

`POST /workboards/import/inspect-source` and `/import/from-source` take a
caller-chosen ``datasource_map``. Before the fix they only checked the Source
existed, so any workboards:edit user could list tables on — and auto-create a
dataset bound to — a Source they had no access to.

Runs the real workboards router and the real object-permission check
(`require_view_access` → owner / resource_shares) against in-memory SQLite.
The template service is replaced by a spy so "no table listing leaked" is
asserted directly: on refusal it must never be called.
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
from app.models.models import DataSource, DataSourceType
from app.models.resource_share import ResourceShare, ResourceType, SharePermission
from app.models.team import TeamMembership


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


OWNER_ID = uuid.UUID("aaaaaaaa-0000-0000-0000-000000000001")
CALLER_ID = uuid.UUID("bbbbbbbb-0000-0000-0000-000000000002")


class _Caller:
    id = CALLER_ID
    email = "editor@example.com"
    full_name = "Editor"
    # workboards:edit, data_sources:edit at module level — but owns no Source;
    # object access comes only from resource_shares.
    permissions = {"workboards": "edit", "data_sources": "edit"}
    is_active = True
    token_scopes = None


@pytest.fixture()
def env(monkeypatch):
    from app.core.dependencies import get_current_user
    from app.modules.workboards import api as wb_api

    engine = create_engine(
        "sqlite://", future=True, connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(
        engine,
        tables=[DataSource.__table__, ResourceShare.__table__, TeamMembership.__table__],
    )
    SessionLocal = sessionmaker(bind=engine, future=True)
    s = SessionLocal()
    s.add_all([
        DataSource(id=1, name="hidden_pg", type=DataSourceType.POSTGRESQL, config={}, owner_id=OWNER_ID),
        DataSource(id=2, name="shared_pg", type=DataSourceType.POSTGRESQL, config={}, owner_id=OWNER_ID),
        DataSource(id=3, name="shared_docs", type=DataSourceType.GOOGLE_DOCS, config={}, owner_id=OWNER_ID),
        DataSource(id=4, name="edit_pg", type=DataSourceType.POSTGRESQL, config={}, owner_id=OWNER_ID),
    ])
    s.add(ResourceShare(resource_type=ResourceType.DATASOURCE, resource_id="4",
                        user_id=CALLER_ID, permission=SharePermission.EDIT, shared_by=OWNER_ID))
    for rid in ("2", "3"):
        s.add(ResourceShare(resource_type=ResourceType.DATASOURCE, resource_id=rid,
                            user_id=CALLER_ID, permission=SharePermission.VIEW, shared_by=OWNER_ID))
    s.commit()
    s.close()

    calls: list = []

    def _spy_inspect(db, bundle, datasource_map):
        calls.append(("inspect", dict(datasource_map)))
        return {"tables": [{"name": "listed"}]}

    def _spy_import(db, bundle, **kw):
        calls.append(("import", dict(kw.get("datasource_map") or {})))
        raise ValueError("stop after authorization")

    monkeypatch.setattr(wb_api._template_svc, "inspect_source_match", _spy_inspect)
    monkeypatch.setattr(wb_api._template_svc, "import_from_source", _spy_import)

    def _db():
        d = SessionLocal()
        try:
            yield d
        finally:
            d.close()

    app = FastAPI()
    app.include_router(wb_api.router)
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: _Caller()
    prefix = wb_api.router.prefix or ""
    return TestClient(app, raise_server_exceptions=False), calls, prefix


SQL_BUNDLE = {"version": 2, "dataset_tables": [
    {"old_table_id": 1, "source_kind": "sql_query", "datasource_ref": "src",
     "source_query": "SELECT secret_col FROM secret_table"},
]}
PHYS_BUNDLE = {"version": 2, "dataset_tables": [
    {"old_table_id": 1, "source_kind": "physical_table", "datasource_ref": "src",
     "source_table_name": "orders"},
]}


def _post(client, url, ds_id, bundle=None):
    return client.post(url, json={"bundle": bundle or {"version": 2}, "datasource_map": {"src": ds_id}})


@pytest.mark.parametrize("path", ["/import/inspect-source", "/import/from-source"])
def test_source_without_access_is_refused_and_nothing_listed(env, path):
    client, calls, prefix = env
    r = _post(client, prefix + path, 1)
    assert r.status_code == 404, r.text
    assert "listed" not in r.text and "hidden_pg" not in r.text
    assert calls == []


@pytest.mark.parametrize("path", ["/import/inspect-source", "/import/from-source"])
def test_google_docs_source_is_refused(env, path):
    client, calls, prefix = env
    r = _post(client, prefix + path, 3)
    assert r.status_code == 400, r.text
    assert calls == []


@pytest.mark.parametrize("path", ["/import/inspect-source", "/import/from-source"])
def test_missing_source_is_404(env, path):
    client, calls, prefix = env
    r = _post(client, prefix + path, 999)
    assert r.status_code == 404, r.text
    assert calls == []


def test_view_shared_source_reaches_table_listing(env):
    client, calls, prefix = env
    r = _post(client, prefix + "/import/inspect-source", 2)
    assert r.status_code == 200, r.text
    assert calls == [("inspect", {"src": 2})]


def test_view_shared_source_reaches_import_step(env):
    client, calls, prefix = env
    r = _post(client, prefix + "/import/from-source", 2)
    assert calls and calls[0][0] == "import", r.text


@pytest.mark.parametrize("path", ["/import/inspect-source", "/import/from-source"])
def test_nonexistent_and_inaccessible_are_indistinguishable(env, path):
    client, _calls, prefix = env
    a = _post(client, prefix + path, 1)
    b = _post(client, prefix + path, 999)
    assert a.status_code == b.status_code == 404
    norm = lambda r: r.json()["detail"].replace("id=1", "id=X").replace("id=999", "id=X")
    assert norm(a) == norm(b)


def test_view_only_source_refuses_sql_template(env):
    client, calls, prefix = env
    r = _post(client, prefix + "/import/from-source", 2, SQL_BUNDLE)
    assert r.status_code == 403, r.text
    assert calls == []
    assert "secret_table" not in r.text


def test_view_only_source_allows_physical_binding(env):
    client, calls, prefix = env
    _post(client, prefix + "/import/from-source", 2, PHYS_BUNDLE)
    assert calls and calls[0] == ("import", {"src": 2})


def test_edit_shared_source_allows_sql_template(env):
    client, calls, prefix = env
    _post(client, prefix + "/import/from-source", 4, SQL_BUNDLE)
    assert calls and calls[0] == ("import", {"src": 4})


def test_forged_source_id_with_sql_template_is_404_not_403(env):
    client, calls, prefix = env
    r = _post(client, prefix + "/import/from-source", 1, SQL_BUNDLE)
    assert r.status_code == 404, r.text
    assert calls == []
