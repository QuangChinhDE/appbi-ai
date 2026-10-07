"""Source update concurrency on Postgres (real row locks).

DataSourceCRUDService.update runs the connection test with NO transaction open
and NO row lock held; persistence is a short FOR UPDATE transaction that
refuses (409 source_conflict) when config_version moved since the snapshot the
test ran on. Fails, never skips, without Postgres (CI: backend-contract-tests
integration job). Rows are committed (two connections must see them) and
removed in teardown.
"""
from __future__ import annotations

import os
import uuid

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker

NAME = "srch-conc-" + uuid.uuid4().hex[:8]


def _pg_config(password="pw-A-secret", schema=None):
    cfg = {"host": "db-a.example.com", "port": 5432, "database": "sales", "username": "analyst",
           "password": password}
    if schema:
        cfg["schema_name"] = schema
    return cfg


@pytest.fixture()
def env(monkeypatch):
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_source_concurrency_pg needs Postgres (DATABASE_URL).")
    from app.models.models import DataSource
    from app.schemas import DataSourceCreate
    from app.services.datasource_crud_service import DataSourceCRUDService

    engine = sa.create_engine(url)
    S = sessionmaker(bind=engine)
    with S() as s:
        ds = DataSourceCRUDService.create(s, DataSourceCreate(name=NAME + uuid.uuid4().hex[:4], type="postgresql",
                                                              config=_pg_config()))
        ds_id = ds.id
    yield S, engine, ds_id
    with S() as s:
        s.query(DataSource).filter(DataSource.id == ds_id).delete()
        s.commit()
    engine.dispose()


def _row(S, ds_id):
    from app.core.crypto import decrypt_config
    from app.models.models import DataSource
    with S() as s:
        ds = s.get(DataSource, ds_id)
        return int(ds.config_version), decrypt_config(dict(ds.config))


def test_slow_connection_test_holds_no_row_lock(env, monkeypatch):
    """While the (slow) test runs, another connection can take the row lock
    with NOWAIT and see no open transaction from the updating session."""
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.datasource_service import DataSourceConnectionService
    S, engine, ds_id = env
    observed = {}

    def slow_test(ds_type, config):
        with engine.connect() as other:
            with other.begin():
                # Would raise LockNotAvailable if the updater held the row.
                observed["locked"] = other.execute(
                    sa.text("SELECT id FROM data_sources WHERE id = :i FOR UPDATE NOWAIT"), {"i": ds_id}
                ).scalar()
            # No backend of this test DB is "idle in transaction" (the updater's
            # session ended its read txn before the test).
            observed["idle_in_txn"] = other.execute(sa.text(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                "AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()")).scalar()
        return True, "ok"
    monkeypatch.setattr(DataSourceConnectionService, "test_connection", staticmethod(slow_test))
    with S() as s:
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(config=_pg_config(password="pw-NEW")),
                                     test_connection=True)
    assert observed == {"locked": ds_id, "idle_in_txn": 0}
    version, cfg = _row(S, ds_id)
    assert version == 2 and cfg["password"] == "pw-NEW"


def test_interleaved_update_during_test_gets_409_and_rotation_survives(env, monkeypatch):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.source_lifecycle import SourceConfigError
    S, _engine, ds_id = env
    fired = []

    def test_then_a_commits(ds_type, config):
        if not fired:
            fired.append(1)
            with S() as s2:  # A rotates the password while B's test runs
                # A regression that locks across the test would make A wait on B
                # forever; fail fast instead.
                s2.execute(sa.text("SET lock_timeout = '5s'"))
                DataSourceCRUDService.update(s2, ds_id, DataSourceUpdate(config=_pg_config(password="pw-ROT")),
                                             test_connection=True)
        return True, "ok"
    monkeypatch.setattr(DataSourceConnectionService, "test_connection", staticmethod(test_then_a_commits))
    with S() as s, pytest.raises(SourceConfigError) as exc:
        DataSourceCRUDService.update(
            s, ds_id, DataSourceUpdate(config={**_pg_config(schema="mart"), "password": "__stored__"}),
            test_connection=True)
    assert exc.value.code == "source_conflict" and exc.value.status_code == 409
    version, cfg = _row(S, ds_id)
    assert version == 2 and cfg["password"] == "pw-ROT" and "schema_name" not in cfg


def test_failed_test_leaves_row_and_version_untouched(env, monkeypatch):
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.source_lifecycle import SourceConfigError
    import app.services.datasource_crud_service as crud
    S, _engine, ds_id = env
    inval = []
    monkeypatch.setattr(crud, "invalidate_source", lambda *a, **k: inval.append(1) or {})
    monkeypatch.setattr(DataSourceConnectionService, "test_connection",
                        staticmethod(lambda t, c: (False, "password authentication failed")))
    with S() as s, pytest.raises(SourceConfigError):
        DataSourceCRUDService.update(s, ds_id, DataSourceUpdate(config=_pg_config(password="pw-BAD")),
                                     test_connection=True)
    version, cfg = _row(S, ds_id)
    assert (version, cfg["password"], inval) == (1, "pw-A-secret", [])
