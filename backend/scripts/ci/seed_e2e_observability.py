#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Seed the Observability journeys (`e2e/tests/observability.spec.ts`). CI / local rig only.

A REAL SOURCE: tables in schema ``e2e_obs`` of the job's own Postgres, read
through an ordinary PostgreSQL datasource. Nothing is scanned here — the spec
runs every check through the product (Run checks / Scan now) and asserts what
the browser shows. Seeded directly are only things that cannot be produced
deterministically without time passing or a model: anomaly alerts, a backlog of
incidents for paging, and alert deliveries that already failed.

Datasets (owner = the E2E admin):
  OBS Fresh     orders_fresh, no checks          -> O01 not monitored, O02/O03 set up + pass
  OBS Stale     orders_stale + freshness 24h     -> O04 breach, O09 repeated scans
  OBS Broken    a table whose source is gone     -> O05 error, never healthy
  OBS Anomaly   metric with a NEW alert (O07) and one whose open incident has
                only an OLD alert (O08 recovery)
  OBS Backlog   260 incidents                    -> O20 paging / search
  OBS Schema    sql_query table + schema monitor -> O12 change + explicit accept
Principals (written to e2e/.auth/observability.json): editor (dataset edit on
all), viewer (dataset view on all), outsider (Observability, no dataset).
A dataset channel on OBS Stale has one FAILED and one DEAD delivery (O14).

DETERMINISTIC + IDEMPOTENT: looked up by name; re-running refreshes the
source rows (timestamps relative to now) and nothing else.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))

import sqlalchemy as sa  # noqa: E402

SCHEMA = "e2e_obs"
DATASOURCE = "E2E observability Postgres"
EMAIL = os.environ.get("E2E_EMAIL", "admin@appbi.io")
COLS = [{"name": "id", "type": "integer"}, {"name": "amount", "type": "numeric"},
        {"name": "loaded_at", "type": "timestamp"}]


