"""OpenAI Responses API streaming adapter with tool calling — the GPT-6 family.

WHY A SECOND OPENAI ADAPTER
---------------------------
Not a second way to do the same thing: a different protocol. GPT-6 models call
tools only through `/v1/responses` (OpenAI's model guide: "Use the Responses API
for tool calling"; Astra rejects tools on Chat Completions outright). The request
shape, the stream events and — above all — the state carried between tool rounds
all differ from Chat Completions, which `openai_provider.stream_openai` keeps
serving for the models catalogued `endpoint="chat_completions"`.

STATELESS, AND THE ROUND'S ITEMS GO BACK UNCHANGED
-------------------------------------------------
`store: false` — AppBI keeps no conversation on OpenAI's side. So the reasoning
items a model produced before a tool call (with their `encrypted_content`) must
be sent back with the call's output, or the model resumes without the reasoning
that chose the call. The adapter emits every output item of a round as
`provider_state` ({"items": [...]}); the runtime stores it on that assistant turn
opaquely, and on the next round this adapter replays those items verbatim in
place of a reconstruction. A turn without state (history from elsewhere) is
rebuilt from text and tool calls.

Same event contract as the other adapters: `text`, `tool_call`, `usage`,
`provider_state`, and `error` with a classified `code`.
"""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator

import httpx

from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.dashboard_ai_bot.providers.errors import ProviderError, classify
from app.services.dashboard_ai_bot.providers.openai_provider import _tool_args, _tool_payload

logger = logging.getLogger(__name__)

RESPONSES_URL = "https://api.openai.com/v1/responses"
#: Item fields the API returns but does not accept back on input.
_OUTPUT_ONLY = ("status",)


def _user_content(msg: dict) -> Any:
    text = str(msg.get("content") or "")
    images = [img for img in (msg.get("image_blocks") or []) if isinstance(img, dict) and img.get("png_base64")]
    if not images:
        return text
    parts: list[dict] = [{"type": "input_text", "text": text}]
    for img in images:
        parts.append({"type": "input_image", "detail": "low",
                      "image_url": f"data:{img.get('media_type') or 'image/png'};base64,{img['png_base64']}"})
    return parts


def to_input(messages: list[dict]) -> list[dict]:
    """Our message log → Responses `input` items."""
    out: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        if role == "user":
            out.append({"role": "user", "content": _user_content(msg)})
        elif role == "assistant":
            items = (msg.get("provider_state") or {}).get("items")
            if isinstance(items, list) and items:
                # The round exactly as the model produced it: reasoning, message
                # and function_call items, in order.
                out.extend({k: v for k, v in it.items() if k not in _OUTPUT_ONLY}
                           for it in items if isinstance(it, dict))
                continue
            text = msg.get("content")
            if text:
                out.append({"role": "assistant", "content": str(text)})
            for tc in msg.get("tool_calls") or []:
                out.append({"type": "function_call", "call_id": tc["id"], "name": tc["name"],
                            "arguments": json.dumps(_tool_args(tc), default=str)})
        elif role == "tool":
            out.append({"type": "function_call_output", "call_id": msg["tool_call_id"],
                        "output": _tool_payload(msg)})
    return out


def to_tools(tools: list[dict] | None) -> list[dict] | None:
    if not tools:
        return None
    # `strict: false` — the registry's schemas are not written to OpenAI's strict
    # subset (optional fields, open objects); strict mode would reject them.
    return [{"type": "function", "name": t["name"], "description": t["description"],
             "parameters": t["input_schema"], "strict": False} for t in tools]


