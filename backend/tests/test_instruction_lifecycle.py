# -*- coding: utf-8 -*-
"""An instruction declared for an Agent reaches the reasoning turn it governs.

THE DEFECT THIS STARTED FROM
----------------------------
The language reminder — "answer in the language of the question; the data above
is English" — was appended to the conversation AFTER the reasoning loop. The model
that wrote the answer never read it; only the correction calls that happened to
reuse the message list did. It looked implemented, and in the round it existed
for it did nothing.

THE CONTRACT (runtime/strategies/tool_calling.py, "instructions, each on the round
it governs")
---------------------------------------------------------------------------------
    system       every round: base (full for the answering step, compact for the
                 rest, classifier contract for a choice step), the node prompt,
                 grant notes, sources, the routing note (routed steps only), the
                 evidence index (compute steps only)
    after_tools  the round that reads tool results: the language reminder, placed
                 right after those results — one copy, moved forward
    final        the round offered no tools: told it is the last turn
    correction   a verifier's own round, through the runtime, reading the latest
                 reminder

These tests record what a provider actually RECEIVED, round by round, and check
each instruction against the round it is meant for. Not the prompt builder's
output — the request.
"""
from __future__ import annotations

import asyncio
import copy
import inspect
import os

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import replay_harness as H  # noqa: E402

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import agent_runtime, executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.agent_flows.runtime.strategies.tool_calling import FINAL_ROUND  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402

REMINDER_MARK = "Nhắc lại: trả lời bằng ngôn ngữ của câu hỏi"


class _Recorder:
    """A provider that records every request and follows a per-role script."""

    def __init__(self, scripts: dict[str, list]):
        self.scripts = {k: list(v) for k, v in scripts.items()}
        self.requests: list[dict] = []

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            role = next((r for r in self.scripts if r in system_prompt), "?")
            self.requests.append({"role": role, "system": system_prompt,
                                  "messages": copy.deepcopy(messages),
                                  "tools": [t.get("name") for t in (tools or [])]})
            script = self.scripts.get(role) or []
            step = script.pop(0) if script else ("text", f"{role} xong")
            if step[0] == "call" and tools:
                yield AgentEvent(type="tool_call", tool_call_id=f"c{len(self.requests)}",
                                 tool_name=step[1], tool_args=step[2])
            else:
                yield AgentEvent(type="text", text=step[1] if step[0] == "text" else f"{role} xong")
            yield AgentEvent(type="usage", extra={"prompt_tokens": 3, "completion_tokens": 1})
        return fake

    def of(self, role):
        return [r for r in self.requests if r["role"] == role]


def _tool(ctx, name, args, allowed=None, use_cache=True):
    if allowed is not None and name not in allowed:
        return {"ok": False, "error_code": "not_granted", "error": "not granted"}
    return {"ok": True, "kind": "value", "data": {"value": 1234.5, "label": "revenue"}}


def _run(monkeypatch, body, rec, *, llm=12, locale="vi", question="Doanh thu thế nào?"):
    monkeypatch.setattr(AH, "_stream", rec.stream())
    monkeypatch.setattr(tool_registry, "execute", _tool)
    flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx_i", name="i"),
                                "key": "fx_i", "name": "i"})
    env = H._envelope({"envelope": {"request": {"locale": locale},
                                    "question": {"raw": question, "normalized": question},
                                    "runtime": {"provider": "openai", "model": "m", "budget": {
                                        "max_llm_calls": llm, "max_tool_calls": 30, "max_seconds": 60}}}})

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=H._Ctx([41]),
                                          api_key="k", base_system_prompt="BASE_FULL_CONTRACT"):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    return asyncio.run(go())


def _agent(key, marker, tools=("total_measure",), **kw):
    return {"key": key, "name": key, "type": "agent", "prompt": f"{marker} {kw.pop('say', '')}".strip(),
            "max_tool_calls": 10, "tools": [{"tool": t} for t in tools], **kw}


def _user_texts(req) -> list[str]:
    return [m.get("content") for m in req["messages"] if m.get("role") == "user"
            and isinstance(m.get("content"), str)]


