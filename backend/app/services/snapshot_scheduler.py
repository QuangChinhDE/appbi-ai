"""Snapshot refresh scheduler (Pha B).

Runs Sync & Publish on a cadence for datasets whose
``settings.snapshot_config.schedule`` is not "manual". The DB (dataset settings)
is the source of truth: startup() registers a cron job per scheduled dataset;
the snapshot-config API calls sync_dataset_job(id) after every save to keep the
live registry in sync without a restart.

Mirrors anomaly_scheduler / dataset_quality_scheduler for consistency. The job
body calls dataset_publish_service.start_sync_and_publish, which already:
  - refuses to double-run (cross-worker lease per dataset),
  - runs the ETL off the request path (background thread),
  - validates + advances the published generation atomically,
so a scheduled tick is safe even if the prior one is still building.
"""
from __future__ import annotations

import logging
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.core.database import SessionLocal
from app.core.scheduler_lock import job_lock
from app.models.dataset import Dataset
from app.services import dataset_snapshot_config as snapcfg

logger = logging.getLogger(__name__)

_scheduler: Optional[BackgroundScheduler] = None


def _job_id(dataset_id: int) -> str:
    return f"snapshot_refresh:{dataset_id}"


def _trigger_for(schedule: dict) -> Optional[CronTrigger]:
    """Build a CronTrigger from a snapshot_config.schedule, or None for manual."""
    mode = str((schedule or {}).get("mode") or "manual").lower()
    tz = (schedule or {}).get("timezone") or "UTC"
    try:
        if mode == "hourly":
            return CronTrigger(minute=0, timezone=tz)
        if mode == "daily":
            at = str(schedule.get("at") or "02:00")
            hh, mm = (at.split(":") + ["0"])[:2]
            return CronTrigger(hour=int(hh), minute=int(mm), timezone=tz)
        if mode == "cron":
            cron = str(schedule.get("cron") or "").strip()
            return CronTrigger.from_crontab(cron, timezone=tz) if cron else None
    except Exception as exc:  # noqa: BLE001
        logger.error("[snapshot_scheduler] bad schedule %r: %s", schedule, exc)
    return None


def _run_scheduled_refresh(dataset_id: int) -> None:
    """APScheduler worker body: kick a Sync & Publish for the dataset. Only for
    datasets already in the publish lifecycle (publish_state set); skips manual/
    legacy. Never raises.

    Advisory-locked PER DATASET: every uvicorn worker schedules this job, so
    without the lock the same dataset would be rebuilt WEB_CONCURRENCY times
    concurrently — wasted warehouse spend and a genuine race on the snapshot
    staging table. The key carries the dataset id so unrelated datasets are
    never serialised behind each other.
    """
    with job_lock(f"snapshot_refresh:{dataset_id}") as _owned:
        if not _owned:
            return
        _run_scheduled_refresh_locked(dataset_id)


def _run_scheduled_refresh_locked(dataset_id: int) -> None:
    db = SessionLocal()
    try:
        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if ds is None:
            return
        state = getattr(ds, "publish_state", None)
        # Power BI-standard: a SCHEDULED refresh reloads DATA on the currently
        # PUBLISHED design. It must NEVER auto-deploy an in-progress design edit —
        # a dataset in draft / changes_pending / sync_failed is skipped; the DA
        # deploys design changes explicitly via the Sync & Publish button. (This
        # keeps "scheduled = data refresh", "manual = deploy + refresh", like PBI.)
        if state != "published":
            logger.info(
                "[snapshot_scheduler] skip dataset=%s (state=%s — scheduled refresh runs only on a clean published design)",
                dataset_id, state,
            )
            return
        from app.services import dataset_publish_service
        # Record the run in the schedule's OWN timezone (what the DA configured),
        # so the history shows the scheduled fire time in that zone.
        _tz = str((snapcfg.schedule_config(ds) or {}).get("timezone") or "UTC")
        res = dataset_publish_service.start_sync_and_publish(
            dataset_id, trigger="scheduled", timezone=_tz,
        )
        logger.info("[snapshot_scheduler] scheduled refresh dataset=%s -> %s", dataset_id, res)
    except Exception as exc:  # noqa: BLE001
        logger.error("[snapshot_scheduler] scheduled refresh failed dataset=%s: %s", dataset_id, exc)
    finally:
        db.close()


def sync_dataset_job(dataset_id: int) -> None:
    """(Re)register or remove this dataset's refresh job to match its current
    schedule config. Called from the snapshot-config API after every save."""
    global _scheduler
    if _scheduler is None or not _scheduler.running:
        return  # DB persists; startup() will pick it up next boot
    db = SessionLocal()
    try:
        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        job_id = _job_id(dataset_id)
        if _scheduler.get_job(job_id):
            _scheduler.remove_job(job_id)
        if ds is None:
            return
        trigger = _trigger_for(snapcfg.schedule_config(ds))
        if trigger is None:
            return
        _scheduler.add_job(
            _run_scheduled_refresh, trigger=trigger, id=job_id, args=[dataset_id],
            replace_existing=True, misfire_grace_time=600, coalesce=True, max_instances=1,
        )
        logger.info("[snapshot_scheduler] scheduled dataset=%s %s", dataset_id, snapcfg.schedule_config(ds))
    except Exception as exc:  # noqa: BLE001
        logger.error("[snapshot_scheduler] sync failed dataset=%s: %s", dataset_id, exc)
    finally:
        db.close()


def startup() -> None:
    global _scheduler
    if _scheduler is not None and _scheduler.running:
        return
    _scheduler = BackgroundScheduler(timezone="UTC")
    _scheduler.start()
    db = SessionLocal()
    n = 0
    try:
        for ds in db.query(Dataset).all():
            trigger = _trigger_for(snapcfg.schedule_config(ds))
            if trigger is None:
                continue
            _scheduler.add_job(
                _run_scheduled_refresh, trigger=trigger, id=_job_id(ds.id), args=[ds.id],
                replace_existing=True, misfire_grace_time=600, coalesce=True, max_instances=1,
            )
            n += 1
        logger.info("[snapshot_scheduler] started with %d scheduled dataset(s)", n)
    except Exception as exc:  # noqa: BLE001
        logger.error("[snapshot_scheduler] startup load failed: %s", exc)
    finally:
        db.close()


def shutdown() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("[snapshot_scheduler] stopped")
    _scheduler = None
