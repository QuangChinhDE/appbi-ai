"""Self-critique pass for the Normal bot — opt-in only.

Same shape as the May-8 baseline (commit e38c0bc): runs the same
provider/model against a CRITIQUE_SYSTEM_PROMPT + the draft answer,
streams the corrected text. Errors fall through to the original
draft so the user never sees a blank response.

Default OFF in Normal mode. The admin can flip it on per link via
``appearance_config.ai_bot_critique_enabled`` if they want stricter
citation/contradiction enforcement.
"""
from __future__ import annotations

import logging
from typing import AsyncGenerator, Callable

from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.dashboard_ai_bot.normal.prompts import (
    CRITIQUE_SYSTEM_PROMPT,
    build_critique_user_prompt,
)

logger = logging.getLogger(__name__)


StreamerFn = Callable[..., AsyncGenerator[AgentEvent, None]]


async def critique_and_stream(
    *,
    streamer: StreamerFn,
    api_key: str,
    user_question: str,
    tool_log: list[dict],
    draft_answer: str,
    model: str | None = None,
) -> AsyncGenerator[AgentEvent, None]:
    if not draft_answer.strip():
        return

    user_prompt = build_critique_user_prompt(
        user_question=user_question,
        tool_log=tool_log,
        draft_answer=draft_answer,
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
                logger.warning("normal critique error: %s", ev.text)
                break
    except Exception:
        logger.exception("normal critique stream raised")

    if not saw_text:
        yield AgentEvent(type="text", text=draft_answer)