# ── after_tools: the language reminder reaches the answering round ──────────
def test_the_round_that_reads_tool_results_reads_the_language_reminder_right_after_them(monkeypatch):
    rec = _Recorder({"TRA_LOI": [("call", "total_measure", {"chart_id": 41}), ("text", "Doanh thu là 1234.5")]})
    _run(monkeypatch, {"answer_node": "tl", "nodes": [_agent("tl", "TRA_LOI")]}, rec)
    first, second = rec.of("TRA_LOI")
    assert not any(REMINDER_MARK in (t or "") for t in _user_texts(first)), \
        "no tool has run yet: nothing to compete with"
    msgs = second["messages"]
    tool_at = max(i for i, m in enumerate(msgs) if m.get("role") == "tool")
    assert REMINDER_MARK in (msgs[tool_at + 1].get("content") or ""), \
        "the reminder sits right after the results it competes with"
    assert tool_at + 1 == len(msgs) - 1, "…and is the last thing the answering round reads"


def test_the_reminder_is_moved_forward_not_piled_up(monkeypatch):
    rec = _Recorder({"TRA_LOI": [("call", "total_measure", {"chart_id": 41}),
                                 ("call", "total_measure", {"chart_id": 41, "x": 1}),
                                 ("call", "total_measure", {"chart_id": 41, "x": 2}),
                                 ("text", "xong")]})
    _run(monkeypatch, {"answer_node": "tl", "nodes": [_agent("tl", "TRA_LOI")]}, rec)
    last = rec.of("TRA_LOI")[-1]
    assert sum(REMINDER_MARK in (t or "") for t in _user_texts(last)) == 1


def test_a_step_that_never_calls_a_tool_is_never_reminded(monkeypatch):
    rec = _Recorder({"TRA_LOI": [("text", "Không cần công cụ.")]})
    _run(monkeypatch, {"answer_node": "tl", "nodes": [_agent("tl", "TRA_LOI")]}, rec)
    assert not any(REMINDER_MARK in (t or "") for r in rec.requests for t in _user_texts(r))


# ── final: the round offered no tools is told so ────────────────────────────
def test_the_budget_final_round_is_told_it_is_final_and_offered_no_tools(monkeypatch):
    rec = _Recorder({"TRA_LOI": [("call", "total_measure", {"chart_id": 41}),
                                 ("call", "total_measure", {"chart_id": 41, "x": 1})]})
    _run(monkeypatch, {"answer_node": "tl", "nodes": [_agent("tl", "TRA_LOI")]}, rec, llm=2)
    first, final = rec.of("TRA_LOI")
    assert first["tools"] and final["tools"] == []
    assert _user_texts(final)[-1] == FINAL_ROUND
    assert FINAL_ROUND not in _user_texts(first)


def test_the_round_ceiling_final_round_is_told_too(monkeypatch):
    monkeypatch.setattr(AH, "MAX_ROUNDS", 2)
    rec = _Recorder({"TRA_LOI": [("call", "total_measure", {"chart_id": 41})] * 5})
    _run(monkeypatch, {"answer_node": "tl", "nodes": [_agent("tl", "TRA_LOI")]}, rec)
    rounds = rec.of("TRA_LOI")
    assert len(rounds) == 2 and rounds[-1]["tools"] == [] and _user_texts(rounds[-1])[-1] == FINAL_ROUND


# ── system: every round, and only the right step ────────────────────────────
def test_the_node_prompt_and_its_base_reach_every_round(monkeypatch):
    rec = _Recorder({"GOM": [("call", "total_measure", {"chart_id": 41}), ("text", "gom xong")],
                     "TRA_LOI": [("text", "tl xong")]})
    body = {"answer_node": "tl", "nodes": [
        _agent("gom", "GOM", say="đọc doanh thu",
               **{"tools": [{"tool": "total_measure", "note": "dùng khi cần tổng"}]}),
        _agent("tl", "TRA_LOI", tools=())]}
    body["nodes"][0]["tools"] = [{"tool": "total_measure", "note": "dùng khi cần tổng"}]
    _run(monkeypatch, body, rec)
    for r in rec.of("GOM"):
        assert "GOM đọc doanh thu" in r["system"]
        assert "dùng khi cần tổng" in r["system"], "grant notes are part of the step's contract"
        assert "BASE_FULL_CONTRACT" not in r["system"], "an intermediate step gets the compact base"
    [tl] = rec.of("TRA_LOI")
    assert "BASE_FULL_CONTRACT" in tl["system"] and "NGÔN NGỮ:" in tl["system"]
    assert "[FOLLOWUP]" in tl["system"]


