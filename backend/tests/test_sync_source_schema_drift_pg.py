"""Sync & Publish reconciles the source schema before it materializes.

A column dropped (or renamed) at the source after the dataset cached it used to
sync "successfully": the declared-type extract loaded it as all-NULL and a
``SELECT *`` simply left it out, so the published generation broke every chart
that used it. The source relation is now compared with the cached columns before
the build: missing ⇒ explicit SOURCE_SCHEMA_DRIFT, the table is not built, the
publish is refused and the previous generation keeps serving; added ⇒
``columns_cache["source_added_columns"]`` and the build proceeds.

Real Postgres source (the CI Postgres job's DATABASE_URL); the BigQuery build is
stubbed — the gate runs before it.
"""
from __future__ import annotations

import os
from urllib.parse import urlparse

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

S = "e2e_drift_src"


def _url():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.skip("needs the Postgres CI job (DATABASE_URL=postgresql://…)")
    return url


@pytest.fixture()
def env(monkeypatch):
    from app.core.database import Base
    from app.models.dataset import Dataset, DatasetRefreshRun, DatasetTable, DatasetTableSnapshot
    from app.models.models import DataSource
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    url = _url()
    engine = sa.create_engine(url)
    with engine.begin() as c:
        c.execute(sa.text(f"DROP SCHEMA IF EXISTS {S} CASCADE"))
        c.execute(sa.text(f"CREATE SCHEMA {S}"))
        c.execute(sa.text(f"CREATE TABLE {S}.orders (id int, amount int, discount int)"))
        c.execute(sa.text(f"INSERT INTO {S}.orders VALUES (1, 10, 1), (2, 20, 2)"))
    u = urlparse(url)
    monkeypatch.setattr("app.core.crypto.decrypt_config", lambda c: dict(c or {}))
    meta = sa.create_engine("sqlite://", future=True)
    from sqlalchemy.dialects.postgresql import JSONB, UUID
    from sqlalchemy.ext.compiler import compiles

    @compiles(UUID, "sqlite")
    def _u(_t, _c, **_k):
        return "CHAR(36)"

    @compiles(JSONB, "sqlite")
    def _j(_t, _c, **_k):
        return "JSON"

    Base.metadata.create_all(meta, tables=[
        Dataset.__table__, DatasetTable.__table__, DataSource.__table__, DatasetTableSnapshot.__table__,
        DatasetRefreshRun.__table__, SemanticView.__table__, SemanticModel.__table__, SemanticExplore.__table__])
    db = Session(meta)
    db.add(DataSource(id=1, name="pg", type="postgresql",
                      config={"host": u.hostname, "port": u.port or 5432, "database": u.path.lstrip("/"),
                              "username": u.username, "password": u.password, "schema": S}))
    db.add(Dataset(id=1, name="Sales", publish_state="published", published_generation=1))
    db.add(DatasetTable(id=11, dataset_id=1, datasource_id=1, display_name="orders",
                        source_table_name=f"{S}.orders", source_kind="physical_table",
                        columns_cache={"columns": [{"name": "id", "type": "integer"},
                                                   {"name": "amount", "type": "integer"},
                                                   {"name": "discount", "type": "integer"}]}))
    db.commit()
    try:
        yield db, engine
    finally:
        db.close()
        with engine.begin() as c:
            c.execute(sa.text(f"DROP SCHEMA IF EXISTS {S} CASCADE"))
        engine.dispose()


def _drift(db):
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource
    from app.services.snapshot_service import _source_schema_drift

    return _source_schema_drift(db, db.get(DatasetTable, 11), db.get(DataSource, 1))


def test_an_unchanged_source_passes(env):
    db, _e = env
    assert _drift(db) is None


def test_a_dropped_source_column_is_drift(env):
    db, engine = env
    with engine.begin() as c:
        c.execute(sa.text(f"ALTER TABLE {S}.orders DROP COLUMN discount"))
    msg = _drift(db)
    assert msg and msg.startswith("SOURCE_SCHEMA_DRIFT") and "discount" in msg


def test_a_renamed_source_column_is_drift(env):
    db, engine = env
    with engine.begin() as c:
        c.execute(sa.text(f"ALTER TABLE {S}.orders RENAME COLUMN amount TO amount_vnd"))
    assert "amount" in (_drift(db) or "")


def test_an_added_source_column_is_flagged_not_failed(env):
    from app.models.dataset import DatasetTable

    db, engine = env
    with engine.begin() as c:
        c.execute(sa.text(f"ALTER TABLE {S}.orders ADD COLUMN channel text"))
    assert _drift(db) is None
    t = db.get(DatasetTable, 11)
    assert t.columns_cache["source_added_columns"] == ["channel"]
    assert not t.schema_change_pending  # that flag means "AI description stale" — not this


def test_sync_refuses_to_build_or_publish_a_drifted_table(env, monkeypatch):
    """Through refresh_all_for_dataset + the publish gate: the drifted table is
    never built, the run records SOURCE_SCHEMA_DRIFT, generation 1 stays."""
    from app.models.dataset import Dataset, DatasetRefreshRun
    from app.models.models import DataSource
    from app.services import dataset_publish_service as pub, snapshot_service as ss

    db, engine = env
    with engine.begin() as c:
        c.execute(sa.text(f"ALTER TABLE {S}.orders DROP COLUMN discount"))
    built = []
    monkeypatch.setattr(ss, "resolve_host", lambda _db, _id: db.get(DataSource, 1))
    monkeypatch.setattr(ss, "is_federated_materializable", lambda _t: True)
    monkeypatch.setattr(ss, "build_table_snapshot", lambda *a, **k: built.append(a) or None)
    monkeypatch.setattr(ss, "gc_dataset_snapshots", lambda *a, **k: 0)
    out = pub._sync_and_publish_blocking(db, 1)
    run = db.query(DatasetRefreshRun).order_by(DatasetRefreshRun.id.desc()).first()
    assert out["ok"] is False and built == []
    assert run.status == "failed" and "SOURCE_SCHEMA_DRIFT" in run.error and "discount" in run.error
    assert db.get(Dataset, 1).published_generation == 1
