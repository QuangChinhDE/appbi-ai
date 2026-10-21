"""Cancelling a governed read that is already running (spec §2.6, PR-1D).

A bounded query can still be the wrong query: a person closes the answer, an
Analyst run is abandoned, a timeout is about to bite. Cancelling must stop the
statement AT THE WAREHOUSE, not merely abandon the Python call — an abandoned
call leaves the database working and the cost accruing.

Shape:

  * `CancelRegistry` is process-local: `query_id -> Canceller`, plus the set of
    ids that were asked to cancel. `cancel()` is IDEMPOTENT and may be called
    before the canceller is registered (the id is remembered, and the query is
    refused as soon as it checks) or after the query finished (a no-op).
  * A `Canceller` is one adapter per engine. Each one cancels from a SEPARATE
    connection, because the connection running the statement is busy.
  * GQS registers the canceller as soon as the engine reports its backend id,
    unregisters in a `finally`, and refuses `cancelled` if the id was cancelled
    at any point — even when rows already came back. A cancelled query never
    returns a completed result.

Cross-process cancel (a worker cancelling another worker's query) needs the
durable ledger to look the running id up; that is PR-1E and is NOT implemented
here. In one process this registry is the whole mechanism.
"""
from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Optional, Protocol, Set

logger = logging.getLogger(__name__)


class Canceller(Protocol):
    """Stops one running statement. Returns True when the engine accepted the
    request; never raises — a cancel that fails must not mask the refusal."""

    def cancel(self) -> bool:
        ...


class PostgresCanceller:
    """`pg_cancel_backend(pid)` from a second connection, aimed at ONE session.

    The target is identified by ``(pid, backend_start)``, never by pid alone: once
    our statement's session ends, Postgres can hand the same pid to another
    session — another user's, another tenant's. The cancel is a single statement
    that only fires if the session with that pid still has the backend_start we
    captured, so a late cancel can never stop someone else's query.

    Postgres itself only lets a non-superuser cancel sessions of its own role (or
    with pg_signal_backend). The canceller connects with the same source
    credential that ran the statement, which is exactly the role allowed to stop
    it — and no other."""

    def __init__(self, config: Dict[str, Any], backend: Any):
        self.config = config
        # Accept the executor's {"pid", "backend_start"} (the only safe form). A
        # bare pid is not enough to cancel safely and is treated as unknown.
        self.pid = backend.get("pid") if isinstance(backend, dict) else None
        self.backend_start = backend.get("backend_start") if isinstance(backend, dict) else None

    def cancel(self) -> bool:
        if self.pid is None or self.backend_start is None:
            return False
        conn = None
        try:
            from app.services.datasource_service import _pg_connect

            conn = _pg_connect(
                host=self.config.get("host"), port=self.config.get("port", 5432),
                database=self.config.get("database"), user=self.config.get("username"),
                password=self.config.get("password"), connect_timeout=5,
            )
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT pg_cancel_backend(pid) FROM pg_stat_activity "
                    "WHERE pid = %s AND backend_start = %s",
                    (int(self.pid), self.backend_start),
                )
                row = cur.fetchone()
            conn.commit()
            return bool(row and row[0])
        except Exception:  # noqa: BLE001 - a failed cancel is reported, never raised
            logger.warning("governed query: postgres cancel failed for pid %s", self.pid, exc_info=True)
            return False
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass


class MySQLCanceller:
    """`KILL QUERY <connection id>` from a second connection."""

    def __init__(self, config: Dict[str, Any], connection_id: Any):
        self.config = config
        self.connection_id = connection_id

    def cancel(self) -> bool:
        if self.connection_id is None:
            return False
        conn = None
        try:
            from app.services.datasource_service import _mysql_connect

            conn = _mysql_connect(
                host=self.config.get("host"), port=self.config.get("port", 3306),
                database=self.config.get("database"), user=self.config.get("username"),
                password=self.config.get("password"), connect_timeout=5,
                read_timeout=5, write_timeout=5,
            )
            with conn.cursor() as cur:
                cur.execute(f"KILL QUERY {int(self.connection_id)}")
            return True
        except Exception:  # noqa: BLE001
            logger.warning("governed query: mysql cancel failed for %s", self.connection_id, exc_info=True)
            return False
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass


class BigQueryCanceller:
    """`job.cancel()` on the running query job."""

    def __init__(self, job: Any):
        self.job = job

    def cancel(self) -> bool:
        try:
            self.job.cancel()
            return True
        except Exception:  # noqa: BLE001
            logger.warning("governed query: bigquery job cancel failed", exc_info=True)
            return False


class CancelRegistry:
    """Process-local. Every method is safe to call from another thread, which is
    the point: the cancel arrives on a different request than the query."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._cancellers: Dict[str, Canceller] = {}
        self._cancelled: Set[str] = set()

    def register(self, query_id: str, canceller: Canceller) -> bool:
        """Attach the canceller. If cancel() already arrived for this id, the
        statement is cancelled at once and True is returned."""
        with self._lock:
            self._cancellers[query_id] = canceller
            already = query_id in self._cancelled
        if already:
            canceller.cancel()
        return already

    def unregister(self, query_id: str) -> None:
        """Drop the canceller. The CANCELLED mark is kept: a query that finished
        a moment after the cancel must still be refused, not returned."""
        with self._lock:
            self._cancellers.pop(query_id, None)

    def forget(self, query_id: str) -> None:
        """Drop everything about the id (end of the request)."""
        with self._lock:
            self._cancellers.pop(query_id, None)
            self._cancelled.discard(query_id)

    def cancel(self, query_id: str) -> bool:
        """Idempotent. Marks the id cancelled and stops the statement if it is
        running here. True when a statement was actually asked to stop."""
        with self._lock:
            self._cancelled.add(query_id)
            canceller = self._cancellers.get(query_id)
        return bool(canceller and canceller.cancel())

    def is_cancelled(self, query_id: str) -> bool:
        with self._lock:
            return query_id in self._cancelled

    def running_ids(self) -> Set[str]:
        with self._lock:
            return set(self._cancellers)


#: The one registry a process uses. A test may build its own.
REGISTRY = CancelRegistry()
