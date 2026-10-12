"""Observability native monitors against a REAL MySQL source (connector readiness, R5).

AppBI metadata lives in Postgres (DATABASE_URL); the monitored table lives in
MySQL (APPBI_TEST_MYSQL_URL - the CI integration job's MySQL 8.4 service). The
monitors are configured and run through ObservabilityService exactly as the API
and the scheduler do; the source is then changed underneath them.

In CI this suite FAILS (does not skip) without both databases: a connector
check that skipped would read as coverage.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime

import pytest
import sqlalchemy as sa

TABLE = f"obs_mon_{uuid.uuid4().hex[:6]}"


def _need(var: str, prefix: str) -> str:
    url = os.environ.get(var, "")
    if not url.startswith(prefix):
        if os.environ.get("CI"):
            pytest.fail(f"{var} must point at {prefix}... in CI (got {url.split('@')[-1] or '<unset>'})")
        pytest.skip(f"needs {var}")
    return url


@pytest.fixture(scope="module")
def mysql():
    _need("DATABASE_URL", "postgresql")
    url = _need("APPBI_TEST_MYSQL_URL", "mysql://")
    eng = sa.create_engine(url.replace("mysql://", "mysql+pymysql://", 1))
    with eng.begin() as c:
        c.execute(sa.text(f"CREATE TABLE {TABLE} (id INT, amount DECIMAL(12,2), loaded_at DATETIME)"))
        c.execute(sa.text("SET SESSION cte_max_recursion_depth = 100000"))
        c.execute(sa.text(f"INSERT INTO {TABLE} WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g "
                          f"WHERE n < 100) SELECT n, n * 10, UTC_TIMESTAMP() FROM g"))
    u = sa.engine.make_url(url.replace("mysql://", "mysql+pymysql://", 1))
    yield eng, {"host": u.host, "port": u.port or 3306, "database": u.database,
                "username": u.username, "password": u.password or ""}
    with eng.begin() as c:
        c.execute(sa.text(f"DROP TABLE IF EXISTS {TABLE}"))
    eng.dispose()


@pytest.fixture()
def world(mysql, monkeypatch):
    # Plain config in the test datasource (no encryption key in this job).
    monkeypatch.setattr("app.core.crypto.decrypt_config", lambda c: dict(c or {}))
    from app.core.database import SessionLocal
    from app.models.dataset import Dataset, DatasetTable
    from app.models.models import DataSource, DataSourceType
    from app.models.user import User, UserStatus

    _eng, cfg = mysql
    db = SessionLocal()
    owner = User(id=uuid.uuid4(), email=f"obs-mysql-{uuid.uuid4().hex[:6]}@e2e.test", full_name="obs mysql",
                 status=UserStatus.ACTIVE, password_hash=None, permissions={})
    db.add(owner)
    db.flush()
    src = DataSource(name=f"mysql-{uuid.uuid4().hex[:6]}", type=DataSourceType("mysql"), owner_id=owner.id, config=cfg)
    ds = Dataset(name=f"obs-mysql-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add_all([src, ds])
    db.flush()
    t = DatasetTable(dataset_id=ds.id, datasource_id=src.id, display_name="orders", source_kind="physical_table",
                     source_table_name=f"{cfg['database']}.{TABLE}",
                     columns_cache={"columns": [{"name": "id", "type": "int"}, {"name": "amount", "type": "decimal"},
                                                {"name": "loaded_at", "type": "datetime"}]})
    db.add(t)
    db.commit()
    yield db, ds, t, src
    db.close()


def _run(db, ds, kind):
    from app.models.observability import ObservabilityMonitor
    from app.services.observability_service import ObservabilityService as S

    S.run_scan(db, dataset_id=ds.id)
    db.expire_all()
    return db.query(ObservabilityMonitor).filter(ObservabilityMonitor.dataset_id == ds.id,
                                                 ObservabilityMonitor.kind == kind).one()


def test_mysql_freshness_reads_the_source_and_breaches_when_stale(world, mysql):
    from app.services.observability_service import ObservabilityService as S

    db, ds, t, _src = world
    eng, _cfg = mysql
    S.save_monitor(db, ds.id, {"table_id": t.id, "kind": "freshness",
                               "config": {"time_column": "loaded_at", "max_lag_hours": 2}})
    db.commit()
    m = _run(db, ds, "freshness")
    assert m.last_status == "ok", m.last_detail
    assert m.last_value is not None and m.last_value < 1
    with eng.begin() as c:
        c.execute(sa.text(f"UPDATE {TABLE} SET loaded_at = loaded_at - INTERVAL 30 HOUR"))
    m = _run(db, ds, "freshness")
    assert m.last_status == "breached" and m.last_value >= 29, m.last_detail
    with eng.begin() as c:
        c.execute(sa.text(f"UPDATE {TABLE} SET loaded_at = UTC_TIMESTAMP()"))


def test_mysql_volume_counts_the_source_rows(world, mysql):
    from app.services.observability_service import ObservabilityService as S

    db, ds, t, _src = world
    S.save_monitor(db, ds.id, {"table_id": t.id, "kind": "volume", "config": {"z_threshold": 3, "min_rows": 500}})
    db.commit()
    m = _run(db, ds, "volume")
    assert m.last_value == 100.0
    assert m.last_status == "breached" and "500" in m.last_detail["reason"], m.last_detail


def test_mysql_schema_change_breaches_against_the_live_relation(world, mysql):
    from app.services.observability_service import ObservabilityService as S

    db, ds, t, _src = world
    eng, _cfg = mysql
    S.save_monitor(db, ds.id, {"table_id": t.id, "kind": "schema"})
    db.commit()
    assert _run(db, ds, "schema").last_status == "ok"
    with eng.begin() as c:
        c.execute(sa.text(f"ALTER TABLE {TABLE} ADD COLUMN note VARCHAR(20)"))
    try:
        m = _run(db, ds, "schema")
        assert m.last_status == "breached" and "note" in m.last_detail["added"], m.last_detail
    finally:
        with eng.begin() as c:
            c.execute(sa.text(f"ALTER TABLE {TABLE} DROP COLUMN note"))


def test_an_unreachable_mysql_source_is_an_error_and_the_scan_partial(world):
    from app.services.observability_service import ObservabilityService as S

    db, ds, t, src = world
    S.save_monitor(db, ds.id, {"table_id": t.id, "kind": "freshness",
                               "config": {"time_column": "loaded_at", "max_lag_hours": 2}})
    src.config = {**src.config, "port": 1}
    db.commit()
    out = S.run_scan(db, dataset_id=ds.id)
    from app.models.observability import ObservabilityMonitor

    db.expire_all()
    m = db.query(ObservabilityMonitor).filter(ObservabilityMonitor.dataset_id == ds.id,
                                              ObservabilityMonitor.kind == "freshness").one()
    assert m.last_status == "error" and out["status"] == "partial" and out["monitor_errors"] >= 1
