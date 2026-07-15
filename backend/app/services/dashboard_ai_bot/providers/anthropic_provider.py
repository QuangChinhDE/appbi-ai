"""Anthropic Messages API streaming adapter with tool use."""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator

import httpx

from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
# Alias (no date suffix) — claude-3-5-haiku-20241022 was retired 2026-02-19.
ANTHROPIC_MODEL = "claude-haiku-4-5"


def _to_anthropic_messages(messages: list[dict]) -> list[dict]:
    """Translate our internal message log to Anthropic's wire format.

    Internal format (one entry per turn):
      - {"role": "user" | "assistant", "content": "..."}            (plain text)
      - {"role": "assistant", "tool_calls": [{"id","name","args"}]} (model asked for tools)
      - {"role": "tool",      "tool_call_id": "...", "result": {..}} (tool output)

    Anthropic wants ``content`` to be a list of blocks for tool messages.
    """
    out: list[dict] = []
    pending_tool_results: list[dict] = []

    def _flush_tool_results():
        nonlocal pending_tool_results
        if pending_tool_results:
            out.append({"role": "user", "content": pending_tool_results})
            pending_tool_results = []

    for msg in messages:
        role = msg.get("role")
        if role == "user":
            _flush_tool_results()
            blocks: list[dict] = [{"type": "text", "text": str(msg.get("content") or "")}]
            # Multimodal image blocks (Phase D). Anthropic accepts:
            #   {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}
            for img in msg.get("image_blocks") or []:
                if not isinstance(img, dict):
                    continue
                b64 = img.get("png_base64")
                if not b64:
                    continue
                blocks.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": img.get("media_type") or "image/png",
                        "data": b64,
                    },
                })
            out.append({"role": "user", "content": blocks})
        elif role == "assistant":
            _flush_tool_results()
            blocks: list[dict] = []
            text = msg.get("content")
            if text:
                blocks.append({"type": "text", "text": str(text)})
            for tc in msg.get("tool_calls") or []:
                blocks.append({
                    "type": "tool_use",
                    "id": tc["id"],
                    "name": tc["name"],
                    "input": tc.get("args") or {},
                })
            if blocks:
                out.append({"role": "assistant", "content": blocks})
        elif role == "tool":
            pending_tool_results.append({
                "type": "tool_result",
                "tool_use_id": msg["tool_call_id"],
                "content": json.dumps(msg.get("result") or {}, default=str),
            })
    _flush_tool_results()
    return out


def _to_anthropic_tools(tools: list[dict] | None) -> list[dict] | None:
    if not tools:
        return None
    return [
        {
            "name": t["name"],
            "description": t["description"],
            "input_schema": t["input_schema"],
        }
        for t in tools
    ]


