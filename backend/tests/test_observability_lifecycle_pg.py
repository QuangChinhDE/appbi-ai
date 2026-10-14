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


def test_anomaly_incident_resolves_on_a_clean_check_after_the_alert(db, world):  # noqa: F811
    """Recovery needs evidence: a check that ran and found the metric normal
    AFTER the newest alert (was: "no alert for N days", see the R1 tests)."""
    from app.services.observability_service import ObservabilityService as S

    m, a = _metric_with_alert(db, world)
    key = f"anomaly:metric_{m.id}"
    S.fold_anomaly(db)
    db.commit()
    assert len(_open_for(db, key)) == 1
    a.detected_at = datetime.utcnow() - timedelta(days=30)
    m.last_checked_at = m.last_ok_at = datetime.utcnow()
    m.last_check_status = "ok"
    db.commit()
    S.fold_anomaly(db)
    db.commit()
    assert _open_for(db, key) == [], "an anomaly whose metric was checked normal stayed open"


# ── R1: "no new alert" is not "recovered" ───────────────────────────────────

@pytest.mark.parametrize("status,error", [("error", "history query failed: OperationalError"),
                                          ("insufficient", "fewer than 8 days of data"),
                                          (None, None)])
def test_an_anomaly_is_not_recovered_when_the_detector_could_not_judge(db, world, status, error):  # noqa: F811
    """The source was unreachable for days (error), the data too thin
    (insufficient) or the metric never checked (None): no new alert, but no
    evidence either - the incident stays open and says why."""
    from app.services.observability_service import ObservabilityService as S

    m, a = _metric_with_alert(db, world)
    key = f"anomaly:metric_{m.id}"
    S.fold_anomaly(db)
    db.commit()
    a.detected_at = datetime.utcnow() - timedelta(days=30)        # far past every window
    m.last_checked_at = datetime.utcnow() if status else None
    m.last_check_status, m.last_check_error = status, error
    db.commit()
    for _ in range(3):
        S.fold_anomaly(db)
        db.commit()
    [inc] = _open_for(db, key)
    assert inc.detail["detector"]["status"] == (status or "never")
    assert inc.detail["detector"]["error"] == error


def test_a_clean_check_older_than_the_alert_is_not_recovery(db, world):  # noqa: F811
    from app.services.observability_service import ObservabilityService as S

    m, a = _metric_with_alert(db, world)
    m.last_ok_at = a.detected_at - timedelta(hours=1)
    m.last_check_status = "error"
    db.commit()
    S.fold_anomaly(db)
    db.commit()
    assert len(_open_for(db, f"anomaly:metric_{m.id}")) == 1


def test_a_stale_alert_cleared_by_a_clean_check_never_opens(db, world):  # noqa: F811
    from app.services.observability_service import ObservabilityService as S

    m, a = _metric_with_alert(db, world)
    m.last_ok_at = datetime.utcnow()
    m.last_check_status = "ok"
    db.commit()
    S.fold_anomaly(db)
    db.commit()
    assert _open_for(db, f"anomaly:metric_{m.id}") == []


def test_run_all_checks_records_an_unreachable_source_as_error_not_normal(db, world):  # noqa: F811
    """The real detector against a source that refuses connections."""
    from app.models.anomaly import MonitoredMetric
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource, DataSourceType
    from app.services.anomaly_detection import AnomalyDetectionService

    src = DataSource(name=f"down-{uuid.uuid4().hex[:6]}", type=DataSourceType.POSTGRESQL,
                     owner_id=world["owner"].id,
                     config={"host": "127.0.0.1", "port": 1, "database": "x", "username": "x", "password": "x"})
    db.add(src)
    db.flush()
    t = DatasetTable(dataset_id=world["ds"].id, display_name="down", source_kind="physical_table",
                     source_table_name="public.nope", datasource_id=src.id)
    db.add(t)
    db.flush()
    m = MonitoredMetric(dataset_table_id=t.id, metric_column="amount", time_column="day", owner_id=world["owner"].id)
    db.add(m)
    db.commit()
    others = db.query(MonitoredMetric).filter(MonitoredMetric.id != m.id, MonitoredMetric.is_active == True).all()  # noqa: E712
    for o in others:                     # this run checks only the metric under test
        o.is_active = False
    db.commit()
    try:
        out = AnomalyDetectionService.run_all_checks(db)
    finally:
        for o in others:
            o.is_active = True
        db.commit()
    db.refresh(m)
    assert out["errored"] == 1
    assert m.last_check_status == "error" and m.last_checked_at and m.last_ok_at is None
    assert m.last_check_error


