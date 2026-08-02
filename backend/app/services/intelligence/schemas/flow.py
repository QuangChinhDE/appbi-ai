"""Flow graph schema — a flow is DATA, never Python.

This is the single most consequential decision in the redesign, and it is made
here rather than later: the runtime loads its graph from JSON in the database
from day one, even while the only flows that exist are the built-ins we seed.
Hard-coding the graph first and adding a builder afterwards would mean throwing
the runtime away and writing it again.

Node vocabulary (see docs/Intelligence/appbi_intelligence_flow_map.md §5):

    guard      deterministic input screening      no LLM   system-owned
    route      intent → branch                    no LLM*  system-owned
    context    assemble the knowledge bundle      no LLM
    agent      one LLM turn with a tool allowlist  LLM
    tool       one deterministic tool call        no LLM
    function   a handler from the code registry   no LLM
    condition  branch on a state expression       no LLM
    legacy     run the pre-v2 agent wholesale     LLM      migration bridge
    end        terminal                           —

    * `route` may escalate to a cheap classifier when the regex score lands in
      the ambiguous band; that is a config flag, not a separate node.

The reason `function` handlers are chosen from a registry and never written by
the author is the whole safety story of the future Flow Studio: the builder
composes, it does not execute arbitrary code.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

NodeType = Literal[
    "guard", "route", "context", "agent", "tool",
    "function", "condition", "verify", "parallel", "clarify",
    "legacy", "end",
]

# Node types whose output can contain figures a viewer reads as fact.
FIGURE_PRODUCING: frozenset[str] = frozenset({"agent", "legacy"})
# Node types that satisfy the verifier obligation.
VERIFYING: frozenset[str] = frozenset({"verify"})
# System nodes an author may never delete — they carry the guarantees the
# runtime is built on (injection screening, and a terminal state).
MANDATORY: frozenset[str] = frozenset({"guard", "end"})

# System ceilings. A flow's own limits are CLAMPED to these, so an author (or a
# corrupted row) can never grant itself a bigger budget than the deployment allows.
MAX_MODEL_CALLS_CEILING = 12
MAX_TOOL_CALLS_CEILING = 20
MAX_DEADLINE_SECONDS_CEILING = 240
MAX_USD_CEILING = 1.0


class FlowLimits(BaseModel):
    """Per-run budget. Exceeding any of these does not error — it jumps to the
    composing step with whatever has been gathered, so the viewer always gets
    an answer (see runtime.engine.ForceCompose)."""

    max_model_calls: int = Field(default=6, ge=1)
    max_tool_calls: int = Field(default=10, ge=0)
    deadline_seconds: int = Field(default=120, ge=5)
    max_usd: float = Field(default=0.10, gt=0)
    max_loops_per_node: int = Field(default=1, ge=0)

    def clamped(self) -> "FlowLimits":
        return FlowLimits(
            max_model_calls=min(self.max_model_calls, MAX_MODEL_CALLS_CEILING),
            max_tool_calls=min(self.max_tool_calls, MAX_TOOL_CALLS_CEILING),
            deadline_seconds=min(self.deadline_seconds, MAX_DEADLINE_SECONDS_CEILING),
            max_usd=min(self.max_usd, MAX_USD_CEILING),
            max_loops_per_node=self.max_loops_per_node,
        )


class NodePosition(BaseModel):
    """Canvas coordinates.

    Persisted with the graph on purpose: an author who arranges a flow to read
    left-to-right must find it that way tomorrow. Re-deriving layout on every
    load would silently rearrange their work, and the runtime ignores these
    fields entirely — they are presentation, stored next to what they present.
    """
    x: float = 0
    y: float = 0


class FlowNode(BaseModel):
    type: NodeType
    # Human-facing label. The runtime keys on the node's dict key; this is what
    # a person reads on the canvas, so "Chuyên viên phân tích" can sit on a node
    # whose key is `analyze` without either leaking into the other.
    display_name: str | None = None
    description: str | None = None
    position: NodePosition | None = None
    disabled: bool = False

    # Linear successor. Mutually usable with `routes` (a router node uses both:
    # `routes` for known branches, `next` as the fallback).
    next: str | None = None
    routes: dict[str, str] = Field(default_factory=dict)
    on_success: str | None = None
    on_failure: str | None = None
    # type="parallel" → branch entrypoints, merged by `reducer`
    branches: list[str] = Field(default_factory=list)
    reducer: str | None = None

    # type="agent"  → "data_analyst@3"
    agent: str | None = None
    # type="agent"  → tool allowlist for THIS node (subset of the agent's own)
    tools: list[str] = Field(default_factory=list)
    # type="tool"   → tool name + static/bound args
    tool: str | None = None
    args: dict[str, Any] = Field(default_factory=dict)
    # type="function" → handler key from the function registry
    handler: str | None = None
    # type="condition" → restricted expression over state
    when: str | None = None
    # free-form per-type settings (context sources, route options, …)
    config: dict[str, Any] = Field(default_factory=dict)

    def successors(self) -> list[str]:
        out = [
            self.next, self.on_success, self.on_failure,
            *self.routes.values(), *self.branches,
        ]
        return [s for s in out if s]


class FlowGraph(BaseModel):
    entrypoint: str
    nodes: dict[str, FlowNode]
    limits: FlowLimits = Field(default_factory=FlowLimits)
    requires_tools: bool = True
    # Free-form canvas viewport (zoom/pan) so a flow reopens where it was left.
    viewport: dict[str, float] = Field(default_factory=dict)

    @field_validator("nodes")
    @classmethod
    def _non_empty(cls, v: dict[str, FlowNode]) -> dict[str, FlowNode]:
        if not v:
            raise ValueError("flow must declare at least one node")
        return v

    def node(self, key: str) -> FlowNode | None:
        return self.nodes.get(key)
