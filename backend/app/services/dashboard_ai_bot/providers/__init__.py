"""LLM provider adapters for the agentic Dashboard AI Bot.

Each adapter exposes one async generator function:

    async def stream(
        *,
        api_key: str,
        system_prompt: str,
        messages: list[dict],   # {role, content} OR provider-native turns
        tools: list[dict] | None,
    ) -> AsyncGenerator[AgentEvent, None]

For Anthropic and OpenAI, ``messages`` MAY include tool_use / tool_result
turns produced by previous loop iterations — the adapter is responsible
for translating these to/from the wire format.

For Gemini we only support a single-shot fallback (no tool calling) since
Gemini function-calling reliability is uneven; the loop falls back to
stuffing pre-computed insight packs into the system prompt.
"""

from app.services.dashboard_ai_bot.providers.anthropic_provider import stream_anthropic
from app.services.dashboard_ai_bot.providers.openai_provider import stream_openai
from app.services.dashboard_ai_bot.providers.gemini_provider import stream_gemini_singleshot

__all__ = ["stream_anthropic", "stream_openai", "stream_gemini_singleshot"]