def test_step_specific_context_goes_only_to_the_step_it_is_for(monkeypatch):
    everything = [n for n in sorted(tool_registry.all_tools())
                  if not tool_registry.all_tools()[n].reaches_outside]
    rec = _Recorder({"ROUTED": [("text", "x")], "PLAIN": [("text", "y")]})
    body = {"answer_node": "b", "nodes": [
        {"key": "a", "name": "a", "type": "agent", "prompt": "ROUTED", "max_tool_calls": 5,
         "visible_capabilities": 6, "tools": [{"tool": t} for t in everything]},
        _agent("b", "PLAIN", tools=("rank_values", "total_measure"))]}
    _run(monkeypatch, body, rec)
    [routed], [plain] = rec.of("ROUTED"), rec.of("PLAIN")
    assert "find_capability" in routed["system"] and "find_capability" in routed["tools"]
    assert "find_capability" not in plain["system"] and "find_capability" not in plain["tools"]


def test_a_specialist_reads_its_brief_straight_after_the_question(monkeypatch):
    rec = _Recorder({"CHUYEN_GIA": [("text", "phân tích")], "TRA_LOI": [("text", "kết")]})

    async def planner(**kw):
        yield AgentEvent(type="text", text="cg_a")

    body = {"answer_node": "tl", "nodes": [
        {"key": "dp", "name": "dp", "type": "coordinate", "prompt": "Chọn", "max_specialists": 1,
         "specialists": [{"key": "cg_a", "name": "A", "when": "khi hỏi về doanh thu",
                          "body": [_agent("a1", "CHUYEN_GIA", tools=())]},
                         {"key": "cg_b", "name": "B", "when": "khi hỏi về đánh giá",
                          "body": [_agent("b1", "KHONG_CHON", tools=())]}]},
        _agent("tl", "TRA_LOI", tools=())]}
    base = rec.stream()

    async def routed(**kw):
        if "Chọn (các) chuyên gia" in kw["system_prompt"]:
            async for ev in planner(**kw):
                yield ev
            return
        async for ev in base(**kw):
            yield ev

    monkeypatch.setattr(AH, "_stream", routed)
    monkeypatch.setattr(tool_registry, "execute", _tool)
    flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx_i", name="i"),
                                "key": "fx_i", "name": "i"})
    env = H._envelope({"envelope": {"runtime": {"provider": "openai", "model": "m"}}})

    async def go():
        async for _ in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=H._Ctx([41]),
                                         api_key="k", base_system_prompt="BASE"):
            pass

    asyncio.run(go())
    [lane] = rec.of("CHUYEN_GIA")
    users = [m for m in lane["messages"] if m.get("role") == "user"]
    assert users[0]["content"] == FlowInput.model_validate(env).question.text()
    assert "khi hỏi về doanh thu" in users[1]["content"], "the brief follows the question"
    assert not rec.of("KHONG_CHON"), "an unchosen specialist is not run"


# ── correction: through the runtime, reading the latest reminder ────────────
def test_a_correction_round_goes_through_the_runtime_and_reads_the_reminder(monkeypatch):
    rec = _Recorder({"TRA_LOI": [("call", "total_measure", {"chart_id": 41}),
                                 ("text", "Doanh thu là 99999999."),       # invented figure
                                 ("text", "Doanh thu là 1234.5.")]})       # the correction
    called = {}
    original = agent_runtime.AgentRuntime.correct

    async def spy(self, system, messages):
        called["messages"] = copy.deepcopy(messages)
        return await original(self, system, messages)

    monkeypatch.setattr(agent_runtime.AgentRuntime, "correct", spy)
    env = _run(monkeypatch, {"answer_node": "tl", "nodes": [_agent("tl", "TRA_LOI")]}, rec)
    assert called, "the figure correction went through AgentRuntime.correct"
    assert any(REMINDER_MARK in (m.get("content") or "") for m in called["messages"]
               if m.get("role") == "user" and isinstance(m.get("content"), str))
    answer = "".join(b.get("markdown") or "" for b in env["answer"]["blocks"])
    assert "1234.5" in answer and "99999999" not in answer
    assert env["usage"]["llm_calls"] == 3


# ── the seam itself ─────────────────────────────────────────────────────────
def test_the_runtime_composes_no_conversation():
    """Messages are the strategy's. The runtime executes and governs; a message it
    appended would be reasoning policy living on the wrong side of the seam."""
    src = inspect.getsource(agent_runtime)
    assert "messages.append" not in src
    assert '"role": "user"' not in src
