# -*- coding: utf-8 -*-
"""A funded run always ends by answering — or by saying, in a structured way, why not.

THE FAILURE THIS PINS
---------------------
    agent finds its evidence → asks for one more tool on its last model call →
    no call left to read it → "Chưa trả lời được: đã dùng hết số lượt gọi mô hình"

Budget is a RUNTIME rule, not a prompt: before every node the executor reserves
the minimum the nodes after it need (`runtime/reserve.py`, `Budget.reserve`), and
the last call a step may make is offered no tools (`AgentRuntime.ask`). These
tests drive greedy scripted models — models that ask for a tool whenever one is
offered — through the shapes that used to starve the answer, on the smallest
budgets that should still work:

  * one answering agent that never stops asking;
  * a gathering agent before the answering one;
  * Business Analyst → mandatory verification Skill → Answer, on the minimum;
  * a coordinator whose lanes are greedy;
  * discovery, and corrections, never touching the reservation;
  * a link funded below the flow's minimum is refused at assignment;
  * every step records where its budget went.
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

import pytest  # noqa: E402

import replay_harness as H  # noqa: E402
from test_skills_run_as_governed_children import SKILL_BODY, _children, skill_db  # noqa: E402,F401

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.agent_flows.runtime.reserve import minimum_calls  # noqa: E402
from app.services.agent_flows.runtime.state import Budget, StepBudgetExhausted  # noqa: E402
from app.services.agent_flows.runtime.strategies.tool_calling import FINAL_ROUND  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402


# ── a greedy world ──────────────────────────────────────────────────────────
class _Greedy:
    """Every agent asks for a tool whenever one is offered; the planner picks every
    lane. Role is read from a marker in the system prompt."""

    def __init__(self):
        self.calls: list[dict] = []

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            role = "PLANNER" if "Chọn (các) chuyên gia" in system_prompt else next(
                (m for m in ("GOM", "TRA_LOI", "VAI_TRO_CON", "CHUYEN_GIA") if m in system_prompt), "?")
            names = [t.get("name") for t in (tools or [])]
            self.calls.append({"role": role, "offered": names,
                               "last_user": next((m.get("content") for m in reversed(messages)
                                                  if m.get("role") == "user"), "")})
            if role == "PLANNER":
                yield AgentEvent(type="text", text="cg_a, cg_b")
            elif tools:
                tool = "total_measure" if "total_measure" in names else names[0]
                yield AgentEvent(type="tool_call", tool_call_id=f"c{len(self.calls)}",
                                 tool_name=tool, tool_args={"chart_id": 41})
            else:
                yield AgentEvent(type="text", text=f"{role}: kết luận từ dữ liệu đã có.")
            yield AgentEvent(type="usage", extra={"prompt_tokens": 5, "completion_tokens": 2})
        return fake

    def by(self, role):
        return [c for c in self.calls if c["role"] == role]


def _tool(ctx, name, args, allowed=None, use_cache=True):
    if allowed is not None and name not in allowed:
        return {"ok": False, "error_code": "not_granted", "error": "not granted"}
    return {"ok": True, "kind": "value", "data": {"value": 1234.5}}


def _flow(body: dict, key: str = "fx_budget") -> Flow:
    return Flow.model_validate({**upgrade_body(copy.deepcopy(body), key=key, name=key),
                                "key": key, "name": key})


def _run(monkeypatch, body, *, llm, tools=30, db=None, model=None):
    model = model or _Greedy()
    monkeypatch.setattr(AH, "_stream", model.stream())
    monkeypatch.setattr(tool_registry, "execute", _tool)
    env = H._envelope({"envelope": {"runtime": {"provider": "openai", "model": "m", "budget": {
        "max_llm_calls": llm, "max_tool_calls": tools, "max_seconds": 60}}}})
    holder = {}

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=_flow(body),
                                          ctx=H._Ctx([41]), api_key="k", base_system_prompt="BASE",
                                          db=db, on_state=lambda s: holder.setdefault("s", s)):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    return asyncio.run(go()), model, holder.get("s")


def _answer(env) -> str:
    return "".join(b.get("markdown") or b.get("text") or "" for b in
                   ((env.get("answer") or {}).get("blocks") or []))


def _codes(env) -> list[str]:
    return [n.get("code") for n in env.get("notices") or []]


def _steps(env) -> list[dict]:
    return (env.get("trace") or {}).get("steps") or []


def _agent(key, marker, *, tools=("total_measure",), **kw):
    return {"key": key, "name": key, "type": "agent", "prompt": f"{marker} làm việc",
            "max_tool_calls": 10, "tools": [{"tool": t} for t in tools], **kw}


# ── 1. the answering step itself ────────────────────────────────────────────
def test_an_agent_that_never_stops_asking_for_tools_still_answers(monkeypatch):
    env, model, _ = _run(monkeypatch, {"answer_node": "tl", "nodes": [_agent("tl", "TRA_LOI")]}, llm=3)
    rounds = model.by("TRA_LOI")
    assert [bool(r["offered"]) for r in rounds] == [True, True, False]
    assert rounds[-1]["last_user"] == FINAL_ROUND, "the final round is TOLD it is final"
    assert "kết luận" in _answer(env)
    assert env["status"] == "ok" and "budget_exhausted" not in _codes(env)
    assert env["usage"]["llm_calls"] == 3
    assert _steps(env)[-1]["capabilities"]["final_rounds"] == 1


def test_a_gathering_step_cannot_spend_the_answering_steps_call(monkeypatch):
    body = {"answer_node": "tl", "nodes": [_agent("gom", "GOM"), _agent("tl", "TRA_LOI", tools=())]}
    env, model, _ = _run(monkeypatch, body, llm=4)
    assert len(model.by("GOM")) == 3 and model.by("GOM")[-1]["offered"] == []
    assert len(model.by("TRA_LOI")) == 1
    assert "TRA_LOI" in _answer(env) and env["status"] == "ok"
    gom = next(s for s in _steps(env) if s["key"] == "gom")
    assert gom["budget"]["llm_calls"] == 3
    assert gom["budget"]["llm_reserved_for_later"] == 1
    assert gom["budget"]["llm_available_at_start"] == 3


def test_an_underfunded_gathering_step_is_skipped_not_the_answer(monkeypatch):
    """One model call for two agents: the answer gets it; the gatherer is refused,
    recorded as such, and the run says the answer may be incomplete."""
    body = {"answer_node": "tl", "nodes": [_agent("gom", "GOM"), _agent("tl", "TRA_LOI", tools=())]}
    env, model, _ = _run(monkeypatch, body, llm=1)
    assert model.by("GOM") == [] and len(model.by("TRA_LOI")) == 1
    gom = next(s for s in _steps(env) if s["key"] == "gom")
    assert gom["status"] == "error" and "giữ cho các bước" in gom["error"]
    assert "steps_skipped_for_budget" in _codes(env)
    assert env["status"] == "partial" and "TRA_LOI" in _answer(env)


# ── 2. Business Analyst → mandatory Skill → Answer ──────────────────────────
BA_SKILL_ANSWER = {
    "answer_node": "tl",
    "nodes": [
        _agent("ba", "GOM"),
        {"key": "kiem_tra", "name": "Kiểm chứng", "type": "skill", "skill_key": "so_sanh",
         "version": 2, "inputs": {"question": {"source": "literal", "value": "Doanh thu?"},
                                  "chart_id": {"source": "literal", "value": 41}}},
        _agent("tl", "TRA_LOI", tools=()),
    ],
}


def test_the_minimum_of_a_flow_counts_its_skill_and_its_answer(skill_db):
    from app.services.agent_flows.runtime.reserve import skill_lookup_for

    # analyst 1 + the Skill's own agent 1 + the answer 1; no Tool step anywhere
    assert minimum_calls(_flow(BA_SKILL_ANSWER).nodes, skill_lookup=skill_lookup_for(skill_db.db)) == (3, 0)


def test_a_mandatory_verifier_skill_and_the_answer_run_on_the_minimum_budget(monkeypatch, skill_db):
    env, model, _ = _run(monkeypatch, BA_SKILL_ANSWER, llm=3, db=skill_db.db)
    assert len(model.by("GOM")) == 1 and model.by("GOM")[0]["offered"] == [], \
        "the analyst gets exactly what is not owed to the verifier and the answer"
    assert len(model.by("VAI_TRO_CON")) == 1, "the verifier Skill ran"
    [child] = _children(skill_db.db)
    assert child.status in ("ok", "partial")
    assert len(model.by("TRA_LOI")) == 1 and env["status"] == "ok"


def test_with_room_the_analyst_uses_it_and_nothing_downstream_is_starved(monkeypatch, skill_db):
    env, model, state = _run(monkeypatch, BA_SKILL_ANSWER, llm=8, db=skill_db.db)
    assert len(model.by("GOM")) == 6          # 8 − (verifier 1 + answer 1)
    assert model.by("GOM")[-1]["offered"] == []
    assert model.by("VAI_TRO_CON") and model.by("TRA_LOI")
    assert env["status"] == "ok"
    # The child spent the PARENT's budget: every call is on one ledger.
    assert state.budget.llm_calls == env["usage"]["llm_calls"] == 8


def test_a_skill_the_answering_agent_calls_leaves_it_its_reading_round(monkeypatch, skill_db):
    body = {"answer_node": "tl", "nodes": [{
        "key": "tl", "name": "tl", "type": "agent", "prompt": "TRA_LOI",
        "max_tool_calls": 10, "tools": [{"tool": "skill:so_sanh", "version": 2}]}]}

    class M(_Greedy):
        def stream(self):
            inner = super().stream()

            async def fake(**kw):
                if "TRA_LOI" in kw["system_prompt"] and kw["tools"]:
                    self.calls.append({"role": "TRA_LOI", "offered": [t["name"] for t in kw["tools"]],
                                       "last_user": ""})
                    yield AgentEvent(type="tool_call", tool_call_id="s1", tool_name="skill__so_sanh",
                                     tool_args={"question": "Doanh thu?", "chart_id": 41})
                    return
                async for ev in inner(**kw):
                    yield ev
            return fake

    env, model, _ = _run(monkeypatch, body, llm=4, db=skill_db.db, model=M())
    assert len(model.by("VAI_TRO_CON")) == 2       # 4 − 1 asked − 1 kept to read
    assert model.by("TRA_LOI")[-1]["offered"] == []
    assert "TRA_LOI" in _answer(env) and env["status"] == "ok"


def _calls_skill_whenever_offered():
    class M(_Greedy):
        def stream(self):
            inner = super().stream()

            async def fake(**kw):
                if "TRA_LOI" in kw["system_prompt"] and kw["tools"]:
                    self.calls.append({"role": "TRA_LOI", "offered": [t["name"] for t in kw["tools"]],
                                       "last_user": ""})
                    yield AgentEvent(type="tool_call", tool_call_id=f"s{len(self.calls)}",
                                     tool_name="skill__so_sanh",
                                     tool_args={"question": "Doanh thu?", "chart_id": 41})
                    return
                async for ev in inner(**kw):
                    yield ev
            return fake
    return M()


_CALLS_SKILL = {"answer_node": "tl", "nodes": [{
    "key": "tl", "name": "tl", "type": "agent", "prompt": "TRA_LOI",
    "max_tool_calls": 10, "tools": [{"tool": "skill:so_sanh", "version": 2}]}]}


def test_the_working_minimum_is_a_different_question_from_the_reservation(skill_db):
    from app.services.agent_flows.runtime.reserve import working_minimum

    skill = _flow(SKILL_BODY, key="so_sanh")
    # The reservation: its one agent step can END on one call.
    assert minimum_calls(list(skill.nodes)) == (1, 0)
    # Doing what it is for: that step has tools, so one round that can call one.
    assert working_minimum(list(skill.nodes)) == (2, 1)
    speaks_only = copy.deepcopy(SKILL_BODY)
    speaks_only["nodes"][0]["tools"] = []
    assert working_minimum(list(_flow(speaks_only, key="so_sanh").nodes)) == (1, 0)


def test_a_skill_handed_less_than_one_tool_round_is_refused_before_it_runs(monkeypatch, skill_db):
    """Measured live on a 6-call link: the child got its answer round only, ran no
    tool, and handed back "bạn có thể sử dụng compare_periods…", recorded `ok`.
    3 calls − 1 asked − 1 kept to read leaves the Skill 1: not enough for a tool
    round, so it is not started and the calling step keeps its calls."""
    env, model, state = _run(monkeypatch, _CALLS_SKILL, llm=3, db=skill_db.db,
                             model=_calls_skill_whenever_offered())
    assert model.by("VAI_TRO_CON") == [], "the starved Skill never ran"
    assert _children(skill_db.db) == [], "and never recorded a child run"
    refusals = [e["result"] for e in state.evidence_store.values()] if state else []
    assert refusals == [], "a refusal is not evidence"
    step = next(s for s in _steps(env) if s["key"] == "tl")
    assert "skill__so_sanh(budget_exhausted)" in (step.get("tool_calls") or []), step.get("tool_calls")
    assert model.by("TRA_LOI")[-1]["offered"] == [] and "TRA_LOI" in _answer(env)
    assert env["status"] == "ok"
    assert state.budget.llm_calls == 3, "the refused Skill spent nothing of its own"


def test_the_refusal_says_why_and_that_retrying_cannot_help(monkeypatch, skill_db):
    from app.services.agent_flows import skills

    seen = {}
    real = skills.invoke_skill

    async def spy(*a, **kw):
        async for ev in real(*a, **kw):
            yield ev
        seen.setdefault("results", []).append(kw["outcome"].get("result"))

    monkeypatch.setattr(skills, "invoke_skill", spy)
    _run(monkeypatch, _CALLS_SKILL, llm=3, db=skill_db.db, model=_calls_skill_whenever_offered())
    first = seen["results"][0]
    assert first["ok"] is False and first["error_code"] == "budget_exhausted"
    assert first["retryable"] is False and "cần ít nhất 2 lượt" in first["error"]
    assert "Không gọi lại Skill này" in first["recovery"]


# ── 3. coordinator lanes spend the parent's budget, never the answer's ──────
def test_greedy_specialists_cannot_spend_the_answering_steps_call(monkeypatch):
    body = {"answer_node": "tl", "nodes": [
        {"key": "dp", "name": "Điều phối", "type": "coordinate", "prompt": "Chọn",
         "max_specialists": 2, "specialists": [
             {"key": "cg_a", "name": "A", "when": "doanh thu", "body": [_agent("a1", "CHUYEN_GIA")]},
             {"key": "cg_b", "name": "B", "when": "đánh giá", "body": [_agent("b1", "CHUYEN_GIA")]}]},
        _agent("tl", "TRA_LOI", tools=())]}
    env, model, _ = _run(monkeypatch, body, llm=6)
    assert len(model.by("PLANNER")) == 1
    assert len(model.by("TRA_LOI")) == 1 and env["status"] in ("ok", "partial")
    assert "TRA_LOI" in _answer(env)
    assert env["usage"]["llm_calls"] <= 6
    # Every specialist round that ended the specialist's budget was answer-only.
    lanes = model.by("CHUYEN_GIA")
    assert lanes and lanes[-1]["offered"] == []
    # BOTH chosen specialists ran: the first could not spend the second's call.
    steps = {s["key"]: s for s in _steps(env)}
    assert steps["a1"]["status"] == "ok" and steps["b1"]["status"] == "ok"
    assert steps["a1"]["budget"]["llm_reserved_for_later"] >= 2   # lane b + the answer


# ── 4. nothing resets, nothing eats the reservation ─────────────────────────
def test_a_correction_round_never_spends_a_later_steps_reservation():
    b = Budget(max_llm_calls=3, max_tool_calls=10)
    with b.reserve(llm=2, tools=0):
        assert b.try_spend_llm() is True       # the step's own call
        assert b.try_spend_llm() is False      # a correction would eat the reservation
    assert b.try_spend_llm() is True           # after the reservation is released


def test_the_step_budget_rule_raises_the_right_thing():
    from app.services.agent_flows.runtime.agent_runtime import AgentRuntime

    b = Budget(max_llm_calls=2, max_tool_calls=10)
    rt = SimpleNamespace(state=SimpleNamespace(budget=b))
    with b.reserve(llm=2, tools=0):
        assert AgentRuntime.can_ask(rt) is False
    b.llm_calls = 2
    assert AgentRuntime.can_ask(rt) is False
    assert issubclass(StepBudgetExhausted, Exception)


def test_discovery_spends_the_step_budget_and_is_capped(monkeypatch):
    from app.services.agent_flows.runtime import capabilities as CAP

    everything = [n for n in sorted(tool_registry.all_tools())
                  if not tool_registry.all_tools()[n].reaches_outside]

    class Finder(_Greedy):
        def stream(self):
            async def fake(*, provider, api_key, model, system_prompt, messages, tools):
                names = [t.get("name") for t in (tools or [])]
                self.calls.append({"role": "TRA_LOI", "offered": names, "last_user": ""})
                if CAP.FIND_CAPABILITY in names:
                    yield AgentEvent(type="tool_call", tool_call_id=f"f{len(self.calls)}",
                                     tool_name=CAP.FIND_CAPABILITY, tool_args={"need": "dự báo"})
                else:
                    yield AgentEvent(type="text", text="TRA_LOI xong")
            return fake

    body = {"answer_node": "tl", "nodes": [{
        "key": "tl", "name": "tl", "type": "agent", "prompt": "TRA_LOI", "max_tool_calls": 20,
        "visible_capabilities": 6, "tools": [{"tool": t} for t in everything]}]}
    env, model, _ = _run(monkeypatch, body, llm=8, model=Finder())
    step = _steps(env)[-1]
    calls = step["tool_calls"]
    assert calls.count(CAP.FIND_CAPABILITY) == CAP.MAX_DISCOVERIES
    assert f"{CAP.FIND_CAPABILITY}(discovery_exhausted)" in calls
    assert env["usage"]["tool_calls"] == CAP.MAX_DISCOVERIES   # charged, and only when it ran
    assert "TRA_LOI xong" in _answer(env)


# ── 5. assignment refuses a link that cannot fund the minimum ───────────────
def test_minimum_is_the_one_definition_the_preflight_reads():
    flow = _flow({"answer_node": "tl", "nodes": [_agent("gom", "GOM"), _agent("tl", "TRA_LOI")]})
    assert minimum_calls(flow.nodes) == (2, 0)
    branchy = _flow({"answer_node": "tl", "nodes": [
        {"key": "r", "type": "report_read", "output_var": "ctx_r"},
        {"key": "sw", "type": "if", "paths": [
            {"key": "co", "kind": "rules", "match": "all", "name": "co",
             "conditions": [{"left": "{{question}}", "op": "contains", "right": "x"}],
             "body": [_agent("a", "GOM"), _agent("b", "GOM")]},
            {"key": "khong", "kind": "fallback", "name": "khong", "body": [_agent("c", "GOM")]}]},
        _agent("tl", "TRA_LOI")]})
    # the most demanding branch (2) + the answer (1); one read
    assert minimum_calls(branchy.nodes) == (3, 1)
