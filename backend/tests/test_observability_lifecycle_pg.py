"""Observability lifecycle, delivery and authority — executed on real Postgres.

Each test is named for the defect it locks (audit of demo@96b94da8):

* H02 anomaly  — a person resolved an anomaly incident; the next scan re-opened
                 it as a NEW incident from the same historical alert, every scan
                 for 14 days, and it was never auto-resolved once the metric
                 recovered.
* H03 delivery — once any channel was healthy, every scan re-sent EVERY open
                 incident to every channel; a channel that failed was retried
                 only by that blanket resend.
* H04 volume   — breached row counts became the baseline, so a sustained drop
                 "recovered" by itself.
* H09 authority— a VIEW share on a dataset could acknowledge / resolve its
                 incidents.
* H15 scan     — a scan whose commit failed returned an ordinary result.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg


# ── fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.dataset import Dataset, DatasetTable

    owner = make_user(db, "obs-owner", observability="edit", datasets="edit")
    viewer = make_user(db, "obs-viewer", observability="edit", datasets="view")
    ds = Dataset(name=f"obs-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add(ds)
    db.commit()
    tbl = DatasetTable(dataset_id=ds.id, display_name="orders", source_kind="physical_table")
    db.add(tbl)
    db.commit()
    share(db, "dataset", ds.id, viewer, "view", owner)
    return dict(owner=owner, viewer=viewer, ds=ds, tbl=tbl)


def _metric_with_alert(db, world, *, days_ago: float = 0.0):
    from app.models.anomaly import AnomalyAlert, MonitoredMetric

    m = MonitoredMetric(dataset_table_id=world["tbl"].id, metric_column="revenue",
                        owner_id=world["owner"].id)
    db.add(m)
    db.commit()
    a = AnomalyAlert(monitored_metric_id=m.id, detected_at=datetime.utcnow() - timedelta(days=days_ago),
                     current_value=10.0, expected_value=100.0, z_score=-4.0, change_pct=-90.0,
                     severity="critical")
    db.add(a)
    db.commit()
    return m, a


def _open_for(db, key):
    from app.models.observability import ObservabilityIncident

    db.expire_all()
    return (db.query(ObservabilityIncident)
            .filter(ObservabilityIncident.dedup_key == key)
            .filter(ObservabilityIncident.status != "resolved").all())


# ── H02 anomaly lifecycle ───────────────────────────────────────────────────

def test_resolved_anomaly_is_not_reopened_from_the_same_alert(client, db, world):  # noqa: F811
    from app.services.observability_service import ObservabilityService as S

    m, _ = _metric_with_alert(db, world)
    key = f"anomaly:metric_{m.id}"
    S.fold_anomaly(db)
    db.commit()
    [inc] = _open_for(db, key)
    r = client.patch(f"/api/v1/observability/incidents/{inc.id}", headers=world["owner"].headers,
                     json={"action": "resolve"})
    assert r.status_code == 200
    for _ in range(3):                      # the daily scan keeps running
        S.fold_anomaly(db)
        db.commit()
    assert _open_for(db, key) == [], "a resolved anomaly came back from an alert it already covered"


def test_a_new_anomaly_alert_after_resolution_opens_a_new_incident(db, world):  # noqa: F811
    from app.models.anomaly import AnomalyAlert
    from app.services.observability_service import ObservabilityService as S

    m, _ = _metric_with_alert(db, world, days_ago=2)
    key = f"anomaly:metric_{m.id}"
    S.fold_anomaly(db)
    db.commit()
    [inc] = _open_for(db, key)
    inc.status, inc.resolved_at = "resolved", datetime.utcnow() - timedelta(days=1)
    db.commit()
    db.add(AnomalyAlert(monitored_metric_id=m.id, detected_at=datetime.utcnow(), current_value=5.0,
                        expected_value=100.0, z_score=-5.0, change_pct=-95.0, severity="critical"))
    db.commit()
    S.fold_anomaly(db)
    db.commit()
    assert len(_open_for(db, key)) == 1, "a fresh anomaly after resolution must open again"


def test_anomaly_incident_resolves_once_the_metric_has_no_recent_alert(db, world):  # noqa: F811
    from app.services.observability_service import ObservabilityService as S

    m, a = _metric_with_alert(db, world)
    key = f"anomaly:metric_{m.id}"
    S.fold_anomaly(db)
    db.commit()
    assert len(_open_for(db, key)) == 1
    a.detected_at = datetime.utcnow() - timedelta(days=30)   # the metric has been normal since
    db.commit()
    S.fold_anomaly(db)
    db.commit()
    assert _open_for(db, key) == [], "an anomaly whose metric recovered stayed open forever"


# ── H03 delivery ────────────────────────────────────────────────────────────

@pytest.fixture()
def sends(monkeypatch):
    sent: list = []
    fail: set = set()

    def _send(ch, inc):
        if ch.id in fail:
            raise RuntimeError("boom")
        sent.append((ch.id, inc.id))

    monkeypatch.setattr("app.services.observability_notifier._send_one", _send)
    return sent, fail


def _channel(db, ds_id, name):
    from app.models.observability import ObservabilityAlertChannel

    c = ObservabilityAlertChannel(kind="webhook", name=name, target="https://hooks.example.com/x",
                                  scope="dataset", dataset_id=ds_id, min_severity="info")
    db.add(c)
    db.commit()
    return c


def _incident(db, world, key="freshness:monitor_x"):
    from app.services.observability_service import ObservabilityService as S

    inc, _ = S.upsert_incident(db, dataset_id=world["ds"].id, dataset_table_id=None, source="freshness",
                               dedup_key=f"{key}-{uuid.uuid4().hex[:6]}", title="t", detail={},
                               severity="critical")
    db.commit()
    return inc


def test_a_delivered_incident_is_not_sent_again_by_later_scans(db, world, sends):  # noqa: F811
    from app.services.observability_notifier import notify_new_incidents

    sent, _ = sends
    ch = _channel(db, world["ds"].id, "a")
    inc = _incident(db, world)
    notify_new_incidents(db, [inc])
    notify_new_incidents(db, [])            # next scan, nothing new
    notify_new_incidents(db, [])
    assert sent.count((ch.id, inc.id)) == 1, f"delivered incident re-sent: {sent}"


def test_a_failed_delivery_is_retried_on_that_channel_only(db, world, sends):  # noqa: F811
    from app.services.observability_notifier import notify_new_incidents

    sent, fail = sends
    good = _channel(db, world["ds"].id, "good")
    bad = _channel(db, world["ds"].id, "bad")
    fail.add(bad.id)
    inc = _incident(db, world)
    from app.models.observability import ObservabilityAlertDelivery as D
    from app.services.observability_notifier import dispatch_due

    notify_new_incidents(db, [inc])
    row = db.query(D).filter(D.incident_id == inc.id, D.channel_id == bad.id).one()
    assert row.status == "failed" and row.attempts == 1 and row.last_error, "a failed send left no record"
    fail.clear()                            # channel recovered
    notify_new_incidents(db, [])            # backoff not elapsed yet: nothing re-sent
    assert sent.count((bad.id, inc.id)) == 0
    dispatch_due(db, now=datetime.utcnow() + timedelta(minutes=6))
    assert sent.count((bad.id, inc.id)) == 1, f"failed delivery never retried: {sent}"
    assert sent.count((good.id, inc.id)) == 1, f"successful channel got a duplicate: {sent}"
    db.refresh(row)
    assert row.status == "sent" and row.attempts == 2


def test_a_delivery_that_keeps_failing_becomes_dead_not_lost(db, world, sends):  # noqa: F811
    from app.models.observability import ObservabilityAlertDelivery as D
    from app.services.observability_notifier import MAX_ATTEMPTS, dispatch_due, notify_new_incidents

    sent, fail = sends
    bad = _channel(db, world["ds"].id, "always-bad")
    fail.add(bad.id)
    inc = _incident(db, world)
    notify_new_incidents(db, [inc])
    t = datetime.utcnow()
    for i in range(MAX_ATTEMPTS + 2):
        t += timedelta(days=1)
        dispatch_due(db, now=t)
    row = db.query(D).filter(D.incident_id == inc.id, D.channel_id == bad.id).one()
    assert row.status == "dead" and row.attempts == MAX_ATTEMPTS


def test_a_delivery_for_a_resolved_incident_or_paused_channel_is_cancelled(db, world, sends):  # noqa: F811
    from app.models.observability import ObservabilityAlertDelivery as D
    from app.services.observability_notifier import dispatch_due, enqueue_deliveries

    sent, _ = sends
    ch = _channel(db, world["ds"].id, "c")
    inc = _incident(db, world)
    enqueue_deliveries(db, [inc])
    db.commit()
    inc.status = "resolved"
    db.commit()
    dispatch_due(db)
    assert (ch.id, inc.id) not in sent
    assert db.query(D).filter(D.incident_id == inc.id, D.channel_id == ch.id).one().status == "cancelled"


def test_enqueue_is_idempotent(db, world, sends):  # noqa: F811
    from app.models.observability import ObservabilityAlertDelivery as D
    from app.services.observability_notifier import enqueue_deliveries

    ch = _channel(db, world["ds"].id, "c")
    inc = _incident(db, world)
    for _ in range(3):
        enqueue_deliveries(db, [inc])
        db.commit()
    assert db.query(D).filter(D.incident_id == inc.id, D.channel_id == ch.id).count() == 1


# ── H04 volume baseline ─────────────────────────────────────────────────────

def test_a_sustained_volume_drop_does_not_become_the_baseline(db, world, monkeypatch):  # noqa: F811
    from app.models.observability import ObservabilityCheck, ObservabilityMonitor
    from app.services.observability_service import ObservabilityService as S

    mon = ObservabilityMonitor(dataset_id=world["ds"].id, dataset_table_id=world["tbl"].id, kind="volume",
                               name="v", config={}, severity="warning")
    db.add(mon)
    db.commit()
    base = datetime.utcnow() - timedelta(days=40)
    for i, v in enumerate([1000, 1010, 990, 1005, 995, 1000, 1002, 998]):
        db.add(ObservabilityCheck(monitor_id=mon.id, checked_at=base + timedelta(days=i), value=v, status="ok"))
    db.commit()
    count = {"n": 0.0}
    monkeypatch.setattr(S, "_live_base", staticmethod(lambda db_, t: (None, "postgresql", "(select 1) b")))
    monkeypatch.setattr(S, "_run_sql", staticmethod(lambda db_, t, sql: [{"cnt": count["n"]}]))
    statuses = []
    for _ in range(40):                     # the table stays empty for 40 scans
        statuses.append(S.run_monitor(mon, db)["status"])
        db.commit()
    assert set(statuses) == {"breached"}, f"a sustained drop to 0 'recovered' by itself: {statuses}"


# ── H09 incident authority ──────────────────────────────────────────────────

def test_a_dataset_view_share_cannot_change_incident_lifecycle(client, db, world):  # noqa: F811
    inc = _incident(db, world)
    for action in ("acknowledge", "resolve"):
        r = client.patch(f"/api/v1/observability/incidents/{inc.id}", headers=world["viewer"].headers,
                         json={"action": action})
        assert r.status_code == 403, f"{action} by a view share -> {r.status_code}"
    r = client.get("/api/v1/observability/incidents", headers=world["viewer"].headers,
                   params={"dataset_id": world["ds"].id})
    assert r.status_code == 200 and any(i["id"] == inc.id for i in _items(r.json()))


def test_dataset_editor_can_change_incident_lifecycle_positive_control(client, db, world):  # noqa: F811
    inc = _incident(db, world)
    r = client.patch(f"/api/v1/observability/incidents/{inc.id}", headers=world["owner"].headers,
                     json={"action": "acknowledge"})
    assert r.status_code == 200 and r.json()["status"] == "acknowledged"


def _items(body):
    return body["items"] if isinstance(body, dict) else body


# ── H15 scan that failed to persist ─────────────────────────────────────────

def test_a_scan_whose_results_cannot_be_saved_fails_and_is_recorded(db, world, monkeypatch):  # noqa: F811
    from app.models.observability import ObservabilityScanRun
    from app.services.observability_service import ObservabilityService as S

    def boom(db_, dataset_id):
        raise RuntimeError("commit failed")

    monkeypatch.setattr(S, "_scan_body", staticmethod(boom))
    with pytest.raises(S.ScanFailed) as ei:
        S.run_scan(db, dataset_id=world["ds"].id)
    db.expire_all()
    run = db.get(ObservabilityScanRun, ei.value.run_id)
    assert run.status == "failed" and run.finished_at and "commit failed" in run.errors[0]


def test_one_failing_step_makes_the_scan_partial_and_keeps_the_rest(db, world, monkeypatch):  # noqa: F811
    from app.models.observability import ObservabilityScanRun
    from app.services.observability_service import ObservabilityService as S

    m, _ = _metric_with_alert(db, world)

    def broken(db_, dataset_ids=None):
        raise RuntimeError("semantic layer down")

    monkeypatch.setattr(S, "fold_semantic", staticmethod(broken))
    out = S.run_scan(db, dataset_id=world["ds"].id)
    assert out["status"] == "partial" and any("semantic" in e for e in out["errors"])
    assert len(_open_for(db, f"anomaly:metric_{m.id}")) == 1, "the anomaly fold's result was lost"
    assert db.get(ObservabilityScanRun, out["run_id"]).status == "partial"


def test_a_concurrent_scan_is_refused_not_run_twice(db, world):  # noqa: F811
    from app.core.scheduler_lock import job_lock
    from app.services.observability_service import ObservabilityService as S
    import threading

    held, release = threading.Event(), threading.Event()

    def hold():
        with job_lock(S.SCAN_LOCK) as owned:
            assert owned
            held.set()
            release.wait(10)

    t = threading.Thread(target=hold)
    t.start()
    held.wait(10)
    try:
        with pytest.raises(S.ScanBusy):
            S.run_scan(db, dataset_id=world["ds"].id)
    finally:
        release.set()
        t.join()


def test_scan_endpoints_report_busy_as_409(client, db, world):  # noqa: F811
    from app.core.scheduler_lock import job_lock
    from app.services.observability_service import ObservabilityService as S
    import threading

    held, release = threading.Event(), threading.Event()

    def hold():
        with job_lock(S.SCAN_LOCK):
            held.set()
            release.wait(10)

    t = threading.Thread(target=hold)
    t.start()
    held.wait(10)
    try:
        r = client.post(f"/api/v1/observability/datasets/{world['ds'].id}/scan", headers=world["owner"].headers)
        assert r.status_code == 409
    finally:
        release.set()
        t.join()
    r = client.post(f"/api/v1/observability/datasets/{world['ds'].id}/scan", headers=world["owner"].headers)
    assert r.status_code == 200 and r.json()["status"] in ("succeeded", "partial")


def test_dataset_scan_needs_dataset_edit(client, db, world):  # noqa: F811
    r = client.post(f"/api/v1/observability/datasets/{world['ds'].id}/scan", headers=world["viewer"].headers)
    assert r.status_code == 403


# ── N1 duplicates ───────────────────────────────────────────────────────────

def test_two_alerts_for_one_metric_open_one_incident(db, world):  # noqa: F811
    from app.models.anomaly import AnomalyAlert
    from app.services.observability_service import ObservabilityService as S

    m, _ = _metric_with_alert(db, world, days_ago=1)
    db.add(AnomalyAlert(monitored_metric_id=m.id, detected_at=datetime.utcnow(), current_value=1.0,
                        expected_value=100.0, z_score=-6.0, change_pct=-99.0, severity="critical"))
    db.commit()
    S.fold_anomaly(db)
    db.commit()
    assert len(_open_for(db, f"anomaly:metric_{m.id}")) == 1


def test_the_database_refuses_a_second_open_incident_for_a_key(db, world):  # noqa: F811
    from sqlalchemy.exc import IntegrityError
    from app.models.observability import ObservabilityIncident

    key = f"freshness:monitor_dup-{uuid.uuid4().hex[:6]}"
    now = datetime.utcnow()
    for _ in range(2):
        db.add(ObservabilityIncident(dataset_id=world["ds"].id, source="freshness", pillar="freshness",
                                     dedup_key=key, title="t", severity="warning", status="open",
                                     first_seen_at=now, last_seen_at=now))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


# ── H06 resolve vs accept ───────────────────────────────────────────────────

def _schema_incident(db, world, monkeypatch, live_cols):
    from app.models.observability import ObservabilityCheck, ObservabilityMonitor
    from app.services.observability_service import ObservabilityService as S

    mon = ObservabilityMonitor(dataset_id=world["ds"].id, dataset_table_id=world["tbl"].id, kind="schema",
                               name="s", config={}, severity="warning")
    db.add(mon)
    db.commit()
    db.add(ObservabilityCheck(monitor_id=mon.id, checked_at=datetime.utcnow() - timedelta(days=1), status="ok",
                              value=2, detail={"columns": [{"name": "a", "type": "number"},
                                                           {"name": "b", "type": "text"}], "baseline_v": 2}))
    db.commit()
    monkeypatch.setattr(S, "_live_columns_fingerprint", staticmethod(lambda db_, t, reason=None: live_cols))
    assert S.run_monitor(mon, db)["status"] == "breached"
    db.commit()
    [inc] = _open_for(db, f"schema:monitor_{mon.id}")
    return mon, inc


def test_resolving_a_schema_incident_does_not_accept_the_change(client, db, world, monkeypatch):  # noqa: F811
    from app.services.observability_service import ObservabilityService as S

    mon, inc = _schema_incident(db, world, monkeypatch, [{"name": "a", "type": "number"}])
    r = client.patch(f"/api/v1/observability/incidents/{inc.id}", headers=world["owner"].headers,
                     json={"action": "resolve"})
    assert r.status_code == 200
    db.expire_all()
    assert S.run_monitor(mon, db)["status"] == "breached", "resolve silently accepted the schema change"
    db.commit()
    assert len(_open_for(db, f"schema:monitor_{mon.id}")) == 1


def test_accepting_a_schema_change_is_explicit_and_audited(client, db, world, monkeypatch):  # noqa: F811
    from app.models.audit_log import AuditLog
    from app.services.observability_service import ObservabilityService as S

    mon, inc = _schema_incident(db, world, monkeypatch, [{"name": "a", "type": "number"}])
    r = client.patch(f"/api/v1/observability/incidents/{inc.id}", headers=world["viewer"].headers,
                     json={"action": "accept_baseline"})
    assert r.status_code == 403
    r = client.patch(f"/api/v1/observability/incidents/{inc.id}", headers=world["owner"].headers,
                     json={"action": "accept_baseline"})
    assert r.status_code == 200 and r.json()["status"] == "resolved"
    assert [h["action"] for h in r.json()["detail"]["history"]][-1] == "accept_baseline"
    db.expire_all()
    assert S.run_monitor(mon, db)["status"] == "ok"
    assert db.query(AuditLog).filter(AuditLog.resource_id == str(inc.id),
                                     AuditLog.resource_type == "observability_incident").count() == 1


# ── H13 paging ──────────────────────────────────────────────────────────────

def test_every_incident_is_reachable_by_paging(client, db, world):  # noqa: F811
    from app.models.observability import ObservabilityIncident

    now = datetime.utcnow()
    for i in range(230):
        db.add(ObservabilityIncident(dataset_id=world["ds"].id, source="quality", pillar="quality",
                                     dedup_key=f"quality:rule_page{i}-{uuid.uuid4().hex[:4]}", title=f"page {i}",
                                     severity=("critical", "warning", "info")[i % 3], status="open",
                                     first_seen_at=now, last_seen_at=now - timedelta(minutes=i)))
    db.commit()
    seen, offset, total = [], 0, None
    while True:
        r = client.get("/api/v1/observability/incidents", headers=world["owner"].headers,
                       params={"dataset_id": world["ds"].id, "limit": 100, "offset": offset})
        body = r.json()
        total = body["total"]
        seen += [i["id"] for i in body["items"]]
        offset += 100
        if offset >= total:
            break
    assert total >= 230 and len(seen) == total == len(set(seen))
    r = client.get("/api/v1/observability/incidents", headers=world["owner"].headers,
                   params={"dataset_id": world["ds"].id, "q": "page 17", "limit": 5})
    assert r.json()["total"] >= 1 and all("page 17" in i["title"] for i in r.json()["items"])


def test_incident_deep_link_is_404_without_access(client, db, world):  # noqa: F811
    inc = _incident(db, world)
    stranger = make_user(db, "obs-stranger", observability="full", datasets="view")
    assert client.get(f"/api/v1/observability/incidents/{inc.id}", headers=stranger.headers).status_code == 404
    r = client.get(f"/api/v1/observability/incidents/{inc.id}", headers=world["viewer"].headers)
    assert r.status_code == 200 and r.json()["capabilities"]["act"] is False
    r = client.get(f"/api/v1/observability/incidents/{inc.id}", headers=world["owner"].headers)
    assert r.json()["capabilities"]["act"] is True


# ── N4 lineage disclosure ───────────────────────────────────────────────────

def test_lineage_does_not_name_charts_or_dashboards_the_caller_cannot_open(client, db, world):  # noqa: F811
    from app.models.models import Chart, ChartType, Dashboard, DashboardChart

    secret = f"Board-Payroll-{uuid.uuid4().hex[:6]}"
    other = make_user(db, "obs-other", explore_charts="full", dashboards="full", datasets="view")
    ch = Chart(name=f"Chart-Salaries-{uuid.uuid4().hex[:6]}", chart_type=list(ChartType)[0], config={},
               dataset_table_id=world["tbl"].id, owner_id=other.id)
    db.add(ch)
    db.commit()
    d = Dashboard(name=secret, owner_id=other.id)
    db.add(d)
    db.commit()
    db.add(DashboardChart(dashboard_id=d.id, chart_id=ch.id, layout={"x": 0, "y": 0, "w": 4, "h": 3}))
    db.commit()
    r = client.get("/api/v1/observability/semantic-lineage", headers=world["viewer"].headers,
                   params={"dataset_id": world["ds"].id})
    assert r.status_code == 200
    assert ch.name not in r.text and secret not in r.text, "lineage disclosed private chart/dashboard names"
