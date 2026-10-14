"""Plans, approvals and resumable operations (spec §3–§4).

A *plan* is the validated, normalised description of what will be written. Its
SHA-256 over canonical JSON is the `plan_hash`; an approval covers exactly that
hash for exactly that user.

An *operation* executes one approved plan as a sequence of named steps. Each
write step is persisted `sent → done | failed` with the AppBI ids it produced,
so re-running the operation skips finished steps and reconciles an ambiguous
one (sent, outcome unknown) by reading AppBI before writing again. Nothing is
ever deleted to "roll back".
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .appbi_client import AmbiguousWrite, AppbiError
from .state import StateStore, canonical_json, new_id, sha256_hex

PLAN_TTL = 24 * 3600
APPROVAL_TTL = 30 * 60
RUNNER_GRACE = 30

TERMINAL = {"draft_ready", "blocked", "conflict", "stale_plan", "partially_failed", "published", "sync_failed"}


class OperationError(Exception):
    """Ends the run with a definite status (blocked / conflict / stale_plan / …)."""

    def __init__(self, status: str, message: str, *, step: str | None = None, detail: Any = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.step = step
        self.detail = detail


@dataclass
class Plan:
    id: str
    user_id: str
    grant_id: str
    kind: str
    body: dict[str, Any]
    plan_hash: str
    summary: dict[str, Any]
    fingerprint: dict[str, Any]
    created_at: float
    expires_at: float


class PlanStore:
    def __init__(self, store: StateStore):
        self.store = store

    # ── plans ────────────────────────────────────────────────────────────────

    def create(self, *, user_id: str, grant_id: str, kind: str, body: dict[str, Any], summary: dict[str, Any], fingerprint: dict[str, Any]) -> Plan:
        now = time.time()
        plan = Plan(
            id=new_id("plan"),
            user_id=user_id,
            grant_id=grant_id,
            kind=kind,
            body=body,
            plan_hash=sha256_hex(canonical_json({"kind": kind, "body": body})),
            summary=summary,
            fingerprint=fingerprint,
            created_at=now,
            expires_at=now + PLAN_TTL,
        )
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO plans(id, user_id, grant_id, kind, plan_json, plan_hash, summary_json, fingerprint_json, created_at, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (plan.id, user_id, grant_id, kind, canonical_json(body), plan.plan_hash, canonical_json(summary),
                 canonical_json(fingerprint), now, plan.expires_at),
            )
        return plan

    def get(self, plan_id: str, user_id: str) -> Plan | None:
        """A plan of another user is indistinguishable from a missing one."""
        row = self.store.query_one("SELECT * FROM plans WHERE id = ? AND user_id = ?", (plan_id, user_id))
        if not row:
            return None
        return Plan(
            id=row["id"], user_id=row["user_id"], grant_id=row["grant_id"], kind=row["kind"],
            body=json.loads(row["plan_json"]), plan_hash=row["plan_hash"], summary=json.loads(row["summary_json"]),
            fingerprint=json.loads(row["fingerprint_json"]), created_at=row["created_at"], expires_at=row["expires_at"],
        )

    def verify_hash(self, plan: Plan) -> bool:
        return sha256_hex(canonical_json({"kind": plan.kind, "body": plan.body})) == plan.plan_hash

    # ── approvals ────────────────────────────────────────────────────────────

    def approve(self, plan: Plan, user_id: str) -> None:
        if plan.user_id != user_id:
            raise PermissionError("approval by a different user")
        now = time.time()
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO approvals(plan_id, user_id, plan_hash, approved_at, expires_at) "
                "SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM plan_rejections WHERE plan_id = ?) "
                "ON CONFLICT(plan_id) DO UPDATE SET approved_at = excluded.approved_at, expires_at = excluded.expires_at, "
                "plan_hash = excluded.plan_hash WHERE approvals.consumed_at IS NULL",
                (plan.id, user_id, plan.plan_hash, now, now + APPROVAL_TTL, plan.id),
            )

    def reject(self, plan: Plan, user_id: str) -> bool:
        """Record the user's rejection; final for this plan. False once the plan has started."""
        if plan.user_id != user_id:
            raise PermissionError("rejection by a different user")
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT OR IGNORE INTO plan_rejections(plan_id, user_id, rejected_at) "
                "SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM approvals WHERE plan_id = ? AND consumed_at IS NOT NULL)",
                (plan.id, user_id, time.time(), plan.id),
            )
            return self.store.query_one("SELECT 1 FROM plan_rejections WHERE plan_id = ?", (plan.id,)) is not None

    def approval_state(self, plan: Plan) -> str:
        """none | approved | expired | consumed | mismatch | rejected"""
        if self.store.query_one("SELECT 1 FROM plan_rejections WHERE plan_id = ?", (plan.id,)):
            return "rejected"
        row = self.store.query_one("SELECT * FROM approvals WHERE plan_id = ?", (plan.id,))
        if not row:
            return "none"
        if row["user_id"] != plan.user_id or row["plan_hash"] != plan.plan_hash:
            return "mismatch"
        if row["consumed_at"] is not None:
            return "consumed"
        if row["expires_at"] < time.time():
            return "expired"
        return "approved"

    def consume_approval(self, plan: Plan) -> bool:
        with self.store.transaction() as cur:
            cur.execute(
                "UPDATE approvals SET consumed_at = ? WHERE plan_id = ? AND user_id = ? AND plan_hash = ? "
                "AND consumed_at IS NULL AND expires_at >= ? "
                "AND NOT EXISTS (SELECT 1 FROM plan_rejections WHERE plan_id = approvals.plan_id)",
                (time.time(), plan.id, plan.user_id, plan.plan_hash, time.time()),
            )
            return cur.rowcount == 1

    # ── operations ───────────────────────────────────────────────────────────

    def operation(self, plan_id: str) -> dict[str, Any] | None:
        row = self.store.query_one("SELECT * FROM operations WHERE plan_id = ?", (plan_id,))
        if not row:
            return None
        out = dict(row)
        out["result"] = json.loads(row["result_json"])
        return out

    def start_operation(self, plan: Plan) -> None:
        now = time.time()
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT OR IGNORE INTO operations(plan_id, user_id, status, result_json, started_at, updated_at) "
                "VALUES (?, ?, 'running', '{}', ?, ?)",
                (plan.id, plan.user_id, now, now),
            )

    def claim_runner(self, plan_id: str, runner: str, budget: int) -> bool:
        now = time.time()
        with self.store.transaction() as cur:
            cur.execute(
                "UPDATE operations SET runner = ?, runner_until = ?, status = 'running', updated_at = ? "
                "WHERE plan_id = ? AND (runner IS NULL OR runner_until IS NULL OR runner_until < ?)",
                (runner, now + budget + RUNNER_GRACE, now, plan_id, now),
            )
            return cur.rowcount == 1

    def finish_operation(self, plan_id: str, runner: str, status: str, result: dict[str, Any]) -> None:
        with self.store.transaction() as cur:
            cur.execute(
                "UPDATE operations SET status = ?, result_json = ?, runner = NULL, runner_until = NULL, updated_at = ? "
                "WHERE plan_id = ? AND runner = ?",
                (status, canonical_json(result), time.time(), plan_id, runner),
            )

    def active_operations(self, user_id: str) -> int:
        row = self.store.query_one(
            "SELECT COUNT(*) AS n FROM operations WHERE user_id = ? AND runner IS NOT NULL AND runner_until > ?",
            (user_id, time.time()),
        )
        return int(row["n"]) if row else 0

    # ── steps ────────────────────────────────────────────────────────────────

    def step(self, plan_id: str, key: str) -> dict[str, Any] | None:
        row = self.store.query_one("SELECT * FROM operation_steps WHERE plan_id = ? AND step_key = ?", (plan_id, key))
        if not row:
            return None
        out = dict(row)
        out["result"] = json.loads(row["result_json"]) if row["result_json"] else None
        out["error"] = json.loads(row["error_json"]) if row["error_json"] else None
        return out

    def claimed_resource_ids(self, step_key: str, field: str, *, exclude_plan: str) -> set[int]:
        """Ids other plans' finished steps already own (so a reconcile never adopts them)."""
        rows = self.store.query(
            "SELECT result_json FROM operation_steps WHERE step_key = ? AND status = 'done' AND plan_id != ?",
            (step_key, exclude_plan),
        )
        out: set[int] = set()
        for r in rows:
            try:
                value = json.loads(r["result_json"] or "{}").get(field)
                if value is not None:
                    out.add(int(value))
            except (ValueError, TypeError, AttributeError):
                continue
        return out

    def steps(self, plan_id: str) -> list[dict[str, Any]]:
        rows = self.store.query("SELECT step_key, status, sent_at, done_at FROM operation_steps WHERE plan_id = ? ORDER BY sent_at", (plan_id,))
        return [dict(r) for r in rows]

    def mark(self, plan_id: str, key: str, status: str, *, result: Any = None, error: Any = None) -> None:
        now = time.time()
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO operation_steps(plan_id, step_key, status, sent_at, done_at, result_json, error_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_id, step_key) DO UPDATE SET status = excluded.status, "
                "done_at = excluded.done_at, result_json = COALESCE(excluded.result_json, operation_steps.result_json), "
                "error_json = excluded.error_json, sent_at = CASE WHEN excluded.status = 'sent' THEN excluded.sent_at ELSE operation_steps.sent_at END",
                (
                    plan_id, key, status, now, now if status in ("done", "failed") else None,
                    canonical_json(result) if result is not None else None,
                    canonical_json(error) if error is not None else None,
                ),
            )


