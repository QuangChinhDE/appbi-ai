"""Variables, reshaping, early exit, waiting. The cheap nodes.

Every one of these is deterministic and costs nothing. Together they are what turns
a chain of prompts into a program: somewhere to put a value, a way to reshape it,
and a way to stop.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncGenerator

from app.services.agent_flows.contract import (
    DelayNode,
    SetVarNode,
    StopNode,
    TransformNode,
)
from app.services.agent_flows.runtime.nodes import NodeSpec
from app.services.agent_flows.runtime.state import RunState
from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)


async def run_set_var(
    node: SetVarNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    value = state.resolve(node.value)
    state.set_var(node.var, _coerce(value, node.value_type))
    state.outputs[node.key] = state.vars[node.var]
    if node.run_policy != "every_turn":
        state.memory_set[node.var] = state.vars[node.var]
    return
    yield  # pragma: no cover — makes this an async generator


def _coerce(value: Any, kind: str) -> Any:
    """Best-effort typing.

    Refuses to raise: a Set Variable that fails mid-answer because a model returned
    "8.4B" where a number was declared is worse than a value that stays text. The
    declared type is a hint to downstream nodes, not a gate.
    """
    if kind == "number":
        try:
            return float(str(value).replace(",", "").strip())
        except (TypeError, ValueError):
            return value
    if kind == "bool":
        return str(value).strip().lower() in {"1", "true", "yes", "có", "co"}
    if kind == "list":
        from app.services.agent_flows.runtime.state import as_list

        return as_list(value, limit=1000)
    if kind == "object":
        if isinstance(value, dict):
            return value
        try:
            parsed = json.loads(str(value))
            return parsed if isinstance(parsed, dict) else {"value": value}
        except Exception:  # noqa: BLE001
            return {"value": value}
    return value if isinstance(value, str) else value


async def run_transform(
    node: TransformNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    """A FIXED set of operations, not code.

    Free-form expressions here would need a sandbox, a review story and an answer to
    "what can a flow do" — for five operations the builder already renders as a
    dropdown.
    """
    source = state.resolve(node.source) if node.source else state.vars.get("previous")
    target = (node.target or node.output_var or "").replace("[]", "").strip()
    result: Any

    if node.operation == "append_to_list":
        current = state.vars.get(target)
        items = list(current) if isinstance(current, list) else ([] if current is None else [current])
        items.append(source)
        result = items
    elif node.operation == "map_fields":
        result = {k: state.resolve(v) for k, v in node.mapping.items()}
    elif node.operation == "format_object":
        result = state.resolve_text(node.source or "")
    elif node.operation == "join_text":
        from app.services.agent_flows.runtime.state import as_list, render_value

        parts = as_list(source, limit=1000)
        # Third of the three copies. See `render_value` for what they disagreed on.
        result = node.separator.join(render_value(x) for x in parts)
    elif node.operation == "pick":
        keys = list(node.mapping.keys())
        if isinstance(source, list):
            result = [
                {k: row.get(k) for k in keys} for row in source if isinstance(row, dict)
            ]
        elif isinstance(source, dict):
            result = {k: source.get(k) for k in keys}
        else:
            result = source
    else:  # unreachable — the contract's Literal bounds this
        result = source

    if target:
        state.set_var(target, result)
        if node.run_policy != "every_turn":
            state.memory_set[target] = result
    state.outputs[node.key] = result
    return
    yield  # pragma: no cover


async def run_stop(
    node: StopNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    """End the run.

    `emit` is what makes this useful inside a branch: a path that already knows the
    answer does not have to fall through the rest of the flow to deliver it. Without
    it, the run ends and the designated answering node — which never ran — has
    nothing, and the viewer gets the "no answer" fallback.
    """
    state.stopped = True
    message = state.resolve_text(node.message or "")
    if node.emit and message:
        state.stop_message = message
    state.outputs[node.key] = {"stopped": True, "message": message}
    if message:
        yield AgentEvent(type="status", text="Kết thúc sớm theo thiết kế của flow.")


async def run_delay(
    node: DelayNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    """Wait, inside the turn, bounded at 30s by the contract.

    A longer wait cannot work on this path: the answer streams over one response to
    a viewer who is watching, and after five minutes there is nowhere left to deliver
    it. Waiting properly needs a background execution mode, which is a product
    decision and not a node.
    """
    seconds = max(0.0, min(float(node.seconds), 30.0))
    # Never outstay the run's own clock — a delay that eats the whole budget leaves
    # nothing for the node that writes the answer.
    remaining = state.budget.max_seconds - state.budget.elapsed() - 2
    seconds = max(0.0, min(seconds, remaining))
    if seconds > 0:
        yield AgentEvent(type="status", text=f"Chờ {seconds:.0f} giây…")
        await asyncio.sleep(seconds)
    state.outputs[node.key] = {"waited_seconds": seconds}


SPECS = [
    NodeSpec(
        type="set_var",
        label_vi="Set Variable",
        label_en="Set Variable",
        description_vi="Tạo hoặc cập nhật một biến trung gian.",
        category="utility",
        icon="=",
        handler=run_set_var,
    ),
    NodeSpec(
        type="transform",
        label_vi="Transform",
        label_en="Transform",
        description_vi="Gom, map, ghép hoặc rút gọn dữ liệu giữa các bước.",
        category="utility",
        icon="◫",
        handler=run_transform,
    ),
    NodeSpec(
        type="stop",
        label_vi="Stop / Return",
        label_en="Stop / Return",
        description_vi="Kết thúc sớm và trả về câu trả lời của nhánh này.",
        category="flow",
        icon="■",
        handler=run_stop,
    ),
    NodeSpec(
        type="delay",
        label_vi="Delay / Wait",
        label_en="Delay / Wait",
        description_vi="Chờ trong lượt trả lời. Tối đa 30 giây.",
        category="flow",
        icon="◷",
        handler=run_delay,
    ),
]
