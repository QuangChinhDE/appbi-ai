"""
APScheduler-based scheduler for automatic datasource syncs.

On app startup, all datasources with sync_config.schedule.enabled=true are registered.
When sync-config is saved via the API, the scheduler is updated accordingly.

Supported schedule types (mirror the frontend SyncScheduleConfig):
  interval    — every N hours  (IntervalTrigger)
  daily       — at HH:MM in a timezone  (CronTrigger)
  custom_cron — arbitrary cron expression  (CronTrigger)
"""
from __future__ import annotations

from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import DataSource, SyncJob
from datetime import datetime, timezone

logger = get_logger(__name__)

# Singleton scheduler instance
_scheduler: Optional[BackgroundScheduler] = None


def get_scheduler() -> BackgroundScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = BackgroundScheduler(
            timezone="UTC",
            job_defaults={"misfire_grace_time": 300, "coalesce": True},
        )
    return _scheduler


# ── Trigger builders ──────────────────────────────────────────────────────────

def _build_trigger(schedule_cfg: dict):
    stype = schedule_cfg.get("type", "interval")

    if stype == "interval":
        hours = max(1, int(schedule_cfg.get("interval_hours", 24)))
        return IntervalTrigger(hours=hours)

    if stype == "daily":
        time_str = schedule_cfg.get("time", "00:00")
        tz = schedule_cfg.get("timezone", "UTC") or "UTC"
        parts = time_str.split(":")
        hour = int(parts[0]) if parts else 0
        minute = int(parts[1]) if len(parts) > 1 else 0
        return CronTrigger(hour=hour, minute=minute, timezone=tz)

    if stype == "custom_cron":
        cron_expr = schedule_cfg.get("cron_expression", "0 0 * * *")
        tz = schedule_cfg.get("timezone", "UTC") or "UTC"
        return CronTrigger.from_crontab(cron_expr, timezone=tz)

    # Fallback: daily at midnight UTC
    return CronTrigger(hour=0, minute=0, timezone="UTC")


# ── Scheduled task ────────────────────────────────────────────────────────────

def _scheduled_sync_task(data_source_id: int) -> None:
    """Called by APScheduler — creates a SyncJob record then fires the sync engine."""
    from app.services.sync_engine import trigger_sync as run_sync

    db = SessionLocal()
    try:
        ds = db.query(DataSource).filter(DataSource.id == data_source_id).first()
        if not ds:
            logger.warning(f"[scheduler] datasource {data_source_id} not found, skipping")
            return

        # Skip if a job is already running for this datasource
        running = (
            db.query(SyncJob)
            .filter(SyncJob.data_source_id == data_source_id, SyncJob.status == "running")
            .first()
        )
        if running:
            logger.info(
                f"[scheduler] datasource {data_source_id}: job #{running.id} already running, skipping"
            )
            return

        job = SyncJob(
            data_source_id=data_source_id,
            status="running",
            mode="scheduled",
            triggered_by="schedule",
            started_at=datetime.now(timezone.utc),
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        logger.info(f"[scheduler] scheduled sync triggered: ds={data_source_id} job={job.id}")
        run_sync(data_source_id, job.id)
    finally:
        db.close()


# ── Public API ────────────────────────────────────────────────────────────────

def _job_id(ds_id: int) -> str:
    return f"sync_ds_{ds_id}"


def register_datasource(ds_id: int, sync_config: dict) -> None:
    """Add or update the scheduled job for a datasource based on its sync_config."""
    import json as _json
    scheduler = get_scheduler()
    if isinstance(sync_config, str):
        try:
            sync_config = _json.loads(sync_config)
        except Exception:
            sync_config = {}
    if not isinstance(sync_config, dict):
        sync_config = {}
    schedule = sync_config.get("schedule") or {}
    if isinstance(schedule, str):
        try:
            schedule = _json.loads(schedule)
        except Exception:
            schedule = {}
    jid = _job_id(ds_id)

    if not schedule.get("enabled"):
        if scheduler.get_job(jid):
            scheduler.remove_job(jid)
            logger.info(f"[scheduler] removed job for datasource {ds_id}")
        return

    trigger = _build_trigger(schedule)
    if scheduler.get_job(jid):
        scheduler.reschedule_job(jid, trigger=trigger)
        logger.info(f"[scheduler] rescheduled job for datasource {ds_id}")
    else:
        scheduler.add_job(
            _scheduled_sync_task,
            trigger=trigger,
            id=jid,
            args=[ds_id],
            replace_existing=True,
            name=f"Sync DataSource {ds_id}",
        )
        logger.info(f"[scheduler] registered job for datasource {ds_id}")


def unregister_datasource(ds_id: int) -> None:
    """Remove the scheduled job for a datasource (e.g. on datasource delete)."""
    scheduler = get_scheduler()
    jid = _job_id(ds_id)
    if scheduler.get_job(jid):
        scheduler.remove_job(jid)
        logger.info(f"[scheduler] unregistered job for datasource {ds_id}")


def startup() -> None:
    """
    Start the scheduler and register all active schedules loaded from the database.
    Call once at application startup.
    """
    scheduler = get_scheduler()
    scheduler.start()
    logger.info("[scheduler] APScheduler started")

    db = SessionLocal()
    try:
        datasources = (
            db.query(DataSource).filter(DataSource.sync_config.isnot(None)).all()
        )
        count = 0
        for ds in datasources:
            cfg = ds.sync_config or {}
            if isinstance(cfg, str):
                import json
                try:
                    cfg = json.loads(cfg)
                except Exception:
                    cfg = {}
            if not isinstance(cfg, dict):
                cfg = {}
            schedule_cfg = cfg.get("schedule") or {}
            if isinstance(schedule_cfg, str):
                import json
                try:
                    schedule_cfg = json.loads(schedule_cfg)
                except Exception:
                    schedule_cfg = {}
            if schedule_cfg.get("enabled"):
                register_datasource(ds.id, cfg)
                count += 1
        logger.info(f"[scheduler] loaded {count} scheduled sync job(s) from DB")
    finally:
        db.close()


def shutdown() -> None:
    """Stop the scheduler gracefully. Call on application shutdown."""
    scheduler = get_scheduler()
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("[scheduler] APScheduler stopped")
