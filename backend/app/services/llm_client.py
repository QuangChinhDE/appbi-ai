"""
OpenRouter-backed LLM client for backend AI tasks (auto-tagging, descriptions).
"""
import json
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
_TIMEOUT = 45.0  # seconds


class LLMClient:
    """Minimal JSON-only client for backend AI generation tasks."""

    @staticmethod
    def _call_openrouter(
        prompt: str, system: str, model: str, max_tokens: int
    ) -> Optional[dict]:
        api_key = settings.OPENROUTER_API_KEY
        if not api_key:
            return None

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
        Send a prompt through OpenRouter and parse the JSON response.
        Returns None on failure or when no API key is configured.
        """
        if not settings.OPENROUTER_API_KEY:
            logger.debug("LLMClient: OPENROUTER_API_KEY not configured")
            return None

        effective_model = model or settings.active_description_model

        try:
            result = LLMClient._call_openrouter(prompt, system, effective_model, max_tokens)
            if result is not None:
                return result
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "LLMClient: OpenRouter HTTP error %s - %s",
                exc.response.status_code,
                exc.response.text[:200],
            )
        except Exception as exc:
            logger.warning("LLMClient: OpenRouter failed - %s", exc)

        return None
