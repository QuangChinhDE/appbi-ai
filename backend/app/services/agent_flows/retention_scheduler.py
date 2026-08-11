"""Age out run history on a schedule.

WHY THIS IS A JOB AND NOT A MANUAL CHORE
----------------------------------------
The three run tables were designed with three different lifetimes — metrics kept,
the viewer's question pruned, the per-node trace pruned hardest — and a retention
policy that only exists in a docstring is not a retention policy. At the mockup's
own figure of 312 runs a day, ONE flow writes ~114k runs and over a million step
rows a year; the trace is the part that grows fastest and answers the least after
the week somebody debugs with it.

WHY IT LOGS WHAT IT DELETED
---------------------------
A prune that runs silently is indistinguishable from data loss when somebody later
goes looking for a run that "should" be there. The count goes in the log, and the
window is configurable so an operator can answer "why is last March gone".
"""
from __future__ import annotations

import logging
import os

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.core.database import SessionLocal
from app.core.scheduler_lock import single_run

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def _window(name: str, default: int) -> int:
    """Retention in days, from the environment.

    Read at RUN time rather than at import: a deployment that needs to keep more
    history for an audit should not need a code change, and a value read once at
    boot would ignore the change until the next restart.
    """
    try:
        value = int(os.getenv(name, "") or default)
    except ValueError:
        logger.warning("[flow] %s is not a number; using %s", name, default)
        return default
    # Zero or negative would mean "delete everything on the next tick", which is
    # never what somebody typing a config value means.
    return max(1, value)


@single_run("agent_flow_retention")
def _prune() -> None:
    """Guarded by an advisory lock: every uvicorn worker starts this scheduler, so
    without it the delete would run WEB_CONCURRENCY times over the same rows."""
    from app.services.agent_flows.runs import prune

    db = SessionLocal()
    try:
        result = prune(
            db,
            content_days=_window("AGENT_FLOW_CONTENT_RETENTION_DAYS", 180),
            step_days=_window("AGENT_FLOW_STEP_RETENTION_DAYS", 30),
        )
        logger.info("[flow] retention pass: %s", result)
    except Exception:  # noqa: BLE001
        # Never let a housekeeping job take the app down on boot or on a tick.
        logger.exception("[flow] retention pass failed")
    finally:
        db.close()


def startup() -> None:
    """Start the retention scheduler. Called from the app lifespan."""
    global _scheduler
    _scheduler = BackgroundScheduler(timezone="UTC")
    # 03:20 UTC — after the anomaly scan at 02:00, so a slow night of housekeeping
    # jobs does not stack on the same minute.
    _scheduler.add_job(
        _prune,
        trigger=CronTrigger(hour=3, minute=20),
        id="agent_flow_retention",
        replace_existing=True,
    )
    _scheduler.start()
    logger.info(
        "[flow] retention scheduler started (daily 03:20 UTC; content %sd, trace %sd)",
        _window("AGENT_FLOW_CONTENT_RETENTION_DAYS", 180),
        _window("AGENT_FLOW_STEP_RETENTION_DAYS", 30),
    )
