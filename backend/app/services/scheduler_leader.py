"""Single-runner election for background schedulers.

With ``WEB_CONCURRENCY>1`` uvicorn runs N worker processes, each importing
``app.main`` and running its own lifespan — so without a guard every scheduler
(anomaly, dataset-quality, AI-learning, token cleanup) starts N times and fires
N× (a confirmed audit finding: the shipped ``.env.example`` sets ``WEB_CONCURRENCY=4``).

This elects ONE leader per host via a non-blocking file lock (``flock``) on a
marker in ``DATA_DIR`` (a shared volume). The first worker to grab the lock is the
leader and runs the schedulers; the rest skip. The lock fd is held for the process
lifetime (kept in a module global so it is never closed/GC'd). If the leader dies
the OS releases the lock, but schedulers only (re)elect at startup — a container
restart re-elects (acceptable for daily jobs; a dedicated scheduler process is the
longer-term move).

Fail-SAFE: falls back to ``leader=True`` when ``flock`` is unavailable (non-Linux
dev) or on any error. A false "not leader" on every worker would disable ALL
schedulers silently, which is worse than a rare duplicate — so we bias to running.
"""
from __future__ import annotations

import logging
import os

from app.core import settings

logger = logging.getLogger(__name__)

_decided: bool | None = None
_lock_fd = None  # held open for the process lifetime to keep the flock


def is_scheduler_leader() -> bool:
    """True if THIS process should run background schedulers. Memoized — the
    decision is made once per process and reused (startup + shutdown)."""
    global _decided, _lock_fd
    if _decided is not None:
        return _decided
    try:
        import fcntl  # Linux/container only
    except Exception:  # noqa: BLE001 — non-Linux dev: assume single process
        _decided = True
        return _decided
    try:
        data_dir = str(
            getattr(settings, "data_dir_path", None) or os.getenv("DATA_DIR") or "/app/.data"
        )
        os.makedirs(data_dir, exist_ok=True)
        fd = open(os.path.join(data_dir, "scheduler.leader.lock"), "w")
        try:
            fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fd.close()
            _decided = False
            logger.info(
                "scheduler leader: another worker holds the lock — skipping schedulers here"
            )
            return _decided
        try:
            fd.write(str(os.getpid()))
            fd.flush()
        except Exception:  # noqa: BLE001
            pass
        _lock_fd = fd  # keep open → hold the lock for this process's lifetime
        _decided = True
        logger.info(
            "scheduler leader: this worker (pid=%s) runs the background schedulers", os.getpid()
        )
        return _decided
    except Exception:  # noqa: BLE001 — never disable schedulers on an election bug
        logger.warning("scheduler leader election failed — defaulting to leader=True", exc_info=True)
        _decided = True
        return _decided
