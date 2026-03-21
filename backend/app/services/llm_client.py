"""
Lightweight OpenRouter LLM client for backend AI tasks (auto-tagging, etc.).
Uses httpx synchronously — safe for FastAPI background tasks.
"""
import json
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "openai/gpt-4o-mini"
_TIMEOUT = 30.0  # seconds


class LLMClient:
    """Simple OpenRouter client for structured JSON completions."""

    @staticmethod
    def _get_api_key() -> Optional[str]:
        return settings.OPENROUTER_API_KEY or None

    @staticmethod
    def complete_json(
        prompt: str,
        system: str = "You are a helpful AI assistant. Always respond with valid JSON.",
        model: Optional[str] = None,
        max_tokens: int = 512,
    ) -> Optional[dict]:
        """
        Send a prompt to OpenRouter and parse the JSON response.
        Returns a dict on success, None on any failure.
        """
        api_key = LLMClient._get_api_key()
        if not api_key:
            logger.debug("LLMClient: OPENROUTER_API_KEY not set, skipping")
            return None

        payload = {
            "model": model or DEFAULT_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
        }

        try:
            response = httpx.post(
                f"{OPENROUTER_BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://appbi.io",
                    "X-Title": "AppBI Auto-Tagging",
                },
                json=payload,
                timeout=_TIMEOUT,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            return json.loads(content)
        except httpx.HTTPStatusError as exc:
            logger.warning("LLMClient: HTTP error %s — %s", exc.response.status_code, exc.response.text[:200])
            return None
        except Exception as exc:
            logger.warning("LLMClient: request failed — %s", exc)
            return None
