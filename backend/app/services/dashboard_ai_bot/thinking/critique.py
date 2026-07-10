"""Self-critique pass: rewrite a draft answer for accuracy + citation rules.

Invoked once at the end of each turn, BEFORE the agent streams the final
text to the user. The critique runs against the same provider/model the
user is using (BYOK) so we don't introduce a new dependency.

If the critique pass fails (provider error, etc.) we fall back to streaming
the original draft so the user is never blocked by review.
"""
from __future__ import annotations

import logging
from typing import AsyncGenerator, Callable

from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.dashboard_ai_bot.thinking.prompts import (
    CRITIQUE_SYSTEM_PROMPT,
    build_critique_user_prompt,
)

logger = logging.getLogger(__name__)


# A "Streamer" is the same kind of async generator factory the providers expose.
# We keep this loose so callers can pass any compatible function.
StreamerFn = Callable[..., AsyncGenerator[AgentEvent, None]]


async def critique_and_stream(
    *,
    streamer: StreamerFn,
    api_key: str,
    user_question: str,
    tool_log: list[dict],
    draft_answer: str,
    model: str | None = None,
    state_block: str = "",
) -> AsyncGenerator[AgentEvent, None]:
    """Run the critique LLM and yield its corrected text as `text` events.

    On any error we fall back to yielding the original draft so the user
    always gets an answer.
    """
    if not draft_answer.strip():
        # Nothing to review
        return

    user_prompt = build_critique_user_prompt(
        user_question=user_question,
        tool_log=tool_log,
        draft_answer=draft_answer,
        state_block=state_block,
    )

    saw_text = False
    try:
        gen = streamer(
            api_key=api_key,
            system_prompt=CRITIQUE_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
            tools=None,
            model=model or None,
        )
        async for ev in gen:
            if ev.type == "text" and ev.text:
                saw_text = True
                yield ev
            elif ev.type == "error":
                # Don't surface critique errors to user — log and fall through
                logger.warning("critique error: %s", ev.text)
                break
    except Exception:
        logger.exception("critique stream raised")

    if not saw_text:
        # Fallback: stream the original draft
        yield AgentEvent(type="text", text=draft_answer)
