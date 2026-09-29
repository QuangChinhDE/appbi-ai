# -*- coding: utf-8 -*-
"""What an independent adversarial review of the V3 closure found — each locked.

The review was asked to break capability routing, budget, Skill lifecycle,
compute provenance, instruction placement and coordinator nesting. It found two
provenance escapes (P0), three ways a funded run still missed its answer (P1),
and a handful of smaller holes (P2). Every test here reproduced the defect before
its fix (the reviewer ran them failing); they are named for the defect.
"""
from __future__ import annotations

import asyncio
import copy
import os
from types import SimpleNamespace

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import replay_harness as H  # noqa: E402
import test_budget_always_reaches_an_answer as B  # noqa: E402
from test_skills_run_as_governed_children import skill_db  # noqa: E402,F401

from app.services.agent_flows import skills  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import capabilities as CAP  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.agent_flows.runtime.reserve import minimum_calls, skill_lookup_for  # noqa: E402
from app.services.agent_flows.runtime.state import RunState  # noqa: E402
from app.services.agent_flows.tools import compute  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402


def _ctx(state):
    return SimpleNamespace(evidence_store=state.evidence_store)


# ── P0: provenance ──────────────────────────────────────────────────────────
def test_a_text_skills_prose_answer_is_never_certified_by_compute():
    state = RunState()
    state.evidence_source = "ba"
    ref = state.record_evidence({"ok": True, "kind": "value", "data": {
        "skill": "so_sanh", "version": 2, "returns": "text", "answer": "13590000",
        "status": "ok", "notices": [], "evidence_values": [], "evidence_paths": []}},
        tool="skill__so_sanh")
    out = compute.tool_compute(_ctx(state), {"expression": "x", "vars": {"x": {"ref": ref, "path": "answer"}}})
    assert out["data"]["provenance"] == "unreferenced" and out["data"]["evidence_values"] == []


def test_a_literal_of_a_certified_compute_is_not_laundered_into_the_next():
    state = RunState()
    state.evidence_source = "a"
    e1 = state.record_evidence({"ok": True, "kind": "value", "data": {"value": 100.0}}, tool="get_chart_data")
    first = compute.tool_compute(_ctx(state), {"expression": "x + 13590000",
                                               "vars": {"x": {"ref": e1, "path": "value"}}})
    assert first["data"]["provenance"] == "referenced"
    e2 = state.record_evidence(first, tool="compute")
    for path in ("literals[0]", "inputs[0].value", "data.literals[0]"):
        second = compute.tool_compute(_ctx(state), {"expression": "z", "vars": {"z": {"ref": e2, "path": path}}})
        assert second["data"]["provenance"] == "unreferenced", path
    ok = compute.tool_compute(_ctx(state), {"expression": "z", "vars": {"z": {"ref": e2, "path": "result"}}})
    assert ok["data"]["provenance"] == "referenced", "the vouched field still certifies"


# ── P1: a funded run reaches its answer ─────────────────────────────────────
def _run_env(monkeypatch, body, *, llm, tools, web=False, tool_fn=None, model=None, db=None):
    model = model or B._Greedy()
    monkeypatch.setattr(AH, "_stream", model.stream())
    monkeypatch.setattr(tool_registry, "execute", tool_fn or B._tool)
    env = H._envelope({"envelope": {
        "binding": {"capabilities": {"web_search": web, "read_rows": True}},
        "runtime": {"provider": "openai", "model": "m", "budget": {
            "max_llm_calls": llm, "max_tool_calls": tools, "max_seconds": 60}}}})

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=B._flow(body),
                                          ctx=H._Ctx([41], web_search=web), api_key="k",
                                          base_system_prompt="BASE", db=db):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    return asyncio.run(go()), model


def test_a_budget_refusal_never_triggers_on_error_stop(monkeypatch):
    body = {"answer_node": "tl", "nodes": [
        {"key": "lp", "name": "lp", "type": "loop", "over": "a, b, c", "item_var": "it",
         "body": [B._agent("a1", "GOM", on_error="stop")]},
        B._agent("tl", "TRA_LOI", tools=())]}
    assert minimum_calls(B._flow(body).nodes) == (2, 0)
    env, model = _run_env(monkeypatch, body, llm=2, tools=10)
    assert len(model.by("TRA_LOI")) == 1


