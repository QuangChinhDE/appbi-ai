# -*- coding: utf-8 -*-
"""Strategy decides; Runtime executes and governs.

The Agent step used to be one 480-line function that owned the provider call,
the budget, the retry policy, evidence, scope AND the reasoning loop. A second
way of reasoning would have meant a second copy of every rule — which is how a
budget or a scope check gets forgotten. The split (V3 phase 2) is only real if
it is enforced, so this file pins the seam mechanically:

  * no strategy module imports a provider adapter or the tool registry;
  * the only strategies a node may name are the ones registered;
  * the Agent handler no longer calls the registry or a provider itself — it
    composes `AgentRuntime` with a strategy;
  * the default strategy is the behaviour every Agent step has always had
    (the canonical replay fixtures are the behavioural proof of that).
"""
from __future__ import annotations

import ast
import inspect
import os
import pathlib
import typing

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_strategy.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.agent_flows import contract
from app.services.agent_flows.runtime import strategies
from app.services.agent_flows.runtime.handlers import agent as agent_handler

STRATEGY_DIR = pathlib.Path(strategies.__file__).parent

FORBIDDEN_MODULES = (
    "app.services.dashboard_ai_bot.providers",
    "app.services.agent_flows.tools.registry",
    "app.services.agent_flows.tools",
)


def _imports(path: pathlib.Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
            found |= {f"{node.module}.{a.name}" for a in node.names}
    return found


@pytest.mark.parametrize("path", sorted(STRATEGY_DIR.glob("*.py")), ids=lambda p: p.name)
def test_a_strategy_imports_no_provider_and_no_tool_registry(path):
    bad = sorted(i for i in _imports(path) if i.startswith(FORBIDDEN_MODULES))
    assert bad == [], (
        f"{path.name} imports {bad}. A strategy asks `AgentRuntime` to call the "
        "model or run a capability; importing either directly is how a second "
        "copy of the budget, retry or scope rules starts."
    )


@pytest.mark.parametrize("path", sorted(STRATEGY_DIR.glob("*.py")), ids=lambda p: p.name)
def test_a_strategy_never_names_the_registry_or_a_stream_function(path):
    src = path.read_text(encoding="utf-8")
    code = "\n".join(l for l in src.splitlines() if not l.strip().startswith("#"))
    for word in ("tool_registry", "registry.execute", "stream_openai",
                 "stream_anthropic", "_stream(", "spend_tool", "spend_llm"):
        assert word not in code, f"{path.name} reaches for `{word}` — that is the runtime's"


def test_the_names_a_node_may_choose_are_exactly_the_registered_strategies():
    declared = set(typing.get_args(contract.AgentStrategyName))
    assert declared == set(strategies.STRATEGIES)


def test_the_default_strategy_is_what_agent_steps_have_always_done():
    node = contract.AgentNode(key="a", prompt="x")
    assert node.strategy == strategies.DEFAULT_STRATEGY == "tool_calling"


def test_the_agent_handler_composes_runtime_and_strategy_and_calls_neither_directly():
    src = inspect.getsource(agent_handler.run)
    code = "\n".join(l for l in src.splitlines() if not l.strip().startswith("#"))
    assert "AgentRuntime(" in code and "strategy_for(" in code
    assert "tool_registry.execute" not in code
    assert "spend_tool" not in code and "spend_llm" not in code


def test_an_unknown_strategy_fails_loudly_rather_than_reasoning_some_other_way():
    class _Node:
        strategy = "planner_that_does_not_exist"

    with pytest.raises(RuntimeError, match="không tồn tại"):
        strategies.strategy_for(_Node(), None, None, max_rounds=1)
