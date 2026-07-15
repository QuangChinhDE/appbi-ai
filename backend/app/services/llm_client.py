"""Multi-provider LLM client for backend AI tasks (auto-tagging, descriptions,
HTML import). Returns JSON.

Fallback chain: OpenAI → Gemini → Anthropic (Claude). Each provider is tried in
order using its OWN key; on quota/auth/error the next provider is used, so a
GPT outage/limit automatically rolls over to Gemini, then Claude. Models are
fixed in code. Returns None only when EVERY configured provider fails.

The report AI Bot is separate (per-link keys) and unaffected by this module.
"""
import json
import logging
import re
from typing import Optional

import httpx

from app.core.config import settings, OPENAI_TEXT_MODEL

logger = logging.getLogger(__name__)

_TIMEOUT = 45.0  # seconds

# Fixed models per provider (fallback tier — cheap/fast JSON generation).
_OPENAI_MODEL = OPENAI_TEXT_MODEL                 # gpt-4o-mini
_GEMINI_MODEL = "gemini-2.5-flash-lite"
_ANTHROPIC_MODEL = "claude-3-5-haiku-latest"      # stable alias; bump when desired


def _parse_json_object(content: str) -> Optional[dict]:
    text = (content or "").strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


# ── per-provider calls (raise on failure → caller rolls to next provider) ────
def _call_openai(key: str, system: str, prompt: str, max_tokens: int) -> Optional[dict]:
    resp = httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": _OPENAI_MODEL,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
        },
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return _parse_json_object(resp.json()["choices"][0]["message"]["content"])


def _call_gemini(key: str, system: str, prompt: str, max_tokens: int) -> Optional[dict]:
    resp = httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{_GEMINI_MODEL}:generateContent?key={key}",
        headers={"Content-Type": "application/json"},
        json={
            "contents": [{"role": "user", "parts": [{"text": f"{system}\n\n{prompt}"}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens, "responseMimeType": "application/json"},
        },
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    text = "".join(
        p.get("text", "")
        for p in (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    )
    return _parse_json_object(text)


def _call_anthropic(key: str, system: str, prompt: str, max_tokens: int) -> Optional[dict]:
    resp = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
        json={
            "model": _ANTHROPIC_MODEL,
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "system": f"{system}\n\nRespond with ONLY a valid JSON object, no prose.",
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return _parse_json_object(text)


def _providers() -> list[tuple[str, str, object]]:
    """Configured providers in fallback order (only those with a key)."""
    out: list[tuple[str, str, object]] = []
    if settings.OPENAI_API_KEY.strip():
        out.append(("openai", settings.OPENAI_API_KEY.strip(), _call_openai))
    if settings.GEMINI_API_KEY.strip():
        out.append(("gemini", settings.GEMINI_API_KEY.strip(), _call_gemini))
    if settings.ANTHROPIC_API_KEY.strip():
        out.append(("anthropic", settings.ANTHROPIC_API_KEY.strip(), _call_anthropic))
    return out


class LLMClient:
    """JSON-only client with cross-provider fallback (OpenAI → Gemini → Claude)."""

    @staticmethod
    def complete_json(
        prompt: str,
        system: str = "You are a helpful AI assistant. Always respond with valid JSON.",
        model: Optional[str] = None,  # accepted for backward-compat; models are fixed per provider
        max_tokens: int = 512,
    ) -> Optional[dict]:
        providers = _providers()
        if not providers:
            logger.debug("LLMClient: no AI provider key configured (OPENAI/GEMINI/ANTHROPIC)")
            return None
        for name, key, call in providers:
            try:
                result = call(key, system, prompt, max_tokens)
                if result is not None:
                    return result
                logger.warning("LLMClient: provider %s returned no JSON — trying next", name)
            except Exception as exc:  # noqa: BLE001
                logger.warning("LLMClient: provider %s failed (%s) — falling back to next", name, exc)
                continue
        logger.error("LLMClient: all %d provider(s) failed", len(providers))
        return None
