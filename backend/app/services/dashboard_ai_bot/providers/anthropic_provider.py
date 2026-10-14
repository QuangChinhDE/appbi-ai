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


def _tool_payload(msg: dict) -> str:
    """The tool's output, whichever key the caller used.

    The documented contract is `result`; the flow engine sent `content`, and this
    translation read only `result` — so every tool result an Agent Flow node
    produced arrived at the model as `{}`. The model then answered a question about
    a report it had effectively never been shown, and nothing anywhere said so.

    Accepting both keys is not tolerance for sloppiness: it is a boundary that
    cannot silently drop the one thing it exists to carry. A payload that is
    genuinely absent is reported as such, so it fails loudly instead of looking
    like an empty result set.
    """
    import json as _json

    for key in ("result", "content"):
        if key in msg and msg[key] is not None:
            value = msg[key]
            if isinstance(value, str):
                return value
            return _json.dumps(value, default=str)
    return _json.dumps({"ok": False, "error": "tool result missing from the message"})


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
            # THE ROUND EXACTLY AS THE MODEL PRODUCED IT. A thinking model's tool
            # turn must come back with every thinking / redacted_thinking block
            # complete and unmodified, in order, beside its tool_use (Anthropic:
            # "Modified thinking blocks are rejected with a 400 error"). The
            # runtime carries the round's blocks as `provider_state.content`.
            kept = (msg.get("provider_state") or {}).get("content")
            if isinstance(kept, list) and kept:
                out.append({"role": "assistant", "content": kept})
                continue
            blocks: list[dict] = []
            text = msg.get("content")
            if text:
                blocks.append({"type": "text", "text": str(text)})
            for tc in msg.get("tool_calls") or []:
                blocks.append({
                    "type": "tool_use",
                    "id": tc["id"],
                    "name": tc["name"],
                    "input": _tool_args(tc),
                })
            if blocks:
                out.append({"role": "assistant", "content": blocks})
        elif role == "tool":
            pending_tool_results.append({
                "type": "tool_result",
                "tool_use_id": msg["tool_call_id"],
                "content": _tool_payload(msg),
            })
    _flush_tool_results()
    return out


def _tool_args(tc: dict) -> dict:
    for key in ("args", "arguments"):
        value = tc.get(key)
        if isinstance(value, dict) and value:
            return value
    return {}


def _tools_named_in(messages: list[dict]) -> list[dict]:
    """Minimal definitions for the tools a history already used.

    An answer-only round over a tool history must still DEFINE those tools — the
    API refuses tool_use blocks otherwise — and must not rewrite them into text
    on a thinking model (that changes the turn the thinking belongs to). Declared
    with `tool_choice: none`, so nothing can be called.
    """
    names: list[str] = []
    for msg in messages:
        for block in msg.get("content") if isinstance(msg.get("content"), list) else []:
            if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") not in names:
                names.append(block.get("name"))
    return [{"name": n, "description": "(đã dùng ở lượt trước)",
             "input_schema": {"type": "object", "additionalProperties": True}} for n in names if n]


