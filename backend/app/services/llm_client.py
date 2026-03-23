"""
Lightweight LLM client for backend AI tasks (auto-tagging, etc.).
Tries OpenAI first (if OPENAI_API_KEY is set), falls back to OpenRouter.
Uses httpx synchronously — safe for FastAPI background tasks.
"""
import json
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

OPENAI_BASE_URL = "https://api.openai.com/v1"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "gpt-4o-mini"
_TIMEOUT = 45.0  # seconds


class LLMClient:
    """LLM client that tries OpenAI first, then OpenRouter as fallback."""

    @staticmethod
    def _call_openai(
        prompt: str, system: str, model: str, max_tokens: int
    ) -> Optional[dict]:
        api_key = settings.OPENAI_API_KEY
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
            f"{OPENAI_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=_TIMEOUT,
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return json.loads(content)

    @staticmethod
    def _call_openrouter(
        prompt: str, system: str, model: str, max_tokens: int
    ) -> Optional[dict]:
        api_key = settings.OPENROUTER_API_KEY
        if not api_key:
            return None
        payload = {
            "model": f"openai/{model}" if not "/" in model else model,
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
                "HTTP-Referer": "https://appbi.io",
                "X-Title": "AppBI Auto-Tagging",
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
        Send a prompt and parse the JSON response.
        Tries OpenAI first, then OpenRouter. Returns None on all failures.
        """
        effective_model = model or DEFAULT_MODEL

        # Try OpenAI first
        if settings.OPENAI_API_KEY:
            try:
                result = LLMClient._call_openai(prompt, system, effective_model, max_tokens)
                if result is not None:
                    return result
            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "LLMClient: OpenAI HTTP error %s — %s",
                    exc.response.status_code, exc.response.text[:200]
                )
            except Exception as exc:
                logger.warning("LLMClient: OpenAI failed — %s", exc)

        # Fall back to OpenRouter
        if settings.OPENROUTER_API_KEY:
            try:
                result = LLMClient._call_openrouter(prompt, system, effective_model, max_tokens)
                if result is not None:
                    return result
            except httpx.HTTPStatusError as exc:
                logger.warning(
                    "LLMClient: OpenRouter HTTP error %s — %s",
                    exc.response.status_code, exc.response.text[:200]
                )
            except Exception as exc:
                logger.warning("LLMClient: OpenRouter failed — %s", exc)

        logger.debug("LLMClient: No API keys configured or all providers failed")
        return None
