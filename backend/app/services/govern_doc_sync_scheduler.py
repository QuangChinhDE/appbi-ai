"""Govern Knowledge Doc source-sync scheduler.

Runs sync_doc() on a cadence for docs whose sync_schedule is not "manual"
(google_doc/web sources only — file sources have no recurring schedule, only
re-upload). The DB (govern_knowledge_docs.sync_schedule) is the source of
truth: startup() registers a cron job per scheduled doc; the /source save API
calls sync_doc_job(id) after every save to keep the live registry in sync
without a restart.

Mirrors snapshot_scheduler.py / dataset_quality_scheduler.py / anomaly_scheduler.py
for consistency (same BackgroundScheduler + per-key advisory lock pattern).
"""
from __future__ import annotations

import logging
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.core.database import SessionLocal
from app.core.scheduler_lock import job_lock

logger = logging.getLogger(__name__)

_scheduler: Optional[BackgroundScheduler] = None


def _job_id(doc_id: int) -> str:
    return f"knowledge_doc_sync:{doc_id}"


def _trigger_for(schedule: dict | None) -> Optional[CronTrigger]:
    """Build a CronTrigger from a sync_schedule dict, or None for manual/unset.
    Same {mode, at, cron, timezone} shape as dataset snapshot schedules —
    duplicated here (not imported) since it's ~15 lines and importing dataset-
    scheduler internals into Govern code isn't worth the coupling."""
    mode = str((schedule or {}).get("mode") or "manual").lower()
    tz = (schedule or {}).get("timezone") or "UTC"
    try:
        if mode == "hourly":
            return CronTrigger(minute=0, timezone=tz)
        if mode == "daily":
            at = str((schedule or {}).get("at") or "02:00")
            hh, mm = (at.split(":") + ["0"])[:2]
            return CronTrigger(hour=int(hh), minute=int(mm), timezone=tz)
        if mode == "cron":
            cron = str((schedule or {}).get("cron") or "").strip()
            return CronTrigger.from_crontab(cron, timezone=tz) if cron else None
    except Exception as exc:  # noqa: BLE001
        logger.error("[govern_doc_sync_scheduler] bad schedule %r: %s", schedule, exc)
    return None


def _run_scheduled_sync(doc_id: int) -> None:
    """APScheduler worker body. Advisory-locked PER DOC: every uvicorn worker
    schedules this job, so without the lock the same doc would be synced
    WEB_CONCURRENCY times concurrently."""
    with job_lock(_job_id(doc_id)) as owned:
        if not owned:
            return
        _run_scheduled_sync_locked(doc_id)


def _run_scheduled_sync_locked(doc_id: int) -> None:
    db = SessionLocal()
    try:
        from app.models.governance import GovernKnowledgeDoc
        d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        if d is None or d.source_type not in ("google_doc", "web"):
            return  # doc deleted, or source changed to file/manual since this job was registered
        from app.services.govern_doc_sync_service import sync_doc
        result = sync_doc(db, d, trigger="scheduled")
        logger.info("[govern_doc_sync_scheduler] scheduled sync doc=%s -> %s", doc_id, result)
    except Exception as exc:  # noqa: BLE001
        logger.error("[govern_doc_sync_scheduler] scheduled sync failed doc=%s: %s", doc_id, exc)
    finally:
        db.close()


def sync_doc_job(doc_id: int) -> None:
    """(Re)register or remove this doc's sync job to match its current
    source_type/sync_schedule. Called from the /source save API after every
    save, so a schedule change takes effect without a restart."""
    global _scheduler
    if _scheduler is None or not _scheduler.running:
        return  # DB persists; startup() will pick it up next boot
    db = SessionLocal()
    try:
        from app.models.governance import GovernKnowledgeDoc
        d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        job_id = _job_id(doc_id)
        if _scheduler.get_job(job_id):
            _scheduler.remove_job(job_id)
        if d is None or d.source_type not in ("google_doc", "web"):
            return
        trigger = _trigger_for(d.sync_schedule)
        if trigger is None:
            return
        _scheduler.add_job(
            _run_scheduled_sync, trigger=trigger, id=job_id, args=[doc_id],
            replace_existing=True, misfire_grace_time=600, coalesce=True, max_instances=1,
        )
        logger.info("[govern_doc_sync_scheduler] scheduled doc=%s %s", doc_id, d.sync_schedule)
    except Exception as exc:  # noqa: BLE001
        logger.error("[govern_doc_sync_scheduler] sync failed doc=%s: %s", doc_id, exc)
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
        from app.models.governance import GovernKnowledgeDoc
        for d in db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.source_type.in_(["google_doc", "web"])).all():
            trigger = _trigger_for(d.sync_schedule)
            if trigger is None:
                continue
            _scheduler.add_job(
                _run_scheduled_sync, trigger=trigger, id=_job_id(d.id), args=[d.id],
                replace_existing=True, misfire_grace_time=600, coalesce=True, max_instances=1,
            )
            n += 1
        logger.info("[govern_doc_sync_scheduler] started with %d scheduled doc(s)", n)
    except Exception as exc:  # noqa: BLE001
        logger.error("[govern_doc_sync_scheduler] startup load failed: %s", exc)
    finally:
        db.close()


def shutdown() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("[govern_doc_sync_scheduler] stopped")
    _scheduler = None