def _flatten_tool_blocks(messages: list[dict]) -> list[dict]:
    """tool_use / tool_result blocks → text blocks, preserving order and roles."""
    out: list[dict] = []
    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, list):
            out.append(msg)
            continue
        blocks: list[dict] = []
        for block in content:
            kind = block.get("type") if isinstance(block, dict) else None
            if kind == "tool_use":
                blocks.append({"type": "text", "text": "[đã gọi %s %s]" % (
                    block.get("name"), json.dumps(block.get("input") or {}, ensure_ascii=False)[:2000])})
            elif kind == "tool_result":
                body = block.get("content")
                if isinstance(body, list):
                    body = " ".join(str(b.get("text") or "") for b in body if isinstance(b, dict))
                blocks.append({"type": "text", "text": "[kết quả công cụ] %s" % str(body or "")})
            else:
                blocks.append(block)
        out.append({**msg, "content": blocks})
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
    strict: bool = False,
) -> AsyncGenerator[AgentEvent, None]:
    """Stream one Messages call.

    `strict` is the Agent Flow contract (other callers keep today's behaviour):
    thinking blocks are captured with their signatures and the round's content is
    emitted as `provider_state` for verbatim replay; an answer-only round keeps the
    tool history structurally intact (`tool_choice: none`) instead of flattening
    it; output cut at `max_tokens` and malformed tool arguments are reported;
    errors carry a classified `code`.
    """
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
    used = _tools_named_in(payload["messages"]) if (strict and not tools) else []
    if used:
        payload["tools"] = used
        payload["tool_choice"] = {"type": "none"}
    elif not tools:
        # AN ANSWER-ONLY ROUND OVER A TOOL HISTORY. Anthropic refuses a request
        # whose messages hold tool_use / tool_result blocks when it defines no
        # tools — which is exactly an agent's final round and every correction
        # round. The history is kept, as text, so the model still reads what the
        # tools returned; nothing is offered to call.
        payload["messages"] = _flatten_tool_blocks(payload["messages"])
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
    #: Strict mode: the round's content blocks in order, exactly as produced.
    round_blocks: list[tuple[int, dict]] = []
    stop_reason = ""
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
                    if strict:
                        from app.services.dashboard_ai_bot.providers.errors import classify

                        perr = classify(resp.status_code, body)
                        logger.warning("agent_flow anthropic_error model=%s status=%s code=%s",
                                       model, resp.status_code, perr.code)
                        yield AgentEvent(type="error", text=perr.text("Anthropic", model), extra=perr.extra())
                        return
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
                            extra={"http_status": 429},
                        )
                    elif resp.status_code in (401, 403):
                        yield AgentEvent(
                            type="error",
                            text="Anthropic từ chối API key (401/403). Kiểm tra lại key hoặc quyền truy cập model.",
                            extra={"http_status": resp.status_code},
                        )
                    else:
                        yield AgentEvent(
                            type="error",
                            text=f"Anthropic {resp.status_code}: {detail}",
                            extra={"http_status": resp.status_code},
                        )
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
                        elif bt == "thinking":
                            blocks[idx] = {"type": "thinking", "thinking": block.get("thinking") or "",
                                           "signature": block.get("signature") or ""}
                        elif bt == "redacted_thinking":
                            blocks[idx] = {"type": "redacted_thinking", "data": block.get("data") or ""}
                        else:
                            blocks[idx] = {"type": "text", "text": ""}
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
                                if block.get("type") == "text":
                                    block["text"] = block.get("text", "") + text
                                yield AgentEvent(type="text", text=text)
                        elif dt == "thinking_delta":
                            # Kept for replay, never shown to the reader.
                            block["thinking"] = block.get("thinking", "") + (delta.get("thinking") or "")
                        elif dt == "signature_delta":
                            block["signature"] = block.get("signature", "") + (delta.get("signature") or "")
                        elif dt == "input_json_delta":
                            block["input_json"] += delta.get("partial_json") or ""
                    elif et == "content_block_stop":
                        idx = event.get("index", 0)
                        block = blocks.pop(idx, None)
                        if block and block.get("type") in ("thinking", "redacted_thinking"):
                            round_blocks.append((idx, dict(block)))
                        elif block and block.get("type") == "text" and block.get("text"):
                            round_blocks.append((idx, {"type": "text", "text": block["text"]}))
                        if block and block.get("type") == "tool_use":
                            malformed = ""
                            try:
                                args = json.loads(block.get("input_json") or "{}") or {}
                            except json.JSONDecodeError as exc:
                                args, malformed = {}, str(exc)
                            if not isinstance(args, dict):
                                args, malformed = {}, "arguments were not a JSON object"
                            round_blocks.append((idx, {"type": "tool_use", "id": block.get("id") or "",
                                                       "name": block.get("name") or "", "input": args}))
                            yield AgentEvent(
                                type="tool_call",
                                tool_call_id=block.get("id") or "",
                                tool_name=block.get("name") or "",
                                tool_args=args,
                                extra={"malformed_args": malformed} if (strict and malformed) else {},
                            )
                    # message_delta / message_stop: nothing to emit
                    elif et == "message_delta":
                        u = (event.get("usage") or {})
                        if u:
                            usage_out += int(u.get("output_tokens") or 0)
                        stop_reason = str((event.get("delta") or {}).get("stop_reason") or stop_reason)
                    elif et == "message_stop":
                        if strict and any(b.get("type") in ("thinking", "redacted_thinking")
                                          for _, b in round_blocks):
                            yield AgentEvent(type="provider_state", extra={"state": {
                                "content": [b for _, b in sorted(round_blocks, key=lambda p: p[0])]}})
                        if strict and stop_reason == "max_tokens":
                            from app.services.dashboard_ai_bot.providers.errors import ProviderError

                            perr = ProviderError("truncated", 200)
                            yield AgentEvent(type="error", text=perr.text("Anthropic", model), extra=perr.extra())
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
        yield AgentEvent(type="error", text="Anthropic request timed out.",
                         extra={"http_status": 408, "code": "timeout", "retryable": True})
    except Exception as exc:
        logger.exception("Anthropic stream error")
        yield AgentEvent(type="error", text=f"Anthropic transport error: {type(exc).__name__}",
                         extra={"http_status": 503, "code": "stream_interrupted", "retryable": True})


def _extract_error_detail(body: bytes) -> str:
    try:
        obj = json.loads(body)
        return str(obj.get("error", {}).get("message") or obj)[:300]
    except Exception:
        return body.decode(errors="replace")[:300]