@dataclass
class Run:
    """One execution pass over a plan's steps."""

    plans: PlanStore
    plan: Plan
    deadline: float
    resources: list[dict[str, Any]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def check_budget(self, key: str) -> None:
        if time.time() > self.deadline:
            raise OperationError("partially_failed", "The operation ran out of time; call execute_plan again to resume.", step=key)

    async def write(
        self,
        key: str,
        run: Callable[[], Awaitable[Any]],
        *,
        reconcile: Callable[[float], Awaitable[Any]] | None = None,
    ) -> Any:
        """Run a write step at most once.

        * done before        → return the stored result (no request)
        * sent, outcome unknown → `reconcile(sent_at)`; adopt what exists, else run
        * AppBI refused      → step failed; OperationError with AppBI's message
        * ambiguous transport failure → step stays `sent`; partially_failed
        """
        self.check_budget(key)
        rec = self.plans.step(self.plan.id, key)
        if rec and rec["status"] == "done":
            return rec["result"]
        if rec and rec["status"] == "sent" and reconcile is not None:
            found = await reconcile(float(rec["sent_at"] or 0) - 5)
            if found is not None:
                self.plans.mark(self.plan.id, key, "done", result=found)
                return found
        self.plans.mark(self.plan.id, key, "sent")
        try:
            result = await run()
        except AmbiguousWrite as exc:
            raise OperationError(
                "partially_failed",
                "AppBI did not confirm this step in time. Call execute_plan again: it checks AppBI before retrying.",
                step=key, detail=str(exc),
            ) from exc
        except AppbiError as exc:
            self.plans.mark(self.plan.id, key, "failed", error=exc.as_dict())
            raise
        except OperationError as exc:
            # A refusal decided inside the step (e.g. a measure dry-run AppBI rejected)
            # is a definite failure, not an unknown outcome: never leave it `sent`.
            if exc.status != "partially_failed":
                self.plans.mark(self.plan.id, key, "failed", error={"status": exc.status, "message": str(exc)})
            raise
        self.plans.mark(self.plan.id, key, "done", result=result)
        return result


def outcome_for_appbi_error(exc: AppbiError) -> str:
    if exc.kind == "conflict":
        return "conflict"
    if exc.kind in ("unavailable", "server", "rate_limited"):
        return "partially_failed"
    return "blocked"
