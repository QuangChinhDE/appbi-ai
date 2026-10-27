# -*- coding: utf-8 -*-
"""Model & provider compatibility: what a step chooses is what runs, through the
protocol that model needs, with its round-to-round state intact.

Mocked transports — these pin PROTOCOL handling. Whether a model works with a
real key is `backend/eval/certify_models.py`'s job (live evidence).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))

from test_agent_flow_golden import AGENT, agent_handler, build, run, stub_everything  # noqa: E402,F401

from app.services.agent_flows import models_catalogue as cat  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
from app.services.dashboard_ai_bot.providers import anthropic_provider as AP  # noqa: E402
from app.services.dashboard_ai_bot.providers import openai_provider as OP  # noqa: E402
from app.services.dashboard_ai_bot.providers import openai_responses as OR  # noqa: E402
from app.services.dashboard_ai_bot.providers.errors import classify  # noqa: E402

#: The real dispatcher, captured before the golden suite's autouse stub replaces it.
REAL_STREAM = agent_handler._stream


# ── a fake httpx that streams scripted SSE lines and records requests ────────
class _Resp:
    def __init__(self, status, lines, body=b""):
        self.status_code, self._lines, self._body, self.headers = status, lines, body, {}

    async def aread(self):
        return self._body

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _Client:
    def __init__(self, script, seen):
        self.script, self.seen = script, seen

    def stream(self, method, url, headers=None, json=None):
        self.seen.append({"url": url, "json": json})
        status, lines, body = self.script.pop(0)
        return _Resp(status, lines, body)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _fake_httpx(monkeypatch, module, script):
    seen: list[dict] = []
    monkeypatch.setattr(module.httpx, "AsyncClient", lambda *a, **k: _Client(script, seen))
    return seen


def _sse(*events):
    return [f"data: {json.dumps(e)}" for e in events]


def _collect(gen):
    async def go():
        return [ev async for ev in gen]
    return asyncio.run(go())


# ── the catalogue ─────────────────────────────────────────────────────────────
def test_every_offered_model_says_how_far_its_claim_goes():
    for group in cat.catalogue():
        for m in group["models"]:
            assert m["lifecycle"] in ("active", "legacy", "deprecated", "retired"), m["model"]
            assert m["endpoint"] in cat.SUPPORTED_ENDPOINTS[group["provider"]], m["model"]
            assert m["certification"]["status"] in ("certified", "legacy_verified", "unverified"), m["model"]
            assert m["price"]["source"].startswith("https://") and m["price"]["as_of"], m["model"]
            if m["certification"]["status"] == "certified":
                assert m["certification"].get("evidence"), f"{m['model']}: certified without evidence"
            if m["certification"]["status"] == "unverified":
                assert m["certification"].get("reason"), f"{m['model']}: unverified without a reason"
            if m["lifecycle"] != "active":
                assert m.get("replacement") and cat.known_model(group["provider"], m["replacement"]), m["model"]


def test_an_empty_model_still_means_what_it_ran_on_whatever_the_display_order():
    """GPT-6 Luna is listed first now; a stored step that named only a provider
    must not silently move onto it."""
    assert cat.MODELS["openai"][0]["model"] == "gpt-6-luna"
    assert cat.default_model("openai") == "gpt-4o-mini"
    assert cat.default_model("anthropic") == "claude-haiku-4-5"
    assert cat.default_model("gemini") == "gemini-2.5-flash"
    from app.services.agent_flows.contract import AgentNode

    node = AgentNode.model_validate({"key": "a", "type": "agent", "prompt": "x", "provider": "openai", "model": ""})
    assert node.model == "gpt-4o-mini"
    assert cat.DEFAULT_MODEL == "gpt-4o-mini"


def test_a_legacy_model_still_parses_and_tells_its_author_what_to_move_to():
    from app.services.agent_flows.contract import AgentNode

    node = AgentNode.model_validate({"key": "a", "type": "agent", "prompt": "x", "provider": "anthropic",
                                     "model": "claude-haiku-4-5"})
    assert node.model == "claude-haiku-4-5"
    warning = cat.lifecycle_warning("anthropic", "claude-haiku-4-5")
    assert "claude-haiku-5-5" in warning and "2026-10-15" in warning


# ── dispatch: the model's own protocol and budget ────────────────────────────
def _capture_dispatch(monkeypatch):
    seen: dict = {}

    def recorder(name):
        async def fn(**kw):
            seen["fn"], seen["kw"] = name, kw
            yield AgentEvent(type="text", text="ok")
        return fn

    import app.services.dashboard_ai_bot.providers as P
    monkeypatch.setattr(P, "stream_openai", recorder("chat"))
    monkeypatch.setattr(P, "stream_anthropic", recorder("anthropic"))
    monkeypatch.setattr(P, "stream_gemini", recorder("gemini"))
    monkeypatch.setattr(OR, "stream_openai_responses", recorder("responses"))
    return seen


@pytest.mark.parametrize("provider,model,fn,extra", [
    ("openai", "gpt-6-luna", "responses", {"reasoning_effort": "low", "max_tokens": 16000}),
    ("openai", "gpt-6-astra", "responses", {"reasoning_effort": "low"}),
    ("openai", "gpt-4o-mini", "chat", {"strict": True, "max_tokens": 4096}),
    ("anthropic", "claude-sonnet-5-5", "anthropic", {"strict": True, "max_tokens": 16000}),
    ("gemini", "gemini-3.8-flash", "gemini", {"strict": True, "max_tokens": 16000}),
])
def test_a_step_runs_its_model_through_the_protocol_that_model_needs(monkeypatch, provider, model, fn, extra):
    # every step goes through the Model Gateway first (ai_runtime/gateway.py): a
    # ledger it can reserve in, and the step's own budget fits the default cap
    import sqlalchemy as sa
    from app.models.ai_runtime import AiUsageLedger
    from app.services.ai_runtime import gateway

    engine = sa.create_engine("sqlite://", poolclass=sa.pool.StaticPool,
                              connect_args={"check_same_thread": False})
    AiUsageLedger.__table__.create(engine)
    monkeypatch.setattr(gateway, "_engine", lambda: engine)
    seen = _capture_dispatch(monkeypatch)
    _collect(REAL_STREAM(provider=provider, api_key="k", model=model, system_prompt="s",
                       messages=[{"role": "user", "content": "q"}], tools=[]))
    assert seen["fn"] == fn and seen["kw"]["model"] == model
    for k, v in extra.items():
        assert seen["kw"][k] == v, (k, seen["kw"].get(k))
    with engine.connect() as c:
        assert c.execute(sa.text("SELECT count(*) FROM ai_usage_ledger")).scalar() == 1


# ── OpenAI Responses (GPT-6) ──────────────────────────────────────────────────
_FC = {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "get_chart_data",
       "arguments": '{"chart_id": 41}', "status": "completed"}
_RS = {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "ENC", "status": "completed"}


def test_responses_emits_tool_calls_and_the_rounds_items_for_replay(monkeypatch):
    seen = _fake_httpx(monkeypatch, OR, [(200, _sse(
        {"type": "response.output_item.done", "item": _RS},
        {"type": "response.output_item.done", "item": _FC},
        {"type": "response.completed", "response": {"status": "completed",
                                                    "usage": {"input_tokens": 50, "output_tokens": 9,
                                                              "output_tokens_details": {"reasoning_tokens": 4}}}},
    ), b"")])
    evs = _collect(OR.stream_openai_responses(api_key="k", system_prompt="S", messages=[
        {"role": "user", "content": "q"}], tools=[{"name": "get_chart_data", "description": "d",
                                                   "input_schema": {"type": "object"}}],
        model="gpt-6-luna", reasoning_effort="low"))
    req = seen[0]["json"]
    assert seen[0]["url"].endswith("/v1/responses")
    assert req["store"] is False and req["reasoning"] == {"effort": "low"} and req["instructions"] == "S"
    assert req["tools"][0]["type"] == "function" and req["tools"][0]["strict"] is False
    assert "temperature" not in req and "max_tokens" not in req and req["max_output_tokens"] == 16000
    state = next(e for e in evs if e.type == "provider_state").extra["state"]
    assert [i["type"] for i in state["items"]] == ["reasoning", "function_call"]
    call = next(e for e in evs if e.type == "tool_call")
    assert (call.tool_call_id, call.tool_name, call.tool_args) == ("call_1", "get_chart_data", {"chart_id": 41})
    usage = next(e for e in evs if e.type == "usage").extra
    assert usage["prompt_tokens"] == 50 and usage["completion_tokens"] == 9 and usage["reasoning_tokens"] == 4


def test_responses_replays_the_reasoning_items_exactly_and_rebuilds_only_without_them():
    with_state = OR.to_input([
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "name": "get_chart_data",
                                                             "args": {"chart_id": 41}}],
         "provider_state": {"items": [_RS, _FC]}},
        {"role": "tool", "tool_call_id": "call_1", "name": "get_chart_data", "result": {"ok": True}},
    ])
    assert with_state[1] == {k: v for k, v in _RS.items() if k != "status"}
    assert with_state[1]["encrypted_content"] == "ENC"
    assert with_state[2]["type"] == "function_call" and with_state[3]["type"] == "function_call_output"
    rebuilt = OR.to_input([{"role": "assistant", "content": "x",
                            "tool_calls": [{"id": "c9", "name": "t", "args": {"a": 1}}]}])
    assert rebuilt[1] == {"type": "function_call", "call_id": "c9", "name": "t", "arguments": '{"a": 1}'}


def test_responses_cut_by_the_token_limit_is_an_error_not_an_answer(monkeypatch):
    _fake_httpx(monkeypatch, OR, [(200, _sse(
        {"type": "response.output_text.delta", "delta": "Doanh thu là"},
        {"type": "response.incomplete", "response": {"status": "incomplete",
                                                     "incomplete_details": {"reason": "max_output_tokens"}}},
    ), b"")])
    evs = _collect(OR.stream_openai_responses(api_key="k", system_prompt="S",
                                              messages=[{"role": "user", "content": "q"}], model="gpt-6-luna"))
    err = next(e for e in evs if e.type == "error")
    assert err.extra["code"] == "truncated"


def test_responses_names_the_vendor_error(monkeypatch):
    _fake_httpx(monkeypatch, OR, [(400, [], json.dumps({"error": {
        "message": "Unsupported parameter: 'temperature' is not supported with this model.",
        "type": "invalid_request_error", "code": "unsupported_parameter"}}).encode())])
    evs = _collect(OR.stream_openai_responses(api_key="k", system_prompt="S",
                                              messages=[{"role": "user", "content": "q"}], model="gpt-6-astra"))
    assert evs[-1].type == "error" and evs[-1].extra["code"] == "unsupported_parameter"


# ── OpenAI Chat Completions, strict ──────────────────────────────────────────
def test_strict_never_swaps_the_authors_model_on_a_429(monkeypatch):
    """The legacy adapter fails gpt-4o over to gpt-4o-mini, process-wide, for 45s.
    An Agent Flow step must run what its author chose — or say why it could not."""
    OP._RATE_LIMITED_UNTIL.clear()

    async def no_wait(*_a, **_k):
        return None

    monkeypatch.setattr(asyncio, "sleep", no_wait)
    body = json.dumps({"error": {"message": "Rate limit reached", "type": "rate_limit_exceeded"}}).encode()
    seen = _fake_httpx(monkeypatch, OP, [(429, [], body), (429, [], body), (429, [], body)])
    evs = _collect(OP.stream_openai(api_key="k", system_prompt="s", messages=[{"role": "user", "content": "q"}],
                                    model="gpt-4o", strict=True))
    assert {r["json"]["model"] for r in seen} == {"gpt-4o"}
    assert "gpt-4o" not in OP._RATE_LIMITED_UNTIL
    assert evs[-1].type == "error" and evs[-1].extra["code"] == "rate_limited"


def test_strict_reports_a_length_cut(monkeypatch):
    _fake_httpx(monkeypatch, OP, [(200, _sse(
        {"choices": [{"delta": {"content": "Doanh thu"}, "finish_reason": None}]},
        {"choices": [{"delta": {}, "finish_reason": "length"}]},
    ), b"")])
    evs = _collect(OP.stream_openai(api_key="k", system_prompt="s", messages=[{"role": "user", "content": "q"}],
                                    model="gpt-4o-mini", strict=True))
    assert evs[-1].type == "error" and evs[-1].extra["code"] == "truncated"


def test_gemini_thought_signatures_go_back_on_the_exact_call(monkeypatch):
    sig = {"google": {"thought_signature": "SIG=="}}
    _fake_httpx(monkeypatch, OP, [(200, _sse(
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "g1", "extra_content": sig,
                                                "function": {"name": "t", "arguments": "{}"}}]},
                      "finish_reason": None}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    ), b"")])
    evs = _collect(OP.stream_openai(api_key="k", system_prompt="s", messages=[{"role": "user", "content": "q"}],
                                    model="gemini-3.8-flash", base_url="https://x/openai", vendor="gemini",
                                    strict=True))
    state = next(e for e in evs if e.type == "provider_state").extra["state"]
    assert state == {"tool_extra": {"g1": sig}}
    wire = OP._to_openai_messages("s", [{"role": "assistant", "content": "", "tool_calls": [
        {"id": "g1", "name": "t", "args": {}}], "provider_state": state}])
    assert wire[1]["tool_calls"][0]["extra_content"] == sig


# ── Anthropic thinking ────────────────────────────────────────────────────────
def _anthropic_round():
    return _sse(
        {"type": "message_start", "message": {"usage": {"input_tokens": 10}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "plan"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "S1"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "tu1", "name": "t"}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"a":1}'}},
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 5}},
        {"type": "message_stop"},
    )


def test_anthropic_keeps_thinking_blocks_and_replays_them_unmodified(monkeypatch):
    _fake_httpx(monkeypatch, AP, [(200, _anthropic_round(), b"")])
    evs = _collect(AP.stream_anthropic(api_key="k", system_prompt="s", messages=[{"role": "user", "content": "q"}],
                                       tools=[{"name": "t", "description": "d", "input_schema": {"type": "object"}}],
                                       model="claude-sonnet-5-5", strict=True))
    assert not any(e.type == "text" and "plan" in e.text for e in evs), "thinking must never reach the reader"
    state = next(e for e in evs if e.type == "provider_state").extra["state"]
    assert state["content"][0] == {"type": "thinking", "thinking": "plan", "signature": "S1"}
    assert state["content"][1]["type"] == "tool_use" and state["content"][1]["input"] == {"a": 1}
    wire = AP._to_anthropic_messages([{"role": "assistant", "content": "", "tool_calls": [
        {"id": "tu1", "name": "t", "args": {"a": 1}}], "provider_state": state}])
    assert wire[0]["content"] == state["content"]


def test_anthropic_answer_only_round_keeps_the_tool_turn_intact(monkeypatch):
    """Flattening tool_use into text rewrites the turn a thinking block belongs to."""
    seen = _fake_httpx(monkeypatch, AP, [(200, _sse({"type": "message_stop"}), b""),
                                         (200, _sse({"type": "message_stop"}), b"")])
    history = [{"role": "user", "content": "q"},
               {"role": "assistant", "content": "", "tool_calls": [{"id": "tu1", "name": "t", "args": {"a": 1}}]},
               {"role": "tool", "tool_call_id": "tu1", "name": "t", "result": {"ok": True}}]
    _collect(AP.stream_anthropic(api_key="k", system_prompt="s", messages=history, tools=None,
                                 model="claude-sonnet-5-5", strict=True))
    strict_req = seen[0]["json"]
    assert strict_req["tool_choice"] == {"type": "none"} and [t["name"] for t in strict_req["tools"]] == ["t"]
    assert any(b.get("type") == "tool_use" for m in strict_req["messages"] for b in m["content"])
    # Other callers keep today's behaviour.
    _collect(AP.stream_anthropic(api_key="k", system_prompt="s", messages=history, tools=None))
    legacy = seen[1]["json"]
    assert "tool_choice" not in legacy
    assert not any(b.get("type") == "tool_use" for m in legacy["messages"] for b in m["content"])


def test_anthropic_reports_a_max_tokens_cut(monkeypatch):
    _fake_httpx(monkeypatch, AP, [(200, _sse(
        {"type": "message_start", "message": {"usage": {"input_tokens": 3}}},
        {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}, "usage": {"output_tokens": 16}},
        {"type": "message_stop"}), b"")])
    evs = _collect(AP.stream_anthropic(api_key="k", system_prompt="s", messages=[{"role": "user", "content": "q"}],
                                       model="claude-haiku-5-5", strict=True))
    assert any(e.type == "error" and e.extra.get("code") == "truncated" for e in evs)


# ── the runtime carries the round's state to the next round ──────────────────
def test_the_next_round_receives_the_vendor_state_of_the_previous_one(monkeypatch):
    seen: dict = {}
    calls = {"n": 0}

    async def fake(*, provider, api_key, model, system_prompt, messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            yield AgentEvent(type="provider_state", extra={"state": {"items": [_RS, _FC]}})
            yield AgentEvent(type="tool_call", tool_call_id="call_1", tool_name="get_chart_data",
                             tool_args={"chart_id": 41})
            return
        seen["messages"] = list(messages)
        yield AgentEvent(type="text", text="xong")

    monkeypatch.setattr(agent_handler, "_stream", fake)
    run(build([AGENT], answer_node="answer"))
    turn = next(m for m in seen["messages"] if m.get("role") == "assistant" and m.get("tool_calls"))
    assert turn["provider_state"] == {"items": [_RS, _FC]}


# ── error classification ─────────────────────────────────────────────────────
@pytest.mark.parametrize("status,body,code", [
    (401, {"error": {"message": "Incorrect API key provided", "code": "invalid_api_key"}}, "invalid_credentials"),
    (400, [{"error": {"code": 400, "message": "Please pass a valid API key", "status": "INVALID_ARGUMENT"}}],
     "invalid_credentials"),
    (429, {"error": {"message": "You exceeded your current quota", "code": "insufficient_quota"}}, "quota_exhausted"),
    (429, {"error": {"message": "Rate limit reached", "type": "rate_limit_exceeded"}}, "rate_limited"),
    (404, {"error": {"message": "The model `x` does not exist or you do not have access to it.",
                     "code": "model_not_found"}}, "model_unavailable"),
    (404, {"error": {"type": "not_found_error", "message": "model: claude-x not found"}}, "unknown_model"),
    (403, {"error": {"type": "permission_error", "message": "not allowed"}}, "no_entitlement"),
    (400, {"error": {"message": "Unsupported parameter: 'temperature'", "code": "unsupported_parameter"}},
     "unsupported_parameter"),
    (404, {"error": {"message": "The model claude-3-5-haiku-20241022 has been retired."}}, "retired_model"),
    (529, {"error": {"type": "overloaded_error", "message": "Overloaded"}}, "provider_outage"),
])
def test_a_vendor_failure_is_named_for_what_it_is(status, body, code):
    assert classify(status, json.dumps(body).encode()).code == code


def test_no_error_text_carries_the_vendor_body_verbatim():
    perr = classify(401, json.dumps({"error": {"message": "key sk-live-abc123 rejected"}}).encode())
    assert "sk-live" not in perr.text("OpenAI", "gpt-6-luna")


# ── the layered model check ───────────────────────────────────────────────────
def test_a_model_is_ready_only_when_a_real_tool_call_passed(monkeypatch):
    from app.services.agent_flows import credentials as C

    class Row:
        provider = "openai"

    monkeypatch.setattr(C, "get_for", lambda *a, **k: Row())
    monkeypatch.setattr(C, "_decrypt", lambda row: "k")

    async def ok_probe(p, s):
        return {"ok": True, "error": None, "latency_ms": 1, "code": None}

    async def avail(p, s, m):
        return C._level("availability", "pass", "ok")

    async def smoke(p, s, m):
        return C._level("smoke", "pass", "ok")

    monkeypatch.setattr(C, "probe", ok_probe)
    monkeypatch.setattr(C, "_availability", avail)
    monkeypatch.setattr(C, "_smoke", smoke)
    untested = asyncio.run(C.check_model(None, None, 1, "gpt-6-luna", smoke=False))
    assert untested["verdict"] == "available_untested"
    assert untested["levels"][-1] == {**untested["levels"][-1], "level": "smoke", "status": "not_run"}
    ready = asyncio.run(C.check_model(None, None, 1, "gpt-6-luna", smoke=True))
    assert ready["verdict"] == "ready"

    async def bad_probe(p, s):
        return {"ok": False, "error": "Key không hợp lệ", "latency_ms": 1, "code": "invalid_credentials"}

    monkeypatch.setattr(C, "probe", bad_probe)
    bad = asyncio.run(C.check_model(None, None, 1, "gpt-6-luna", smoke=True))
    assert bad["verdict"] == "not_ready"
    assert [lv["status"] for lv in bad["levels"]] == ["fail", "not_run", "pass", "not_run"]
    assert bad["levels"][0]["code"] == "invalid_credentials"


def test_an_unknown_model_fails_compatibility_with_its_reason(monkeypatch):
    from app.services.agent_flows import credentials as C

    class Row:
        provider = "openai"

    monkeypatch.setattr(C, "get_for", lambda *a, **k: Row())
    monkeypatch.setattr(C, "_decrypt", lambda row: "k")

    async def ok_probe(p, s):
        return {"ok": True, "error": None, "latency_ms": 1, "code": None}

    async def avail(p, s, m):
        return C._level("availability", "fail", "x", "unknown_model")

    monkeypatch.setattr(C, "probe", ok_probe)
    monkeypatch.setattr(C, "_availability", avail)
    got = asyncio.run(C.check_model(None, None, 1, "gpt-9-imaginary", smoke=True))
    comp = next(lv for lv in got["levels"] if lv["level"] == "compatibility")
    assert comp["status"] == "fail" and comp["code"] == "unknown_model"
    assert got["verdict"] == "not_ready"


def test_a_text_only_model_cannot_carry_a_tool_grant(monkeypatch):
    """M11: no catalogued model is text-only today, so one is added for the test —
    the rule must hold the day one is."""
    from app.services.agent_flows.contract import AgentNode

    monkeypatch.setitem(cat.MODELS, "openai", [*cat.MODELS["openai"], {
        "model": "text-only-x", "label": "Text only", "tier_hint": "fast", "lifecycle": "active",
        "endpoint": "chat_completions", "tools": False, "price": {}, "certification": {"status": "unverified"}}])
    with pytest.raises(Exception) as exc:
        AgentNode.model_validate({"key": "a", "type": "agent", "prompt": "x", "provider": "openai",
                                  "model": "text-only-x", "tools": [{"tool": "list_charts"}]})
    assert "không hỗ trợ gọi công cụ" in str(exc.value)
    ok = AgentNode.model_validate({"key": "a", "type": "agent", "prompt": "x", "provider": "openai",
                                   "model": "text-only-x", "tools": []})
    assert ok.model == "text-only-x"
