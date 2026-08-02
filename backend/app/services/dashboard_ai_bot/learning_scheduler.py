"""Daily reflection scheduler for the AI bot's institutional memory.

Once a day it walks every dashboard that has accumulated knowledge and runs the
deterministic ``consolidate`` pass — promoting recurring candidates to validated,
decaying stale beliefs, retiring contradicted ones. This is the "phân tích
chuyên sâu hàng ngày" that keeps the bot's understanding curated instead of
letting an early wrong guess linger forever.

Mirrors dataset_quality_scheduler / anomaly_scheduler (APScheduler background,
own DB session per run). No LLM/network — safe to run unattended.
"""
from __future__ import annotations

import logging
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.core.database import SessionLocal
from app.core.scheduler_lock import single_run
from app.models.ai_bot_knowledge import AiBotKnowledge
from app.services.dashboard_ai_bot import knowledge as kb

logger = logging.getLogger(__name__)

_scheduler: Optional[BackgroundScheduler] = None


@single_run("ai_bot_daily_reflection")
def run_daily_reflection() -> dict:
    """Consolidate knowledge for every dashboard that has any. Returns totals.

    Advisory-locked: every uvicorn worker starts this scheduler, so without the
    lock four copies would consolidate the same rows at 18:30 UTC — and
    consolidation is NOT idempotent (it decays confidence and promotes on
    support count, so a fourfold run skews both).
    """
    db = SessionLocal()
    totals = {"dashboards": 0, "reviewed": 0, "promoted": 0, "decayed": 0, "retired": 0}
    try:
        dash_ids = [
            row[0]
            for row in db.query(AiBotKnowledge.dashboard_id).distinct().all()
            if row[0] is not None
        ]
        for did in dash_ids:
            try:
                rep = kb.consolidate(db, dashboard_id=did)
                totals["dashboards"] += 1
                for k in ("reviewed", "promoted", "decayed", "retired"):
                    totals[k] += rep.get(k, 0)
            except Exception:  # noqa: BLE001
                logger.warning("[ai_learning] consolidate failed for dashboard %s", did, exc_info=True)
                db.rollback()
        logger.info("[ai_learning] daily reflection done: %s", totals)
    except Exception:  # noqa: BLE001
        logger.error("[ai_learning] daily reflection crashed", exc_info=True)
    finally:
        db.close()
    return totals


def startup() -> None:
    global _scheduler
    if _scheduler is not None and _scheduler.running:
        return
    _scheduler = BackgroundScheduler(timezone="UTC")
    _scheduler.add_job(
        run_daily_reflection,
        trigger=CronTrigger(hour=18, minute=30, timezone="UTC"),
        id="ai_bot_daily_reflection",
        replace_existing=True,
        misfire_grace_time=3600,
        coalesce=True,
        max_instances=1,
    )
    _scheduler.start()
    logger.info("[ai_learning] daily reflection scheduler started (18:30 UTC).")


def shutdown() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("[ai_learning] daily reflection scheduler stopped.")
    _scheduler = None
