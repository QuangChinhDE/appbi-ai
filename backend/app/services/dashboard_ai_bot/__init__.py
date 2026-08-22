"""Shared pieces the Agent Flow engine still uses from the first-generation bot.

WHAT THIS PACKAGE IS NOW, AND WHAT IT WAS.

It used to hold two whole bots — `normal/` (the May baseline: 5 tools, one prompt)
and `thinking/` (the full agentic stack) — plus a heuristic `router` and a
dispatcher that picked between them on a `mode` header. Agent Flow replaced all of
that: a flow IS the way of thinking, chosen per link, and the engine that answers a
viewer is `agent_flows.dispatch`.

The replacement shipped and the replaced parts stayed. `run_agent_stream` had no
caller from any route — `api/public.py` says so in a comment where the import used
to be — the router computed a `RouteDecision` nothing read, and `normal/` was
reachable only through the dispatcher that nothing called. Fourteen hundred lines
of a second engine that could not be reached, sitting next to the one that answers,
which is precisely the confusion to remove when the question is "what actually
answers a viewer".

Deleted: `normal/`, `router.py`, and the mode dispatcher below it.

STILL LIVE, and why each one is:
  thinking/            `build_proactive_recon` — the bot's first read of a report,
                       imported DIRECTLY by the routes that use it.
  insight_pack         chart statistics, used by the flow engine's tools.
  govern_tools         knowledge retrieval for a Knowledge step.
  knowledge            institutional memory (remember/recall).
  providers/           the vendor streamers every Agent step calls.
  summary_cache        cross-turn pack cache.
  public_link_config   resolves the deployment's key.
  verifier, evidence   check the answer's figures against what was read.
  tool_context         now a re-export of `agent_flows.tools.context`.
"""
from app.services.dashboard_ai_bot.insight_pack import (  # noqa: F401
    InsightPack,
    build_chart_manifest,
    build_insight_pack,
)
from app.services.dashboard_ai_bot.tool_context import ToolContext  # noqa: F401

__all__ = [
    "InsightPack",
    "ToolContext",
    "build_chart_manifest",
    "build_insight_pack",
]