def test_optional_web_fetches_stop_at_the_reservation(monkeypatch):
    body = {"answer_node": "tl", "nodes": [
        {"key": "w", "name": "w", "type": "web", "fetch_pages": True},
        B._agent("tl", "TRA_LOI", tools=())]}

    def tool(ctx, name, args, allowed=None, use_cache=True):
        if name == "web_search":
            return {"ok": True, "kind": "value", "data": {},
                    "results": [{"url": f"https://x{i}.com/a", "title": "t"} for i in range(3)]}
        return {"ok": True, "kind": "value", "data": {"text": "page"}}

    env, model = _run_env(monkeypatch, body, llm=1, tools=2, web=True, tool_fn=tool)
    assert len(model.by("TRA_LOI")) == 1


def test_a_spent_tool_ceiling_does_not_stop_a_step_that_needs_only_the_model(monkeypatch):
    body = {"answer_node": "tl", "nodes": [
        {"key": "t", "name": "t", "type": "tool", "tool": "list_charts", "inputs": {}},
        B._agent("tl", "TRA_LOI", tools=())]}
    env, model = _run_env(monkeypatch, body, llm=5, tools=1)
    assert len(model.by("TRA_LOI")) == 1 and env["status"] == "ok"


def test_a_batch_re_reads_its_room_after_a_skill_spent_its_share(monkeypatch, skill_db):
    body = {"answer_node": "tl", "nodes": [
        {"key": "gom", "name": "gom", "type": "agent", "prompt": "GOM", "max_tool_calls": 10,
         "tools": [{"tool": "skill:so_sanh", "version": 2}, {"tool": "total_measure"}]},
        B._agent("tl", "TRA_LOI", tools=())]}

    class M(B._Greedy):
        def stream(self):
            inner = super().stream()

            async def fake(**kw):
                if "GOM" in kw["system_prompt"] and kw["tools"] and not self.by("GOM"):
                    self.calls.append({"role": "GOM", "offered": [t["name"] for t in kw["tools"]], "last_user": ""})
                    yield AgentEvent(type="tool_call", tool_call_id="s1", tool_name="skill__so_sanh",
                                     tool_args={"question": "Doanh thu?", "chart_id": 41})
                    yield AgentEvent(type="tool_call", tool_call_id="s2", tool_name="total_measure",
                                     tool_args={"chart_id": 41})
                    return
                async for ev in inner(**kw):
                    yield ev
            return fake

    env, model = _run_env(monkeypatch, body, llm=8, tools=2, model=M(), db=skill_db.db)
    assert len(model.by("TRA_LOI")) == 1
    assert env["usage"]["tool_calls"] <= 2, "never past the run ceiling"


# ── P2 ──────────────────────────────────────────────────────────────────────
def test_calling_unshown_names_cannot_load_the_whole_catalogue():
    grant = [n for n in sorted(tool_registry.all_tools()) if not tool_registry.all_tools()[n].reaches_outside]
    view = CAP.build_view(grant, SimpleNamespace(web_search=True, read_rows=True), web_enabled=True, limit=6)
    view.refresh("doanh thu")
    hidden = [n for n in view.eligible if n not in view.visible]
    loaded = [n for n in hidden if view.load_on_refusal(n)]
    assert len(loaded) == CAP.MAX_LOAD
    view.refresh()
    assert len(view.visible) <= 6 + CAP.MAX_LOAD


def test_bracket_paths_resolve_like_dotted_ones():
    state = RunState(vars={"ranking": {"items": [{"value": 7}]}})
    assert state.get("ranking.items[0].value") == 7 == state.get("ranking.items.0.value")
    assert state.resolve("{{ranking.items[0].value}}") == 7


def test_a_disabled_skill_is_not_reserved_for(skill_db):
    row = skill_db.registry[("so_sanh", 2)][0]
    row.lifecycle = skills.DISABLED
    flow = B._flow({"answer_node": "tl", "nodes": [
        {"key": "k", "type": "skill", "skill_key": "so_sanh", "version": 2, "inputs": {}},
        B._agent("tl", "TRA_LOI", tools=())]})
    assert minimum_calls(flow.nodes, skill_lookup=skill_lookup_for(skill_db.db)) == (1, 0)


