"""The flow engine — deterministic outside, agentic inside each node.

One loop, one rule set, applied identically to a built-in flow and to anything a
customer builds later. The invariants it enforces are the reason a non-engineer
can be handed a graph builder at all:

  * **budgets are checked before each node**, and exceeding one jumps to the
    composing step rather than raising — the viewer always gets an answer, even
    if a shorter one (``ForceCompose``);
  * **a node writes state only through a validated patch** (see state.py);
  * **a loop is bounded per node**, so a cyclic graph cannot spin;
  * **a broken flow falls back** to the built-in legacy flow instead of taking
    the chat down.

Nothing here knows how to fetch a chart or call a model. Node implementations
live in ``runtime/nodes/`` and reach the data plane only through the tool
catalog, which is what keeps the boundary honest as the surface grows.
"""
from __future__ import annotations

import logging
import time
from typing import AsyncGenerator, Awaitable, Callable

from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.intelligence.runtime.state import PatchRejected, RunState, StatePatch
from app.services.intelligence.schemas.flow import FlowGraph, FlowNode

logger = logging.getLogger(__name__)

# A node handler streams events and finally returns a patch. Signature:
#   handler(node_key, node, state, ctx) -> AsyncGenerator[AgentEvent | StatePatch]
# Yielding a StatePatch signals completion; anything else is forwarded to the
# client. Keeping both on one channel avoids a second callback protocol.
NodeHandler = Callable[..., AsyncGenerator[object, None]]


class FlowAborted(Exception):
    """Unrecoverable: the caller should fall back to the built-in flow."""


def _limit_breach(state: RunState, graph: FlowGraph) -> str | None:
    lim = graph.limits.clamped()
    if state.model_calls >= lim.max_model_calls:
        return "max_model_calls"
    if state.tool_calls >= lim.max_tool_calls:
        return "max_tool_calls"
    if state.usd >= lim.max_usd:
        return "max_usd"
    if state.seconds_left() <= 0:
        return "deadline"
    return None


def _find_compose_node(graph: FlowGraph) -> str | None:
    """Where ForceCompose jumps to.

    Preference order: an explicitly named compose node, then any node whose
    handler/agent mentions compose, then the last agent node. If a flow really
    has nowhere to compose, the engine ends the run and the caller emits what it
    has — still an answer, never a blank screen.
    """
    for key in ("compose", "composer", "answer"):
        if key in graph.nodes:
            return key
    for key, node in graph.nodes.items():
        hint = f"{node.agent or ''}{node.handler or ''}".lower()
        if "compose" in hint:
            return key
    for key, node in reversed(list(graph.nodes.items())):
        if node.type in ("agent", "legacy"):
            return key
    return None


def _next_node(node: FlowNode, patch_route: str | None) -> str | None:
    """Resolve the successor, given an optional route key from the node."""
    if patch_route:
        if patch_route in node.routes:
            return node.routes[patch_route]
        if patch_route == "success" and node.on_success:
            return node.on_success
        if patch_route == "failure" and node.on_failure:
            return node.on_failure
        if "*" in node.routes:
            return node.routes["*"]
    return node.next or node.on_success


