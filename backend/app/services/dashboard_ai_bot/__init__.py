"""Agentic AI Bot for public dashboard links.

Phase 15.77 — the bot lives in two flavours under physically separate
folders:

  - ``normal/``   — May-8 baseline: 5 tools, 1 prompt, no briefing, no
                    reading_plan, no advanced analytics. Cheap, fast,
                    less prescription. Default when the chat UI's
                    Normal/Thinking toggle is on Normal (or no mode
                    header is sent).
  - ``thinking/`` — full agentic stack: 19 tools, briefing wizard,
                    conversation state, reading_plan + per-step
                    progress, cross-turn summary cache, opt-in
                    self-critique. Selected with X-User-Ai-Mode:
                    thinking.

Both flavours share the chart-fetch boundary (``tool_context``),
``insight_pack``, the provider streamers, the ``events`` dataclasses,
and ``public_link_config``. The dispatcher below picks one based on
``mode``.

External callers should import:
    - ``run_agent_stream``          (dispatcher)
    - ``build_proactive_recon``     (dispatcher)
    - ``InsightPack`` + helpers     (shared)
"""
from typing import AsyncGenerator

from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.dashboard_ai_bot.insight_pack import (
    InsightPack,
    build_chart_manifest,
    build_insight_pack,
)
from app.services.dashboard_ai_bot.tool_context import ToolContext


def _normalize_mode(mode: str | None) -> str:
    """Coerce an explicit mode. Unknown/empty → "auto" (let the router decide)."""
    m = (mode or "").strip().lower()
    if m in ("normal", "thinking", "auto"):
        return m
    return "auto"


def _resolve_mode(mode: str | None, user_messages) -> tuple[str, dict | None]:
    """Resolve the effective mode. For "auto" run the heuristic router.

    Returns ``(resolved_mode, route_info | None)`` — route_info is the
    router decision dict (for the `route` telemetry event) only when we
    actually routed; None when the mode was explicitly forced.
    """
    requested = _normalize_mode(mode)
    if requested in ("normal", "thinking"):
        return requested, None
    from app.services.dashboard_ai_bot.router import (
        classify_question_mode,
        last_user_text,
    )
    decision = classify_question_mode(
        last_user_text(user_messages),
        recent_messages=user_messages,
    )
    info = decision.to_dict()
    info["auto"] = True
    return decision.mode, info


async def run_agent_stream(
    *,
    mode: str | None = None,
    **kwargs,
) -> AsyncGenerator[AgentEvent, None]:
    """Dispatch to normal/agent or thinking/agent based on `mode`.

    `mode` semantics:
        "normal"     → simple bot (5 tools)
        "thinking"   → full agentic stack (19 tools, briefing, etc.)
        "auto" / None / unknown → heuristic router picks per question

    When routing happens we first yield a ``route`` event so the FE can
    show which depth was chosen (and why) without offering a toggle.

    All other kwargs are forwarded verbatim. Note that the two
    implementations accept SIMILAR but not identical kwargs — thinking
    accepts `briefing`, `state`, `enable_critique` (admin-toggled);
    normal accepts a smaller subset. The caller is responsible for
    passing the right set; extras passed to normal are silently
    ignored at the call site (TypeError surfaces obvious mismatches).
    """
    resolved, route_info = _resolve_mode(mode, kwargs.get("user_messages"))
    if route_info is not None:
        yield AgentEvent(type="route", extra={"route": route_info})
    if resolved == "thinking":
        from app.services.dashboard_ai_bot.thinking.agent import (
            run_agent_stream as _thinking_run,
        )
        async for ev in _thinking_run(**kwargs):
            yield ev
        return
    # Default: normal mode. Strip kwargs the normal implementation doesn't
    # accept so the FE doesn't have to special-case based on mode.
    # web_search is a Thinking-only (domain-research) capability.
    _NORMAL_DROP = ("briefing", "state", "web_search_enabled", "guide_mode")
    normal_kwargs = {k: v for k, v in kwargs.items() if k not in _NORMAL_DROP}
    from app.services.dashboard_ai_bot.normal.agent import (
        run_agent_stream as _normal_run,
    )
    async for ev in _normal_run(**normal_kwargs):
        yield ev


def build_proactive_recon(ctx: ToolContext, *, mode: str | None = None) -> dict:
    """Dispatch recon builder. Same mode semantics as run_agent_stream."""
    resolved = _normalize_mode(mode)
    if resolved == "thinking":
        from app.services.dashboard_ai_bot.thinking.agent import (
            build_proactive_recon as _thinking_recon,
        )
        return _thinking_recon(ctx)
    from app.services.dashboard_ai_bot.normal.agent import (
        build_proactive_recon as _normal_recon,
    )
    return _normal_recon(ctx)


__all__ = [
    "InsightPack",
    "ToolContext",
    "build_chart_manifest",
    "build_insight_pack",
    "build_proactive_recon",
    "run_agent_stream",
]
