"""The durable audit ledger service (PR-1E): `governed_query_executions` writes.

`PostgresLedger` is the AuditSink GQS executes against. Every write is its own
committed transaction on a connection of its own, so the record never depends
on the caller's ORM session committing (a rolled-back request still leaves its
audit row).

Contracts (the table contract itself is in models/governed_query_execution.py):

* ``begin`` is insert-only. A second ``begin`` for the same ``query_id`` raises:
  a replayed request cannot rewrite history. If the INSERT did not commit,
  ``begin`` raises and GQS refuses ``audit_unavailable`` — nothing runs.
* Budgets are reserved INSIDE ``begin``, atomically: the transaction takes
  advisory locks on the budget keys (user, datasource, run), counts, and inserts
  the running row before releasing them. A concurrent ``begin`` on the same key
  waits, then counts that row. COUNT-then-INSERT without the lock is not atomic
  and is not what happens here. Over budget, a terminal ``refused`` row with
  ``budget_exceeded`` is written and ``BudgetExceeded`` is raised.
* ``finish`` is a conditional UPDATE from ``running``. The first terminal write
  wins; the same terminal status again is idempotent; a different one after it
  is rejected (``LedgerConflict``) — no flip from ``cancelled`` to ``ok``.
* ``request_cancel`` marks a running row; only the user who owns the query may
  mark it. The worker that runs it sees the mark (``CancelWatcher``) and cancels
  on its own connection — no worker signals a backend it does not own.
* ``recover_stale_running`` moves rows whose worker stopped heart-beating to
  ``abandoned``. Rows are never deleted and never re-run.

Never written: SQL text, result rows, filter values, credentials.
"""
from __future__ import annotations

import hashlib
import logging
import os
import socket
import threading
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional

import sqlalchemy as sa

from app.services.governed_query.principal import GovernedRefusal

logger = logging.getLogger(__name__)

TERMINAL = ("ok", "refused", "error", "cancelled", "timeout", "abandoned")


class LedgerConflict(RuntimeError):
    """A write that would rewrite history (second begin, terminal flip)."""


class BudgetExceeded(GovernedRefusal):
    def __init__(self, budget: str, limit: int, used: int):
        super().__init__("budget_exceeded", "Đã vượt hạn mức truy vấn được phép.",
                         {"budget": budget, "limit": limit, "used": used})


@dataclass(frozen=True)
class LedgerBudgets:
    """Server-side limits; None = not limited. Never taken from a request."""

    max_queries_per_run: Optional[int] = None
    max_queries_per_user_day: Optional[int] = None
    max_concurrent_per_datasource: Optional[int] = None
    max_bq_bytes_per_user_day: Optional[int] = None


def default_worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


def _lock_key(name: str) -> int:
    """A stable signed 64-bit advisory-lock key for a budget scope."""
    return int.from_bytes(hashlib.sha256(f"gqs-budget:{name}".encode()).digest()[:8], "big", signed=True)


