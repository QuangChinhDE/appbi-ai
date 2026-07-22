"""Cooperative stop for an in-flight dataset Sync & Publish / Refresh.

The Stop request (POST /snapshots/stop) and the running sync are NOT guaranteed to
be in the same process: on a multi-worker deploy (`uvicorn --workers > 1`) the POST
lands on any worker while the sync runs in the worker holding the publish lease. So
the flag is kept BOTH in-process (fast, same-worker) AND in the shared sqlite KV
(cross-worker, the same store the publish lease uses) — otherwise a Stop landing on
another worker would be silently ignored. No shared store (dev/1-worker) → in-process
only (unchanged).

Semantics: the flag is a REQUEST, checked cooperatively by refresh_all_for_dataset
BETWEEN tables and by the row-load progress callback DURING a table. A stopped batch
leaves the previous COMPLETE generation untouched (atomic swap only happens on a
fully-loaded table), so readers keep serving correct last-complete numbers.
"""
from __future__ import annotations

import threading
from typing import Set

from app.services import query_cache as _qc

_lock = threading.Lock()
_stop: Set[int] = set()

_STOP_TTL = 3600  # 1h backstop; cleared explicitly when the sync ends


def _key(dataset_id: int) -> str:
    return f"syncstop::{int(dataset_id)}"


class SyncCancelled(Exception):
    """Raised inside the build/load loop when a Stop was requested for a dataset."""


def request_stop(dataset_id: int) -> None:
    with _lock:
        _stop.add(int(dataset_id))
    _qc.set_shared(_key(dataset_id), {"stop": True}, _STOP_TTL)  # cross-worker


def is_stop_requested(dataset_id: int) -> bool:
    with _lock:
        if int(dataset_id) in _stop:
            return True
    return _qc.get_shared(_key(dataset_id)) is not None  # set by another worker?


def clear_stop(dataset_id: int) -> None:
    with _lock:
        _stop.discard(int(dataset_id))
    _qc.del_shared(_key(dataset_id))
