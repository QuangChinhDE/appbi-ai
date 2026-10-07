"""Shared harness for the Source hardening Phase B suites (not a test module).

`make_db(monkeypatch)` builds an in-memory SQLite with every table the Source
lifecycle touches (sources, datasets, snapshots, knowledge docs, shares, Google
pending consents, manual assets, audit log) and a real Fernet key, so configs
are encrypted at rest exactly as in production.

`make_http(monkeypatch, S, users)` mounts the REAL datasources + datasets
routers with the real session-JWT auth and object-permission resolution.
"""
from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


OWNER = uuid.UUID("bbbbbbbb-0000-0000-0000-00000000000f")
OTHER = uuid.UUID("bbbbbbbb-0000-0000-0000-00000000000e")


def _tables():
    from app.models.audit_log import AuditLog
    from app.models.dataset import Dataset, DatasetTable, DatasetTableSnapshot
    from app.models.governance import GovernKnowledgeDoc
    from app.models.manual_source_asset import ManualSourceAsset
    from app.models.models import DataSource, GoogleOAuthPending
    from app.models.resource_share import ResourceShare
    from app.models.revoked_token import RevokedToken
    from app.models.team import Team, TeamMembership
    from app.models.user import User

    return [User.__table__, RevokedToken.__table__, Team.__table__, TeamMembership.__table__,
            ResourceShare.__table__, DataSource.__table__, Dataset.__table__, DatasetTable.__table__,
            DatasetTableSnapshot.__table__, GovernKnowledgeDoc.__table__, ManualSourceAsset.__table__,
            GoogleOAuthPending.__table__, AuditLog.__table__]


def make_db(monkeypatch):
    """Return a sessionmaker over a fresh in-memory DB (Fernet key set)."""
    from cryptography.fernet import Fernet

    from app.core.config import settings
    from app.core.database import Base

    monkeypatch.setattr(settings, "ENVIRONMENT", "test", raising=False)
    monkeypatch.setattr(settings, "DATASOURCE_ENCRYPTION_KEY", Fernet.generate_key().decode(), raising=False)
    tables = _tables()
    for table in tables:
        for col in table.columns:
            sd = col.server_default
            if sd is not None and "::" in str(getattr(sd, "arg", "")):
                monkeypatch.setattr(col, "server_default", None)
    engine = create_engine("sqlite://", future=True, poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=tables)
    S = sessionmaker(bind=engine, future=True)
    import app.core.database as database
    monkeypatch.setattr(database, "SessionLocal", S)
    return S


def add_user(s, uid, perms):
    from app.models.user import User, UserStatus
    s.add(User(id=uid, email=f"{uid}@example.com", full_name=str(uid), password_hash="x",
               status=UserStatus.ACTIVE, permissions=dict(perms), google_oauth_scopes=[]))


def make_http(monkeypatch, S, users: dict):
    """Real routers + auth. `users` = {uuid: module-permissions}. Returns call()."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import app.api.datasets as datasets_api
    import app.api.datasources as api
    from app.api.auth import create_access_token
    from app.core import get_db
    from app.models.user import User

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
    app.include_router(datasets_api.router, prefix="/datasets")
    app.dependency_overrides[get_db] = _db
    tokens = {}
    with S() as s:
        for uid, perms in users.items():
            if s.get(User, uid) is None:
                add_user(s, uid, perms)
        s.commit()
        for uid in users:
            tokens[uid] = create_access_token(s.get(User, uid))
    client = TestClient(app, raise_server_exceptions=False)

    def call(uid, method, path, **kw):
        client.cookies.clear()
        return client.request(method, path, headers={"Authorization": f"Bearer {tokens[uid]}"}, **kw)

    return call


def pg_config(host="db-a.example.com", password="pw-A-secret"):
    return {"host": host, "port": 5432, "database": "sales", "username": "analyst", "password": password}


def no_network(monkeypatch, ok=True):
    """Replace only the outbound connection test (records what it saw)."""
    from app.core.crypto import decrypt_config
    from app.services.datasource_service import DataSourceConnectionService

    seen = []

    def fake(ds_type, config):
        seen.append((ds_type, decrypt_config(config)))
        return (True, "Connection successful") if ok else (False, "password authentication failed")
    monkeypatch.setattr(DataSourceConnectionService, "test_connection", staticmethod(fake))
    return seen
