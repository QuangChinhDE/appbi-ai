"""Cross-turn cache for insight packs.

Phase 15.72 — turn-2+ on the same dashboard with the same filters used
to re-run every `get_chart_summary` from scratch. For a 4-chart turn that
adds ~25s + $0.03 of pure waste; the underlying chart query + pack stats
are deterministic for the same (dashboard, filters, chart_id) triple, so
we keep a small in-process LRU.

Scope choices:
  - In-process LRU, not Redis. Keeps the BI worker dependency-free and
    avoids deploying a new service to ship this fix. Multiple uvicorn
    workers will each warm their own cache; we accept the duplication.
  - 5-minute TTL. Long enough that follow-up questions land on cached
    packs (typical chat session) but short enough that stale-data risk
    after a backend SQL change stays bounded.
  - Cap 256 entries. Each pack is small (~5 KB), so worst case ~1.3 MB
    per worker — negligible against the ~500 MB FastAPI footprint.

Key shape: (dashboard_id, filters_hash, chart_id). filters_hash is
hash(json.dumps(filters, sort_keys=True)) so two filter lists with
different order still collide correctly.

Thread safety: a single RLock guards the dict — chart queries already
release the GIL on the BigQuery side, so contention here is
microsecond-scale.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict
from typing import Any

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 300  # 5 minutes
CACHE_MAX_ENTRIES = 256


def _filters_hash(filters: list[dict] | None) -> str:
    if not filters:
        return "_"
    try:
        payload = json.dumps(filters, sort_keys=True, default=str)
    except (TypeError, ValueError):
        payload = repr(filters)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]


class _SummaryCache:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._store: OrderedDict[tuple[int, str, int], tuple[float, dict]] = OrderedDict()

    def get(
        self, dashboard_id: int, filters: list[dict] | None, chart_id: int
    ) -> dict | None:
        key = (int(dashboard_id), _filters_hash(filters), int(chart_id))
        now = time.monotonic()
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            ts, pack = entry
            if now - ts > CACHE_TTL_SECONDS:
                self._store.pop(key, None)
                return None
            # LRU bump
            self._store.move_to_end(key)
            return pack

    def put(
        self,
        dashboard_id: int,
        filters: list[dict] | None,
        chart_id: int,
        pack: dict,
    ) -> None:
        if not isinstance(pack, dict):
            return
        key = (int(dashboard_id), _filters_hash(filters), int(chart_id))
        with self._lock:
            self._store[key] = (time.monotonic(), pack)
            self._store.move_to_end(key)
            while len(self._store) > CACHE_MAX_ENTRIES:
                self._store.popitem(last=False)

    def invalidate_dashboard(self, dashboard_id: int) -> int:
        """Drop all entries for one dashboard. Returns count removed."""
        with self._lock:
            keys = [k for k in self._store if k[0] == int(dashboard_id)]
            for k in keys:
                self._store.pop(k, None)
            return len(keys)

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "entries": len(self._store),
                "ttl_seconds": CACHE_TTL_SECONDS,
                "max_entries": CACHE_MAX_ENTRIES,
            }


_INSTANCE = _SummaryCache()


def get_cached_pack(
    dashboard_id: int, filters: list[dict] | None, chart_id: int
) -> dict | None:
    return _INSTANCE.get(dashboard_id, filters, chart_id)


def put_cached_pack(
    dashboard_id: int, filters: list[dict] | None, chart_id: int, pack: dict
) -> None:
    _INSTANCE.put(dashboard_id, filters, chart_id, pack)


def invalidate_dashboard_summary_cache(dashboard_id: int) -> int:
    return _INSTANCE.invalidate_dashboard(dashboard_id)


def summary_cache_stats() -> dict[str, Any]:
    return _INSTANCE.stats()
