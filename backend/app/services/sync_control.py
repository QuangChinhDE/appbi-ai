"""Cooperative stop for an in-flight dataset Sync & Publish / Refresh.

The Stop request (POST /snapshots/stop) and the background sync thread run in the
SAME uvicorn process (single-worker deployment — entrypoint.sh, no --workers), so
an in-process flag is race-free and sufficient. Mirrors sync_progress. If workers
are added later this would need the shared-sqlite KV (query_cache.*_global) so a
Stop landing on another worker still reaches the thread.

Semantics: the flag is a REQUEST, checked cooperatively by refresh_all_for_dataset
BETWEEN tables and by the row-load progress callback DURING a table. A stopped
batch leaves the previous COMPLETE generation untouched (atomic swap only happens
on a fully-loaded table), so readers keep serving correct last-complete numbers.
"""
from __future__ import annotations

import threading
from typing import Set

_lock = threading.Lock()
_stop: Set[int] = set()


class SyncCancelled(Exception):
    """Raised inside the build/load loop when a Stop was requested for a dataset."""


def request_stop(dataset_id: int) -> None:
    with _lock:
        _stop.add(int(dataset_id))


def is_stop_requested(dataset_id: int) -> bool:
    with _lock:
        return int(dataset_id) in _stop


def clear_stop(dataset_id: int) -> None:
    with _lock:
        _stop.discard(int(dataset_id))