def test_an_answer_only_round_runs_no_tool_even_if_the_model_asks(monkeypatch):
    """The model's last call is offered no tools; a tool call it produces anyway
    must not run (it used to pass `is_visible` and execute)."""
    ran = []

    def tool(ctx, name, args, allowed=None, use_cache=True):
        ran.append(name)
        return {"ok": True, "kind": "value", "data": {"value": 1}}

    class Stubborn(B._Greedy):
        def stream(self):
            async def fake(*, provider, api_key, model, system_prompt, messages, tools):
                self.calls.append({"role": "TRA_LOI", "offered": [t.get("name") for t in tools or []],
                                   "last_user": ""})
                yield AgentEvent(type="tool_call", tool_call_id=f"c{len(self.calls)}",
                                 tool_name="total_measure", tool_args={"chart_id": 41})
            return fake

    env, model = _run_env(monkeypatch, {"answer_node": "tl", "nodes": [B._agent("tl", "TRA_LOI")]},
                          llm=2, tools=10, tool_fn=tool, model=Stubborn())
    assert model.calls[-1]["offered"] == []
    assert ran == ["total_measure"], "only the round that offered the tool ran it"
    assert "total_measure(tools_withdrawn)" in B._steps(env)[-1]["tool_calls"]


def test_an_anthropic_answer_only_round_over_tool_history_sends_no_tool_blocks():
    from app.services.dashboard_ai_bot.providers import anthropic_provider as A

    msgs = A._to_anthropic_messages([
        {"role": "user", "content": "Doanh thu?"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "t1", "name": "total_measure", "args": {"chart_id": 41}}]},
        {"role": "tool", "tool_call_id": "t1", "name": "total_measure", "result": {"ok": True, "data": {"value": 5}}},
        {"role": "user", "content": "Trả lời."},
    ])
    flat = A._flatten_tool_blocks(msgs)
    kinds = {b.get("type") for m in flat for b in (m["content"] if isinstance(m["content"], list) else [])}
    assert "tool_use" not in kinds and "tool_result" not in kinds
    text = str(flat)
    assert "total_measure" in text and "5" in text, "the history is kept, as text"
    assert [m["role"] for m in flat] == [m["role"] for m in msgs]


def test_a_rollback_is_not_refused_over_a_deprecated_pin(monkeypatch):
    import inspect

    from app.services.agent_flows import registry as reg

    src = inspect.getsource(reg.rollback)
    assert "allow_deprecated_pins=True" in src
    assert "allow_deprecated_pins" in inspect.signature(reg.publish).parameters


# ── found by the first live eval ────────────────────────────────────────────
def test_an_id_passed_as_a_numeric_string_is_the_id():
    """Models pass `"686"` for an integer `chart_id`; `rank_values` refused it as
    bad_argument three times in a row and the step answered "no data"."""
    import inspect

    spec = tool_registry.all_tools()["rank_values"]
    args = {"chart_id": "686", "top_n": "3", "order": "asc"}
    out = tool_registry._coerce_numeric_args(spec, args)
    assert out == {"chart_id": 686, "top_n": 3, "order": "asc"}
    assert args["chart_id"] == "686", "the caller's dict is not mutated"
    assert tool_registry._coerce_numeric_args(spec, {"chart_id": "686; drop", "top_n": 2.5}) ==         {"chart_id": "686; drop", "top_n": 2.5}, "only an exact number is coerced"
    assert "_coerce_numeric_args(spec" in inspect.getsource(tool_registry.execute)


def test_the_cutoff_is_relative_to_the_best_candidate_not_to_the_core():
    """A KPI question ranked a core tool so high that the value reader was cut."""
    grant = [n for n in sorted(tool_registry.all_tools()) if not tool_registry.all_tools()[n].reaches_outside]
    view = CAP.build_view(grant, SimpleNamespace(web_search=True, read_rows=True), web_enabled=True,
                          question="Tỷ lệ giao hàng đúng hẹn là bao nhiêu?")
    view.refresh()
    assert {"total_measure", "get_chart_summary", "get_chart_data"} & set(view.visible)


def test_a_compute_refusal_says_what_compute_is():
    out = compute.tool_compute(SimpleNamespace(evidence_store={}), {"expression": "", "vars": {}})
    assert out["ok"] is False and "không tự đọc số liệu" in (out.get("recovery") or "")
