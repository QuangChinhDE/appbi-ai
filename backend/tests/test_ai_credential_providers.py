# -*- coding: utf-8 -*-
"""Each vendor an Agent step may choose actually runs as that vendor, with its tools.

  * Gemini went through `stream_gemini_singleshot`, which IGNORES `tools` — a
    Gemini step granted tools silently lost every one. It now goes through
    Gemini's OpenAI-compatible endpoint, which keeps them.
  * The OpenAI adapter fails over to `gpt-4o-mini` on a 429. That is an OpenAI
    model name: for any other vendor reusing the adapter it must stay off.
  * A compatible endpoint may send each tool call whole, without `index`; two
    parallel calls must not be glued into one.
  * "Test key" must recognise a bad key on every vendor — Google answers one with
    400 API_KEY_INVALID, not 401 (measured against a real invalid key).

No network: every request goes to an `httpx.MockTransport`.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.services.dashboard_ai_bot.providers import gemini_provider, openai_provider


def run(agen):
    async def go():
        return [ev async for ev in agen]
    return asyncio.new_event_loop().run_until_complete(go())


@pytest.fixture()
def transport(monkeypatch):
    """Route every httpx.AsyncClient through a handler the test sets."""
    state = {"handler": None, "requests": []}
    real = httpx.AsyncClient

    def factory(*a, **kw):
        def handle(request):
            state["requests"].append(request)
            return state["handler"](request)
        kw["transport"] = httpx.MockTransport(handle)
        return real(*a, **kw)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return state


def sse(*events):
    body = "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n"
    return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})


def test_an_agent_step_on_gemini_uses_the_tool_calling_adapter(monkeypatch):
    from app.services.agent_flows.runtime.handlers import agent as A

    seen = {}

    async def fake_openai(**kw):
        seen.update(kw)
        if False:
            yield None

    monkeypatch.setattr(openai_provider, "stream_openai", fake_openai)
    tools = [{"name": "get_chart_data", "description": "d", "input_schema": {"type": "object"}}]
    run(A._stream(provider="gemini", api_key="AIzaTEST", model="gemini-2.5-flash",
                  system_prompt="S", messages=[{"role": "user", "content": "q"}], tools=tools))
    assert seen["base_url"] == gemini_provider.GEMINI_OPENAI_BASE_URL
    assert seen["vendor"] == "gemini"
    assert seen["tools"] == tools, "a Gemini step must keep the tools it was granted"
    assert seen["model"] == "gemini-2.5-flash"


def test_the_gemini_request_goes_to_google_with_the_key_in_a_header(transport):
    transport["handler"] = lambda r: sse({"choices": [{"delta": {"content": "Xin chào"},
                                                       "finish_reason": "stop"}]})
    events = run(gemini_provider.stream_gemini(
        api_key="AIzaHEADERONLY", system_prompt="S",
        messages=[{"role": "user", "content": "q"}],
        tools=[{"name": "t", "description": "d", "input_schema": {"type": "object"}}]))
    req = transport["requests"][0]
    assert str(req.url) == gemini_provider.GEMINI_OPENAI_BASE_URL + "/chat/completions"
    assert req.headers["authorization"] == "Bearer AIzaHEADERONLY"
    assert "AIza" not in str(req.url), "the key must never ride in a URL httpx logs"
    body = json.loads(req.content)
    assert body["model"] == "gemini-2.5-flash" and body["tools"]
    assert [e.text for e in events if e.type == "text"] == ["Xin chào"]


def test_a_429_on_gemini_never_fails_over_to_an_openai_model(transport, monkeypatch):
    transport["handler"] = lambda r: httpx.Response(429, json={"error": {"message": "quota"}})

    async def no_sleep(_s):
        return None

    # The adapter waits between 429 retries; the wait is not what is under test.
    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    events = run(gemini_provider.stream_gemini(
        api_key="AIzaX", system_prompt="S", messages=[{"role": "user", "content": "q"}],
        model="gemini-2.5-pro"))
    models = {json.loads(r.content)["model"] for r in transport["requests"]}
    assert models == {"gemini-2.5-pro"}, models
    err = [e for e in events if e.type == "error"]
    assert err and "Gemini 429" in err[-1].text and "gpt-4o-mini" not in err[-1].text


def test_openai_still_fails_over_to_mini_on_a_429(transport):
    calls = []

    def handler(r):
        model = json.loads(r.content)["model"]
        calls.append(model)
        if model == "gpt-4o":
            return httpx.Response(429, json={"error": {"message": "rate"}})
        return sse({"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]})

    transport["handler"] = handler
    openai_provider._RATE_LIMITED_UNTIL.clear()
    events = run(openai_provider.stream_openai(
        api_key="sk-x", system_prompt="S", messages=[{"role": "user", "content": "q"}],
        model="gpt-4o"))
    openai_provider._RATE_LIMITED_UNTIL.clear()
    assert calls == ["gpt-4o", "gpt-4o-mini"]
    assert [e.text for e in events if e.type == "text"] == ["ok"]


def test_two_parallel_tool_calls_without_index_stay_two_calls(transport):
    transport["handler"] = lambda r: sse({"choices": [{"delta": {"tool_calls": [
        {"id": "c1", "type": "function", "function": {"name": "a", "arguments": '{"x": 1}'}},
        {"id": "c2", "type": "function", "function": {"name": "b", "arguments": '{"y": 2}'}},
    ]}, "finish_reason": "tool_calls"}]})
    events = run(gemini_provider.stream_gemini(
        api_key="AIzaX", system_prompt="S", messages=[{"role": "user", "content": "q"}],
        tools=[{"name": "a", "description": "d", "input_schema": {"type": "object"}},
               {"name": "b", "description": "d", "input_schema": {"type": "object"}}]))
    calls = [(e.tool_call_id, e.tool_name, e.tool_args) for e in events if e.type == "tool_call"]
    assert calls == [("c1", "a", {"x": 1}), ("c2", "b", {"y": 2})]


@pytest.mark.parametrize("provider,status,body,ok", [
    ("openai", 200, "{}", True),
    ("openai", 401, '{"error":{}}', False),
    ("anthropic", 401, '{"error":{}}', False),
    ("gemini", 400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}', False),
    ("gemini", 429, "{}", False),
])
def test_test_key_reads_each_vendors_answer(transport, provider, status, body, ok):
    from app.services.agent_flows import credentials as C

    transport["handler"] = lambda r: httpx.Response(status, text=body)
    got = asyncio.new_event_loop().run_until_complete(C.probe(provider, "SECRETKEY1234567"))
    assert got["ok"] is ok
    req = transport["requests"][0]
    assert "SECRETKEY" not in str(req.url), "the key must travel in a header"
    if not ok:
        assert "SECRETKEY" not in (got["error"] or "")
    if provider == "gemini" and status == 400:
        assert "không hợp lệ" in got["error"], got["error"]
