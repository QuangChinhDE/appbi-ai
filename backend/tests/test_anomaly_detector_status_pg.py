"""Anomaly detector outcome -> incident lifecycle, on real Postgres (O08b).

Locks the defect behind the intermittent e2e O08b: a monitored metric with no
time column can never be checked, yet the real detector recorded it as
"insufficient" (too little data - i.e. "wait and it will confirm"). The e2e
seed labels such a metric "error"; whenever the daily 02:00 UTC scheduler ran
the real detector during the e2e job it overwrote that with "insufficient".

Statuses:
  error        - the detector could not execute (no time column, query failed)
  insufficient - it ran, but the history is too thin to judge
  ok           - it ran and the latest value is inside the band: the ONLY
                 outcome that may auto-resolve an open anomaly incident.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta
from urllib.parse import urlparse

import pytest
import sqlalchemy as sa

from tests.authz_http import OWNER_URL, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg

SCHEMA = "o08b_src"


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.dataset import Dataset, DatasetTable
    from app.models.models import DataSource, DataSourceType

    owner_engine = sa.create_engine(OWNER_URL)
    with owner_engine.begin() as c:
        c.execute(sa.text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.thin, {SCHEMA}.steady"))
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.thin (amount numeric, loaded_at timestamp)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.thin SELECT g, now() - (g || ' minutes')::interval "
                          f"FROM generate_series(1, 50) g"))
        # 20 days, alternating 100/110 per day: stdev > 0 and today inside the band.
        c.execute(sa.text(f"CREATE TABLE {SCHEMA}.steady (amount numeric, loaded_at timestamp)"))
        c.execute(sa.text(f"INSERT INTO {SCHEMA}.steady SELECT CASE WHEN g % 2 = 0 THEN 100 ELSE 110 END, "
                          f"current_date - g + interval '1 minute' FROM generate_series(0, 19) g"))

    owner_engine.dispose()
    u = urlparse(OWNER_URL)
    owner = make_user(db, "o08b-owner", observability="edit", datasets="edit")
    src = DataSource(name=f"o08b-{uuid.uuid4().hex[:6]}", type=DataSourceType.POSTGRESQL, owner_id=owner.id,
                     config={"host": u.hostname, "port": u.port or 5432, "database": u.path.lstrip("/"),
                             "username": u.username, "password": u.password})
    db.add(src)
    ds = Dataset(name=f"o08b-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add(ds)
    db.flush()
    tables = {}
    for name in ("thin", "steady"):
        t = DatasetTable(dataset_id=ds.id, display_name=name, source_kind="physical_table",
                         source_table_name=f"{SCHEMA}.{name}", datasource_id=src.id)
        db.add(t)
        db.flush()
        tables[name] = t
    db.commit()
    return dict(owner=owner, ds=ds, tables=tables)


def _metric_with_open_incident(db, world, table: str, time_column):  # noqa: F811
    """A metric with a 30-day-old alert and the incident it opened back then."""
    from app.models.anomaly import AnomalyAlert, MonitoredMetric
    from app.models.observability import ObservabilityIncident

    t = world["tables"][table]
    m = MonitoredMetric(dataset_table_id=t.id, metric_column="amount", time_column=time_column,
                        owner_id=world["owner"].id)
    db.add(m)
    db.flush()
    old = datetime.utcnow() - timedelta(days=30)
    db.add(AnomalyAlert(monitored_metric_id=m.id, detected_at=old, current_value=1.0, expected_value=50.0,
                        z_score=-4.0, change_pct=-98.0, severity="warning"))
    key = f"anomaly:metric_{m.id}"
    db.add(ObservabilityIncident(dataset_id=world["ds"].id, dataset_table_id=t.id, source="anomaly",
                                 pillar="distribution", dedup_key=key, title="amount: old anomaly", detail={},
                                 severity="warning", status="open", first_seen_at=old, last_seen_at=old))
    db.commit()
    return m, key


def _run_only(db, metric):  # noqa: F811
    """run_all_checks for this metric alone (other suites' metrics paused)."""
    from app.models.anomaly import MonitoredMetric
    from app.services.anomaly_detection import AnomalyDetectionService

    others = db.query(MonitoredMetric).filter(MonitoredMetric.id != metric.id,
                                              MonitoredMetric.is_active == True).all()  # noqa: E712
    for o in others:
        o.is_active = False
    db.commit()
    try:
        out = AnomalyDetectionService.run_all_checks(db)
    finally:
        for o in others:
            o.is_active = True
        db.commit()
    db.refresh(metric)
    return out


def _scan_twice(db, key):  # noqa: F811
    from app.models.observability import ObservabilityIncident
    from app.services.observability_service import ObservabilityService as S

    for _ in range(2):
        S.fold_anomaly(db)
        db.commit()
    return db.query(ObservabilityIncident).filter(ObservabilityIncident.dedup_key == key).one()


def test_a_detector_that_cannot_run_is_error_and_its_incident_stays_open(db, world):  # noqa: F811
    m, key = _metric_with_open_incident(db, world, "thin", time_column=None)
    out = _run_only(db, m)
    assert m.last_check_status == "error", m.last_check_status
    assert out["errored"] == 1
    assert m.last_check_error and "time column" in m.last_check_error
    assert m.last_ok_at is None
    inc = _scan_twice(db, key)
    assert inc.status == "open"
    assert inc.detail["detector"]["status"] == "error"
    assert inc.detail["detector"]["error"] == m.last_check_error


def test_too_little_history_is_insufficient_and_is_not_recovery(db, world):  # noqa: F811
    m, key = _metric_with_open_incident(db, world, "thin", time_column="loaded_at")
    out = _run_only(db, m)
    assert m.last_check_status == "insufficient", m.last_check_status
    assert out["errored"] == 0
    assert m.last_check_error == "fewer than 8 days of data"
    assert m.last_ok_at is None
    inc = _scan_twice(db, key)
    assert inc.status == "open"
    assert inc.detail["detector"]["status"] == "insufficient"


def test_a_clean_check_resolves_the_incident(db, world):  # noqa: F811
    m, key = _metric_with_open_incident(db, world, "steady", time_column="loaded_at")
    _run_only(db, m)
    assert m.last_check_status == "ok", (m.last_check_status, m.last_check_error)
    assert m.last_ok_at is not None and m.last_check_error is None
    inc = _scan_twice(db, key)
    assert inc.status == "resolved"
    assert inc.detail["history"][-1]["reason"] == "metric_recovered"
