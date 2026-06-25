"""OpenAI Chat Completions streaming adapter with tool calling."""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator

import httpx

from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_MODEL = "gpt-4o-mini"


def _to_openai_messages(system_prompt: str, messages: list[dict]) -> list[dict]:
    out: list[dict] = [{"role": "system", "content": system_prompt}]
    for msg in messages:
        role = msg.get("role")
        if role == "user":
            text = str(msg.get("content") or "")
            image_blocks = msg.get("image_blocks") or []
            if image_blocks:
                # OpenAI multimodal: content is a list of parts, each with a
                # type ("text" | "image_url"). Image_url accepts a data URL.
                parts: list[dict] = [{"type": "text", "text": text}]
                for img in image_blocks:
                    if not isinstance(img, dict):
                        continue
                    b64 = img.get("png_base64")
                    if not b64:
                        continue
                    media = img.get("media_type") or "image/png"
                    parts.append({
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{media};base64,{b64}",
                            "detail": "low",
                        },
                    })
                out.append({"role": "user", "content": parts})
            else:
                out.append({"role": "user", "content": text})
        elif role == "assistant":
            entry: dict[str, Any] = {"role": "assistant"}
            text = msg.get("content")
            entry["content"] = str(text) if text else None
            tcs = msg.get("tool_calls") or []
            if tcs:
                entry["tool_calls"] = [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {
                            "name": tc["name"],
                            "arguments": json.dumps(tc.get("args") or {}, default=str),
                        },
                    }
                    for tc in tcs
                ]
            out.append(entry)
        elif role == "tool":
            out.append({
                "role": "tool",
                "tool_call_id": msg["tool_call_id"],
                "content": json.dumps(msg.get("result") or {}, default=str),
            })
    return out


def _to_openai_tools(tools: list[dict] | None) -> list[dict] | None:
    if not tools:
        return None
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"],
            },
        }
        for t in tools
    ]


async def stream_openai(
    *,
    api_key: str,
    system_prompt: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    model: str = OPENAI_MODEL,
    max_tokens: int = 2048,
) -> AsyncGenerator[AgentEvent, None]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    # Phase-15.70 — gpt-5 / o1 / o3 / o4 model family rejects the legacy
    # `max_tokens` field; OpenAI moved it to `max_completion_tokens`.
    # Detect the new-family by prefix so the bot keeps working as OpenAI
    # rolls out more reasoning models.
    model_lc = (model or "").strip().lower()
    uses_new_tokens_field = (
        model_lc.startswith("gpt-5")
        or model_lc.startswith("o1")
        or model_lc.startswith("o3")
        or model_lc.startswith("o4")
    )
    tokens_field = "max_completion_tokens" if uses_new_tokens_field else "max_tokens"
    # Reasoning models (gpt-5 / o-series) spend the completion budget on hidden
    # reasoning tokens BEFORE any visible output. A 2048 cap is consumed by
    # reasoning, so the model emits nothing and the turn ends with no answer.
    # Give the new family generous headroom so it can both think AND finalise.
    effective_max_tokens = max(max_tokens, 16000) if uses_new_tokens_field else max_tokens
    payload: dict[str, Any] = {
        "model": model,
        "messages": _to_openai_messages(system_prompt, messages),
        "stream": True,
        tokens_field: effective_max_tokens,
        # Ask OpenAI to emit a final chunk carrying token usage so the agent
        # loop can tally cost against the per-turn cap.
        "stream_options": {"include_usage": True},
    }
    openai_tools = _to_openai_tools(tools)
    if openai_tools:
        payload["tools"] = openai_tools

    # Aggregate streamed tool_call deltas: index -> {id, name, args_buffer}
    pending_tools: dict[int, dict[str, Any]] = {}

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream("POST", OPENAI_URL, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    detail = _extract_error_detail(body)
                    logger.warning(
                        "dashboard_ai_bot openai_error model=%s status=%s detail=%s",
                        model,
                        resp.status_code,
                        detail,
                    )
                    if resp.status_code == 429:
                        yield AgentEvent(
                            type="error",
                            text="OpenAI 429: vượt quota / bị rate-limit. Đợi vài chục giây hoặc chuyển sang gpt-4o-mini.",
                        )
                    elif resp.status_code in (401, 403):
                        yield AgentEvent(
                            type="error",
                            text="OpenAI từ chối API key (401/403). Kiểm tra key hoặc model permission.",
                        )
                    else:
                        yield AgentEvent(type="error", text=f"OpenAI {resp.status_code}: {detail}")
                    return
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

                    # The final chunk in a stream_options.include_usage stream
                    # has empty `choices` and a top-level `usage` block.
                    usage = event.get("usage")
                    if usage and isinstance(usage, dict):
                        prompt_details = usage.get("prompt_tokens_details") or {}
                        completion_details = usage.get("completion_tokens_details") or {}
                        yield AgentEvent(
                            type="usage",
                            extra={
                                "provider": "openai",
                                "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                                "completion_tokens": int(usage.get("completion_tokens") or 0),
                                "effective_prompt_tokens": int(usage.get("prompt_tokens") or 0),
                                "cached_prompt_tokens": int(prompt_details.get("cached_tokens") or 0),
                                "reasoning_tokens": int(completion_details.get("reasoning_tokens") or 0),
                            },
                        )

                    choices = event.get("choices") or []
                    if not choices:
                        continue
                    choice = choices[0]
                    delta = choice.get("delta") or {}
                    finish = choice.get("finish_reason")

                    # Streaming text
                    text = delta.get("content")
                    if text:
                        yield AgentEvent(type="text", text=text)

                    # Streaming tool calls (deltas)
                    for tc_delta in delta.get("tool_calls") or []:
                        idx = tc_delta.get("index", 0)
                        slot = pending_tools.setdefault(idx, {"id": "", "name": "", "args_buf": ""})
                        if tc_delta.get("id"):
                            slot["id"] = tc_delta["id"]
                        fn = tc_delta.get("function") or {}
                        if fn.get("name"):
                            slot["name"] = fn["name"]
                        if fn.get("arguments"):
                            slot["args_buf"] += fn["arguments"]

                    if finish in ("tool_calls", "stop", "length"):
                        # Emit any accumulated tool calls
                        for slot in sorted(pending_tools.values(), key=lambda s: s.get("id") or ""):
                            try:
                                args = json.loads(slot.get("args_buf") or "{}") or {}
                            except json.JSONDecodeError:
                                args = {}
                            yield AgentEvent(
                                type="tool_call",
                                tool_call_id=slot.get("id") or "",
                                tool_name=slot.get("name") or "",
                                tool_args=args if isinstance(args, dict) else {},
                            )
                        pending_tools.clear()
    except httpx.TimeoutException:
        logger.warning("dashboard_ai_bot openai_timeout model=%s", model)
        yield AgentEvent(type="error", text="OpenAI request timed out.")
    except Exception as exc:
        logger.exception("OpenAI stream error")
        yield AgentEvent(type="error", text=f"OpenAI transport error: {type(exc).__name__}")


def _extract_error_detail(body: bytes) -> str:
    try:
        obj = json.loads(body)
        return str(obj.get("error", {}).get("message") or obj)[:300]
    except Exception:
        return body.decode(errors="replace")[:300]
