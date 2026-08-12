"""Where a pack gets its implementation and its schema — for now.

THIS FILE IS A SEAM, AND IT IS MEANT TO DISAPPEAR.

The tool bodies and their JSON schemas currently live under
`app/services/dashboard_ai_bot/`. That package is being deleted: its
first-generation brain — hardcoded prompts, briefing, recon, self-critique,
verification — is exactly what Agent Flows replaces. But the tool BODIES are not a
way of thinking. They are the data path: merging the dashboard's public filters
into a query, resolving the semantic layer, choosing snapshot or live, coercing
column types. That path is where dozens of hard-won corrections live, and
rewriting it from a clean sheet means finding those failures again in production.

So the packs declare WHAT a tool is here and now — its name, label, cost, what it
returns, whether it leaves AppBI — while the body is still imported from the old
location. When the files are physically relocated, one import block in this module
changes and no pack changes at all.

Schemas are LOOKED UP rather than transcribed. Copying twenty-four JSON schemas
into pack files would create a second definition of every tool's arguments, and a
second definition is the thing this whole registry exists to remove.

`local` is the other constructor here: a tool whose body lives in this package
because it was written against the contract rather than adapted to it. New tools
use it, and every tool will once the seam closes.
"""
from __future__ import annotations

from typing import Any

from app.services.agent_flows.tools.registry import (
    CostClass, PayloadSize, ToolFn, ToolSpec,
)
from app.services.agent_flows.tools.result import ResultKind


def _sources() -> tuple[dict[str, Any], dict[str, dict]]:
    """The live implementation map and the merged schema map, keyed by tool name."""
    from app.services.dashboard_ai_bot.thinking import tools as legacy

    # advanced_tools registers itself late to avoid a circular import; without this
    # the map is missing thirteen of the twenty-six.
    legacy._register_advanced_tools()

    defs: dict[str, dict] = {}
    for lst in (legacy.TOOL_DEFINITIONS, legacy.EXTERNAL_TOOL_DEFS):
        for d in lst:
            name = d.get("name") or (d.get("function") or {}).get("name")
            if name:
                defs[name] = d
    return dict(legacy.TOOLS), defs


def spec(
    name: str,
    *,
    label_vi: str,
    label_en: str,
    description_vi: str,
    result_kind: ResultKind,
    returns: dict[str, str],
    cost_class: CostClass = "cheap",
    payload: PayloadSize = "small",
    reaches_outside: bool = False,
    deterministic: bool = True,
    cacheable: bool | None = None,
    self_sufficient: bool = False,
    answers_vi: tuple[str, ...] = (),
) -> ToolSpec:
    """Declare a tool whose body still lives in the old package.

    Fails loudly if the tool or its schema is missing — on purpose. A pack naming
    a tool that no longer exists would otherwise register a picker entry the model
    can never call: the same silent gap as a node type with no runtime handler.

    `result_kind` and `returns` are REQUIRED. They are the half of the contract
    that lets a flow node use a result without a model reading it for them, and
    making them optional would mean the tools nobody got around to describing are
    exactly the ones no node can use.
    """
    fns, defs = _sources()
    fn = fns.get(name)
    if fn is None:
        raise LookupError(f"tool '{name}' is declared in a pack but not implemented")
    definition = defs.get(name)
    if definition is None:
        raise LookupError(f"tool '{name}' has no LLM schema; the model could not call it")
    if not returns:
        raise ValueError(f"tool '{name}' must declare what it returns")
    return ToolSpec(
        name=name,
        fn=fn,
        definition=definition,
        label_vi=label_vi,
        label_en=label_en,
        description_vi=description_vi,
        cost_class=cost_class,
        payload=payload,
        reaches_outside=reaches_outside,
        result_kind=result_kind,
        returns=returns,
        deterministic=deterministic,
        cacheable=(deterministic and not reaches_outside) if cacheable is None else cacheable,
        self_sufficient=self_sufficient,
        answers_vi=answers_vi,
    )


def local(
    name: str,
    fn: ToolFn,
    definition: dict,
    *,
    label_vi: str,
    label_en: str,
    description_vi: str,
    result_kind: ResultKind,
    returns: dict[str, str],
    cost_class: CostClass = "cheap",
    payload: PayloadSize = "small",
    reaches_outside: bool = False,
    deterministic: bool = True,
    self_sufficient: bool = False,
    answers_vi: tuple[str, ...] = (),
) -> ToolSpec:
    """Declare a tool written against the contract, body and schema supplied here.

    The schema is written beside the body rather than looked up, because there is
    no second copy to look it up from — which is the point of the arrangement this
    seam is working towards.
    """
    if not returns:
        raise ValueError(f"tool '{name}' must declare what it returns")
    return ToolSpec(
        name=name,
        fn=fn,
        definition=definition,
        label_vi=label_vi,
        label_en=label_en,
        description_vi=description_vi,
        cost_class=cost_class,
        payload=payload,
        reaches_outside=reaches_outside,
        result_kind=result_kind,
        returns=returns,
        deterministic=deterministic,
        # Same rule the registry enforces: a tool that leaves AppBI is never
        # cacheable, whatever it claims about determinism.
        cacheable=deterministic and not reaches_outside,
        self_sufficient=self_sufficient,
        answers_vi=answers_vi,
    )