async def stream_openai_responses(
    *,
    api_key: str,
    system_prompt: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    model: str,
    max_tokens: int = 16000,
    reasoning_effort: str | None = None,
) -> AsyncGenerator[AgentEvent, None]:
    label = "OpenAI"
    payload: dict[str, Any] = {
        "model": model,
        "instructions": system_prompt,
        "input": to_input(messages),
        "stream": True,
        "store": False,
        # Reasoning items come back encrypted so they can be replayed statelessly.
        "include": ["reasoning.encrypted_content"],
        # Caps visible AND reasoning tokens together (OpenAI reasoning guide).
        "max_output_tokens": max_tokens,
    }
    if reasoning_effort:
        payload["reasoning"] = {"effort": reasoning_effort}
    rtools = to_tools(tools)
    if rtools:
        payload["tools"] = rtools
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    items: list[dict] = []
    final: dict = {}
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            async with client.stream("POST", RESPONSES_URL, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    perr = classify(resp.status_code, body)
                    logger.warning("agent_flow openai_responses_error model=%s status=%s code=%s",
                                   model, resp.status_code, perr.code)
                    yield AgentEvent(type="error", text=perr.text(label, model), extra=perr.extra())
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        ev = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    et = ev.get("type")
                    if et == "response.output_text.delta":
                        if ev.get("delta"):
                            yield AgentEvent(type="text", text=ev["delta"])
                    elif et == "response.output_item.done":
                        if isinstance(ev.get("item"), dict):
                            items.append(ev["item"])
                    elif et in ("response.completed", "response.incomplete", "response.failed"):
                        final = ev.get("response") or {}
                    elif et == "error":
                        err = ev.get("error") if isinstance(ev.get("error"), dict) else ev
                        perr = classify(int(err.get("status") or 400), json.dumps({"error": err}))
                        yield AgentEvent(type="error", text=perr.text(label, model), extra=perr.extra())
                        return
    except httpx.TimeoutException:
        perr = ProviderError("timeout", 408)
        yield AgentEvent(type="error", text=perr.text(label, model), extra=perr.extra())
        return
    except Exception as exc:  # noqa: BLE001
        logger.warning("agent_flow openai_responses transport model=%s err=%s", model, type(exc).__name__)
        perr = ProviderError("stream_interrupted", 503)
        yield AgentEvent(type="error", text=perr.text(label, model), extra=perr.extra())
        return

    usage = final.get("usage") or {}
    if usage:
        yield AgentEvent(type="usage", extra={
            "provider": "openai",
            "prompt_tokens": int(usage.get("input_tokens") or 0),
            "completion_tokens": int(usage.get("output_tokens") or 0),
            "effective_prompt_tokens": int(usage.get("input_tokens") or 0),
            "cached_prompt_tokens": int((usage.get("input_tokens_details") or {}).get("cached_tokens") or 0),
            "reasoning_tokens": int((usage.get("output_tokens_details") or {}).get("reasoning_tokens") or 0),
        })
    status = final.get("status")
    if not final:
        # The stream ended without its terminal event: nothing here is an answer.
        perr = ProviderError("stream_interrupted", 200)
        yield AgentEvent(type="error", text=perr.text(label, model), extra=perr.extra())
        return
    if status == "failed":
        err = final.get("error") or {}
        perr = classify(400, json.dumps({"error": err}))
        yield AgentEvent(type="error", text=perr.text(label, model), extra=perr.extra())
        return
    if status == "incomplete":
        reason = (final.get("incomplete_details") or {}).get("reason") or ""
        code = "truncated" if reason == "max_output_tokens" else "bad_request"
        perr = ProviderError(code, 200, reason)
        yield AgentEvent(type="error", text=perr.text(label, model), extra=perr.extra())
        return
    if items:
        yield AgentEvent(type="provider_state", extra={"state": {"items": items}})
    for it in items:
        if it.get("type") != "function_call":
            continue
        raw = it.get("arguments") or "{}"
        malformed = ""
        try:
            args = json.loads(raw) or {}
        except json.JSONDecodeError as exc:
            args, malformed = {}, str(exc)
        if not isinstance(args, dict):
            args, malformed = {}, "arguments were not a JSON object"
        yield AgentEvent(type="tool_call", tool_call_id=it.get("call_id") or "",
                         tool_name=it.get("name") or "", tool_args=args,
                         extra={"malformed_args": malformed, "raw_args": raw[:400]} if malformed else {})
