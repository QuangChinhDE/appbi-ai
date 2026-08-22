"""The background worker that drains the document index queue.

NOT an APScheduler job, unlike the other five schedulers here, and the reason is
frequency. Indexing used to happen inside the save so it felt instant; a queue
only keeps that feel if it is polled every couple of seconds. Wired through
APScheduler that produced, per process, two INFO lines every 3 seconds — and with
uvicorn running four workers, roughly eighty log lines a minute saying nothing
happened. Observability that buries itself is worse than none.

So: one daemon thread per process, a CHEAP existence check before anything else,
and a log line only when work was actually done.

Four processes polling is deliberate rather than tolerated. The advisory lock
keeps one drain at a time, and `_claim`'s `FOR UPDATE SKIP LOCKED` makes claiming
the same document twice impossible even if the lock were bypassed — so extra
pollers cost one indexed COUNT every couple of seconds and buy resilience if one
process is wedged.
"""
from __future__ import annotations

import logging
import threading

from sqlalchemy import text

from app.core.database import SessionLocal
from app.core.scheduler_lock import job_lock

logger = logging.getLogger(__name__)

_JOB_ID = "govern_doc_index_worker"
_POLL_SECONDS = 2.0

_thread: threading.Thread | None = None
_stop = threading.Event()


def _has_pending(db) -> bool:
    """One indexed lookup. Cheap enough to run every two seconds forever."""
    try:
        return db.execute(
            text("SELECT 1 FROM govern_doc_index_job WHERE state = 'queued' LIMIT 1")
        ).first() is not None
    except Exception:  # noqa: BLE001
        db.rollback()
        return False


def _pass() -> None:
    from app.services.govern_doc_index_queue import drain

    db = SessionLocal()
    try:
        # Check BEFORE taking the advisory lock: an idle queue should not produce
        # a lock acquisition, and the shared scheduler lock logs every one.
        if not _has_pending(db):
            return
        with job_lock(_JOB_ID) as acquired:
            if not acquired:
                return
            summary = drain(db)
            if summary.get("claimed"):
                logger.info(
                    "govern_doc_index_worker: %s claimed, %s indexed, %s to retry",
                    summary["claimed"], summary["indexed"], summary["failed"],
                )
    except Exception:  # noqa: BLE001 — the loop must outlive any single pass
        logger.exception("govern_doc_index_worker: pass failed")
    finally:
        db.close()


def _loop() -> None:
    while not _stop.is_set():
        _pass()
        _stop.wait(_POLL_SECONDS)


def run_once() -> dict:
    """Drain synchronously — for tests and for a one-off repair from a shell.

    Deliberately not reachable from any request handler: a synchronous indexing
    path is the thing the queue removed.
    """
    from app.services.govern_doc_index_queue import drain

    db = SessionLocal()
    try:
        return drain(db)
    finally:
        db.close()


def startup() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name=_JOB_ID, daemon=True)
    _thread.start()
    logger.info("govern_doc_index_worker: started, polling every %ss", _POLL_SECONDS)


def shutdown() -> None:
    global _thread
    _stop.set()
    if _thread is not None:
        _thread.join(timeout=5)
    _thread = None
