"""
TTL cache for live query results.

Layered architecture:
- Fast in-process TTLCache per datasource for hot repeated reads.
- Optional shared SQLite cache in DATA_DIR so public/embed reloads and process
  restarts can still reuse recent results.

Cache keys intentionally normalize runtime filters so UI-only fields such as
filter ids or labels do not create needless misses.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from cachetools import TTLCache

from app.core.config import settings
from app.core.logging import get_logger
from app.services.chart_contracts import normalize_filter_operator, normalize_filter_value

logger = get_logger(__name__)

_lock = threading.RLock()
_shared_error_lock = threading.Lock()
_shared_cache_error_actions: set[str] = set()

# Per-datasource cache: {datasource_id: TTLCache}
_caches: Dict[int, TTLCache] = {}

_SHARED_CLEANUP_INTERVAL_SECONDS = 60

# ── Single-flight (Fix #9, 2026-06-10) ───────────────────────────────────────
# A dashboard load can fire the SAME chart's data request several times before
# the first response lands in the cache (rapid re-render, a filter toggled
# twice, React StrictMode double-invoke). Prod logs showed chart 833 going
# cache=MISS 3x within 5s — i.e. THREE separate 8-17s BigQuery queries for one
# tile. Single-flight collapses concurrent identical computes: the first caller
# runs the query, every other caller for the same key BLOCKS on the same lock
# and — by the time it acquires — finds the result already cached, so it returns
# the cached value instead of issuing its own source query. Keyed by an opaque
# string the caller derives from its cache identity.
_inflight_locks: Dict[str, threading.Lock] = {}
_inflight_meta_lock = threading.Lock()


_INFLIGHT_LOCKS_MAX = 4096  # Phase 7 (#33): bound the lock registry


def _single_flight_lock(flight_key: str) -> threading.Lock:
    with _inflight_meta_lock:
        lk = _inflight_locks.get(flight_key)
        if lk is None:
            # Phase 7 (#33): the registry grew forever (one Lock per distinct
            # chart×filter combination over the process lifetime). Evict idle
            # (unlocked) entries when the map is full — a re-created Lock for a
            # key nobody holds is semantically identical.
            if len(_inflight_locks) >= _INFLIGHT_LOCKS_MAX:
                for k in list(_inflight_locks.keys()):
                    if len(_inflight_locks) < _INFLIGHT_LOCKS_MAX // 2:
                        break
                    held = _inflight_locks[k]
                    if not held.locked():
                        _inflight_locks.pop(k, None)
            lk = threading.Lock()
            _inflight_locks[flight_key] = lk
        return lk


def single_flight(flight_key: str, compute):
    """Run ``compute()`` under a per-key lock so concurrent callers with the
    same ``flight_key`` don't each execute it. ``compute`` MUST itself re-check
    the result cache first and return the cached value on a hit — that's how the
    waiters (which acquire the lock after the leader has populated the cache)
    avoid recomputing. Returns whatever ``compute`` returns. Best-effort: if the
    key/lock machinery fails for any reason, ``compute`` still runs (correctness
    over dedup)."""
    if not flight_key:
        return compute()
    lk = _single_flight_lock(flight_key)
    with lk:
        return compute()


def _stable_json_dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _canonicalize_json_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _canonicalize_json_value(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, tuple):
        return [_canonicalize_json_value(item) for item in value]
    if isinstance(value, list):
        return [_canonicalize_json_value(item) for item in value]
    if isinstance(value, set):
        normalized_items = [_canonicalize_json_value(item) for item in value]
        return sorted(normalized_items, key=_stable_json_dumps)
    return value


def _canonicalize_filter(filter_obj: dict[str, Any]) -> dict[str, Any] | None:
    field = str(filter_obj.get("field") or "").strip()
    if not field:
        return None

    operator = normalize_filter_operator(filter_obj.get("operator"))
    value = normalize_filter_value(operator, filter_obj.get("value"))
    if operator in {"in", "not_in"} and isinstance(value, list):
        deduped_items: dict[str, Any] = {}
        for item in value:
            canonical_item = _canonicalize_json_value(item)
            deduped_items[_stable_json_dumps(canonical_item)] = canonical_item
        value = [deduped_items[key] for key in sorted(deduped_items)]
    else:
        value = _canonicalize_json_value(value)

    normalized: dict[str, Any] = {
        "field": field,
        "operator": operator,
        "value": value,
    }

    for key in ("datasetId", "semanticField", "fieldKey"):
        raw_value = filter_obj.get(key)
        if raw_value is None:
            continue
        if isinstance(raw_value, str):
            raw_value = raw_value.strip()
            if not raw_value:
                continue
        normalized[key] = raw_value

    calendar_field = str(
        filter_obj.get("calendarField") or filter_obj.get("calendar_field") or ""
    ).strip()
    if calendar_field:
        normalized["calendarField"] = calendar_field
        calendar_source_field = str(
            filter_obj.get("calendarSourceField")
            or filter_obj.get("calendar_source_field")
            or field
        ).strip()
        if calendar_source_field:
            normalized["calendarSourceField"] = calendar_source_field

    return normalized


def _canonicalize_filters(filters: list | None) -> list[dict[str, Any]]:
    canonical_filters: list[dict[str, Any]] = []
    for filter_obj in filters or []:
        if not isinstance(filter_obj, dict):
            continue
        canonical = _canonicalize_filter(filter_obj)
        if canonical is not None:
            canonical_filters.append(canonical)
    return sorted(canonical_filters, key=_stable_json_dumps)


class _SharedSqliteCache:
    def __init__(self, db_path: Path, ttl_seconds: int, max_rows: int) -> None:
        self.db_path = Path(db_path)
        self.ttl_seconds = int(ttl_seconds)
        self.max_rows = max(int(max_rows or 0), 0)
        self._init_lock = threading.Lock()
        self._initialized = False
        self._last_cleanup_monotonic = 0.0

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self.db_path),
            timeout=30,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        with self._init_lock:
            if self._initialized:
                return
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS live_query_cache (
                        datasource_id INTEGER NOT NULL,
                        cache_key TEXT NOT NULL,
                        payload TEXT NOT NULL,
                        expires_at REAL NOT NULL,
                        updated_at REAL NOT NULL,
                        PRIMARY KEY (datasource_id, cache_key)
                    )
                    """
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_live_query_cache_expires_at "
                    "ON live_query_cache(expires_at)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_live_query_cache_updated_at "
                    "ON live_query_cache(updated_at)"
                )
                # Cross-process request coalescing: a leader marks a (ds, key) as
                # in-flight before running the source query; concurrent callers
                # (incl. OTHER workers — this table is the shared sqlite file) see
                # the marker and wait for the leader's cached result instead of
                # firing a duplicate warehouse query. `expires_at` self-heals if a
                # leader dies without releasing.
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS live_query_inflight (
                        datasource_id INTEGER NOT NULL,
                        cache_key TEXT NOT NULL,
                        expires_at REAL NOT NULL,
                        PRIMARY KEY (datasource_id, cache_key)
                    )
                    """
                )
            self._initialized = True

    def get(self, datasource_id: int, cache_key: str) -> Optional[Dict[str, Any]]:
        self._ensure_initialized()
        now = time.time()
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT payload, expires_at
                FROM live_query_cache
                WHERE datasource_id = ? AND cache_key = ?
                """,
                (int(datasource_id), cache_key),
            ).fetchone()
            if row is None:
                return None

            if float(row["expires_at"]) <= now:
                conn.execute(
                    """
                    DELETE FROM live_query_cache
                    WHERE datasource_id = ? AND cache_key = ?
                    """,
                    (int(datasource_id), cache_key),
                )
                return None

            try:
                payload = json.loads(str(row["payload"]))
            except json.JSONDecodeError:
                conn.execute(
                    """
                    DELETE FROM live_query_cache
                    WHERE datasource_id = ? AND cache_key = ?
                    """,
                    (int(datasource_id), cache_key),
                )
                return None
            return payload if isinstance(payload, dict) else None

    def set(self, datasource_id: int, cache_key: str, data: Dict[str, Any], ttl_seconds: Optional[float] = None) -> None:
        self._ensure_initialized()
        now = time.time()
        effective_ttl = float(ttl_seconds) if ttl_seconds is not None else self.ttl_seconds
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO live_query_cache (
                    datasource_id,
                    cache_key,
                    payload,
                    expires_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(datasource_id, cache_key) DO UPDATE SET
                    payload = excluded.payload,
                    expires_at = excluded.expires_at,
                    updated_at = excluded.updated_at
                """,
                (
                    int(datasource_id),
                    cache_key,
                    _stable_json_dumps(data),
                    now + effective_ttl,
                    now,
                ),
            )
        self._cleanup_if_needed()

    def try_claim_inflight(self, datasource_id: int, cache_key: str, ttl_seconds: float) -> bool:
        """Atomically claim the (ds, key) in-flight slot. Returns True → THIS caller
        is the leader (must run the query then call ``release_inflight``); False →
        someone else is already computing (the caller should wait for the cache).
        The PK conflict is what makes leader election atomic across processes
        (sqlite serialises writers via the file lock). Expired markers (a dead
        leader) are cleared first so they never block forever."""
        self._ensure_initialized()
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM live_query_inflight WHERE datasource_id = ? AND cache_key = ? AND expires_at <= ?",
                (int(datasource_id), cache_key, now),
            )
            try:
                cursor = conn.execute(
                    "INSERT INTO live_query_inflight (datasource_id, cache_key, expires_at) VALUES (?, ?, ?)",
                    (int(datasource_id), cache_key, now + float(ttl_seconds)),
                )
                return int(cursor.rowcount or 0) == 1
            except sqlite3.IntegrityError:
                return False  # another caller holds the slot

    def release_inflight(self, datasource_id: int, cache_key: str) -> None:
        self._ensure_initialized()
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM live_query_inflight WHERE datasource_id = ? AND cache_key = ?",
                (int(datasource_id), cache_key),
            )

    def invalidate_datasource(self, datasource_id: int) -> int:
        self._ensure_initialized()
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM live_query_cache WHERE datasource_id = ?",
                (int(datasource_id),),
            )
            return max(int(cursor.rowcount or 0), 0)

    def delete_key(self, datasource_id: int, cache_key: str) -> None:
        self._ensure_initialized()
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM live_query_cache WHERE datasource_id = ? AND cache_key = ?",
                (int(datasource_id), cache_key),
            )

    def clear_all(self) -> int:
        self._ensure_initialized()
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM live_query_cache")
            return max(int(cursor.rowcount or 0), 0)

    def _cleanup_if_needed(self) -> None:
        now_monotonic = time.monotonic()
        if now_monotonic - self._last_cleanup_monotonic < _SHARED_CLEANUP_INTERVAL_SECONDS:
            return

        with self._init_lock:
            now_monotonic = time.monotonic()
            if now_monotonic - self._last_cleanup_monotonic < _SHARED_CLEANUP_INTERVAL_SECONDS:
                return
            self._last_cleanup_monotonic = now_monotonic

        self._ensure_initialized()
        now = time.time()
        with self._connect() as conn:
            conn.execute("DELETE FROM live_query_cache WHERE expires_at <= ?", (now,))
            if self.max_rows <= 0:
                return
            row = conn.execute("SELECT COUNT(*) AS count FROM live_query_cache").fetchone()
            total_rows = int(row["count"] or 0) if row is not None else 0
            overflow = total_rows - self.max_rows
            if overflow > 0:
                conn.execute(
                    """
                    DELETE FROM live_query_cache
                    WHERE rowid IN (
                        SELECT rowid
                        FROM live_query_cache
                        ORDER BY updated_at ASC
                        LIMIT ?
                    )
                    """,
                    (overflow,),
                )


_shared_store: Optional[_SharedSqliteCache] = None
_shared_store_signature: tuple[Any, ...] | None = None


def _log_shared_cache_failure(action: str, exc: Exception) -> None:
    with _shared_error_lock:
        first_time = action not in _shared_cache_error_actions
        if first_time:
            _shared_cache_error_actions.add(action)
    if first_time:
        logger.warning("Shared live query cache %s failed: %s", action, exc)
    else:
        logger.debug("Shared live query cache %s failed", action, exc_info=True)


def _get_shared_store() -> Optional[_SharedSqliteCache]:
    global _shared_store, _shared_store_signature

    if not settings.LIVE_QUERY_SHARED_CACHE_ENABLED:
        return None

    signature = (
        bool(settings.LIVE_QUERY_SHARED_CACHE_ENABLED),
        str(settings.live_query_shared_cache_db_path),
        int(settings.LIVE_QUERY_CACHE_TTL),
        int(settings.LIVE_QUERY_SHARED_CACHE_MAX_SIZE),
    )

    with _lock:
        if _shared_store is None or _shared_store_signature != signature:
            _shared_store = _SharedSqliteCache(
                db_path=settings.live_query_shared_cache_db_path,
                ttl_seconds=settings.LIVE_QUERY_CACHE_TTL,
                max_rows=settings.LIVE_QUERY_SHARED_CACHE_MAX_SIZE,
            )
            _shared_store_signature = signature
        return _shared_store


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
    payload = {
        "tbl": table_identifier,
        "ct": chart_type,
        "rc": _canonicalize_json_value(role_config),
        "f": _canonicalize_filters(filters),
    }
    return hashlib.sha256(_stable_json_dumps(payload).encode()).hexdigest()


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
        logger.debug("Cache HIT (local): ds=%d key=%s", datasource_id, key[:12])
        return result

    shared_store = _get_shared_store()
    if shared_store is None:
        return None

    try:
        result = shared_store.get(datasource_id, key)
    except Exception as exc:
        _log_shared_cache_failure("read", exc)
        return None

    if result is not None:
        with _lock:
            cache[key] = result
        logger.debug("Cache HIT (shared): ds=%d key=%s", datasource_id, key[:12])
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

    shared_store = _get_shared_store()
    if shared_store is not None:
        try:
            shared_store.set(datasource_id, key, data)
        except Exception as exc:
            _log_shared_cache_failure("write", exc)

    logger.debug("Cache SET: ds=%d key=%s", datasource_id, key[:12])


# Cross-process request coalescing (perf): when N viewers open the SAME report
# at once, each tile's data request for a given (chart, filters, grain, snapshot)
# is identical. Without coalescing, on a MULTI-WORKER deployment each worker runs
# its own warehouse query (the in-process single_flight only dedups within ONE
# process) — so the same query hits BigQuery up to `#workers` times and cost
# scales with concurrency. These helpers elect ONE leader across ALL workers
# (atomic sqlite marker in the shared cache file) to run the query; every other
# caller waits for the leader's cached result. NEVER raises → falls back to
# "everyone computes" (current behaviour) on any error.
_INFLIGHT_TTL_SECONDS = 90.0
_COALESCE_WAIT_TIMEOUT = 30.0   # >= slowest expected source query
_COALESCE_POLL_INTERVAL = 0.25


def begin_coalesced_compute(
    datasource_id: int,
    table_identifier: str,
    chart_type: str,
    role_config: dict,
    filters: list,
    *,
    wait_timeout: float = _COALESCE_WAIT_TIMEOUT,
    poll_interval: float = _COALESCE_POLL_INTERVAL,
) -> tuple[Optional[Dict[str, Any]], bool]:
    """Coalesce concurrent identical computes ACROSS workers. Call ONLY after a
    cache miss. Returns ``(cached_result_or_None, is_leader)``:
      • ``(None, True)``  → YOU are the leader: run the query, ``set_cached``,
                            then call ``end_coalesced_compute`` with the same args.
      • ``(result, False)`` → another worker already computed it; use ``result``
                            (do NOT run the query, do NOT end).
    A waiter polls the shared cache up to ``wait_timeout``; if the leader dies
    (marker gone, still no cache) it takes over as leader; on timeout it also
    takes over (best-effort, avoids hanging)."""
    store = _get_shared_store()
    if store is None:
        # No shared store → no cross-process coordination possible; behave exactly
        # as today (the in-process single_flight still dedups within this worker).
        return None, True
    key = _make_key(table_identifier, chart_type, role_config, filters)
    try:
        if store.try_claim_inflight(datasource_id, key, _INFLIGHT_TTL_SECONDS):
            return None, True
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("inflight-claim", exc)
        return None, True
    # Someone else is computing → wait for their result.
    deadline = time.monotonic() + max(float(wait_timeout), 0.0)
    while time.monotonic() < deadline:
        time.sleep(poll_interval)
        # Check the cache FIRST (leader writes cache, THEN releases the marker).
        try:
            result = get_cached(datasource_id, table_identifier, chart_type, role_config, filters)
        except Exception:  # noqa: BLE001
            result = None
        if result is not None:
            return result, False
        # Still no cache — if the marker is now free, the leader died without
        # writing; take over so this request isn't stuck behind a dead leader.
        try:
            if store.try_claim_inflight(datasource_id, key, _INFLIGHT_TTL_SECONDS):
                return None, True
        except Exception:  # noqa: BLE001
            return None, True
    return None, True  # timed out waiting → compute ourselves (rare)


def end_coalesced_compute(
    datasource_id: int,
    table_identifier: str,
    chart_type: str,
    role_config: dict,
    filters: list,
) -> None:
    """Release the in-flight marker after the leader has written the cache."""
    store = _get_shared_store()
    if store is None:
        return
    key = _make_key(table_identifier, chart_type, role_config, filters)
    try:
        store.release_inflight(datasource_id, key)
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("inflight-release", exc)


# ── Phase 7 (#35/#36/#38): CROSS-WORKER global claims ────────────────────────
# Thin wrappers over the shared-sqlite in-flight table under a reserved
# namespace, so background jobs (snapshot rebuilds) can be deduped and observed
# ACROSS uvicorn workers — the in-process registries in snapshot_service are
# per-worker, so "cap = 1 rebuild" and the "đang làm mới…" poll were only true
# per process. No shared store configured → (True/False/None) fallbacks keep
# today's per-process behaviour.
_GLOBAL_CLAIM_NS = -2  # reserved datasource_id namespace


def try_claim_global(key: str, ttl_seconds: float) -> bool:
    """Claim a cross-worker lease for ``key``. True = you own it. Lease
    self-expires (a dead worker never wedges the system)."""
    store = _get_shared_store()
    if store is None:
        return True  # no shared store → in-process registries are authoritative
    try:
        return store.try_claim_inflight(_GLOBAL_CLAIM_NS, key, ttl_seconds)
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("global-claim", exc)
        return True


def release_global(key: str) -> None:
    store = _get_shared_store()
    if store is None:
        return
    try:
        store.release_inflight(_GLOBAL_CLAIM_NS, key)
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("global-release", exc)


def is_claimed_global(key: str) -> bool:
    """True when ANOTHER worker (or this one) currently holds the lease —
    a claim-probe that immediately releases if it accidentally acquires."""
    store = _get_shared_store()
    if store is None:
        return False
    try:
        if store.try_claim_inflight(_GLOBAL_CLAIM_NS, key, 1.0):
            store.release_inflight(_GLOBAL_CLAIM_NS, key)
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("global-probe", exc)
        return False


# ── Generic cross-worker KV (sync coordination: progress / stop / cooldown) ──
# A dedicated namespace so `invalidate_datasource` / real datasource caches never
# touch these. Best-effort: no shared store (dev, single-worker, or disabled) →
# no-op / None → callers fall back to their in-process state (unchanged behaviour).
_SYNC_STATE_NS = -424242


def set_shared(key: str, data: Dict[str, Any], ttl_seconds: float) -> None:
    store = _get_shared_store()
    if store is None:
        return
    try:
        store.set(_SYNC_STATE_NS, key, data, ttl_seconds=ttl_seconds)
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("shared-set", exc)


def get_shared(key: str) -> Optional[Dict[str, Any]]:
    store = _get_shared_store()
    if store is None:
        return None
    try:
        return store.get(_SYNC_STATE_NS, key)
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("shared-get", exc)
        return None


def del_shared(key: str) -> None:
    store = _get_shared_store()
    if store is None:
        return
    try:
        store.delete_key(_SYNC_STATE_NS, key)
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("shared-del", exc)


# ── Public dashboard METADATA cache + coalescing ─────────────────────────────
# GET /public/dashboards/{token} rebuilds a heavy structure per request (hydrate
# every chart + resolve every dataset's semantic model + build the filter
# inventory). It's the SAME for all viewers of a token and is the gate before any
# tile loads, so N concurrent viewers each pay it. Cache the built response by
# token (short TTL — structure changes are rare, and edits still appear within
# the TTL) and coalesce concurrent builds across workers, exactly like chart
# data. A negative sentinel namespace keeps these keys out of the per-datasource
# space. NEVER raises → falls back to rebuilding.
_PUBLIC_META_NS = -1
_PUBLIC_META_TTL_SECONDS = 60.0


def get_public_meta(token: str) -> Optional[Dict[str, Any]]:
    store = _get_shared_store()
    if store is None:
        return None
    try:
        return store.get(_PUBLIC_META_NS, str(token))
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("pubmeta-read", exc)
        return None


def set_public_meta(token: str, data: Dict[str, Any]) -> None:
    store = _get_shared_store()
    if store is None:
        return
    try:
        store.set(_PUBLIC_META_NS, str(token), data, ttl_seconds=_PUBLIC_META_TTL_SECONDS)
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("pubmeta-write", exc)


def begin_coalesced_public_meta(
    token: str, *, wait_timeout: float = 15.0, poll_interval: float = 0.2
) -> tuple[Optional[Dict[str, Any]], bool]:
    """Coalesce concurrent metadata builds for one token across workers. Returns
    ``(cached_or_None, is_leader)`` — same contract as ``begin_coalesced_compute``."""
    store = _get_shared_store()
    if store is None:
        return None, True
    key = str(token)
    try:
        if store.try_claim_inflight(_PUBLIC_META_NS, key, _INFLIGHT_TTL_SECONDS):
            return None, True
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("pubmeta-claim", exc)
        return None, True
    deadline = time.monotonic() + max(float(wait_timeout), 0.0)
    while time.monotonic() < deadline:
        time.sleep(poll_interval)
        try:
            result = store.get(_PUBLIC_META_NS, key)
        except Exception:  # noqa: BLE001
            result = None
        if result is not None:
            return result, False
        try:
            if store.try_claim_inflight(_PUBLIC_META_NS, key, _INFLIGHT_TTL_SECONDS):
                return None, True
        except Exception:  # noqa: BLE001
            return None, True
    return None, True


def end_coalesced_public_meta(token: str) -> None:
    store = _get_shared_store()
    if store is None:
        return
    try:
        store.release_inflight(_PUBLIC_META_NS, str(token))
    except Exception as exc:  # noqa: BLE001
        _log_shared_cache_failure("pubmeta-release", exc)


def invalidate_datasource(datasource_id: int) -> int:
    """Remove all cached entries for a specific datasource (e.g. after sync)."""
    removed_local = 0
    with _lock:
        if datasource_id in _caches:
            removed_local = len(_caches[datasource_id])
            _caches[datasource_id].clear()

    removed_shared = 0
    shared_store = _get_shared_store()
    if shared_store is not None:
        try:
            removed_shared = shared_store.invalidate_datasource(datasource_id)
        except Exception as exc:
            _log_shared_cache_failure("invalidate", exc)

    removed_total = removed_local + removed_shared
    if removed_total:
        logger.info(
            "Cache cleared: %d local + %d shared entries for ds=%d",
            removed_local,
            removed_shared,
            datasource_id,
        )
    return removed_total


def clear_all() -> None:
    """Clear entire cache across all datasources."""
    with _lock:
        total_local = sum(len(cache) for cache in _caches.values())
        _caches.clear()

    total_shared = 0
    shared_store = _get_shared_store()
    if shared_store is not None:
        try:
            total_shared = shared_store.clear_all()
        except Exception as exc:
            _log_shared_cache_failure("clear_all", exc)

    logger.info(
        "Live query cache cleared: %d local + %d shared entries",
        total_local,
        total_shared,
    )
