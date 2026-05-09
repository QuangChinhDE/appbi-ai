"""Token-pricing & per-turn cost cap for the Dashboard AI Bot.

Approximate USD prices per 1M tokens as of 2026-05. We keep this in code
(not config) because the cap is a safety guard, not a billing feature —
the user's BYOK key is the real cost source. The cap stops a single
question from running away into a $1+ tool-calling loop.

If a model is unknown we fall back to a conservative GPT-4o-class
estimate ($2.5 input / $10 output per 1M).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

# (input_per_1m, output_per_1m) in USD. Cached_input is treated as input.
_PRICES: dict[str, tuple[float, float]] = {
    # OpenAI
    "gpt-4o": (2.5, 10.0),
    "gpt-4o-2024-11-20": (2.5, 10.0),
    "gpt-4o-2024-08-06": (2.5, 10.0),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4.1": (2.0, 8.0),
    "gpt-4.1-mini": (0.4, 1.6),
    "gpt-4.1-nano": (0.10, 0.40),
    "o3-mini": (1.1, 4.4),
    # Anthropic
    "claude-opus-4-7": (15.0, 75.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5-20251001": (0.80, 4.0),
    "claude-3-5-sonnet-20241022": (3.0, 15.0),
    "claude-3-5-haiku-20241022": (0.80, 4.0),
    # Gemini
    "gemini-1.5-pro": (1.25, 5.0),
    "gemini-1.5-flash": (0.075, 0.30),
    "gemini-2.0-flash": (0.10, 0.40),
}

_FALLBACK = (2.5, 10.0)


def price_for(model: str) -> tuple[float, float]:
    """Return (input_per_1m, output_per_1m) USD for a model name.

    Lookup is case-insensitive and tolerates suffixes like ``-latest``.
    """
    if not model:
        return _FALLBACK
    key = model.strip().lower()
    if key in _PRICES:
        return _PRICES[key]
    for prefix, price in _PRICES.items():
        if key.startswith(prefix):
            return price
    return _FALLBACK


@dataclass
class CostMeter:
    """Accumulates token usage across multiple LLM rounds in one chat turn.

    The agent loop instantiates one CostMeter per user turn. Each provider
    round emits ``add(prompt_tokens, completion_tokens)`` once it sees the
    final usage block, and the loop checks ``over_cap()`` before deciding
    whether to allow another tool round.
    """

    model: str = ""
    cap_usd: float = 0.10
    prompt_tokens: int = 0
    completion_tokens: int = 0
    rounds: int = 0
    # Free-form notes: rough cost of multimodal images attached out-of-band
    # (we already round those into prompt tokens via the API, so this stays 0
    # unless we want to surface tool I/O cost separately).
    extra_usd: float = 0.0
    capped_emitted: bool = field(default=False, init=False, repr=False)

    def add(self, *, prompt_tokens: int = 0, completion_tokens: int = 0) -> None:
        if prompt_tokens:
            self.prompt_tokens += int(prompt_tokens)
        if completion_tokens:
            self.completion_tokens += int(completion_tokens)
        self.rounds += 1

    @property
    def usd(self) -> float:
        in_p, out_p = price_for(self.model)
        return (
            (self.prompt_tokens / 1_000_000.0) * in_p
            + (self.completion_tokens / 1_000_000.0) * out_p
            + float(self.extra_usd or 0.0)
        )

    @property
    def remaining_usd(self) -> float:
        return max(0.0, self.cap_usd - self.usd)

    def over_cap(self) -> bool:
        return self.usd >= self.cap_usd

    def near_cap(self, ratio: float = 0.75) -> bool:
        if self.cap_usd <= 0:
            return False
        return self.usd >= self.cap_usd * ratio

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "cap_usd": round(self.cap_usd, 4),
            "usd": round(self.usd, 5),
            "remaining_usd": round(self.remaining_usd, 5),
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "rounds": self.rounds,
            "over_cap": self.over_cap(),
            "near_cap": self.near_cap(),
        }
