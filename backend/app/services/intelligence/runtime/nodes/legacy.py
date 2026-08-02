"""The `legacy` node — runs the pre-v2 agent unchanged, inside the flow.

This is the migration bridge, and it is the single most important node in GĐ2.
Wrapping the existing Normal/Thinking agent means 100% of traffic can move onto
the new runtime while the ANSWERS stay byte-identical: same prompts, same tools,
same streaming events. Trace, evidence, budgets and node timing come along for
free, and if anything regresses the fix is one feature flag, not a revert.

Everything the agent emits is forwarded verbatim — `reading_plan`, `plan_step`,
`sources`, `state`, `cost`. The FE is not asked to change for this step.
"""
from __future__ import annotations

import logging
from typing import AsyncGenerator

from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.intelligence.runtime.state import RunState, StatePatch
from app.services.intelligence.schemas.flow import FlowNode

logger = logging.getLogger(__name__)


async def legacy_node(
    node_key: str, node: FlowNode, state: RunState, ctx
) -> AsyncGenerator[object, None]:
    """Delegate the whole turn to the pre-v2 agent.

    ``ctx`` is a LegacyNodeContext carrying everything the old entry point
    needs; the flow layer does not reinterpret any of it.
    """
    kwargs = dict(ctx.agent_kwargs)
    # The caller's kwargs already carry the depth the endpoint resolved. The
    # node's own `config.mode` only OVERRIDES it when a flow author set one —
    # popping first is what keeps `run_agent_stream(mode=..., **kwargs)` from
    # being handed `mode` twice.
    caller_mode = kwargs.pop("mode", None)
    # Precedence: the CALLER's resolved depth wins. It came from the viewer's
    # Normal/Thinking toggle or the link's admin default, and silently ignoring
    # it would be a behaviour change — precisely what this bridge exists to
    # avoid. A flow author can still pin a depth explicitly; "auto" in the node
    # config is a documented default, not a pin.
    pinned = node.config.get("mode")
    is_pin = bool(pinned) and pinned != "auto"
    mode = pinned if is_pin else (caller_mode or "auto")
    kwargs["run_ref"] = state.run_id

    answer_parts: list[str] = []
    usd = 0.0
    tool_calls = 0

    from app.services.dashboard_ai_bot import run_agent_stream

    async for ev in run_agent_stream(mode=mode, **kwargs):
        if ev.type == "text" and ev.text:
            answer_parts.append(ev.text)
        elif ev.type == "cost":
            cost = (ev.extra or {}).get("cost") or {}
            try:
                usd = float(cost.get("usd") or usd)
            except (TypeError, ValueError):
                pass
        elif ev.type == "tool_result":
            tool_calls += 1
        elif ev.type == "done":
            # The flow owns termination; swallowing `done` keeps the engine in
            # charge of when the stream really ends.
            continue
        yield ev

    yield StatePatch(
        set={
            "answer": "".join(answer_parts),
            "usd": state.usd + usd,
            "tool_calls": state.tool_calls + tool_calls,
            "model_calls": state.model_calls + 1,
        }
    )


class LegacyNodeContext:
    """Carrier for the pre-v2 agent's arguments.

    A tiny class rather than a bare dict so that when the Fast Lane nodes start
    needing the same ToolContext, there is one obvious place to widen.
    """

    def __init__(self, agent_kwargs: dict):
        self.agent_kwargs = agent_kwargs
