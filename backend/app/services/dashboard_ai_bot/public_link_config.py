"""Helpers for AI bot settings stored on dashboard public links."""
from __future__ import annotations

from fastapi import HTTPException, status

DEFAULT_PUBLIC_AI_NORMAL_COST_CAP_USD = 0.05
DEFAULT_PUBLIC_AI_THINKING_COST_CAP_USD = 0.10


def clamp_public_ai_cost_cap(value: float) -> float:
    return max(0.01, min(5.0, float(value)))


def parse_public_ai_cost_cap(raw_value) -> float | None:
    if raw_value in (None, ""):
        return None
    try:
        return clamp_public_ai_cost_cap(float(raw_value))
    except (TypeError, ValueError):
        return None


def normalize_public_ai_mode(raw_value: str | None) -> str:
    mode = (raw_value or "").strip().lower()
    return "thinking" if mode == "thinking" else "normal"


def sanitize_report_context_note(raw_value) -> str:
    return str(raw_value or "").strip()[:1200]


def resolve_public_ai_credentials(
    appearance_config: dict | None,
    *,
    x_user_ai_key: str | None,
    x_user_ai_provider: str | None,
    x_user_ai_model: str | None,
    missing_key_detail: str,
) -> tuple[str, str, str | None]:
    config = appearance_config or {}

    stored_key = config.get("ai_bot_key") or ""
    effective_key = (x_user_ai_key or stored_key).strip()
    if not effective_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=missing_key_detail,
        )

    stored_provider = config.get("ai_bot_provider") or ""
    provider = ((x_user_ai_provider or stored_provider).strip().lower()) or "gemini"
    if provider not in ("anthropic", "openai", "gemini"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-User-Ai-Provider must be one of: anthropic, openai, gemini.",
        )

    stored_model = config.get("ai_bot_model") or ""
    model = ((x_user_ai_model or stored_model).strip()) or None
    if model is not None and len(model) > 120:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-User-Ai-Model is too long.",
        )

    return effective_key, provider, model


def resolve_public_ai_critique_enabled(appearance_config: dict | None) -> bool:
    """Phase 15.72 — self-critique pass is opt-in per public link.

    Default OFF. Critique doubles per-turn latency + cost and tends to
    soften sharp insights ("có thể là" sanitizer drops bullets). Admin
    can flip it on per link via appearance_config.ai_bot_critique_enabled
    when they want stricter citation/contradiction enforcement.
    """
    return bool((appearance_config or {}).get("ai_bot_critique_enabled"))


def resolve_public_ai_cost_cap(
    appearance_config: dict | None,
    *,
    x_user_ai_cost_cap_usd: str | None,
    x_user_ai_mode: str | None,
) -> float:
    config = appearance_config or {}
    mode = normalize_public_ai_mode(x_user_ai_mode)
    configured_cap = parse_public_ai_cost_cap(
        config.get(
            "ai_bot_thinking_cost_cap_usd"
            if mode == "thinking"
            else "ai_bot_normal_cost_cap_usd",
        )
    )
    fallback_cap = (
        DEFAULT_PUBLIC_AI_THINKING_COST_CAP_USD
        if mode == "thinking"
        else DEFAULT_PUBLIC_AI_NORMAL_COST_CAP_USD
    )
    requested_cap = parse_public_ai_cost_cap(x_user_ai_cost_cap_usd)

    if configured_cap is None:
        return requested_cap if requested_cap is not None else fallback_cap
    if requested_cap is None:
        return configured_cap
    return min(requested_cap, configured_cap)
