"""Anthropic Messages API streaming adapter with tool use."""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator

import httpx

from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-3-5-haiku-20241022"


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
            out.append({"role": "user", "content": [
                {"type": "text", "text": str(msg.get("content") or "")},
            ]})
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
        "content-type": "application/json",
    }
    payload: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": _to_anthropic_messages(messages),
        "stream": True,
    }
    anthropic_tools = _to_anthropic_tools(tools)
    if anthropic_tools:
        payload["tools"] = anthropic_tools

    # Track in-flight blocks: index -> {type, id, name, input_buffer}
    blocks: dict[int, dict[str, Any]] = {}

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
                    if et == "content_block_start":
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