@pytest.mark.parametrize("flag,scheduled", [(None, True), ("on", True), ("off", False), ("OFF", False)])
def test_the_daily_scan_can_be_kept_off_a_deterministic_deployment(monkeypatch, flag, scheduled):
    """O08b: the 02:00 UTC scan fired inside an E2E run and rewrote seeded detector
    states. APPBI_DAILY_SCAN=off leaves it unscheduled; alert dispatch still runs."""
    from app.services import anomaly_scheduler as sched

    if flag is None:
        monkeypatch.delenv("APPBI_DAILY_SCAN", raising=False)
    else:
        monkeypatch.setenv("APPBI_DAILY_SCAN", flag)
    sched.startup()
    try:
        assert (sched._scheduler.get_job("anomaly_daily_scan") is not None) is scheduled
        assert (sched.next_run_time() is not None) is scheduled
        assert sched._scheduler.get_job("observability_alert_dispatch") is not None
    finally:
        sched.shutdown()


# ── H03 delivery ────────────────────────────────────────────────────────────

@pytest.fixture()
def quiet_ledger(db, world):  # noqa: F811
    """This database is shared by every PG suite: pending deliveries left by
    earlier runs and other suites' global channels would fill the dispatcher's
    batch (it sends the OLDEST due rows first, DISPATCH_BATCH per call) and the
    rows a test asserts on would wait for a later call. Each delivery test owns
    the ledger: leftovers are cancelled, foreign channels paused."""
    from app.models.observability import ObservabilityAlertChannel, ObservabilityAlertDelivery as D

    db.query(D).filter(D.status.in_(("pending", "failed"))).update({"status": "cancelled"}, synchronize_session=False)
    db.query(ObservabilityAlertChannel).filter(
        (ObservabilityAlertChannel.dataset_id.is_(None))
        | (ObservabilityAlertChannel.dataset_id != world["ds"].id)
    ).update({"is_active": False}, synchronize_session=False)
    db.commit()


@pytest.fixture()
def sends(monkeypatch, quiet_ledger):
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


