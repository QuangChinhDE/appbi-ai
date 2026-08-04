"""
Anomaly Detection Scheduler — Phase 4 Proactive Intelligence.

Runs AnomalyDetectionService.run_all_checks() daily at 2 AM.
Uses APScheduler for background scheduling.
"""
import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

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
    without it the scan would run WEB_CONCURRENCY times concurrently.
    """
    db = SessionLocal()
    try:
        result = AnomalyDetectionService.run_all_checks(db)
        logger.info("Anomaly scan completed: %s", result)
    except Exception as exc:
        logger.error("Anomaly scan failed: %s", exc)
    finally:
        db.close()

    # Observability spine scan — runs the native monitors and folds every
    # detector's breaches into the unified incident store.
    db2 = SessionLocal()
    try:
        from app.services.observability_service import ObservabilityService
        obs_result = ObservabilityService.scan_all(db2)
        logger.info("Observability scan completed: %s", obs_result)
    except Exception as exc:
        logger.error("Observability scan failed: %s", exc)
    finally:
        db2.close()


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
    _scheduler.start()
    logger.info("Anomaly detection scheduler started (daily at 02:00 UTC)")


def shutdown():
    """Stop the scheduler. Called from app lifespan cleanup."""
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("Anomaly detection scheduler stopped")
    _scheduler = None
