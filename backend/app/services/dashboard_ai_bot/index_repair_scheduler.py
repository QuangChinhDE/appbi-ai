"""Rebuild document indexes the retriever has decided not to trust.

WHY THIS JOB EXISTS
-------------------
The retriever refuses to search a document whose index format is old, whose
chunks were embedded under a different model than the document is pinned to, or
whose vectors are missing. Refusing is correct — the alternative is returning
passages from a vector space that has nothing to do with the query.

But refusing is INVISIBLE. The document still exists, still appears in the
library, still looks attached to its dashboard, and the assistant simply stops
finding it. Measured on this deployment: migration 0049 invalidated the legacy
index hashes and nothing rebuilt them, so five of six documents on the main
dashboard went unsearchable and "GMV là gì" returned nothing while a document
titled "Từ vựng & Quy ước" sat one query away. The migration was right to
invalidate; what was missing was anything to put it back.

WHY IT RUNS AT BOOT AND NOT ONLY ON A TIMER
-------------------------------------------
An invalidated index is almost always the result of a deploy — a migration, a
model change, a chunking-parameter change. Boot is when that has just happened
and when nobody is watching. A nightly-only job would leave the assistant
answering without its knowledge for a whole day.

Bounded, deferred and lock-guarded, because it spends money: it embeds. One
worker does the work, it starts after the app is serving, and it repairs a
limited number of documents per pass so a large library heals over several ticks
rather than holding a worker for minutes.
"""
from __future__ import annotations

import logging
import os

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger

from app.core.database import SessionLocal
from app.core.scheduler_lock import single_run

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None

#: Documents repaired per pass. Each one costs an embedding call per chunk, so
#: this is a spend ceiling as much as a time ceiling.
_BATCH = 25


def _enabled() -> bool:
    """Off switch for a deployment that would rather repair by hand.

    Read at RUN time: an operator who turns this off during an incident should
    not have to restart the app for it to take effect.
    """
    return (os.getenv("GOVERN_INDEX_AUTO_REPAIR", "true") or "").strip().lower() not in (
        "0", "false", "no", "off",
    )


@single_run("govern_index_repair")
def _repair() -> None:
    """Guarded by an advisory lock: every uvicorn worker starts this scheduler, so
    without it the same documents would be re-embedded WEB_CONCURRENCY times —
    and unlike a prune, that costs money per duplicate run."""
    if not _enabled():
        return
    from app.services.dashboard_ai_bot.govern_doc_embeddings import (
        repair_stale_index, stale_index_docs,
    )

    db = SessionLocal()
    try:
        stale = stale_index_docs(db)
        if not stale:
            return                      # silent when there is nothing to say
        # Logged BEFORE the work, with the reasons, so an operator reading the
        # boot log learns why the assistant was quiet rather than inferring it.
        logger.warning(
            "[govern] %s document(s) have an unsearchable index: %s",
            len(stale), sorted(set(stale.values())),
        )
        logger.info("[govern] index repair: %s", repair_stale_index(db, limit=_BATCH))
    except Exception:  # noqa: BLE001
        # Housekeeping must never take the app down on boot or on a tick.
        logger.exception("[govern] index repair failed")
    finally:
        db.close()


def startup() -> None:
    """Start the repair scheduler. Called from the app lifespan."""
    global _scheduler
    _scheduler = BackgroundScheduler(timezone="UTC")
    # Deferred, not immediate: boot should finish and the app should serve before
    # anything starts spending on embeddings.
    from datetime import datetime, timedelta, timezone as _tz

    _scheduler.add_job(
        _repair,
        trigger=DateTrigger(run_date=datetime.now(_tz.utc) + timedelta(seconds=45)),
        id="govern_index_repair_boot",
        replace_existing=True,
    )
    # And a daily sweep, for an index invalidated by something other than a deploy
    # — a document whose model was changed and whose rebuild failed at the time.
    _scheduler.add_job(
        _repair,
        trigger=CronTrigger(hour=3, minute=40),
        id="govern_index_repair_daily",
        replace_existing=True,
    )
    _scheduler.start()
    logger.info("[govern] index repair scheduler started (boot + daily 03:40 UTC)")