def _source(url: str) -> None:
    eng = sa.create_engine(url)
    with eng.begin() as c:
        c.execute(sa.text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        for name, lag in (("orders_fresh", "0 hours"), ("orders_stale", "48 hours")):
            c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.{name}"))
            c.execute(sa.text(f"CREATE TABLE {SCHEMA}.{name} (id int, amount numeric, loaded_at timestamp)"))
            c.execute(sa.text(f"INSERT INTO {SCHEMA}.{name} SELECT g, g * 10, "
                              f"(now() AT TIME ZONE 'utc') - interval '{lag}' - (g || ' minutes')::interval "
                              f"FROM generate_series(1, 200) g"))
        c.execute(sa.text(f"DROP TABLE IF EXISTS {SCHEMA}.orders_gone"))


def main() -> int:
    if (os.environ.get("ENVIRONMENT") or "").lower() not in ("test", "dev", "development"):
        print("refusing: seed_e2e_observability only runs with ENVIRONMENT=test/dev")
        return 2
    from app.api import auth as auth_api
    from app.core.config import settings
    from app.core.crypto import encrypt_config
    from app.core.database import SessionLocal
    from app.models.anomaly import AnomalyAlert, MonitoredMetric
    from app.models.dataset import Dataset, DatasetGrant, DatasetTable
    from app.models.models import DataSource, DataSourceType
    from app.models.observability import (
        ObservabilityAlertChannel, ObservabilityAlertDelivery, ObservabilityIncident, ObservabilityMonitor,
    )
    from app.models.user import User, UserStatus

    _source(settings.DATABASE_URL)
    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.email == EMAIL).one()
        url = sa.engine.make_url(settings.DATABASE_URL)
        src = db.query(DataSource).filter(DataSource.name == DATASOURCE).first()
        if src is None:
            src = DataSource(name=DATASOURCE, type=DataSourceType("postgresql"), owner_id=admin.id,
                             config=encrypt_config({"host": url.host, "port": url.port or 5432,
                                                    "database": url.database, "username": url.username,
                                                    "password": url.password, "schema_name": SCHEMA}))
            db.add(src)
            db.flush()

        def dataset(name: str, table: str, *, kind: str = "physical_table", query: str | None = None):
            ds = db.query(Dataset).filter(Dataset.name == name).first()
            if ds is None:
                ds = Dataset(name=name, owner_id=admin.id)
                db.add(ds)
                db.flush()
            t = db.query(DatasetTable).filter(DatasetTable.dataset_id == ds.id).first()
            if t is None:
                t = DatasetTable(dataset_id=ds.id, datasource_id=src.id, display_name=table, source_kind=kind,
                                 source_table_name=None if query else f"{SCHEMA}.{table}", source_query=query,
                                 columns_cache={"columns": [dict(c) for c in COLS]})
                db.add(t)
                db.flush()
            return ds, t

        fresh, fresh_t = dataset("OBS Fresh", "orders_fresh")
        stale, stale_t = dataset("OBS Stale", "orders_stale")
        broken, broken_t = dataset("OBS Broken", "orders_gone")
        anomaly, anomaly_t = dataset("OBS Anomaly", "orders_fresh")
        backlog, _ = dataset("OBS Backlog", "orders_fresh")
        schema_ds, schema_t = dataset("OBS Schema", "orders_sql", kind="sql_query",
                                      query=f"SELECT id, amount, loaded_at FROM {SCHEMA}.orders_fresh")

        def monitor(ds, t, kind, config):
            m = (db.query(ObservabilityMonitor)
                 .filter(ObservabilityMonitor.dataset_table_id == t.id, ObservabilityMonitor.kind == kind).first())
            if m is None:
                db.add(ObservabilityMonitor(dataset_id=ds.id, dataset_table_id=t.id, kind=kind,
                                            name=f"{t.display_name} · {kind}", config=config,
                                            severity="critical", owner_id=admin.id))
                db.flush()

        monitor(stale, stale_t, "freshness", {"time_column": "loaded_at", "max_lag_hours": 24})
        monitor(broken, broken_t, "schema", {})
        monitor(schema_ds, schema_t, "schema", {})

        # Anomaly: metric N has a NEW alert; metric R has only a 30-day-old alert
        # and an OPEN incident from back then — the scan must resolve it.
        def metric(col):
            m = (db.query(MonitoredMetric)
                 .filter(MonitoredMetric.dataset_table_id == anomaly_t.id, MonitoredMetric.metric_column == col).first())
            if m is None:
                m = MonitoredMetric(dataset_table_id=anomaly_t.id, metric_column=col, owner_id=admin.id)
                db.add(m)
                db.flush()
            return m

        now = datetime.utcnow()
        new_m, rec_m = metric("amount"), metric("id")
        if not db.query(AnomalyAlert).filter(AnomalyAlert.monitored_metric_id == new_m.id).first():
            db.add(AnomalyAlert(monitored_metric_id=new_m.id, detected_at=now - timedelta(hours=1),
                                current_value=100.0, expected_value=2000.0, z_score=-4.2, change_pct=-95.0,
                                severity="critical", explanation="revenue fell sharply"))
        if not db.query(AnomalyAlert).filter(AnomalyAlert.monitored_metric_id == rec_m.id).first():
            db.add(AnomalyAlert(monitored_metric_id=rec_m.id, detected_at=now - timedelta(days=30),
                                current_value=1.0, expected_value=100.0, z_score=-5.0, change_pct=-99.0,
                                severity="warning"))
        rec_key = f"anomaly:metric_{rec_m.id}"
        if not db.query(ObservabilityIncident).filter(ObservabilityIncident.dedup_key == rec_key).first():
            db.add(ObservabilityIncident(dataset_id=anomaly.id, dataset_table_id=anomaly_t.id, source="anomaly",
                                         pillar="distribution", dedup_key=rec_key, title="id: old anomaly",
                                         detail={}, severity="warning", status="open",
                                         first_seen_at=now - timedelta(days=30), last_seen_at=now - timedelta(days=30)))

        # Backlog for paging (more than the old 200 / 500 caps when counted with resolved)
        if db.query(ObservabilityIncident).filter(ObservabilityIncident.dataset_id == backlog.id).count() < 260:
            for i in range(260):
                db.add(ObservabilityIncident(
                    dataset_id=backlog.id, source="quality", pillar="quality",
                    dedup_key=f"quality:rule_backlog{i}", title=f"Backlog check {i:03d} failed",
                    detail={"rows_failed": i}, severity=("critical", "warning", "info")[i % 3],
                    status="resolved" if i % 4 == 0 else "open",
                    first_seen_at=now - timedelta(hours=i), last_seen_at=now - timedelta(minutes=i),
                    resolved_at=(now - timedelta(minutes=i)) if i % 4 == 0 else None))

        # A dataset channel on OBS Stale whose earlier sends failed.
        ch = db.query(ObservabilityAlertChannel).filter(ObservabilityAlertChannel.name == "OBS failing webhook").first()
        if ch is None:
            ch = ObservabilityAlertChannel(kind="webhook", name="OBS failing webhook", scope="dataset",
                                           target="https://obs-e2e-unreachable.invalid/secret-path",
                                           dataset_id=stale.id, owner_id=admin.id, min_severity="info",
                                           last_error="target answered HTTP 503")
            db.add(ch)
            db.flush()
            for status, attempts in (("failed", 2), ("dead", 6)):
                inc = ObservabilityIncident(dataset_id=stale.id, source="quality", pillar="quality",
                                            dedup_key=f"quality:rule_delivery_{status}", title=f"Delivery {status}",
                                            detail={}, severity="warning", status="open",
                                            first_seen_at=now, last_seen_at=now)
                db.add(inc)
                db.flush()
                db.add(ObservabilityAlertDelivery(incident_id=inc.id, channel_id=ch.id, status=status,
                                                  attempts=attempts, last_error="target answered HTTP 503",
                                                  next_attempt_at=(now + timedelta(days=1)) if status == "failed" else None))

        none = {k: "none" for k in ("data_sources", "datasets", "explore_charts", "dashboards", "workboards",
                                    "govern", "agent_flows", "chat", "observability", "settings")}

        def principal(label, **levels):
            email = f"obs-{label}@e2e.test"
            u = db.query(User).filter(User.email == email).first()
            if u is None:
                u = User(id=uuid.uuid4(), email=email, full_name=f"obs {label}", status=UserStatus.ACTIVE,
                         password_hash=None, permissions={**none, **levels})
                db.add(u)
                db.flush()
            return u

        editor = principal("editor", datasets="edit", observability="edit", explore_charts="view")
        viewer = principal("viewer", datasets="view", observability="edit", explore_charts="view")
        outsider = principal("outsider", datasets="view", observability="full")
        for ds in (fresh, stale, broken, anomaly, backlog, schema_ds):
            for who, verb in ((editor, "edit"), (viewer, "explore")):
                if not db.query(DatasetGrant).filter(DatasetGrant.dataset_id == ds.id,
                                                     DatasetGrant.user_id == who.id).first():
                    db.add(DatasetGrant(dataset_id=ds.id, user_id=who.id, verb=verb, granted_by=admin.id))
        db.commit()

        def tok(u):
            return auth_api.create_access_token(db.get(User, u.id))

        out = {
            "datasets": {"fresh": fresh.id, "stale": stale.id, "broken": broken.id, "anomaly": anomaly.id,
                         "backlog": backlog.id, "schema": schema_ds.id},
            "tables": {"fresh": fresh_t.id, "schema": schema_t.id},
            "metrics": {"new": new_m.id, "recovering": rec_m.id},
            "channel": ch.id,
            "users": {"editor": tok(editor), "viewer": tok(viewer), "outsider": tok(outsider)},
        }
        path = Path(os.environ.get("E2E_OBS_FIXTURE") or (BACKEND.parent / "e2e" / ".auth" / "observability.json"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(out, indent=1), encoding="utf-8")
        print(json.dumps({k: v for k, v in out.items() if k != "users"}))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
