"""Short-TTL, per-process cache for whole-workbook Google Sheets reads.

Why this exists
---------------
``DataSourceConnectionService._execute_google_sheets`` used to call
``list_sheets()`` + ``get_sheet_data()`` for **every tab** on **every query**.
A single Workboard form open (screen read + N lookup reads) therefore fanned
out to many full-workbook reads and routinely tripped the Google Sheets quota
("Read requests per minute per user" = 60), which surfaced as opaque empty
dropdowns / empty tables.

This module collapses all reads of one spreadsheet within a short TTL window
into a single workbook fetch, and turns a quota hit into an explicit, typed
error (``SheetsQuotaError``) — never a silent empty result.

The cache is in-process (one entry per spreadsheet_id). With multiple workers
each keeps its own copy; that is still a ~Nx reduction. A cross-process cache
(Redis) can replace ``_STORE`` later without touching call sites.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Optional

from app.core.config import settings
from app.core.logging import get_logger
from app.services import query_cache as _qc

logger = get_logger(__name__)

# CROSS-WORKER write invalidation. The workbook/result caches below are in-process
# (per worker). On a multi-worker deploy an app write on worker A dropped only A's
# cache, so workers B/C kept serving pre-write data until their own TTL — a
# mini-app write then wasn't reflected on a dashboard tile served by another
# worker. Fix: a write bumps a SHARED "last write" timestamp (in the same sqlite KV
# the sync leases use); every worker treats a cache entry created BEFORE that
# timestamp as stale → a write on ANY worker invalidates ALL workers' caches. The
# big workbook payload stays per-worker (never serialised into the KV) — only a
# tiny timestamp crosses workers. TTL must outlive any cache entry.
_WATERMARK_TTL = 3600.0


def _write_watermark(spreadsheet_id: str) -> float:
    """Epoch of the last app write to this spreadsheet, across all workers (0 if
    none / no shared store → single-worker falls back to local invalidation)."""
    try:
        v = _qc.get_shared(f"sheetswrite::{spreadsheet_id}")
        return float(v.get("at")) if v else 0.0
    except (TypeError, ValueError, AttributeError):
        return 0.0


class SheetsQuotaError(RuntimeError):
    """Raised when the Google Sheets read-quota (HTTP 429 / RATE_LIMIT) is hit
    and retries with backoff did not recover. Callers should surface this as a
    transient 'source busy, retry' state — NOT swallow it to empty data."""


def _default_ttl() -> float:
    raw = getattr(settings, "GOOGLE_SHEETS_CACHE_TTL_SECONDS", None)
    try:
        return float(raw) if raw is not None else 45.0
    except (TypeError, ValueError):
        return 45.0


def is_quota_error(exc: BaseException) -> bool:
    text = str(exc)
    return (
        "429" in text
        or "RATE_LIMIT_EXCEEDED" in text
        or "RESOURCE_EXHAUSTED" in text
        or "Quota exceeded" in text
    )


# spreadsheet_id -> (expires_at_epoch, payload)
_STORE: Dict[str, tuple[float, Any, float]] = {}  # (expires_monotonic, payload, created_wall)
# (spreadsheet_id, query_key) -> (expires_at_epoch, result_payload).
# Caches the COMPUTED result of a chart/lookup SQL over a Sheets workbook.
# `query_cache` (the generic live-query cache) intentionally skips Google
# Sheets because the workbook is externally mutable, so each dashboard tile
# used to rebuild a fresh in-memory DuckDB and re-run its SQL even when the
# underlying data hadn't changed. This store sits ON TOP of the workbook
# cache's freshness contract: it shares the same TTL window and is dropped by
# the SAME `invalidate(spreadsheet_id)` call that app writes already trigger,
# so it introduces NO staleness beyond what the workbook cache already
# accepts. Key includes the SQL + row limit so different charts don't collide.
_RESULT_STORE: Dict[tuple[str, str], tuple[float, Any, float]] = {}
_LOCK = threading.Lock()
# Per-spreadsheet load locks so concurrent requests for the same workbook do
# not each issue a cold load (thundering herd).
_LOAD_LOCKS: Dict[str, threading.Lock] = {}


def _load_lock_for(spreadsheet_id: str) -> threading.Lock:
    with _LOCK:
        lk = _LOAD_LOCKS.get(spreadsheet_id)
        if lk is None:
            lk = threading.Lock()
            _LOAD_LOCKS[spreadsheet_id] = lk
        return lk


def invalidate(spreadsheet_id: str) -> None:
    """Drop the cached workbook AND every cached query result for it so the
    next read reflects a just-written row. Called by the connector on every
    append/update/delete, so the result cache can never serve stale data past
    an app-side write."""
    if not spreadsheet_id:
        return
    with _LOCK:
        _STORE.pop(spreadsheet_id, None)
        # Drop all result-cache entries for this spreadsheet.
        stale_keys = [k for k in _RESULT_STORE if k[0] == spreadsheet_id]
        for k in stale_keys:
            _RESULT_STORE.pop(k, None)
    # Bump the cross-worker watermark so OTHER workers also treat their cached
    # workbook/results as stale (they compare their entry's create-time to this).
    try:
        _qc.set_shared(f"sheetswrite::{spreadsheet_id}", {"at": time.time()}, _WATERMARK_TTL)
    except Exception:  # noqa: BLE001 — best-effort; local invalidation already done
        pass


def get_cached_result(spreadsheet_id: str, query_key: str) -> Optional[Any]:
    """Return a cached SQL result for this workbook, or None if absent/expired."""
    if not spreadsheet_id or not query_key:
        return None
    with _LOCK:
        entry = _RESULT_STORE.get((spreadsheet_id, query_key))
    if not entry:
        return None
    expires_at, payload, created_wall = entry
    if expires_at < time.monotonic() or created_wall < _write_watermark(spreadsheet_id):
        with _LOCK:
            _RESULT_STORE.pop((spreadsheet_id, query_key), None)
        return None
    return payload


def set_cached_result(
    spreadsheet_id: str,
    query_key: str,
    payload: Any,
    *,
    ttl: Optional[float] = None,
) -> None:
    """Cache a computed SQL result for this workbook under the shared TTL."""
    if not spreadsheet_id or not query_key:
        return
    ttl = _default_ttl() if ttl is None else ttl
    with _LOCK:
        _RESULT_STORE[(spreadsheet_id, query_key)] = (time.monotonic() + ttl, payload, time.time())


def _get_fresh(spreadsheet_id: str) -> Optional[Any]:
    with _LOCK:
        entry = _STORE.get(spreadsheet_id)
    if not entry:
        return None
    expires_at, payload, created_wall = entry
    # Stale if TTL-expired OR a write on ANY worker happened after we cached it.
    if expires_at < time.monotonic() or created_wall < _write_watermark(spreadsheet_id):
        return None
    return payload


def get_or_load(
    spreadsheet_id: str,
    loader: Callable[[], Any],
    *,
    ttl: Optional[float] = None,
    retries: int = 2,
    backoff_base: float = 0.6,
) -> Any:
    """Return the cached workbook payload for ``spreadsheet_id`` or run
    ``loader()`` once (serialised per spreadsheet), with quota backoff.

    ``loader`` must perform the actual Sheets API fetch and return the value
    to cache (e.g. the ``{sheet_name: sheet_data}`` dict). On a quota error the
    load is retried with exponential backoff; if it never recovers a
    :class:`SheetsQuotaError` is raised (callers must not swallow it to empty).
    """
    ttl = _default_ttl() if ttl is None else ttl

    cached = _get_fresh(spreadsheet_id)
    if cached is not None:
        return cached

    load_lock = _load_lock_for(spreadsheet_id)
    with load_lock:
        # Another thread may have populated it while we waited for the lock.
        cached = _get_fresh(spreadsheet_id)
        if cached is not None:
            return cached

        last_exc: Optional[BaseException] = None
        for attempt in range(retries + 1):
            try:
                payload = loader()
            except Exception as exc:  # noqa: BLE001 - classify below
                last_exc = exc
                if is_quota_error(exc) and attempt < retries:
                    sleep_s = backoff_base * (2 ** attempt)
                    logger.warning(
                        "Google Sheets quota hit for %s (attempt %d/%d) — backing off %.1fs",
                        spreadsheet_id, attempt + 1, retries + 1, sleep_s,
                    )
                    time.sleep(sleep_s)
                    continue
                raise
            with _LOCK:
                _STORE[spreadsheet_id] = (time.monotonic() + ttl, payload, time.time())
            return payload

        # Exhausted retries on a quota error.
        if last_exc is not None and is_quota_error(last_exc):
            raise SheetsQuotaError(
                "Google Sheets read quota exceeded (60 reads/min/user). "
                "The workbook is being read too frequently — please retry shortly."
            ) from last_exc
        if last_exc is not None:
            raise last_exc
        raise SheetsQuotaError("Google Sheets read failed for an unknown reason.")
