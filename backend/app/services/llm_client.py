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

from app.core.config import settings, OPENAI_TEXT_MODEL, OPENAI_DESIGN_MODEL

logger = logging.getLogger(__name__)

_TIMEOUT = 45.0  # seconds
# A reference image plus a large capability schema is a bigger request than the
# text tier ever sends, and 4o is slower than 4o-mini. The design path gets more
# room so a legitimate vision call is not cut off mid-answer.
_DESIGN_TIMEOUT = 90.0  # seconds

# Fixed models per provider (fallback tier — cheap/fast JSON generation).
_OPENAI_MODEL = OPENAI_TEXT_MODEL                 # gpt-4o-mini
_GEMINI_MODEL = "gemini-2.5-flash-lite"
_ANTHROPIC_MODEL = "claude-3-5-haiku-latest"      # stable alias; bump when desired

# Vision-capable tier for the presentation "Art Director". Every one of these
# can read an attached reference image; the fallback order is unchanged.
_OPENAI_DESIGN_MODEL = OPENAI_DESIGN_MODEL        # gpt-4o
_GEMINI_DESIGN_MODEL = "gemini-2.5-flash"         # flash-lite is not reliably multimodal
_ANTHROPIC_DESIGN_MODEL = "claude-3-5-haiku-latest"


def _split_data_url(url: str) -> tuple[str, str]:
    """`data:image/png;base64,XXXX` → `("image/png", "XXXX")`.

    A bare base64 string (no `data:` prefix) is assumed to be a PNG, which is
    what a canvas/File read produces most often. A malformed value yields an
    empty payload the callers skip rather than send.
    """
    value = (url or "").strip()
    if value.startswith("data:"):
        try:
            head, b64 = value.split(",", 1)
            mime = head[5:].split(";", 1)[0] or "image/png"
            return mime, b64
        except ValueError:
            return "image/png", ""
    return "image/png", value


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
# Each accepts an optional list of image data URLs. When empty the request is
# byte-for-byte the text one that shipped before; when present the image rides
# alongside the prompt as the provider's native vision block. An image only ever
# adds CONTEXT the model reasons about — it cannot reach a dashboard, because the
# only thing this module returns is a plan the client re-validates.
def _call_openai(
    key: str, system: str, prompt: str, max_tokens: int,
    model: str = _OPENAI_MODEL, images: Optional[list[str]] = None, timeout: float = _TIMEOUT,
) -> Optional[dict]:
    if images:
        content: object = [{"type": "text", "text": prompt}] + [
            {"type": "image_url", "image_url": {"url": url}} for url in images
        ]
    else:
        content = prompt
    resp = httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
        },
        timeout=timeout,
    )
    resp.raise_for_status()
    return _parse_json_object(resp.json()["choices"][0]["message"]["content"])


def _call_gemini(
    key: str, system: str, prompt: str, max_tokens: int,
    model: str = _GEMINI_MODEL, images: Optional[list[str]] = None, timeout: float = _TIMEOUT,
) -> Optional[dict]:
    parts: list[dict] = [{"text": f"{system}\n\n{prompt}"}]
    for url in images or []:
        mime, b64 = _split_data_url(url)
        if b64:
            parts.append({"inline_data": {"mime_type": mime, "data": b64}})
    resp = httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
        headers={"Content-Type": "application/json"},
        json={
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens, "responseMimeType": "application/json"},
        },
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    text = "".join(
        p.get("text", "")
        for p in (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    )
    return _parse_json_object(text)


def _call_anthropic(
    key: str, system: str, prompt: str, max_tokens: int,
    model: str = _ANTHROPIC_MODEL, images: Optional[list[str]] = None, timeout: float = _TIMEOUT,
) -> Optional[dict]:
    if images:
        blocks: list[dict] = [{"type": "text", "text": prompt}]
        for url in images:
            mime, b64 = _split_data_url(url)
            if b64:
                blocks.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": mime, "data": b64},
                })
        content: object = blocks
    else:
        content = prompt
    resp = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
        json={
            "model": model,
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "system": f"{system}\n\nRespond with ONLY a valid JSON object, no prose.",
            "messages": [{"role": "user", "content": content}],
        },
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return _parse_json_object(text)


def _providers(design: bool = False) -> list[tuple[str, str, object, str]]:
    """Configured providers in fallback order (only those with a key).

    `design=True` swaps in the vision-capable model for each provider; the order,
    the keys and the fallback behaviour are otherwise identical, so the design
    path inherits the same "GPT out → roll to Gemini → roll to Claude" resilience
    the rest of the app relies on.
    """
    out: list[tuple[str, str, object, str]] = []
    if settings.OPENAI_API_KEY.strip():
        out.append(("openai", settings.OPENAI_API_KEY.strip(), _call_openai,
                    _OPENAI_DESIGN_MODEL if design else _OPENAI_MODEL))
    if settings.GEMINI_API_KEY.strip():
        out.append(("gemini", settings.GEMINI_API_KEY.strip(), _call_gemini,
                    _GEMINI_DESIGN_MODEL if design else _GEMINI_MODEL))
    if settings.ANTHROPIC_API_KEY.strip():
        out.append(("anthropic", settings.ANTHROPIC_API_KEY.strip(), _call_anthropic,
                    _ANTHROPIC_DESIGN_MODEL if design else _ANTHROPIC_MODEL))
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
        for name, key, call, provider_model in providers:
            try:
                result = call(key, system, prompt, max_tokens, provider_model)
                if result is not None:
                    return result
                logger.warning("LLMClient: provider %s returned no JSON — trying next", name)
            except Exception as exc:  # noqa: BLE001
                logger.warning("LLMClient: provider %s failed (%s) — falling back to next", name, exc)
                continue
        logger.error("LLMClient: all %d provider(s) failed", len(providers))
        return None

    @staticmethod
    def complete_json_multimodal(
        prompt: str,
        system: str = "You are a helpful AI assistant. Always respond with valid JSON.",
        images: Optional[list[str]] = None,
        max_tokens: int = 512,
    ) -> Optional[dict]:
        """The design tier: 4o (or a vision fallback), with an optional reference
        image. Attaching no image is a legitimate call — it is how the smarter
        model is used for a text-only "make this a modern SaaS report" request.

        Returns None only when EVERY configured provider fails, exactly like
        `complete_json`. The images are context for the model and nothing else;
        the plan it returns is validated and compiled by the client before it can
        change a single tile, so an image can never alter what a chart shows.
        """
        providers = _providers(design=True)
        if not providers:
            logger.debug("LLMClient: no AI provider key configured for the design tier")
            return None
        clean_images = [img for img in (images or []) if isinstance(img, str) and img.strip()]
        for name, key, call, provider_model in providers:
            try:
                result = call(key, system, prompt, max_tokens, provider_model,
                              clean_images or None, _DESIGN_TIMEOUT)
                if result is not None:
                    return result
                logger.warning("LLMClient(design): provider %s returned no JSON — trying next", name)
            except Exception as exc:  # noqa: BLE001
                logger.warning("LLMClient(design): provider %s failed (%s) — falling back to next", name, exc)
                continue
        logger.error("LLMClient(design): all %d provider(s) failed", len(providers))
        return None
