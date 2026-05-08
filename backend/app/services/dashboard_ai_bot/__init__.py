"""Agentic AI Bot for public dashboard links.

Replaces the legacy single-shot stuff-context approach in
``dashboard_ai_service.py`` with a tool-calling agent loop.

Public surface (re-exported here for convenience):
    - run_agent_stream:       agentic streaming for chat turns
    - build_proactive_recon:  auto-recon on bot open
    - build_legacy_context:   legacy single-shot context (Gemini fallback,
                              kept for backwards compat with the old
                              /ai/context endpoint)

The legacy ``dashboard_ai_service`` module continues to expose
``build_ai_context`` / ``build_system_prompt`` / ``stream_llm_byok`` as
thin facades over this module so existing callers do not break.
"""
from app.services.dashboard_ai_bot.insight_pack import (
    InsightPack,
    build_chart_manifest,
    build_insight_pack,
)

__all__ = [
    "InsightPack",
    "build_chart_manifest",
    "build_insight_pack",
]
