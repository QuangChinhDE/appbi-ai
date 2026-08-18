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


def scope_hash(excluded_columns) -> str:
    """The AI-scope exclusion set, as part of a cache identity.

    A pack is built AFTER the excluded columns are stripped, so what is stored is
    already filtered — for the exclusion set that was in force at the time. Key on
    the dashboard alone and a pack built before a column was hidden keeps being
    served for the rest of its TTL, which is a hidden column answering questions for
    five more minutes. The agent-flow tool cache learned the same lesson; this is the
    same rule in the other engine, so the two cannot disagree about it.
    """
    if not excluded_columns:
        return "_"
    return hashlib.sha1(
        ",".join(sorted(str(c) for c in excluded_columns)).encode("utf-8")
    ).hexdigest()[:8]


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
        # Phase 15.73 — never cache an empty pack. A chart returning 0
        # rows is often a transient filter mismatch (e.g. default
        # "current period" not matching the dashboard's saved date
        # range). Caching that for 5 minutes poisons every follow-up
        # question against the same filter set and makes the bot answer
        # "no data" repeatedly until TTL expires. Better to let the LLM
        # retry the live call so a fresh fetch can recover if the data
        # condition changes (or, if it really is empty, the LLM hits the
        # live tool and can name the empty state in its answer).
        empty_state = pack.get("empty_state")
        total_rows = pack.get("total_rows")
        if empty_state == "no_rows" or (
            isinstance(total_rows, int) and total_rows == 0
        ):
            logger.debug(
                "summary_cache skip-empty dashboard_id=%s chart_id=%s "
                "empty_state=%s total_rows=%s",
                dashboard_id, chart_id, empty_state, total_rows,
            )
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


# ── Recon cache (Phase 16.1 — chat-turn latency fix) ─────────────────────────
#
# The recon snapshot (light manifest + first-3 chart summaries) was being
# rebuilt for EVERY surface that needs it: /ai/recon on bot open, the
# briefing guess, the executive brief, and — worst — inside every chat
# turn's system-prompt assembly. On a big dashboard that is 3+ live chart
# queries in the turn's critical path (measured 25s+ before the first LLM
# byte on dashboard 67). Same determinism argument as packs: for one
# (dashboard, merged-filters) pair the recon is stable → cache the whole
# dict. Shorter TTL than packs because it is the bot's FIRST impression of
# the data.

RECON_TTL_SECONDS = 180
_RECON_MAX_ENTRIES = 32
_recon_lock = threading.RLock()
_recon_store: OrderedDict[tuple[int, str], tuple[float, dict]] = OrderedDict()


def get_cached_recon(dashboard_id: int, filters: list[dict] | None) -> dict | None:
    key = (int(dashboard_id), _filters_hash(filters))
    now = time.monotonic()
    with _recon_lock:
        entry = _recon_store.get(key)
        if entry is None:
            return None
        ts, recon = entry
        if now - ts > RECON_TTL_SECONDS:
            _recon_store.pop(key, None)
            return None
        _recon_store.move_to_end(key)
        return recon


def put_cached_recon(dashboard_id: int, filters: list[dict] | None, recon: dict) -> None:
    if not isinstance(recon, dict):
        return
    # Never cache a recon whose summaries ALL failed (transient warehouse
    # hiccup) — same poisoning argument as the empty-pack skip above.
    if not (recon.get("summaries") or []):
        return
    key = (int(dashboard_id), _filters_hash(filters))
    with _recon_lock:
        _recon_store[key] = (time.monotonic(), recon)
        _recon_store.move_to_end(key)
        while len(_recon_store) > _RECON_MAX_ENTRIES:
            _recon_store.popitem(last=False)


def invalidate_dashboard_recon_cache(dashboard_id: int) -> int:
    with _recon_lock:
        keys = [k for k in _recon_store if k[0] == int(dashboard_id)]
        for k in keys:
            _recon_store.pop(k, None)
        return len(keys)
