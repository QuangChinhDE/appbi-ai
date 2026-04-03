"""
TTL cache for live query results.

Avoids repeated BigQuery/PG/MySQL round-trips when multiple users view the
same dashboard.  No external dependencies — uses Python-only cachetools.

Architecture: per-datasource TTLCache dict so invalidation only clears
the affected datasource's entries, not the entire cache.
"""
from __future__ import annotations

import hashlib
import json
import threading
from typing import Any, Dict, Optional

from cachetools import TTLCache

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_lock = threading.Lock()
# Per-datasource cache: {datasource_id: TTLCache}
_caches: Dict[int, TTLCache] = {}


def _get_ds_cache(datasource_id: int) -> TTLCache:
    """Get or create TTLCache for a specific datasource."""
    if datasource_id not in _caches:
        with _lock:
            if datasource_id not in _caches:
                _caches[datasource_id] = TTLCache(
                    maxsize=settings.LIVE_QUERY_CACHE_MAX_SIZE,
                    ttl=settings.LIVE_QUERY_CACHE_TTL,
                )
    return _caches[datasource_id]


def _make_key(
    table_identifier: str,
    chart_type: str,
    role_config: dict,
    filters: list,
) -> str:
    """Deterministic cache key from query parameters (datasource_id handled by dict key)."""
    payload = json.dumps(
        {
            "tbl": table_identifier,
            "ct": chart_type,
            "rc": role_config,
            "f": filters,
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def get_cached(
    datasource_id: int,
    table_identifier: str,
    chart_type: str,
    role_config: dict,
    filters: list,
) -> Optional[Dict[str, Any]]:
    """Return cached result or None."""
    key = _make_key(table_identifier, chart_type, role_config, filters)
    cache = _get_ds_cache(datasource_id)
    with _lock:
        result = cache.get(key)
    if result is not None:
        logger.debug("Cache HIT: ds=%d key=%s", datasource_id, key[:12])
    return result


def set_cached(
    datasource_id: int,
    table_identifier: str,
    chart_type: str,
    role_config: dict,
    filters: list,
    data: Dict[str, Any],
) -> None:
    """Store a result in cache."""
    key = _make_key(table_identifier, chart_type, role_config, filters)
    cache = _get_ds_cache(datasource_id)
    with _lock:
        cache[key] = data
    logger.debug("Cache SET: ds=%d key=%s", datasource_id, key[:12])


def invalidate_datasource(datasource_id: int) -> int:
    """Remove all cached entries for a specific datasource (e.g. after sync)."""
    with _lock:
        if datasource_id in _caches:
            removed = len(_caches[datasource_id])
            _caches[datasource_id].clear()
            if removed:
                logger.info("Cache cleared: %d entries for ds=%d", removed, datasource_id)
            return removed
    return 0


def clear_all() -> None:
    """Clear entire cache across all datasources."""
    with _lock:
        total = sum(len(c) for c in _caches.values())
        _caches.clear()
    logger.info("Live query cache cleared: %d total entries", total)