async def run_flow(
    *,
    graph: FlowGraph,
    state: RunState,
    handlers: dict[str, NodeHandler],
    ctx: object,
    on_node_complete: Callable[[str, FlowNode, RunState, float], Awaitable[None]] | None = None,
) -> AsyncGenerator[AgentEvent, None]:
    """Execute one turn. Yields AgentEvents; mutates ``state`` in place."""
    lim = graph.limits.clamped()
    current: str | None = graph.entrypoint
    forced = False

    if current not in graph.nodes:
        raise FlowAborted(f"entrypoint '{current}' missing")

    while current:
        node = graph.nodes.get(current)
        if node is None:
            state.errors.append({"node": current, "code": "MISSING_NODE"})
            logger.error("[flow] missing node '%s' in %s", current, state.flow_key)
            break

        if node.type == "end":
            break

        # A disabled node is a no-op the author left in place while iterating —
        # skip its body but keep following its wiring, so the graph they see is
        # still the graph that runs.
        if node.disabled:
            yield AgentEvent(
                type="node_completed",
                extra={"node": current, "node_type": node.type, "ok": True,
                       "skipped": True, "latency_ms": 0},
            )
            state.completed_nodes.append(current)
            current = _next_node(node, None)
            continue

        # ── Loop guard ──────────────────────────────────────────────────────
        visits = state.node_visits.get(current, 0)
        if visits > lim.max_loops_per_node:
            logger.warning(
                "[flow] loop guard tripped node=%s visits=%d flow=%s",
                current, visits, state.flow_key,
            )
            state.errors.append({"node": current, "code": "LOOP_GUARD"})
            current, forced = _force_compose(graph, state, forced)
            continue
        state.node_visits[current] = visits + 1

        # ── Budget ──────────────────────────────────────────────────────────
        # Skipped once forced: the compose step must be allowed to run even
        # though the budget is precisely what sent us here.
        if not forced:
            breach = _limit_breach(state, graph)
            if breach:
                logger.info(
                    "[flow] limit '%s' reached at node=%s flow=%s — force compose",
                    breach, current, state.flow_key,
                )
                state.errors.append({"node": current, "code": f"LIMIT_{breach.upper()}"})
                current, forced = _force_compose(graph, state, forced)
                continue

        handler = handlers.get(node.type)
        if handler is None:
            state.errors.append({"node": current, "code": "NO_HANDLER"})
            logger.error("[flow] no handler for node type '%s'", node.type)
            current, forced = _force_compose(graph, state, forced)
            continue

        state.current_node = current
        yield AgentEvent(
            type="node_started", extra={"node": current, "node_type": node.type},
        )

        started = time.monotonic()
        patch: StatePatch | None = None
        route_key: str | None = None
        node_failed = False

        try:
            async for item in handler(current, node, state, ctx):
                if isinstance(item, StatePatch):
                    patch = item
                elif isinstance(item, tuple) and len(item) == 2:
                    patch, route_key = item
                elif isinstance(item, AgentEvent):
                    yield item
        except Exception as exc:  # noqa: BLE001
            node_failed = True
            logger.exception("[flow] node '%s' raised", current)
            state.errors.append(
                {"node": current, "code": "NODE_ERROR", "detail": type(exc).__name__}
            )

        # ── Apply the patch ─────────────────────────────────────────────────
        if patch is not None and not patch.is_empty():
            allowed = set(node.config.get("writable_state_fields") or []) or None
            try:
                state.apply(patch, allowed_fields=allowed)
            except PatchRejected as exc:
                # Refusing the write is right; carrying on as if the node had
                # succeeded is not — a downstream node would read stale state
                # and answer from it. Compose with what we already trust.
                logger.warning("[flow] %s (node=%s)", exc, current)
                state.errors.append(
                    {"node": current, "code": "PATCH_REJECTED", "detail": exc.field_name}
                )
                node_failed = True

        elapsed_ms = (time.monotonic() - started) * 1000
        state.completed_nodes.append(current)
        yield AgentEvent(
            type="node_completed",
            extra={
                "node": current,
                "node_type": node.type,
                "ok": not node_failed,
                "latency_ms": int(elapsed_ms),
            },
        )
        if on_node_complete is not None:
            try:
                await on_node_complete(current, node, state, elapsed_ms)
            except Exception:  # noqa: BLE001
                logger.debug("[flow] node-complete hook failed", exc_info=True)

        if node_failed:
            if node.on_failure:
                current = node.on_failure
                continue
            current, forced = _force_compose(graph, state, forced)
            continue

        if forced:
            # The compose step we jumped to has now run; stop.
            break

        current = _next_node(node, route_key)

    state.status = "completed"


def _force_compose(graph: FlowGraph, state: RunState, already_forced: bool):
    """Abandon the remaining graph and go straight to composing an answer.

    If we are ALREADY in the forced compose step, stop — otherwise a compose
    node that itself fails would loop forever.
    """
    if already_forced:
        return None, True
    target = _find_compose_node(graph)
    if target is None or target in state.completed_nodes:
        return None, True
    return target, True
