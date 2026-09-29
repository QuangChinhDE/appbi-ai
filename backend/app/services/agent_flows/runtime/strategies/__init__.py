"""How an Agent step reasons. Selected per node by `AgentNode.strategy`.

A strategy decides; `AgentRuntime` executes and governs. Adding a strategy is
adding a class here — not a node type, and not a copy of the runtime's rules.
"""
from __future__ import annotations

from typing import Any

from app.services.agent_flows.runtime.strategies.tool_calling import ToolCallingStrategy

#: Every strategy a node may name. The contract's `AgentStrategyName` literal is
#: checked against these keys by `test_strategy_is_pure.py`.
STRATEGIES: dict[str, type] = {
    ToolCallingStrategy.name: ToolCallingStrategy,
}

DEFAULT_STRATEGY = ToolCallingStrategy.name


def strategy_for(node: Any, state: Any, rctx: Any, *, max_rounds: int) -> Any:
    name = getattr(node, "strategy", None) or DEFAULT_STRATEGY
    cls = STRATEGIES.get(name)
    if cls is None:
        # Unreachable through the contract (the field is a Literal); guarded so a
        # body written by hand fails loudly rather than reasoning some other way.
        raise RuntimeError(f"chiến lược suy luận không tồn tại: {name}")
    return cls(node, state, rctx, max_rounds=max_rounds)
