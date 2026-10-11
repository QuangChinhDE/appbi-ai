"""
Anomaly Detection Scheduler — Phase 4 Proactive Intelligence.

Runs AnomalyDetectionService.run_all_checks() daily at 2 AM, then the
Observability scan; and every 10 minutes dispatches alert deliveries that are
due (first sends after a failed scan dispatch, and retries with backoff).
Uses APScheduler for background scheduling.
"""
import logging
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.core.database import SessionLocal
from app.core.scheduler_lock import single_run
from app.services.anomaly_detection import AnomalyDetectionService

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


@single_run("anomaly_daily_scan")
def _run_anomaly_scan():
    """Scheduled job: run anomaly detection, then the observability scan
    (freshness/volume/schema monitors + fold quality+anomaly into incidents).

    Guarded by an advisory lock: every uvicorn worker starts this scheduler, so
    without it the scan would run WEB_CONCURRENCY times concurrently. The
    observability scan also records itself (observability_scan_runs): a failed
    or partial scan is visible in the module, not only in this log.
    """
    db = SessionLocal()
    try:
        result = AnomalyDetectionService.run_all_checks(db)
        logger.info("Anomaly scan completed: %s", result)
    except Exception as exc:
        logger.error("Anomaly scan failed: %s", exc)
    finally:
        db.close()

    db2 = SessionLocal()
    try:
        from app.services.observability_service import ObservabilityService
        try:
            obs_result = ObservabilityService.scan_all(db2, trigger="schedule")
            logger.info("Observability scan completed: %s", obs_result)
        except ObservabilityService.ScanBusy:
            # A manual scan holds the lock: record that the scheduled one did not
            # run, so the status page does not read it as "done".
            from datetime import datetime as _dt
            from app.models.observability import ObservabilityScanRun
            db2.add(ObservabilityScanRun(scope="global", trigger="schedule", status="failed",
                                         started_at=_dt.utcnow(), finished_at=_dt.utcnow(),
                                         errors=["Skipped: another scan was running."]))
            db2.commit()
            logger.warning("Scheduled observability scan skipped: another scan was running")
    except Exception as exc:
        logger.error("Observability scan failed: %s", exc)
    finally:
        db2.close()


@single_run("observability_alert_dispatch")
def _dispatch_alerts():
    db = SessionLocal()
    try:
        from app.services.observability_notifier import dispatch_due
        sent = dispatch_due(db)
        if sent:
            logger.info("Observability alert dispatch sent %s", sent)
    except Exception as exc:
        logger.error("Observability alert dispatch failed: %s", exc)
    finally:
        db.close()


def next_run_time() -> datetime | None:
    """When the daily scan fires next (naive UTC), or None when not scheduled."""
    if _scheduler is None:
        return None
    job = _scheduler.get_job("anomaly_daily_scan")
    if job is None or job.next_run_time is None:
        return None
    return job.next_run_time.replace(tzinfo=None) if job.next_run_time.tzinfo else job.next_run_time


def startup():
    """Start the anomaly detection scheduler. Called from app lifespan."""
    global _scheduler
    _scheduler = BackgroundScheduler(timezone="UTC")
    # Run daily at 2 AM UTC
    _scheduler.add_job(
        _run_anomaly_scan,
        trigger=CronTrigger(hour=2, minute=0),
        id="anomaly_daily_scan",
        replace_existing=True,
    )
    _scheduler.add_job(
        _dispatch_alerts,
        trigger=IntervalTrigger(minutes=10),
        id="observability_alert_dispatch",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()
    logger.info("Anomaly detection scheduler started (daily at 02:00 UTC; alert dispatch every 10 min)")


def shutdown():
    """Stop the scheduler. Called from app lifespan cleanup."""
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("Anomaly detection scheduler stopped")
    _scheduler = None
