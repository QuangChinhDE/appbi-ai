"""Normal-mode AI bot — the simple baseline.

A faithful re-creation of the original May-8 (commit e38c0bc) AI Bot
shape: 5 tools (list_charts, get_chart_summary, get_chart_data,
compare_segments, compute), 1 system prompt (no PHASE 0 reading_plan,
no briefing wizard, no conversation_state extraction), optional
self-critique, simple parallel recon at chat-open. Routed to when the
user picks "Normal" in the chat UI (X-User-Ai-Mode header empty or
"normal").

Why a separate folder: the user's directive after the bot was
over-engineered with reading_plan + diagnostic flow + 14 tools was to
keep the simple bot as a stable baseline. Putting it in its own
folder means future "upgrade thinking" work doesn't accidentally
touch this path.

Shared with ``thinking/``: ``tool_context`` (ToolContext +
_fetch_chart_data — single source of truth for the chart-data
boundary), ``insight_pack``, ``providers``, ``events``, ``cost``.
"""
from app.services.dashboard_ai_bot.normal.agent import (
    build_proactive_recon,
    run_agent_stream,
)

__all__ = ["build_proactive_recon", "run_agent_stream"]