class PostgresLedger:
    def __init__(self, engine: sa.engine.Engine, *, budgets: Optional[LedgerBudgets] = None,
                 worker_id: Optional[str] = None):
        self.engine = engine
        self.budgets = budgets or LedgerBudgets()
        self.worker_id = worker_id or default_worker_id()

    # ── begin: budgets + the running row, one transaction ───────────────────
    def begin(self, compiled: Any) -> None:
        p = compiled.request.principal
        rel = compiled.request.relation
        run_id = compiled.request.run_id
        ds_id = int(getattr(compiled.datasource, "id", 0) or 0) or None
        reserved = int(compiled.bounds.bq_max_bytes) if compiled.ds_type == "bigquery" else None
        row = {
            "query_id": compiled.query_id, "run_id": run_id, "user_id": str(p.user_id) if p.user_id else None,
            "principal_kind": str(p.kind), "surface": str(p.surface),
            "relation_kind": rel.kind, "relation_id": rel.id,
            "dataset_ids": list(compiled.dataset_ids), "datasource_id": ds_id,
            "dialect": compiled.dialect, "sql_fingerprint": compiled.sql_fingerprint,
            "policy_fingerprint": compiled.policy_fingerprint, "bounds": compiled.bounds.as_dict(),
            "reserved_bq_bytes": reserved, "worker_id": self.worker_id,
            "consent_nonce": getattr(compiled, "consent_nonce", None),
        }
        over = None
        with self.engine.begin() as conn:
            keys = sorted({_lock_key(k) for k in self._budget_scopes(row)})
            for k in keys:  # sorted: two begins never wait on each other in a cycle
                conn.execute(sa.text("SELECT pg_advisory_xact_lock(:k)"), {"k": k})
            over = self._check_budgets(conn, row)
            if over is None:
                self._insert(conn, row, status="running")
        if over is not None:
            with self.engine.begin() as conn:
                # A refused row does not consume the consent: it did not run.
                self._insert(conn, {**row, "consent_nonce": None}, status="refused", refusal_code="budget_exceeded")
            raise BudgetExceeded(*over)

    def _budget_scopes(self, row: dict) -> Iterable[str]:
        b = self.budgets
        if row["user_id"] and (b.max_queries_per_user_day or b.max_bq_bytes_per_user_day):
            yield f"user:{row['user_id']}"
        if row["datasource_id"] and b.max_concurrent_per_datasource:
            yield f"ds:{row['datasource_id']}"
        if row["run_id"] and b.max_queries_per_run:
            yield f"run:{row['run_id']}"

    def _check_budgets(self, conn, row: dict):
        b = self.budgets
        one = lambda q, **kw: int(conn.execute(sa.text(q), kw).scalar() or 0)  # noqa: E731
        # Refused rows are not executions and do not consume a budget.
        if row["run_id"] and b.max_queries_per_run:
            used = one("SELECT count(*) FROM governed_query_executions WHERE run_id = :r "
                       "AND status <> 'refused'", r=row["run_id"])
            if used >= b.max_queries_per_run:
                return ("queries_per_run", b.max_queries_per_run, used)
        if row["user_id"] and b.max_queries_per_user_day:
            used = one("SELECT count(*) FROM governed_query_executions WHERE user_id = :u "
                       "AND started_at >= date_trunc('day', now()) AND status <> 'refused'", u=row["user_id"])
            if used >= b.max_queries_per_user_day:
                return ("queries_per_user_day", b.max_queries_per_user_day, used)
        if row["user_id"] and b.max_bq_bytes_per_user_day and row["reserved_bq_bytes"]:
            used = one("SELECT coalesce(sum(coalesce(bytes_processed, reserved_bq_bytes)), 0) "
                       "FROM governed_query_executions WHERE user_id = :u "
                       "AND started_at >= date_trunc('day', now()) AND status <> 'refused'", u=row["user_id"])
            if used + row["reserved_bq_bytes"] > b.max_bq_bytes_per_user_day:
                return ("bq_bytes_per_user_day", b.max_bq_bytes_per_user_day, used)
        if row["datasource_id"] and b.max_concurrent_per_datasource:
            used = one("SELECT count(*) FROM governed_query_executions WHERE datasource_id = :d "
                       "AND status = 'running'", d=row["datasource_id"])
            if used >= b.max_concurrent_per_datasource:
                return ("concurrent_per_datasource", b.max_concurrent_per_datasource, used)
        return None

    @staticmethod
    def _insert(conn, row: dict, *, status: str, refusal_code: Optional[str] = None) -> None:
        terminal = status != "running"
        try:
            conn.execute(sa.text(
                "INSERT INTO governed_query_executions (query_id, run_id, user_id, principal_kind, surface, "
                "relation_kind, relation_id, dataset_ids, datasource_id, dialect, sql_fingerprint, "
                "policy_fingerprint, bounds, reserved_bq_bytes, status, refusal_code, worker_id, consent_nonce, "
                "heartbeat_at, finished_at) VALUES (:query_id, :run_id, CAST(:user_id AS uuid), :principal_kind, :surface, "
                ":relation_kind, :relation_id, CAST(:dataset_ids AS jsonb), :datasource_id, :dialect, "
                ":sql_fingerprint, :policy_fingerprint, CAST(:bounds AS jsonb), :reserved_bq_bytes, :status, "
                ":refusal_code, :worker_id, :consent_nonce, now(), " + ("now()" if terminal else "NULL") + ")"),
                {**row, "dataset_ids": _json(row["dataset_ids"]), "bounds": _json(row["bounds"]),
                 "status": status, "refusal_code": refusal_code})
        except sa.exc.IntegrityError as exc:
            if "uq_gqe_consent_nonce" in str(exc):
                raise GovernedRefusal("consent_replayed", "Xác nhận này đã được dùng; cần xác nhận lại.",
                                      {}) from exc
            raise LedgerConflict(f"query {row['query_id']} already has a ledger row") from exc

    # ── finish: first terminal write wins ───────────────────────────────────
    def finish(self, query_id: str, *, status: str, refusal_code: Optional[str] = None,
               rows_returned: Optional[int] = None, bytes_processed: Optional[int] = None,
               duration_ms: Optional[int] = None) -> None:
        if status not in TERMINAL:
            raise ValueError(f"not a terminal status: {status}")
        with self.engine.begin() as conn:
            done = conn.execute(sa.text(
                "UPDATE governed_query_executions SET status = :s, refusal_code = :c, rows_returned = :r, "
                "bytes_processed = :b, duration_ms = :d, finished_at = now() "
                "WHERE query_id = :q AND status = 'running' RETURNING query_id"),
                {"s": status, "c": refusal_code, "r": rows_returned, "b": bytes_processed,
                 "d": duration_ms, "q": query_id}).first()
            if done:
                return
            current = conn.execute(sa.text("SELECT status FROM governed_query_executions WHERE query_id = :q"),
                                   {"q": query_id}).scalar()
        if current is None:
            raise LedgerConflict(f"query {query_id} was never begun")
        if current != status:
            raise LedgerConflict(f"query {query_id} is already {current}; refusing {status}")

    def refused(self, *, query_id: str, principal_ref: str, relation: Any, code: str) -> None:
        """A refusal decided before execution: one terminal row, nothing ran."""
        kind, _, rest = str(principal_ref).partition(":")
        user, _, surface = rest.partition("@")
        row = {"query_id": query_id, "run_id": None, "user_id": user or None, "principal_kind": kind or "unknown",
               "surface": surface or "unknown", "relation_kind": getattr(relation, "kind", None),
               "relation_id": getattr(relation, "id", None), "dataset_ids": None, "datasource_id": None,
               "dialect": None, "sql_fingerprint": None, "policy_fingerprint": None, "bounds": None,
               "reserved_bq_bytes": None, "worker_id": self.worker_id, "consent_nonce": None}
        with self.engine.begin() as conn:
            self._insert(conn, row, status="refused", refusal_code=code)

    # ── cross-worker cancel, heartbeat, recovery ────────────────────────────
    def request_cancel(self, query_id: str, *, requested_by: Any) -> bool:
        """Mark a RUNNING query of `requested_by` for cancellation. False when the
        query is not running or is not theirs — the two are not distinguished."""
        with self.engine.begin() as conn:
            hit = conn.execute(sa.text(
                "UPDATE governed_query_executions SET cancel_requested_at = coalesce(cancel_requested_at, now()), "
                "cancel_requested_by = coalesce(cancel_requested_by, CAST(:u AS uuid)) "
                "WHERE query_id = :q AND status = 'running' AND user_id = CAST(:u AS uuid) RETURNING query_id"),
                {"q": query_id, "u": str(requested_by)}).first()
        return hit is not None

    def heartbeat(self, query_ids: Iterable[str]) -> list[str]:
        """Renew this worker's leases; return the ids whose cancel was requested."""
        ids = list(query_ids)
        if not ids:
            return []
        with self.engine.begin() as conn:
            rows = conn.execute(sa.text(
                "UPDATE governed_query_executions SET heartbeat_at = now() "
                "WHERE query_id = ANY(:ids) AND status = 'running' AND worker_id = :w "
                "RETURNING query_id, cancel_requested_at IS NOT NULL"), {"ids": ids, "w": self.worker_id}).all()
        return [r[0] for r in rows if r[1]]

    def recover_stale_running(self, *, older_than_seconds: int) -> list[str]:
        with self.engine.begin() as conn:
            rows = conn.execute(sa.text(
                "UPDATE governed_query_executions SET status = 'abandoned', refusal_code = 'worker_lost', "
                "finished_at = now() WHERE status = 'running' "
                "AND coalesce(heartbeat_at, started_at) < now() - make_interval(secs => :s) RETURNING query_id"),
                {"s": int(older_than_seconds)}).all()
        return [r[0] for r in rows]


class CancelWatcher:
    """One background thread per worker: renews the leases of the queries this
    worker is running and cancels, locally, those another worker marked."""

    def __init__(self, ledger: PostgresLedger, registry: Any, *, interval_seconds: float = 1.0,
                 on_error: Optional[Callable[[BaseException], None]] = None):
        self.ledger = ledger
        self.registry = registry
        self.interval = interval_seconds
        self.on_error = on_error
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def tick(self) -> list[str]:
        marked = self.ledger.heartbeat(self.registry.running_ids())
        for qid in marked:
            self.registry.cancel(qid)
        return marked

    def start(self) -> "CancelWatcher":
        def loop():
            while not self._stop.wait(self.interval):
                try:
                    self.tick()
                except Exception as exc:  # noqa: BLE001 - keep watching
                    logger.warning("governed query: cancel watcher tick failed", exc_info=True)
                    if self.on_error:
                        self.on_error(exc)

        self._thread = threading.Thread(target=loop, name="gqs-cancel-watcher", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)


def _json(value: Any) -> Optional[str]:
    import json

    return None if value is None else json.dumps(value)
