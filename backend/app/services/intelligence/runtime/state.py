"""Run state and the patch protocol.

State is the source of truth for one turn. Nodes never write it directly: they
return a ``StatePatch``, the engine validates the patch against what that node
is allowed to touch, and only then applies it.

That indirection is what makes a user-built flow safe. Once authors can compose
their own graphs, "which node may write which field" stops being a code review
question and becomes a runtime check.

Scope fields are dashboard/link/session — AppBI is single-tenant, and the real
isolation boundary is the shared link. They are set once when the run starts and
are NEVER patchable: a node that could rewrite `dashboard_id` could read another
report's data.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

# Never writable by any node, at any time.
FROZEN_FIELDS = frozenset({
    "run_id", "flow_key", "flow_version", "assistant_key",
    "dashboard_id", "link_token", "session_key",
    "actor_type", "actor_ref", "deadline_at",
})

# Accumulators the engine maintains itself.
ENGINE_FIELDS = frozenset({
    "model_calls", "tool_calls", "usd", "current_node",
    "completed_nodes", "errors", "status",
})


@dataclass
class StatePatch:
    """What a node wants to change. ``set`` replaces, ``append`` extends a list."""

    set: dict[str, Any] = field(default_factory=dict)
    append: dict[str, list] = field(default_factory=dict)

    def touched_fields(self) -> set[str]:
        return set(self.set) | set(self.append)

    def is_empty(self) -> bool:
        return not self.set and not self.append


class PatchRejected(Exception):
    def __init__(self, field_name: str, reason: str):
        self.field_name = field_name
        self.reason = reason
        super().__init__(f"patch rejected on '{field_name}': {reason}")


@dataclass
class RunState:
    run_id: str
    flow_key: str
    flow_version: int

    dashboard_id: int
    link_token: str | None = None
    session_key: str | None = None
    assistant_key: str | None = None
    actor_type: str = "public_session"
    actor_ref: str | None = None

    question: str = ""
    normalized_question: str = ""
    intent: str | None = None

    plan: dict | None = None
    evidence_ids: list[int] = field(default_factory=list)
    findings: list[dict] = field(default_factory=list)
    recommendations: list[dict] = field(default_factory=list)
    verification: dict | None = None
    answer: str = ""
    context_block: str = ""

    current_node: str = ""
    completed_nodes: list[str] = field(default_factory=list)
    node_visits: dict[str, int] = field(default_factory=dict)
    errors: list[dict] = field(default_factory=list)

    model_calls: int = 0
    tool_calls: int = 0
    usd: float = 0.0
    deadline_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc) + timedelta(seconds=120)
    )
    status: str = "running"

    def seconds_left(self) -> float:
        return (self.deadline_at - datetime.now(timezone.utc)).total_seconds()

    def apply(self, patch: StatePatch, *, allowed_fields: set[str] | None) -> None:
        """Apply a validated patch. Raises PatchRejected on the first violation.

        ``allowed_fields=None`` means "engine-internal call" and skips the
        allowlist; frozen fields are refused either way.
        """
        for name in patch.touched_fields():
            if name in FROZEN_FIELDS:
                raise PatchRejected(name, "trường thuộc phạm vi run, không được ghi")
            if not hasattr(self, name):
                raise PatchRejected(name, "trường không tồn tại trong state")
            if allowed_fields is not None and name not in allowed_fields:
                raise PatchRejected(name, "node không được khai quyền ghi trường này")

        for name, value in patch.set.items():
            setattr(self, name, value)
        for name, values in patch.append.items():
            current = getattr(self, name)
            if not isinstance(current, list):
                raise PatchRejected(name, "chỉ append được vào trường dạng danh sách")
            current.extend(values)

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "flow_key": self.flow_key,
            "flow_version": self.flow_version,
            "dashboard_id": self.dashboard_id,
            "intent": self.intent,
            "current_node": self.current_node,
            "completed_nodes": list(self.completed_nodes),
            "model_calls": self.model_calls,
            "tool_calls": self.tool_calls,
            "usd": round(self.usd, 6),
            "status": self.status,
            "errors": list(self.errors),
        }
