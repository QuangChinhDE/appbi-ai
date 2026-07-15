"""Token pricing and per-turn cost accounting for the Dashboard AI Bot.

Prices are USD per 1M tokens and are meant for *guardrail* estimation, not
exact end-user billing. We still try to mirror the providers' billing model
closely enough that a per-question cap behaves predictably:

- OpenAI: uncached input, cached input, and output are priced separately.
- Anthropic: base input, cache reads, and cache writes are priced separately.
- Gemini: input/output pricing can depend on prompt size, and thinking tokens
  are billed as output tokens on models that expose them.

If a model is unknown we fall back to a conservative GPT-4o-class estimate.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping


def _per_token(price_per_million: float, tokens: int) -> float:
    return (max(0, int(tokens or 0)) / 1_000_000.0) * float(price_per_million or 0.0)


def _as_int(value: object, default: int = 0) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return int(default or 0)


@dataclass(frozen=True)
class PriceTier:
    """Pricing for one prompt-size tier of a model family."""

    input_per_1m: float
    output_per_1m: float
    prompt_tokens_lte: int | None = None
    cached_input_per_1m: float | None = None
    cache_read_per_1m: float | None = None
    cache_write_5m_per_1m: float | None = None
    cache_write_1h_per_1m: float | None = None


@dataclass(frozen=True)
class ModelPricing:
    """Pricing metadata for a model family, optionally with prompt-size tiers."""

    tiers: tuple[PriceTier, ...]

    def tier_for_prompt_tokens(self, prompt_tokens: int) -> PriceTier:
        normalized = max(0, int(prompt_tokens or 0))
        for tier in self.tiers:
            if tier.prompt_tokens_lte is None or normalized <= tier.prompt_tokens_lte:
                return tier
        return self.tiers[-1]


def _openai(input_per_1m: float, cached_input_per_1m: float, output_per_1m: float) -> ModelPricing:
    return ModelPricing((
        PriceTier(
            input_per_1m=input_per_1m,
            cached_input_per_1m=cached_input_per_1m,
            output_per_1m=output_per_1m,
        ),
    ))


def _anthropic(input_per_1m: float, output_per_1m: float) -> ModelPricing:
    return ModelPricing((
        PriceTier(
            input_per_1m=input_per_1m,
            output_per_1m=output_per_1m,
            cache_read_per_1m=input_per_1m * 0.10,
            cache_write_5m_per_1m=input_per_1m * 1.25,
            cache_write_1h_per_1m=input_per_1m * 2.00,
        ),
    ))


def _gemini(
    *,
    short_input_per_1m: float,
    short_output_per_1m: float,
    short_cached_input_per_1m: float | None = None,
    long_input_per_1m: float | None = None,
    long_output_per_1m: float | None = None,
    long_cached_input_per_1m: float | None = None,
    threshold_tokens: int | None = None,
) -> ModelPricing:
    if threshold_tokens is None or long_input_per_1m is None or long_output_per_1m is None:
        return ModelPricing((
            PriceTier(
                input_per_1m=short_input_per_1m,
                cached_input_per_1m=short_cached_input_per_1m,
                output_per_1m=short_output_per_1m,
            ),
        ))
    return ModelPricing((
        PriceTier(
            input_per_1m=short_input_per_1m,
            cached_input_per_1m=short_cached_input_per_1m,
            output_per_1m=short_output_per_1m,
            prompt_tokens_lte=threshold_tokens,
        ),
        PriceTier(
            input_per_1m=long_input_per_1m,
            cached_input_per_1m=long_cached_input_per_1m,
            output_per_1m=long_output_per_1m,
        ),
    ))


_PRICES: dict[str, ModelPricing] = {
    # OpenAI
    "gpt-5": _openai(1.25, 0.125, 10.0),
    "gpt-5-mini": _openai(0.25, 0.025, 2.0),
    "gpt-5-nano": _openai(0.05, 0.005, 0.40),
    "gpt-4o-2024-11-20": _openai(2.5, 1.25, 10.0),
    "gpt-4o-2024-08-06": _openai(2.5, 1.25, 10.0),
    "gpt-4o-mini": _openai(0.15, 0.075, 0.60),
    "gpt-4o": _openai(2.5, 1.25, 10.0),
    "gpt-4.1-mini": _openai(0.40, 0.10, 1.60),
    "gpt-4.1-nano": _openai(0.10, 0.025, 0.40),
    "gpt-4.1": _openai(2.0, 0.50, 8.0),
    "o3-mini": _openai(1.10, 0.55, 4.40),
    # Anthropic — refreshed 2026-07 against the live price sheet. The old
    # table priced opus-4-7 at legacy 15/75 (wrong: Opus 4.6+ is 5/25) and
    # still carried the RETIRED claude-3-5-* family (404 since 2026-02-19).
    "claude-fable-5": _anthropic(10.0, 50.0),
    "claude-opus-4-8": _anthropic(5.0, 25.0),
    "claude-opus-4-7": _anthropic(5.0, 25.0),
    "claude-opus-4-6": _anthropic(5.0, 25.0),
    "claude-opus-4": _anthropic(15.0, 75.0),   # legacy opus-4-0/4-1 pricing
    "claude-sonnet-5": _anthropic(3.0, 15.0),
    "claude-sonnet-4-6": _anthropic(3.0, 15.0),
    "claude-sonnet-4": _anthropic(3.0, 15.0),
    "claude-haiku-4-5-20251001": _anthropic(1.0, 5.0),
    "claude-haiku-4-5": _anthropic(1.0, 5.0),
    # Gemini — 1.5 family is EOL; 2.x is the live generation.
    "gemini-2.5-pro": _gemini(
        short_input_per_1m=1.25,
        short_cached_input_per_1m=0.3125,
        short_output_per_1m=10.0,
        long_input_per_1m=2.50,
        long_cached_input_per_1m=0.625,
        long_output_per_1m=15.0,
        threshold_tokens=200_000,
    ),
    "gemini-2.5-flash": _gemini(
        short_input_per_1m=0.30,
        short_cached_input_per_1m=0.075,
        short_output_per_1m=2.50,
    ),
    "gemini-2.0-flash": _gemini(
        short_input_per_1m=0.10,
        short_cached_input_per_1m=0.025,
        short_output_per_1m=0.40,
    ),
}

_FALLBACK = _openai(2.5, 1.25, 10.0)


def price_for(model: str) -> ModelPricing:
    """Return pricing metadata for a model name.

    Lookup is case-insensitive and prefers the longest matching prefix so
    dated snapshot names like ``gpt-4.1-mini-2025-04-14`` resolve to the
    correct family rather than the broader ``gpt-4.1`` tier.
    """
    if not model:
        return _FALLBACK
    key = model.strip().lower()
    if key in _PRICES:
        return _PRICES[key]
    for prefix in sorted(_PRICES.keys(), key=len, reverse=True):
        if key.startswith(prefix):
            return _PRICES[prefix]
    return _FALLBACK


@dataclass
class CostMeter:
    """Accumulates token usage across multiple LLM rounds in one chat turn.

    ``cap_usd`` is optional. The per-question cost ceiling was removed
    (2026-06-23) — the meter now exists purely for server-side telemetry
    (logged spend per turn). ``max_tool_calls`` is the runaway bound. When
    ``cap_usd`` is None, ``over_cap``/``near_cap`` are always False and the
    cap fields are omitted from ``to_dict``.
    """

    model: str = ""
    cap_usd: float | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    rounds: int = 0
    extra_usd: float = 0.0
    billed_usd: float = 0.0
    cached_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_write_input_tokens: int = 0
    reasoning_tokens: int = 0
    capped_emitted: bool = field(default=False, init=False, repr=False)

    def add(self, *, prompt_tokens: int = 0, completion_tokens: int = 0) -> None:
        self.add_usage({
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
        })

    def add_usage(self, usage: Mapping[str, object] | None = None) -> None:
        payload = dict(usage or {})

        prompt_tokens = max(0, _as_int(payload.get("prompt_tokens")))
        completion_tokens = max(0, _as_int(payload.get("completion_tokens")))
        effective_prompt_tokens = max(
            0,
            _as_int(payload.get("effective_prompt_tokens"), prompt_tokens),
        )

        cached_prompt_tokens = max(0, _as_int(payload.get("cached_prompt_tokens")))
        cached_content_tokens = max(0, _as_int(payload.get("cached_content_tokens")))
        cache_read_tokens = max(0, _as_int(payload.get("cache_read_input_tokens")))
        cache_write_total_tokens = max(0, _as_int(payload.get("cache_creation_input_tokens")))
        cache_write_5m_tokens = max(0, _as_int(payload.get("cache_creation_input_tokens_5m")))
        cache_write_1h_tokens = max(0, _as_int(payload.get("cache_creation_input_tokens_1h")))
        base_input_tokens = max(
            0,
            _as_int(
                payload.get("base_input_tokens"),
                prompt_tokens - cache_read_tokens - cache_write_total_tokens,
            ),
        )

        thought_tokens = max(0, _as_int(payload.get("thought_tokens")))
        tool_use_prompt_tokens = max(0, _as_int(payload.get("tool_use_prompt_tokens")))
        reasoning_tokens = max(
            0,
            _as_int(payload.get("reasoning_tokens"))
            if payload.get("reasoning_tokens") is not None
            else thought_tokens,
        )

        self.prompt_tokens += prompt_tokens
        self.completion_tokens += completion_tokens
        self.cached_input_tokens += cached_prompt_tokens + cached_content_tokens
        self.cache_read_input_tokens += cache_read_tokens
        self.cache_write_input_tokens += cache_write_total_tokens
        self.reasoning_tokens += reasoning_tokens
        self.rounds += 1

        pricing = price_for(self.model)
        tier = pricing.tier_for_prompt_tokens(effective_prompt_tokens or prompt_tokens)

        round_usd = 0.0
        has_explicit_anthropic_cache_buckets = (
            "base_input_tokens" in payload
            or cache_read_tokens > 0
            or cache_write_total_tokens > 0
        )
        if has_explicit_anthropic_cache_buckets:
            remaining_cache_write_tokens = max(
                0,
                cache_write_total_tokens - cache_write_5m_tokens - cache_write_1h_tokens,
            )
            round_usd += _per_token(tier.input_per_1m, base_input_tokens)
            round_usd += _per_token(
                tier.cache_read_per_1m or tier.cached_input_per_1m or tier.input_per_1m,
                cache_read_tokens,
            )
            round_usd += _per_token(
                tier.cache_write_5m_per_1m or tier.input_per_1m,
                cache_write_5m_tokens + remaining_cache_write_tokens,
            )
            round_usd += _per_token(
                tier.cache_write_1h_per_1m or tier.input_per_1m,
                cache_write_1h_tokens,
            )
        else:
            cached_input_tokens = max(0, cached_prompt_tokens + cached_content_tokens)
            uncached_prompt_tokens = max(0, prompt_tokens - cached_input_tokens)
            round_usd += _per_token(tier.input_per_1m, uncached_prompt_tokens)
            round_usd += _per_token(
                tier.cached_input_per_1m or tier.input_per_1m,
                cached_input_tokens,
            )

        # Gemini "toolUsePromptTokenCount" is output-only metadata. Our Gemini
        # path does not use tools today, but if a future API revision emits it,
        # charge it as output to stay conservative rather than undercount.
        round_usd += _per_token(
            tier.output_per_1m,
            completion_tokens + tool_use_prompt_tokens,
        )
        self.billed_usd += round_usd

    @property
    def usd(self) -> float:
        return float(self.billed_usd or 0.0) + float(self.extra_usd or 0.0)

    @property
    def remaining_usd(self) -> float | None:
        if self.cap_usd is None:
            return None
        return max(0.0, self.cap_usd - self.usd)

    def over_cap(self) -> bool:
        return self.cap_usd is not None and self.usd >= self.cap_usd

    def near_cap(self, ratio: float = 0.75) -> bool:
        if not self.cap_usd or self.cap_usd <= 0:
            return False
        return self.usd >= self.cap_usd * ratio

    def to_dict(self) -> dict:
        out = {
            "model": self.model,
            "usd": round(self.usd, 5),
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "cache_read_input_tokens": self.cache_read_input_tokens,
            "cache_write_input_tokens": self.cache_write_input_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "rounds": self.rounds,
        }
        if self.cap_usd is not None:
            out["cap_usd"] = round(self.cap_usd, 4)
            out["remaining_usd"] = round(self.remaining_usd or 0.0, 5)
            out["over_cap"] = self.over_cap()
            out["near_cap"] = self.near_cap()
        return out
