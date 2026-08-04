"""Breaker + retry wrapper around any provider streamer.

Wrapping at this level (rather than editing each provider's HTTP loop) keeps
one retry policy for all three vendors and leaves the adapters free to stay
vendor-shaped.

The one non-obvious rule: **retry only before the first token reaches the
consumer.** Once text or a tool call has been streamed out, re-running the
request would duplicate output in the user's chat window, so a mid-stream
failure is surfaced as-is. In practice this is the right trade — provider
failures are overwhelmingly at connect/first-byte time (429, 401, 503), not
halfway through a response.
"""
from __future__ import annotations

import asyncio
import logging
from typing import AsyncGenerator, Callable

from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.dashboard_ai_bot.providers import breaker

logger = logging.getLogger(__name__)

_OPEN_MESSAGE = (
    "Dịch vụ AI đang tạm thời quá tải hoặc bị giới hạn. "
    "Bạn thử lại sau khoảng một phút nhé."
)


def guarded_stream(
    streamer: Callable[..., AsyncGenerator[AgentEvent, None]],
    *,
    provider: str,
) -> Callable[..., AsyncGenerator[AgentEvent, None]]:
    """Return a drop-in replacement for ``streamer`` with breaker + retry."""

    async def _run(*, api_key: str, model: str | None = None, **kwargs):
        key = breaker.breaker_key(api_key, provider, model)

        try:
            breaker.check(key)
        except breaker.CircuitOpen as exc:
            logger.warning("[ai_breaker] short-circuit %s", exc)
            yield AgentEvent(
                type="error", text=_OPEN_MESSAGE,
                extra={"circuit_open": True, "retry_after_s": round(exc.retry_after)},
            )
            return

        attempt = 0
        while True:
            emitted_payload = False   # any text/tool_call handed to the caller
            failure_status: int | None = None
            pending: list[AgentEvent] = []

            try:
                async for ev in streamer(api_key=api_key, model=model, **kwargs):
                    if ev.type == "error":
                        status = (ev.extra or {}).get("http_status")
                        failure_status = int(status) if status is not None else None
                        if not emitted_payload and breaker.is_retryable_status(failure_status):
                            # Hold it back: we may retry and succeed, in which
                            # case the user should never see this error at all.
                            pending.append(ev)
                            break
                        breaker.record_failure(key)
                        yield ev
                        return
                    if ev.type in ("text", "tool_call"):
                        emitted_payload = True
                    yield ev
            except Exception as exc:  # noqa: BLE001
                logger.exception("[ai_breaker] streamer raised provider=%s", provider)
                failure_status = 503
                if emitted_payload:
                    breaker.record_failure(key)
                    yield AgentEvent(
                        type="error",
                        text=f"Lỗi kết nối tới dịch vụ AI: {type(exc).__name__}",
                        extra={"http_status": 503},
                    )
                    return
                pending.append(
                    AgentEvent(
                        type="error",
                        text=f"Lỗi kết nối tới dịch vụ AI: {type(exc).__name__}",
                        extra={"http_status": 503},
                    )
                )

            if failure_status is None:
                # Clean completion (or an already-forwarded non-retryable error).
                breaker.record_success(key)
                return

            breaker.record_failure(key)
            attempt += 1
            if attempt > breaker.MAX_RETRIES:
                for ev in pending:
                    yield ev
                return

            wait = breaker.backoff_seconds(attempt)
            logger.warning(
                "[ai_breaker] retry %d/%d provider=%s status=%s in %.1fs",
                attempt, breaker.MAX_RETRIES, provider, failure_status, wait,
            )
            await asyncio.sleep(wait)
            # Re-check: a concurrent turn may have opened the circuit meanwhile.
            try:
                breaker.check(key)
            except breaker.CircuitOpen as exc:
                yield AgentEvent(
                    type="error", text=_OPEN_MESSAGE,
                    extra={"circuit_open": True, "retry_after_s": round(exc.retry_after)},
                )
                return

    return _run
