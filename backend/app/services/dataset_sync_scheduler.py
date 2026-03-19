"""
Dataset-level sync scheduler using APScheduler.

On app startup, loads all Datasets with sync_config.schedule.enabled=true
and registers APScheduler jobs. When sync_config is saved via API, the
scheduler is updated immediately.

Constraint: Single-worker only (API_WORKERS=1).
"""
from __future__ import annotations

from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import Dataset

logger = get_logger(__name__)

_scheduler: Optional[BackgroundScheduler] = None


def get_scheduler() -> BackgroundScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = BackgroundScheduler(
            timezone="UTC",
            job_defaults={"misfire_grace_time": 300, "coalesce": True},
        )
    return _scheduler


def _build_trigger(schedule_cfg: dict):
    """Build an APScheduler trigger from schedule config."""
    stype = schedule_cfg.get("type", "interval")

    if stype == "interval":
        seconds = schedule_cfg.get("interval_seconds")
        if seconds:
            return IntervalTrigger(seconds=max(60, int(seconds)))
        hours = max(1, int(schedule_cfg.get("interval_hours", 24)))
        return IntervalTrigger(hours=hours)

    if stype == "daily":
        time_str = schedule_cfg.get("time", "02:00")
        hour, minute = (int(x) for x in time_str.split(":"))
        tz = schedule_cfg.get("timezone", "UTC")
        return CronTrigger(hour=hour, minute=minute, timezone=tz)

    if stype == "cron" or stype == "custom_cron":
        expr = schedule_cfg.get("cron") or schedule_cfg.get("cron_expression", "0 2 * * *")
        tz = schedule_cfg.get("timezone", "UTC")
        return CronTrigger.from_crontab(expr, timezone=tz)

    return None


def _scheduled_sync_task(dataset_id: int) -> None:
    """Callback fired by APScheduler — triggers a dataset sync."""
    logger.info("[scheduler] Firing scheduled sync for dataset %d", dataset_id)
    db = SessionLocal()
    try:
        from app.services.dataset_sync_engine import trigger_dataset_sync
        trigger_dataset_sync(dataset_id, db, triggered_by="scheduler")
    except Exception as e:
        logger.error("[scheduler] Failed to trigger sync for dataset %d: %s", dataset_id, e)
    finally:
        db.close()


def register_dataset(dataset_id: int, sync_config: dict) -> None:
    """Register or update a scheduler job for a dataset."""
    scheduler = get_scheduler()
    job_id = f"sync_dataset_{dataset_id}"

    schedule = sync_config.get("schedule", {})
    if not schedule.get("enabled", False):
        # Remove job if disabled
        try:
            scheduler.remove_job(job_id)
            logger.info("[scheduler] Removed job %s (disabled)", job_id)
        except Exception:
            pass
        return

    trigger = _build_trigger(schedule)
    if trigger is None:
        return

    scheduler.add_job(
        func=_scheduled_sync_task,
        trigger=trigger,
        id=job_id,
        args=[dataset_id],
        max_instances=1,
        replace_existing=True,
    )
    logger.info("[scheduler] Registered job %s", job_id)


def unregister_dataset(dataset_id: int) -> None:
    """Remove a scheduler job for a dataset."""
    scheduler = get_scheduler()
    job_id = f"sync_dataset_{dataset_id}"
    try:
        scheduler.remove_job(job_id)
        logger.info("[scheduler] Removed job %s", job_id)
    except Exception:
        pass


def startup() -> None:
    """Start the scheduler and load all dataset schedules from DB."""
    scheduler = get_scheduler()
    db = SessionLocal()
    try:
        datasets = db.query(Dataset).filter(Dataset.sync_config.isnot(None)).all()
        count = 0
        for ds in datasets:
            sc = ds.sync_config or {}
            schedule = sc.get("schedule", {})
            if schedule.get("enabled", False):
                register_dataset(ds.id, sc)
                count += 1
        logger.info("[scheduler] Loaded %d dataset sync schedules", count)
    finally:
        db.close()

    if not scheduler.running:
        scheduler.start()
        logger.info("[scheduler] APScheduler started")


def shutdown() -> None:
    """Shutdown the scheduler."""
    scheduler = get_scheduler()
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("[scheduler] APScheduler shut down")
