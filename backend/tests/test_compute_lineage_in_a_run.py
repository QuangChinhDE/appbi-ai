# -*- coding: utf-8 -*-
"""Compute provenance end to end, through a real Agent step.

`test_compute_owns_the_number.py` pins the tool. This pins the RUN: a model that
reads a figure, is shown its `evidence_ref`, and writes a formula naming that
reference gets a result the runtime computed — and the answer quoting it is
verified. A model that types the number instead gets a result the verifier will
not certify.
"""
from __future__ import annotations

import asyncio
import os

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import replay_harness as H  # noqa: E402

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.agent_flows.runtime.state import RunState  # noqa: E402
from app.services.agent_flows.runtime.strategies.tool_calling import evidence_index  # noqa: E402
from app.services.agent_flows.tools import compute as compute_tool  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402

FLOW_BODY = {
    "answer_node": "answer",
    "nodes": [{
        "key": "answer", "name": "Tra loi", "type": "agent",
        "prompt": "Doanh thu tăng bao nhiêu phần trăm?",
        "tools": [{"tool": "total_measure"}, {"tool": "compute"}],
    }],
}

TOTALS = {41: 1200.0, 42: 1000.0}


class _Model:
    """Round 1: read both totals. Round 2: a formula naming what it was shown.
    Round 3: the answer, quoting the computed figure."""

    def __init__(self, *, reference: bool):
        self.reference = reference
        self.rounds = 0
        self.seen_refs: list[str] = []
        self.system_prompts: list[str] = []

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            self.rounds += 1
            self.system_prompts.append(system_prompt)
            tool_msgs = [m for m in messages if m.get("role") == "tool"]
            self.seen_refs = [str((m.get("result") or {}).get("evidence_ref") or "") for m in tool_msgs]
            if self.rounds == 1:
                for i, cid in enumerate((41, 42)):
                    yield AgentEvent(type="tool_call", tool_call_id=f"t{i}",
                                     tool_name="total_measure", tool_args={"chart_id": cid})
            elif self.rounds == 2:
                cur, prev = self.seen_refs[0], self.seen_refs[1]
                vars_ = ({"cur": {"ref": cur, "path": "value"}, "prev": {"ref": prev, "path": "value"}}
                         if self.reference else {"cur": 1300.0, "prev": 1000.0})
                yield AgentEvent(type="tool_call", tool_call_id="c1", tool_name="compute",
                                 tool_args={"expression": "(cur - prev) / prev * 100", "vars": vars_})
            else:
                computed = [m for m in tool_msgs if m.get("name") == "compute"]
                res = ((computed[-1].get("result") or {}).get("data") or {}).get("result")
                yield AgentEvent(type="text", text=f"Doanh thu tăng {res}%.")
            yield AgentEvent(type="usage", extra={"prompt_tokens": 10, "completion_tokens": 5})

        return fake


def _registry(ctx, name, args, allowed=None, use_cache=True):
    if name == "total_measure":
        return {"ok": True, "kind": "value",
                "data": {"value": TOTALS[int(args["chart_id"])], "measure": "revenue"}}
    # The REAL registry path for compute: the tool body plus every gate.
    return REAL_EXECUTE(ctx, name, args, allowed=allowed, use_cache=use_cache)


REAL_EXECUTE = tool_registry.execute


def _run(monkeypatch, model: _Model) -> dict:
    monkeypatch.setattr(AH, "_stream", model.stream())
    monkeypatch.setattr(tool_registry, "execute", _registry)
    flow = Flow.model_validate({**upgrade_body(FLOW_BODY, key="fx_c", name="c"),
                                "key": "fx_c", "name": "c"})
    env = H._envelope({"envelope": {"runtime": {
        "provider": "openai", "model": "gpt-4o-mini",
        "budget": {"max_llm_calls": 12, "max_tool_calls": 40, "max_seconds": 60}}}})
    ctx = H._Ctx([41, 42])

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=ctx,
                                          api_key="k", base_system_prompt="BASE"):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    return asyncio.run(go())


def _answer(envelope: dict) -> str:
    blocks = ((envelope.get("answer") or {}).get("blocks")) or []
    return "".join(str(b.get("markdown") or "") for b in blocks)


def _notice_codes(envelope: dict) -> set[str]:
    return {n.get("code") for n in (envelope.get("notices") or [])}


def test_the_model_is_shown_a_reference_for_every_result(monkeypatch):
    model = _Model(reference=True)
    _run(monkeypatch, model)
    assert model.seen_refs[:2] == ["e1", "e2"]


def test_a_formula_over_references_yields_a_verified_answer(monkeypatch):
    model = _Model(reference=True)
    env = _run(monkeypatch, model)
    assert "20.0%" in _answer(env)
    assert "figures_unverified" not in _notice_codes(env), _notice_codes(env)


def test_a_formula_over_typed_numbers_is_computed_but_not_certified(monkeypatch):
    """1300 was never read. The formula runs; the answer is flagged."""
    model = _Model(reference=False)
    env = _run(monkeypatch, model)
    assert "30.0%" in _answer(env)
    assert "figures_unverified" in _notice_codes(env), _notice_codes(env)


def test_a_compute_step_is_given_the_results_earlier_steps_produced():
    state = RunState()
    state.evidence_source = "read"
    state.record_evidence({"ok": True, "kind": "table",
                           "data": {"columns": ["c", "v"], "rows": [[1, 2]]}}, tool="get_chart_data")
    state.evidence_source = "answer"
    state.record_evidence({"ok": True, "kind": "value", "data": {"value": 3}}, tool="total_measure")
    index = evidence_index(state, exclude_step="answer")
    assert "e1: get_chart_data (bước read)" in index and "(1 dòng)" in index
    assert "e2" not in index, "a step's own results already carry their reference"


def test_a_step_without_compute_is_not_given_the_index(monkeypatch):
    body = {**FLOW_BODY, "nodes": [{**FLOW_BODY["nodes"][0], "tools": [{"tool": "total_measure"}]}]}
    seen: list[str] = []

    async def fake(*, provider, api_key, model, system_prompt, messages, tools):
        seen.append(system_prompt)
        yield AgentEvent(type="text", text="ok")

    monkeypatch.setattr(AH, "_stream", fake)
    flow = Flow.model_validate({**upgrade_body(body, key="fx_n", name="n"), "key": "fx_n", "name": "n"})
    env = H._envelope({"envelope": {"runtime": {"provider": "openai", "model": "m",
                       "budget": {"max_llm_calls": 4, "max_tool_calls": 4, "max_seconds": 30}}}})

    async def go():
        async for _ in executor.run_flow(FlowInput.model_validate(env), flow=flow,
                                         ctx=H._Ctx([41]), api_key="k", base_system_prompt="BASE"):
            pass

    asyncio.run(go())
    assert seen and all("KẾT QUẢ ĐÃ CÓ" not in s for s in seen)


def test_the_tool_definition_teaches_references_not_numbers():
    props = compute_tool.DEFINITION["input_schema"]["properties"]["vars"]["additionalProperties"]
    assert props["required"] == ["ref", "path"]
