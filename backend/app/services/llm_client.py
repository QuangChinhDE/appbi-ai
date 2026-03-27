"""
OpenRouter-backed LLM client for backend AI tasks (auto-tagging, descriptions).
Supports multi-key rotation: tries OPENROUTER_API_KEY_1..5 in order,
falls back to bare OPENROUTER_API_KEY, stops and logs when all keys are exhausted.
"""
import json
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
_TIMEOUT = 45.0  # seconds

_KEY_EXHAUSTED_STATUSES = {401, 402, 403, 429}


def _is_key_exhausted(exc: Exception) -> bool:
    """Return True when the error signals quota/auth failure for this key."""
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in _KEY_EXHAUSTED_STATUSES
    msg = str(exc).lower()
    return any(kw in msg for kw in ("401", "402", "403", "429", "rate limit", "quota", "insufficient credits", "invalid api key"))


class LLMClient:
    """Minimal JSON-only client for backend AI generation tasks."""

    @staticmethod
    def _call_with_key(
        api_key: str, prompt: str, system: str, model: str, max_tokens: int
    ) -> Optional[dict]:
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
        }
        response = httpx.post(
            f"{OPENROUTER_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": settings.OPENROUTER_SITE_URL,
                "X-Title": settings.OPENROUTER_APP_NAME,
            },
            json=payload,
            timeout=_TIMEOUT,
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return json.loads(content)

    @staticmethod
    def complete_json(
        prompt: str,
        system: str = "You are a helpful AI assistant. Always respond with valid JSON.",
        model: Optional[str] = None,
        max_tokens: int = 512,
    ) -> Optional[dict]:
        """
        Send a prompt through OpenRouter with automatic key rotation.

        Tries each key in OPENROUTER_API_KEY_1..5 order (or bare OPENROUTER_API_KEY).
        Rotates to next key on 401/402/403/429. Returns None when all keys fail.
        """
        api_keys = settings.active_api_keys
        if not api_keys:
            logger.debug("LLMClient: no OPENROUTER_API_KEY configured")
            return None

        effective_model = model or settings.active_description_model

        for key_index, api_key in enumerate(api_keys, start=1):
            try:
                result = LLMClient._call_with_key(api_key, prompt, system, effective_model, max_tokens)
                if result is not None:
                    return result
            except Exception as exc:
                if _is_key_exhausted(exc):
                    logger.warning(
                        "LLMClient: API key #%d exhausted (model=%s): %s — trying next key",
                        key_index, effective_model, exc,
                    )
                    continue
                logger.warning("LLMClient: OpenRouter failed with key #%d — %s", key_index, exc)
                return None  # non-quota error — don't rotate

        logger.error(
            "LLMClient: all %d OpenRouter API key(s) exhausted. "
            "Check credits on OPENROUTER_API_KEY_1..5.",
            len(api_keys),
        )
        return None