async def stream_anthropic(
    *,
    api_key: str,
    system_prompt: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    model: str = ANTHROPIC_MODEL,
    max_tokens: int = 2048,
) -> AsyncGenerator[AgentEvent, None]:
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        # prompt-caching is generally available but the beta header is still
        # honoured and helps older accounts opt in.
        "anthropic-beta": "prompt-caching-2024-07-31",
        "content-type": "application/json",
    }
    # Prompt caching (anthropic-beta): system + tools blocks rarely change
    # within a single chat session, so we mark them with cache_control. This
    # cuts ~60% of input cost on every follow-up turn (cache TTL ≈ 5 min).
    payload: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        # System as a list of blocks lets us pin cache_control on the last
        # one. Anthropic accepts either a string or a list here.
        "system": [
            {
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "messages": _to_anthropic_messages(messages),
        "stream": True,
    }
    anthropic_tools = _to_anthropic_tools(tools)
    if anthropic_tools:
        # Mark the last tool definition with cache_control so the entire
        # tool catalog gets cached as part of the prefix.
        cached_tools = list(anthropic_tools)
        if cached_tools:
            cached_tools[-1] = {
                **cached_tools[-1],
                "cache_control": {"type": "ephemeral"},
            }
        payload["tools"] = cached_tools

    # Track in-flight blocks: index -> {type, id, name, input_buffer}
    blocks: dict[int, dict[str, Any]] = {}
    # Anthropic emits usage in two parts: input_tokens lands in message_start
    # while output_tokens streams in message_delta and is finalised by
    # message_stop. Tally locally and emit once when the response ends.
    usage_in: int = 0
    usage_base_in: int = 0
    usage_cache_read_in: int = 0
    usage_cache_create_in: int = 0
    usage_cache_create_5m_in: int = 0
    usage_cache_create_1h_in: int = 0
    usage_out: int = 0

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream("POST", ANTHROPIC_URL, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    detail = _extract_error_detail(body)
                    logger.warning(
                        "dashboard_ai_bot anthropic_error model=%s status=%s detail=%s",
                        model,
                        resp.status_code,
                        detail,
                    )
                    if resp.status_code == 429:
                        yield AgentEvent(
                            type="error",
                            text="Anthropic 429: API key bị giới hạn rate. Hãy chờ ~30s rồi thử lại, hoặc đổi sang model nhẹ hơn (Haiku).",
                        )
                    elif resp.status_code in (401, 403):
                        yield AgentEvent(
                            type="error",
                            text="Anthropic từ chối API key (401/403). Kiểm tra lại key hoặc quyền truy cập model.",
                        )
                    else:
                        yield AgentEvent(type="error", text=f"Anthropic {resp.status_code}: {detail}")
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

                    et = event.get("type")
                    if et == "message_start":
                        msg_obj = event.get("message") or {}
                        u = msg_obj.get("usage") or {}
                        usage_base_in += int(u.get("input_tokens") or 0)
                        usage_cache_read_in += int(u.get("cache_read_input_tokens") or 0)
                        usage_cache_create_in += int(u.get("cache_creation_input_tokens") or 0)
                        usage_in = usage_base_in + usage_cache_read_in + usage_cache_create_in
                        cache_creation = u.get("cache_creation") or {}
                        usage_cache_create_5m_in += int(
                            cache_creation.get("ephemeral_5m_input_tokens") or 0,
                        )
                        usage_cache_create_1h_in += int(
                            cache_creation.get("ephemeral_1h_input_tokens") or 0,
                        )
                        usage_out += int(u.get("output_tokens") or 0)
                    elif et == "content_block_start":
                        idx = event.get("index", 0)
                        block = event.get("content_block") or {}
                        bt = block.get("type")
                        if bt == "tool_use":
                            blocks[idx] = {
                                "type": "tool_use",
                                "id": block.get("id"),
                                "name": block.get("name"),
                                "input_json": "",
                            }
                        else:
                            blocks[idx] = {"type": "text"}
                    elif et == "content_block_delta":
                        idx = event.get("index", 0)
                        delta = event.get("delta") or {}
                        dt = delta.get("type")
                        block = blocks.get(idx)
                        if not block:
                            continue
                        if dt == "text_delta":
                            text = delta.get("text") or ""
                            if text:
                                yield AgentEvent(type="text", text=text)
                        elif dt == "input_json_delta":
                            block["input_json"] += delta.get("partial_json") or ""
                    elif et == "content_block_stop":
                        idx = event.get("index", 0)
                        block = blocks.pop(idx, None)
                        if block and block.get("type") == "tool_use":
                            try:
                                args = json.loads(block.get("input_json") or "{}") or {}
                            except json.JSONDecodeError:
                                args = {}
                            yield AgentEvent(
                                type="tool_call",
                                tool_call_id=block.get("id") or "",
                                tool_name=block.get("name") or "",
                                tool_args=args if isinstance(args, dict) else {},
                            )
                    # message_delta / message_stop: nothing to emit
                    elif et == "message_delta":
                        u = (event.get("usage") or {})
                        if u:
                            usage_out += int(u.get("output_tokens") or 0)
                    elif et == "message_stop":
                        if usage_in or usage_out:
                            yield AgentEvent(
                                type="usage",
                                extra={
                                    "provider": "anthropic",
                                    "prompt_tokens": usage_in,
                                    "completion_tokens": usage_out,
                                    "effective_prompt_tokens": usage_in,
                                    "base_input_tokens": usage_base_in,
                                    "cache_read_input_tokens": usage_cache_read_in,
                                    "cache_creation_input_tokens": usage_cache_create_in,
                                    "cache_creation_input_tokens_5m": usage_cache_create_5m_in,
                                    "cache_creation_input_tokens_1h": usage_cache_create_1h_in,
                                },
                            )
                            usage_in = 0
                            usage_base_in = 0
                            usage_cache_read_in = 0
                            usage_cache_create_in = 0
                            usage_cache_create_5m_in = 0
                            usage_cache_create_1h_in = 0
                            usage_out = 0
    except httpx.TimeoutException:
        logger.warning("dashboard_ai_bot anthropic_timeout model=%s", model)
        yield AgentEvent(type="error", text="Anthropic request timed out.")
    except Exception as exc:
        logger.exception("Anthropic stream error")
        yield AgentEvent(type="error", text=f"Anthropic transport error: {type(exc).__name__}")


def _extract_error_detail(body: bytes) -> str:
    try:
        obj = json.loads(body)
        return str(obj.get("error", {}).get("message") or obj)[:300]
    except Exception:
        return body.decode(errors="replace")[:300]