def test_two_dispatchers_at_once_send_each_delivery_once(db, world, monkeypatch, quiet_ledger):  # noqa: F811
    """The 10-minute dispatch job and the dispatch after a scan can overlap
    (another worker / instance): a row is claimed before it is sent."""
    import threading
    import time

    from app.core.database import SessionLocal
    from app.services.observability_notifier import dispatch_due, enqueue_deliveries

    sent: list = []
    lock = threading.Lock()

    def slow_send(ch, inc):
        time.sleep(0.3)
        with lock:
            sent.append((ch.id, inc.id))

    monkeypatch.setattr("app.services.observability_notifier._send_one", slow_send)
    ch = _channel(db, world["ds"].id, "race")
    incs = [_incident(db, world) for _ in range(4)]
    enqueue_deliveries(db, incs)
    db.commit()
    mine = {(ch.id, i.id) for i in incs}

    def run():
        s = SessionLocal()
        try:
            dispatch_due(s)
        finally:
            s.close()

    ts = [threading.Thread(target=run) for _ in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(60)
    got = [p for p in sent if p in mine]
    assert sorted(got) == sorted(mine), f"each delivery exactly once, got {got}"


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


# ── review follow-ups ───────────────────────────────────────────────────────

def test_a_delivery_in_backoff_is_not_claimed_again(db, world, sends):  # noqa: F811
    """A dispatcher holding a stale id list must not re-send a row another
    dispatcher just failed and pushed into backoff."""
    from app.models.observability import ObservabilityAlertDelivery as D
    from app.services.observability_notifier import dispatch_due, enqueue_deliveries

    sent, fail = sends
    ch = _channel(db, world["ds"].id, "backoff")
    inc = _incident(db, world)
    enqueue_deliveries(db, [inc])
    db.commit()
    row = db.query(D).filter(D.incident_id == inc.id, D.channel_id == ch.id).one()
    row.status, row.attempts, row.next_attempt_at = "failed", 1, datetime.utcnow() + timedelta(minutes=5)
    db.commit()
    dispatch_due(db)
    assert (ch.id, inc.id) not in sent


def test_a_view_level_module_user_never_sees_a_channel_target(client, db, world):  # noqa: F811
    from app.models.observability import ObservabilityAlertChannel

    u = make_user(db, "obs-viewlevel", observability="view", datasets="edit")
    share(db, "dataset", world["ds"].id, u, "edit", world["owner"])
    ch = ObservabilityAlertChannel(kind="webhook", name="mine", target="https://hooks.example.com/very-secret",
                                   scope="dataset", dataset_id=world["ds"].id, owner_id=u.id)
    db.add(ch)
    db.commit()
    rows = client.get("/api/v1/observability/alert-channels", headers=u.headers).json()
    row = next(r for r in rows if r["id"] == ch.id)
    assert "very-secret" not in row["target"] and row["capabilities"]["manage"] is False


def test_a_scan_left_running_by_a_killed_process_is_reaped(db, world):  # noqa: F811
    from app.models.observability import ObservabilityScanRun
    from app.services.observability_service import ObservabilityService as S

    r = ObservabilityScanRun(scope="dataset", dataset_id=world["ds"].id, trigger="manual", status="running",
                             started_at=datetime.utcnow() - timedelta(hours=9))
    db.add(r)
    db.commit()
    S.run_scan(db, dataset_id=world["ds"].id)
    db.expire_all()
    assert db.get(ObservabilityScanRun, r.id).status == "failed"


# ── R2: scanner crash and the scan's own record ─────────────────────────────

def _admin(db):
    return make_user(db, "obs-admin-r2", observability="full", datasets="full")


def test_status_reaps_a_run_whose_scanner_died_without_waiting(client, db, world):  # noqa: F811
    from app.models.observability import ObservabilityScanRun

    r = ObservabilityScanRun(scope="global", trigger="schedule", status="running",
                             started_at=datetime.utcnow() - timedelta(minutes=3))
    db.add(r)
    db.commit()
    body = client.get("/api/v1/observability/status", headers=_admin(db).headers).json()
    db.expire_all()
    assert db.get(ObservabilityScanRun, r.id).status == "failed"
    assert body["running"] is False


def test_status_never_reaps_a_scan_that_is_really_running(client, db, world):  # noqa: F811
    import threading

    from app.core.scheduler_lock import job_lock
    from app.models.observability import ObservabilityScanRun
    from app.services.observability_service import ObservabilityService as S

    held, release = threading.Event(), threading.Event()

    def hold():
        with job_lock(S.SCAN_LOCK):
            held.set()
            release.wait(10)

    t = threading.Thread(target=hold)
    t.start()
    held.wait(10)
    try:
        r = ObservabilityScanRun(scope="global", trigger="manual", status="running", started_at=datetime.utcnow())
        db.add(r)
        db.commit()
        body = client.get("/api/v1/observability/status", headers=_admin(db).headers).json()
        db.expire_all()
        assert db.get(ObservabilityScanRun, r.id).status == "running" and body["running"] is True
    finally:
        release.set()
        t.join()
        db.query(ObservabilityScanRun).filter(ObservabilityScanRun.status == "running").update(
            {"status": "failed"}, synchronize_session=False)
        db.commit()


def test_results_saved_but_run_record_not_is_not_reported_as_success(client, db, world, monkeypatch):  # noqa: F811
    from app.models.observability import ObservabilityScanRun
    from app.services.observability_service import ObservabilityService as S

    real = S._finish_run
    monkeypatch.setattr(S, "_finish_run", staticmethod(
        lambda db_, run_id, status, counts, errors: False if status != "failed" else real(db_, run_id, status, counts, errors)))
    r = client.post(f"/api/v1/observability/datasets/{world['ds'].id}/scan", headers=world["owner"].headers)
    assert r.status_code == 500, r.text
    run_id = r.json()["detail"]["run_id"] if isinstance(r.json().get("detail"), dict) else None
    monkeypatch.setattr(S, "_finish_run", real)
    client.get("/api/v1/observability/status", headers=_admin(db).headers)    # scanner gone -> reaped
    db.expire_all()
    if run_id:
        assert db.get(ObservabilityScanRun, run_id).status == "failed"
    assert db.query(ObservabilityScanRun).filter(ObservabilityScanRun.status == "running").count() == 0


# ── R3: recovering deliveries that gave up ──────────────────────────────────

def test_dead_deliveries_are_recovered_once_on_request_and_never_resend_delivered(client, db, world, sends):  # noqa: F811
    from app.models.observability import ObservabilityAlertDelivery as D
    from app.services.observability_notifier import MAX_ATTEMPTS, dispatch_due, notify_new_incidents

    sent, fail = sends
    ch = _channel(db, world["ds"].id, "recover")
    ch.owner_id = world["owner"].id
    db.commit()
    dead_inc, done_inc, gone_inc = _incident(db, world), _incident(db, world), _incident(db, world)
    notify_new_incidents(db, [done_inc])                     # delivered fine
    fail.add(ch.id)
    notify_new_incidents(db, [dead_inc, gone_inc])
    t = datetime.utcnow()
    for _ in range(MAX_ATTEMPTS + 1):
        t += timedelta(days=1)
        dispatch_due(db, now=t)
    row = lambda inc: db.query(D).filter(D.incident_id == inc.id, D.channel_id == ch.id).one()  # noqa: E731
    db.expire_all()
    assert row(dead_inc).status == "dead" and row(gone_inc).status == "dead"
    gone_inc.status = "resolved"
    db.commit()
    dispatch_due(db, now=t + timedelta(days=30))             # nothing revives a dead row on its own
    assert row(dead_inc).status == "dead"

    fail.clear()                                             # the user fixed the channel
    before = list(sent)
    assert client.post(f"/api/v1/observability/alert-channels/{ch.id}/retry-deliveries",
                       headers=world["viewer"].headers).status_code in (403, 404)
    r = client.post(f"/api/v1/observability/alert-channels/{ch.id}/retry-deliveries", headers=world["owner"].headers)
    assert r.status_code == 200, r.text
    assert (r.json()["requeued"], r.json()["cancelled"]) == (1, 1)
    db.expire_all()
    new = sent[len(before):]
    assert new.count((ch.id, dead_inc.id)) == 1 and (ch.id, done_inc.id) not in new and (ch.id, gone_inc.id) not in new
    assert row(dead_inc).status == "sent" and row(gone_inc).status == "cancelled" and row(done_inc).status == "sent"
    r = client.post(f"/api/v1/observability/alert-channels/{ch.id}/retry-deliveries", headers=world["owner"].headers)
    assert r.json()["requeued"] == 0                          # idempotent: nothing left to recover


def test_retry_needs_an_active_channel(client, db, world, sends):  # noqa: F811
    ch = _channel(db, world["ds"].id, "paused")
    ch.owner_id, ch.is_active = world["owner"].id, False
    db.commit()
    r = client.post(f"/api/v1/observability/alert-channels/{ch.id}/retry-deliveries", headers=world["owner"].headers)
    assert r.status_code == 409


# ── R4: a disabled module is off everywhere ─────────────────────────────────

def test_a_disabled_module_answers_nothing_and_sends_nothing(client, db, world, monkeypatch):  # noqa: F811
    from app.core.config import settings
    from app.services import anomaly_scheduler as sched

    admin = make_user(db, "obs-admin-r4", observability="full", datasets="full")
    assert client.get("/api/v1/observability/overview", headers=admin.headers).status_code == 200
    calls = []
    monkeypatch.setattr("app.services.anomaly_detection.AnomalyDetectionService.run_all_checks",
                        staticmethod(lambda db_: calls.append("anomaly") or {}))
    monkeypatch.setattr("app.services.observability_service.ObservabilityService.scan_all",
                        staticmethod(lambda db_, **k: calls.append("scan") or {}))
    monkeypatch.setattr("app.services.observability_notifier.dispatch_due",
                        lambda db_, **k: calls.append("dispatch") or 0)

    monkeypatch.setattr(settings, "OBSERVABILITY_ENABLED", False)
    for method, path in (("get", "/api/v1/observability/overview"), ("get", "/api/v1/observability/incidents"),
                         ("post", "/api/v1/observability/scan"), ("get", "/api/v1/observability/alert-channels")):
        assert getattr(client, method)(path, headers=admin.headers).status_code == 404, path
    sched._run_anomaly_scan.__wrapped__()
    sched._dispatch_alerts.__wrapped__()
    assert "scan" not in calls and "dispatch" not in calls

    monkeypatch.setattr(settings, "OBSERVABILITY_ENABLED", True)          # positive control
    assert client.get("/api/v1/observability/overview", headers=admin.headers).status_code == 200
    sched._run_anomaly_scan.__wrapped__()
    sched._dispatch_alerts.__wrapped__()
    assert "scan" in calls and "dispatch" in calls


# ── R5: a scan is bounded in time ───────────────────────────────────────────

def test_a_scan_over_its_time_budget_stops_running_monitors_and_says_so(db, world, monkeypatch):  # noqa: F811
    import time

    from app.core.config import settings
    from app.models.observability import ObservabilityMonitor
    from app.services.observability_service import ObservabilityService as S

    for k in ("freshness", "volume", "schema"):
        db.add(ObservabilityMonitor(dataset_id=world["ds"].id, dataset_table_id=world["tbl"].id, kind=k,
                                    name=k, config={}, severity="warning"))
    db.commit()
    ran = []

    def slow(m, db_):
        ran.append(m.id)
        time.sleep(1.2)
        return {"status": "ok", "value": None, "detail": {}, "created_incident": None}

    monkeypatch.setattr(S, "run_monitor", staticmethod(slow))
    monkeypatch.setattr(settings, "OBSERVABILITY_SCAN_BUDGET_SECONDS", 1)
    out = S.run_scan(db, dataset_id=world["ds"].id)
    assert len(ran) < 3 and out["monitors_skipped"] == 3 - len(ran)
    assert out["status"] == "partial" and "time budget" in out["errors"][0]


# ── Health contract: active anomaly metrics are monitoring ──────────────────

def _usage_row(client, who, ds_id):
    rows = client.get("/api/v1/observability/usage", headers=who.headers).json()
    return next(r for r in rows if r["datasetId"] == ds_id)


def _metric(db, world, status, *, ok_at=None):
    from app.models.anomaly import MonitoredMetric

    m = MonitoredMetric(dataset_table_id=world["tbl"].id, metric_column=f"c{uuid.uuid4().hex[:4]}",
                        owner_id=world["owner"].id, last_check_status=status,
                        last_checked_at=datetime.utcnow() if status else None,
                        last_check_error="history query failed" if status == "error" else None,
                        last_ok_at=ok_at)
    db.add(m)
    db.commit()
    return m


def test_a_dataset_monitored_only_by_an_anomaly_metric_is_observed_and_counted(client, db, world):  # noqa: F811
    _metric(db, world, "ok", ok_at=datetime.utcnow())
    r = _usage_row(client, world["owner"], world["ds"].id)
    assert r["observed"] is True
    assert r["checks"]["active"] == 1 and r["checks"]["passing"] == 1
    assert r["health"] == "healthy"


@pytest.mark.parametrize("status,expected", [("error", "error"), ("insufficient", "unknown"), (None, "unknown"),
                                             ("anomaly", "breached")])
def test_a_failing_or_unjudged_anomaly_detector_is_never_healthy(client, db, world, status, expected):  # noqa: F811
    from app.models.observability import ObservabilityMonitor

    db.add(ObservabilityMonitor(dataset_id=world["ds"].id, dataset_table_id=world["tbl"].id, kind="schema",
                                name="s", config={}, severity="warning", last_status="ok",
                                last_checked_at=datetime.utcnow()))
    db.commit()
    _metric(db, world, status)
    r = _usage_row(client, world["owner"], world["ds"].id)
    assert r["health"] == expected, r
    assert r["checks"]["active"] == 2 and r["checks"]["passing"] == 1


def test_the_distribution_pillar_reflects_active_anomaly_metrics(client, db, world):  # noqa: F811
    _metric(db, world, "ok", ok_at=datetime.utcnow())
    _metric(db, world, "error")
    ov = client.get("/api/v1/observability/overview", headers=world["owner"].headers).json()
    dist = next(p for p in ov["pillars"] if p["pillar"] == "distribution")
    assert dist["monitors"] >= 2 and dist["errored"] >= 1
    assert dist["status"] != "not_monitored" and dist["status"] != "healthy"
