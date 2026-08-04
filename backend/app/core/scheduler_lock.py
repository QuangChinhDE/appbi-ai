"""Cross-worker single-run guard for scheduled jobs.

The API runs under ``WEB_CONCURRENCY`` uvicorn workers (4 by default) and each
one starts its own APScheduler in the FastAPI lifespan. Without coordination
every cron job therefore fires ``WEB_CONCURRENCY`` times at the same instant,
with independent DB sessions, racing on the same rows — the AI memory
consolidation pass and the snapshot refresh are both non-idempotent under that.

A Postgres **advisory lock** fixes it with no new infrastructure: session-level,
held only for the duration of the job, and released automatically if the worker
dies. Whichever worker grabs it runs; the rest return immediately.

Deliberately NOT a separate scheduler service (which the v1 design proposed):
that costs a container, a deploy target and a health check to solve a problem
one `pg_try_advisory_lock` already solves.

Non-Postgres metadata stores (SQLite in tests) fall through to "run it" — a
single-process context has nothing to coordinate.
"""
from __future__ import annotations

import logging
import os
import zlib
from contextlib import contextmanager
from typing import Callable, Iterator, TypeVar

from sqlalchemy import text

from app.core.database import SessionLocal

logger = logging.getLogger(__name__)

T = TypeVar("T")


def _lock_id(job_key: str) -> int:
    """Stable 31-bit id for a job name (advisory locks take bigint keys)."""
    return zlib.crc32(job_key.encode("utf-8")) & 0x7FFFFFFF


@contextmanager
def job_lock(job_key: str) -> Iterator[bool]:
    """Yield True when this process owns ``job_key`` for the block's duration.

    Always yields (never raises) so a locking failure degrades to "run it"
    rather than silently disabling a scheduled job forever.
    """
    session = None
    acquired = False
    # Acquisition is the only thing guarded by try/except here. Wrapping the
    # `yield` too would swallow whatever the JOB raises and re-yield, which
    # Python reports as "generator didn't stop after throw()" — the caller's
    # real exception disappears behind a confusing RuntimeError.
    try:
        session = SessionLocal()
        dialect = session.bind.dialect.name if session.bind is not None else ""
        if dialect != "postgresql":
            # Single-process / test store: nothing to coordinate.
            acquired = True
            session.close()
            session = None
        else:
            acquired = bool(
                session.execute(
                    text("SELECT pg_try_advisory_lock(:id)"), {"id": _lock_id(job_key)}
                ).scalar()
            )
            logger.info(
                "[scheduler] job=%s pid=%s acquired=%s", job_key, os.getpid(), acquired
            )
            if not acquired:
                # Someone else holds it. Drop the session NOW so the unlock in
                # the finally block cannot fire — releasing a lock we never
                # took would hand the job to a second worker after all, which
                # is the exact failure this module exists to prevent.
                session.close()
                session = None
    except Exception:  # noqa: BLE001
        logger.warning(
            "[scheduler] advisory lock unavailable for job=%s — running unguarded",
            job_key,
            exc_info=True,
        )
        acquired = True
        if session is not None:
            try:
                session.close()
            except Exception:  # noqa: BLE001
                pass
            session = None

    try:
        yield acquired
    finally:
        if session is not None:
            try:
                session.execute(
                    text("SELECT pg_advisory_unlock(:id)"), {"id": _lock_id(job_key)}
                )
                session.commit()
            except Exception:  # noqa: BLE001
                logger.warning("[scheduler] unlock failed job=%s", job_key, exc_info=True)
            finally:
                session.close()


def single_run(job_key: str) -> Callable[[Callable[..., T]], Callable[..., T | None]]:
    """Decorator form: only the worker holding ``job_key`` executes the job.

        @single_run("ai_bot_daily_reflection")
        def run_daily_reflection() -> dict: ...

    Returns None on the workers that did not get the lock.
    """
    def _decorate(fn: Callable[..., T]) -> Callable[..., T | None]:
        def _wrapped(*args, **kwargs) -> T | None:
            with job_lock(job_key) as owned:
                if not owned:
                    logger.debug("[scheduler] job=%s skipped (held elsewhere)", job_key)
                    return None
                return fn(*args, **kwargs)

        _wrapped.__name__ = getattr(fn, "__name__", "job")
        _wrapped.__doc__ = fn.__doc__
        _wrapped.__wrapped__ = fn  # type: ignore[attr-defined]
        return _wrapped

    return _decorate
