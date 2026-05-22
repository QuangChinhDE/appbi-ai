"""Thinking-mode AI bot — the full agentic stack.

Includes reading_plan, multi-step recon, briefing wizard, conversation
state, 14 tools (5 core + 4 diagnostic + 5 advanced analytics),
self-critique, and cross-turn summary cache.

Selected when the user picks the "Thinking" toggle in the chat UI
(X-User-Ai-Mode: thinking). The simpler "Normal" mode is in the
sibling ``normal/`` folder; both share top-level infrastructure
(``tool_context``, ``insight_pack``, ``providers``, etc.).
"""
from app.services.dashboard_ai_bot.thinking.agent import (
    build_proactive_recon,
    run_agent_stream,
)

__all__ = ["build_proactive_recon", "run_agent_stream"]
