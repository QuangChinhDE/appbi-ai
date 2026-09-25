"""What a flow needs at MINIMUM to run its mandatory steps — the budget reservation.

`binding.estimate_cost` answers "how much could this cost at worst", for the
person assigning a link. This answers the other question, the one the runtime
needs while a run is in progress: "how much must be left for the steps that have
not run yet, so that they can run at all?" Before each node the executor holds
that much back (`Budget.reserve`), so an earlier step cannot spend it.

MINIMUM, PER NODE
-----------------
    agent        1 model call — its answer round (a step with no tools left is
                 still a step that can say what it found)
    skill        the minimum of the Skill's own pinned flow
    tool, read,
    knowledge,
    web          1 tool call
    if / switch  the most demanding branch: which one runs is not known yet, and
                 the guarantee has to hold for whichever does
    loop         one pass of the body
    coordinate   1 (the planner) + the cheapest lane: at least one lane runs
    anything
    else         every child list, summed — wrong upward, never downward

One definition, read by the executor (reservation) and by the binding preflight
(a link funded below its flow's minimum is refused), so the two cannot disagree
about what "enough" means.
"""
from __future__ import annotations

from typing import Any, Callable

from app.services.agent_flows.contract import (
    MAX_SKILL_DEPTH,
    AgentNode,
    CoordinateNode,
    LoopNode,
    child_node_lists,
)

#: (skill_key, version) → the Skill's Flow, or None when it cannot be resolved.
SkillLookup = Callable[[str, "int | None"], Any]


def node_minimum(node: Any, *, skill_lookup: SkillLookup | None = None,
                 depth: int = 0) -> tuple[int, int]:
    """(model calls, tool calls) this one node needs at minimum."""
    if isinstance(node, AgentNode):
        return 1, 0
    kind = getattr(node, "type", "")
    if kind == "skill":
        flow = None
        if skill_lookup is not None and depth < MAX_SKILL_DEPTH:
            try:
                flow = skill_lookup(str(getattr(node, "skill_key", "")), getattr(node, "version", None))
            except Exception:                                   # noqa: BLE001
                flow = None
        if flow is None:
            # Unresolvable: it will be refused at invocation, which costs nothing.
            return 0, 0
        return minimum_calls(list(flow.nodes), skill_lookup=skill_lookup, depth=depth + 1)
    if kind in ("tool", "report_read", "knowledge", "web"):
        return 0, 1
    groups = [minimum_calls(list(g), skill_lookup=skill_lookup, depth=depth)
              for g in child_node_lists(node)]
    if not groups:
        return 0, 0
    if kind in ("if", "switch"):
        return max(g[0] for g in groups), max(g[1] for g in groups)
    if isinstance(node, LoopNode):
        return sum(g[0] for g in groups), sum(g[1] for g in groups)
    if isinstance(node, CoordinateNode) or kind == "coordinate":
        cheapest = min(groups, key=lambda g: (g[0], g[1]))
        return 1 + cheapest[0], cheapest[1]
    return sum(g[0] for g in groups), sum(g[1] for g in groups)


def minimum_calls(nodes: list[Any], *, skill_lookup: SkillLookup | None = None,
                  depth: int = 0) -> tuple[int, int]:
    """(model calls, tool calls) a sequence of nodes needs at minimum."""
    llm = tools = 0
    for n in nodes:
        a, b = node_minimum(n, skill_lookup=skill_lookup, depth=depth)
        llm += a
        tools += b
    return llm, tools


def working_minimum(nodes: list[Any], *, skill_lookup: SkillLookup | None = None) -> tuple[int, int]:
    """(model calls, tool calls) a Skill needs to do ANY of its tool work.

    A DIFFERENT QUESTION from `minimum_calls`. The reservation asks "can every
    mandatory step still END" — an Agent step that can only speak still ends, so it
    counts 1. Invoking a Skill from an Agent asks "can the Skill do what it is for":
    a Skill whose steps call tools and is handed only its answer round runs no tool,
    answers from nothing and records `ok` — measured live on a 6-call link, where a
    comparison Skill handed back "bạn có thể sử dụng compare_periods…" instead of a
    comparison. So: the reservation minimum, plus one round in which a tool can be
    called when any Agent step in the Skill has tools (and one tool call for it).
    """
    llm, tools = minimum_calls(nodes, skill_lookup=skill_lookup)

    def uses_tools(ns: list[Any]) -> bool:
        return any((isinstance(n, AgentNode) and bool(n.tools))
                   or any(uses_tools(list(g)) for g in child_node_lists(n)) for n in ns)

    if uses_tools(nodes):
        return llm + 1, max(tools, 1)
    return llm, tools


def skill_lookup_for(db: Any, *, include_disabled: bool = False) -> SkillLookup | None:
    """Resolve a Skill reference to its pinned Flow, through the ONE resolver."""
    if db is None:
        return None
    from app.services.agent_flows import skills

    cache: dict[tuple, Any] = {}

    def lookup(key: str, version: int | None) -> Any:
        ident = (key, version)
        if ident not in cache:
            found = skills.resolve_skill(db, key, version)
            # A disabled version is refused at invocation, which costs nothing:
            # reserving for it would starve the steps that will actually run.
            usable = found and (include_disabled or skills.lifecycle_of(found[0]) != skills.DISABLED)
            cache[ident] = found[1] if usable else None
        return cache[ident]

    return lookup
