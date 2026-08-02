"""Circuit breaker + retry policy for third-party LLM calls.

AppBI does not host models — every turn is an HTTP call to Anthropic, OpenAI or
Gemini using a key that belongs to the customer. Two consequences shape this
module:

1. **A provider outage or a rate-limited org must not be hammered.** Without a
   breaker, each turn retries into an already-saturated quota and every viewer
   waits out the full timeout.
2. **Failures are per-credential, not per-model.** Org A's key can be rate
   limited while org B's is fine, on the identical model. So the breaker key is
   ``hash(api_key) + provider + model`` — a process-wide key by model name (what
   a naive implementation does) would let one customer's exhausted quota take
   the assistant offline for everybody.

Retry is deliberately narrow: only 429 / 5xx / timeouts, twice, with backoff.
A 401 (bad key) or 400 (bad model name) is retried zero times — it will never
succeed, and burning two extra round-trips just makes the error slower.

In-process state. With four uvicorn workers each keeps its own view, so worst
case a provider gets 4× the failure threshold before everyone opens. That is
acceptable at this scale and needs no Redis; revisit if the deployment grows
past one node (see the scale triggers in the redesign doc).
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

FAILURE_THRESHOLD = 5        # consecutive failures before the circuit opens
OPEN_SECONDS = 60.0          # how long to stay open before probing again
MAX_RETRIES = 2              # retries AFTER the initial attempt
BACKOFF_BASE_SECONDS = 0.5   # 0.5s then 2.0s

# HTTP statuses worth retrying: rate limit, and transient server-side faults.
RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


@dataclass
class _CircuitState:
    failures: int = 0
    opened_at: float | None = None
    half_open: bool = False


class CircuitOpen(Exception):
    """Raised instead of calling out while the circuit for this key is open."""

    def __init__(self, key: str, retry_after: float):
        self.key = key
        self.retry_after = retry_after
        super().__init__(
            f"circuit open for {key}; retry in {retry_after:.0f}s"
        )


_LOCK = threading.RLock()
_CIRCUITS: dict[str, _CircuitState] = {}


def breaker_key(api_key: str, provider: str, model: str | None) -> str:
    """Per-credential identity. The raw key is hashed — it must never reach a
    log line, and this string ends up in warnings."""
    digest = hashlib.sha256((api_key or "").encode("utf-8")).hexdigest()[:12]
    return f"{digest}:{(provider or '').lower()}:{(model or 'default').lower()}"


def is_retryable_status(status: int | None) -> bool:
    return status is not None and int(status) in RETRYABLE_STATUS


def backoff_seconds(attempt: int) -> float:
    """attempt is 1-based: 1 → 0.5s, 2 → 2.0s."""
    return BACKOFF_BASE_SECONDS * (4 ** (max(1, attempt) - 1))


def check(key: str) -> None:
    """Raise CircuitOpen if this credential/model is currently cut off.

    Lets exactly one caller through once the open window elapses (half-open):
    that probe decides whether to close the circuit or re-open it.
    """
    with _LOCK:
        state = _CIRCUITS.get(key)
        if state is None or state.opened_at is None:
            return
        elapsed = time.monotonic() - state.opened_at
        if elapsed < OPEN_SECONDS:
            raise CircuitOpen(key, OPEN_SECONDS - elapsed)
        if state.half_open:
            # A probe is already in flight — keep everyone else out so a dead
            # provider gets one request per window, not a thundering herd.
            raise CircuitOpen(key, OPEN_SECONDS)
        state.half_open = True
        logger.info("[ai_breaker] half-open probe key=%s", key)


def record_success(key: str) -> None:
    with _LOCK:
        state = _CIRCUITS.get(key)
        if state is None:
            return
        if state.opened_at is not None:
            logger.info("[ai_breaker] closed key=%s", key)
        _CIRCUITS.pop(key, None)


def record_failure(key: str) -> None:
    with _LOCK:
        state = _CIRCUITS.setdefault(key, _CircuitState())
        if state.half_open:
            # The probe failed → straight back to open for another window.
            state.half_open = False
            state.opened_at = time.monotonic()
            logger.warning("[ai_breaker] re-opened after failed probe key=%s", key)
            return
        state.failures += 1
        if state.failures >= FAILURE_THRESHOLD and state.opened_at is None:
            state.opened_at = time.monotonic()
            logger.warning(
                "[ai_breaker] OPEN key=%s after %d consecutive failures",
                key, state.failures,
            )


def reset_all() -> None:
    """Test hook — clears every circuit."""
    with _LOCK:
        _CIRCUITS.clear()


def snapshot() -> dict[str, dict]:
    """Read-only view for diagnostics/admin."""
    with _LOCK:
        now = time.monotonic()
        return {
            k: {
                "failures": s.failures,
                "open": s.opened_at is not None and (now - s.opened_at) < OPEN_SECONDS,
                "half_open": s.half_open,
            }
            for k, s in _CIRCUITS.items()
        }
