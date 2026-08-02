"""Gemini single-shot streaming adapter (no tool calling).

Gemini function calling reliability is uneven across the 1.5/2.0 generations,
and our agent loop is sensitive to malformed tool args. We keep Gemini as a
text-only fallback: the caller is expected to stuff pre-computed Insight Packs
into the system prompt before invoking this adapter.
"""
from __future__ import annotations

import json
import logging
from typing import AsyncGenerator

import httpx

from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)

# gemini-1.5-flash is EOL for new projects — 2.5-flash is the live default.
GEMINI_MODEL = "gemini-2.5-flash"


def _to_gemini_contents(messages: list[dict]) -> list[dict]:
    contents: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        if role == "user":
            parts: list[dict] = [{"text": str(msg.get("content") or "")}]
            for img in msg.get("image_blocks") or []:
                if not isinstance(img, dict):
                    continue
                b64 = img.get("png_base64")
                if not b64:
                    continue
                parts.append({
                    "inline_data": {
                        "mime_type": img.get("media_type") or "image/png",
                        "data": b64,
                    },
                })
            contents.append({"role": "user", "parts": parts})
        elif role == "assistant":
            text = msg.get("content")
            if text:
                contents.append({"role": "model", "parts": [{"text": str(text)}]})
        # tool turns are ignored — caller should be using the tool-aware providers
    return contents


async def stream_gemini_singleshot(
    *,
    api_key: str,
    system_prompt: str,
    messages: list[dict],
    tools: list[dict] | None = None,  # ignored
    model: str = GEMINI_MODEL,
    max_tokens: int = 2048,
) -> AsyncGenerator[AgentEvent, None]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent"
    headers = {"Content-Type": "application/json"}
    params = {"key": api_key, "alt": "sse"}

    payload: dict = {
        "contents": _to_gemini_contents(messages),
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {"maxOutputTokens": max_tokens},
    }

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream("POST", url, headers=headers, params=params, json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    detail = _extract_error_detail(body)
                    logger.warning(
                        "dashboard_ai_bot gemini_error model=%s status=%s detail=%s",
                        model,
                        resp.status_code,
                        detail,
                    )
                    yield AgentEvent(type="error", text=f"Gemini {resp.status_code}: {detail}", extra={"http_status": resp.status_code})
                    return
                latest_usage: dict | None = None
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    for cand in event.get("candidates") or []:
                        for part in (cand.get("content") or {}).get("parts") or []:
                            text = part.get("text") or ""
                            if text:
                                yield AgentEvent(type="text", text=text)
                    meta = event.get("usageMetadata")
                    if meta:
                        thought_tokens = int(meta.get("thoughtsTokenCount") or 0)
                        tool_use_prompt_tokens = int(meta.get("toolUsePromptTokenCount") or 0)
                        latest_usage = {
                            "provider": "gemini",
                            "prompt_tokens": int(meta.get("promptTokenCount") or 0),
                            "completion_tokens": (
                                int(meta.get("candidatesTokenCount") or 0)
                                + thought_tokens
                            ),
                            "effective_prompt_tokens": int(meta.get("promptTokenCount") or 0),
                            "cached_content_tokens": int(meta.get("cachedContentTokenCount") or 0),
                            "thought_tokens": thought_tokens,
                            "tool_use_prompt_tokens": tool_use_prompt_tokens,
                        }
                if latest_usage:
                    yield AgentEvent(type="usage", extra=latest_usage)
    except httpx.TimeoutException:
        logger.warning("dashboard_ai_bot gemini_timeout model=%s", model)
        yield AgentEvent(type="error", text="Gemini request timed out.", extra={"http_status": 408})
    except Exception as exc:
        logger.exception("Gemini stream error")
        yield AgentEvent(type="error", text=f"Gemini transport error: {type(exc).__name__}", extra={"http_status": 503})


def _extract_error_detail(body: bytes) -> str:
    try:
        obj = json.loads(body)
        return str(obj.get("error", {}).get("message") or obj)[:300]
    except Exception:
        return body.decode(errors="replace")[:300]
