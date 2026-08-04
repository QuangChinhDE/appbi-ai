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

So the packs declare WHAT a tool is here and now — its name, label, cost, whether
it leaves AppBI — while the body is still imported from the old location. When the
files are physically relocated, one import block in this module changes and no pack
changes at all.

Schemas are LOOKED UP rather than transcribed. Copying twenty-three JSON schemas
into pack files would create a second definition of every tool's arguments, and a
second definition is the thing this whole registry exists to remove.
"""
from __future__ import annotations

from typing import Any

from app.services.agent_flows.tools.registry import CostClass, ToolSpec


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
    cost_class: CostClass = "cheap",
    reaches_outside: bool = False,
) -> ToolSpec:
    """Build one ToolSpec, failing loudly if the tool or its schema is missing.

    Loudly on purpose. A pack naming a tool that no longer exists would otherwise
    register a picker entry the model can never call — the same silent gap as a
    node type with no runtime handler.
    """
    fns, defs = _sources()
    fn = fns.get(name)
    if fn is None:
        raise LookupError(f"tool '{name}' is declared in a pack but not implemented")
    definition = defs.get(name)
    if definition is None:
        raise LookupError(f"tool '{name}' has no LLM schema; the model could not call it")
    return ToolSpec(
        name=name,
        fn=fn,
        definition=definition,
        label_vi=label_vi,
        label_en=label_en,
        description_vi=description_vi,
        cost_class=cost_class,
        reaches_outside=reaches_outside,
    )
