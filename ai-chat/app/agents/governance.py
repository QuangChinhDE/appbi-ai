"""
GovernanceMiddleware — Phase 3.

Provides:
1. Per-user, per-intent rate limiting (sliding window, in-memory)
2. Token budget alerting (logs warning when a turn exceeds threshold)
3. Session-level usage aggregation (reads from metrics stored on messages)

Design:
- No external dependencies (Redis, DB) — runs in-process
- Thread-safe for asyncio (single-process FastAPI)
- Rate limits are configurable via environment variables
"""
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Rate limit configuration
# ─────────────────────────────────────────────────────────────────────────────

# (requests_allowed, window_seconds)
_RATE_LIMITS: Dict[str, Tuple[int, int]] = {
    "LOOKUP":  (60, 3600),   # 60 lookups per hour
    "EXPLORE": (30, 3600),   # 30 explorations per hour
    "INSIGHT": (10, 3600),   # 10 deep analyses per hour (most expensive)
    "CREATE":  (20, 3600),   # 20 chart/dashboard creations per hour
    "VAGUE":   (100, 3600),  # clarifications are cheap
    "default": (100, 3600),  # fallback for unknown intents
}

# Token budget per turn — log a warning if exceeded
_TOKEN_BUDGET_WARN = 15_000   # warn at 15K input tokens per turn
_TOKEN_BUDGET_ALERT = 50_000  # critical alert at 50K (likely a bug)


# ─────────────────────────────────────────────────────────────────────────────
# Rate limiter
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class _UserIntentCounter:
    timestamps: List[float] = field(default_factory=list)


class RateLimiter:
    """
    Sliding-window rate limiter keyed by (user_id, intent).

    Thread-safe for single-process asyncio (no locks needed — GIL protected).
    """

    def __init__(self):
        # {(user_id, intent): _UserIntentCounter}
        self._counters: Dict[Tuple[str, str], _UserIntentCounter] = defaultdict(
            _UserIntentCounter
        )

    def check(self, user_id: str, intent: str) -> Tuple[bool, int]:
        """
        Check if this user is within the rate limit for this intent.

        Returns:
            (allowed: bool, remaining: int)
        """
        limit, window = _RATE_LIMITS.get(intent, _RATE_LIMITS["default"])
        key = (user_id, intent)
        now = time.monotonic()
        counter = self._counters[key]

        # Evict timestamps outside the window
        counter.timestamps = [t for t in counter.timestamps if now - t < window]
        current = len(counter.timestamps)

        if current >= limit:
            return False, 0

        return True, limit - current

    def record(self, user_id: str, intent: str) -> None:
        """Record a successful request after it was allowed."""
        key = (user_id, intent)
        self._counters[key].timestamps.append(time.monotonic())

    def get_usage(self, user_id: str) -> Dict[str, Dict]:
        """Return current usage counts for all intents for a user."""
        result = {}
        now = time.monotonic()
        for intent, (limit, window) in _RATE_LIMITS.items():
            key = (user_id, intent)
            if key not in self._counters:
                continue
            recent = [t for t in self._counters[key].timestamps if now - t < window]
            result[intent] = {
                "used": len(recent),
                "limit": limit,
                "window_seconds": window,
                "remaining": max(0, limit - len(recent)),
            }
        return result

    def reset_user(self, user_id: str) -> None:
        """Clear all counters for a user (admin use)."""
        keys_to_del = [k for k in self._counters if k[0] == user_id]
        for k in keys_to_del:
            del self._counters[k]


# Singleton instance shared across the process
rate_limiter = RateLimiter()


# ─────────────────────────────────────────────────────────────────────────────
# Token budget monitoring
# ─────────────────────────────────────────────────────────────────────────────

def check_token_budget(
    input_tokens: Optional[int],
    output_tokens: Optional[int],
    user_id: str,
    session_id: str,
    intent: str,
) -> None:
    """Log warnings when a single turn consumes excessive tokens."""
    if input_tokens is None:
        return  # Not yet extracted — skip

    total = (input_tokens or 0) + (output_tokens or 0)

    if total >= _TOKEN_BUDGET_ALERT:
        logger.critical(
            "TOKEN ALERT: user=%s session=%s intent=%s input=%d output=%d total=%d — "
            "investigate immediately",
            user_id, session_id, intent, input_tokens, output_tokens or 0, total,
        )
    elif total >= _TOKEN_BUDGET_WARN:
        logger.warning(
            "TOKEN WARNING: user=%s session=%s intent=%s input=%d output=%d total=%d — "
            "consider reducing context or tool results",
            user_id, session_id, intent, input_tokens, output_tokens or 0, total,
        )


# ─────────────────────────────────────────────────────────────────────────────
# Session usage aggregator
# ─────────────────────────────────────────────────────────────────────────────

def aggregate_session_usage(session) -> Dict:
    """
    Aggregate token usage and tool call stats from all assistant messages in a session.
    Used by the /chat/usage endpoint.
    """
    total_input = 0
    total_output = 0
    total_tool_calls = 0
    total_tool_errors = 0
    turns = 0

    for m in session.messages:
        if m.role != "assistant" or not m.metrics:
            continue
        metrics = m.metrics if isinstance(m.metrics, dict) else {}
        total_input += metrics.get("input_tokens") or 0
        total_output += metrics.get("output_tokens") or 0
        total_tool_calls += metrics.get("tool_call_count") or 0
        total_tool_errors += metrics.get("tool_errors") or 0
        turns += 1

    return {
        "session_id": session.session_id,
        "turns": turns,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "total_tokens": total_input + total_output,
        "total_tool_calls": total_tool_calls,
        "total_tool_errors": total_tool_errors,
        # Rough cost estimate using GPT-4o-mini pricing as proxy ($0.15/1M input, $0.60/1M output)
        "estimated_cost_usd": round(
            (total_input / 1_000_000) * 0.15 + (total_output / 1_000_000) * 0.60, 6
        ),
    }
