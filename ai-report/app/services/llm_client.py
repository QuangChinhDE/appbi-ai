from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger(__name__)

# Errors that mean the key is exhausted/invalid — try next key
_KEY_EXHAUSTED_CODES = {401, 402, 403, 429}


def _is_key_exhausted(exc: Exception) -> bool:
    """Return True when the exception signals a quota/auth failure for this key."""
    msg = str(exc).lower()
    # openai SDK wraps HTTP errors; check status code attribute if present
    status = getattr(exc, "status_code", None) or getattr(getattr(exc, "response", None), "status_code", None)
    if status in _KEY_EXHAUSTED_CODES:
        return True
    # Fallback: text heuristics
    return any(kw in msg for kw in ("401", "402", "403", "429", "rate limit", "quota", "insufficient credits", "invalid api key", "unauthorized"))


def _make_client(api_key: str):
    from openai import AsyncOpenAI
    return AsyncOpenAI(
        api_key=api_key,
        base_url="https://openrouter.ai/api/v1",
        default_headers={
            "HTTP-Referer": settings.openrouter_site_url,
            "X-Title": settings.openrouter_app_name,
        },
    )


def _build_provider_chain(model_override: Optional[str] = None) -> List[Dict[str, str]]:
    primary_model = (model_override or settings.active_llm_model).strip()
    chain = [{"provider": "openrouter", "model": primary_model}]
    for entry in settings.active_llm_fallback_chain:
        if entry not in chain:
            chain.append(entry)
    return chain


PHASE_MAX_TOKENS: Dict[str, int] = {
    "enrichment": 3000,
    "planning": 4000,
    "insight": 2500,
    "narrative": 2000,
}
_DEFAULT_MAX_TOKENS = 2000


async def _call_with_key(
    *,
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    timeout_seconds: int,
    max_tokens: int,
) -> Optional[Dict[str, Any]]:
    """Single attempt with a specific API key. Raises on any error."""
    client = _make_client(api_key)
    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=max_tokens,
            timeout=timeout_seconds,
        )
        content = response.choices[0].message.content or "{}"
        return json.loads(content)
    finally:
        await client.close()


async def generate_json(
    *,
    system_prompt: str,
    user_prompt: str,
    model_override: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
    phase: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Call OpenRouter with automatic multi-key fallback.

    Key rotation strategy:
    - Try OPENROUTER_API_KEY_1 first, then _2 … _5 (or bare OPENROUTER_API_KEY).
    - If a key fails with a quota/auth error (401/402/403/429) → rotate to next key.
    - If a key fails with a non-quota error (timeout, bad JSON, etc.) → try next model
      in the model fallback chain using the SAME key before rotating the key.
    - If ALL keys are exhausted for a given model → move to the next model in chain.
    - If every combination fails → return None and log a clear error.
    """
    effective_timeout = timeout_seconds or settings.active_llm_timeout_seconds
    effective_max_tokens = PHASE_MAX_TOKENS.get((phase or "").lower(), _DEFAULT_MAX_TOKENS)
    api_keys = settings.active_api_keys

    if not api_keys:
        logger.error(
            "No OpenRouter API keys configured. "
            "Set OPENROUTER_API_KEY or OPENROUTER_API_KEY_1..5 in .env"
        )
        return None

    for entry in _build_provider_chain(model_override):
        if entry["provider"] != "openrouter":
            continue
        model = entry["model"]

        for key_index, api_key in enumerate(api_keys, start=1):
            try:
                result = await _call_with_key(
                    api_key=api_key,
                    model=model,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    timeout_seconds=effective_timeout,
                    max_tokens=effective_max_tokens,
                )
                return result
            except Exception as exc:
                if _is_key_exhausted(exc):
                    logger.warning(
                        "API key #%d exhausted (model=%s phase=%s): %s — trying next key",
                        key_index, model, phase, exc,
                    )
                    continue  # rotate to next key
                else:
                    # Non-quota error (timeout, model error) — no point retrying other keys
                    logger.warning(
                        "LLM call failed for key #%d model=%s phase=%s: %s — trying next model",
                        key_index, model, phase, exc,
                    )
                    break  # break key loop → try next model in chain

        # Reached here means all keys exhausted for this model
        logger.warning("All %d API key(s) exhausted for model=%s phase=%s", len(api_keys), model, phase)

    logger.error(
        "All API keys and model fallbacks exhausted. "
        "Check OPENROUTER_API_KEY_1..5 credits and model availability. phase=%s",
        phase,
    )
    return None
