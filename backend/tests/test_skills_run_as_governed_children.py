# -*- coding: utf-8 -*-
"""A Skill is a published flow, run by another flow as a governed CHILD run.

What these tests pin (V3 phase 5, docs/features/agent-flow-v3-capabilities):

  ONE PATH     Agent capability, Skill step and coordinator lane all reach the
               Skill through `skills.invoke_skill`.
  CHILD RUN    the Skill runs as its own run: recorded with `parent_run_key`,
               `parent_step_key`, `invoked_as`, its own exact version, and NO
               reader identity (session/link) — the reader's thumb belongs to
               the parent.
  AUTHORITY    caller ∩ Skill: the child keeps the caller's charts, rows and web
               capability; its knowledge reach is bounded by the caller's scope;
               the Skill owner's rights are never consulted at run time.
  INPUTS ONLY  nothing of the parent's variables, requirements, conversation or
               memory reaches the child — only declared inputs.
  STACK        cycles refused on flow-version identity; depth ≤ MAX_SKILL_DEPTH;
               both at publish (pinned graph) and at run time.
  BUDGET       the child spends the PARENT's budget, and leaves the parent
               the model call it needs to answer.
  PINNING      publish writes the exact Skill version into the parent's body;
               a pinned version still resolves after the Skill moves on.
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

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

import replay_harness as H  # noqa: E402

from app.models.agent_flow_run import AgentFlowRun, AgentFlowRunContent, AgentFlowRunStep  # noqa: E402
from app.services.agent_flows import runs as runs_service  # noqa: E402
from app.services.agent_flows import skills  # noqa: E402
from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.agent_flows.runtime.handlers.data import bounded_scope  # noqa: E402
from app.services.agent_flows.runtime.state import Budget  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):  # pragma: no cover - dialect shim
    return "JSON"


# ── fixtures: a Skill, and flows that call it ────────────────────────────────
SKILL_BODY = {
    "answer_node": "tinh",
    "skill": {
        "inputs": [{"name": "question", "type": "text", "required": True,
                    "description": "câu hỏi so sánh"},
                   {"name": "chart_id", "type": "number", "required": True,
                    "description": "biểu đồ doanh thu"}],
        "output": "Mức thay đổi giữa hai kỳ",
        "when_to_use": "Khi cần so sánh doanh thu giữa hai kỳ liên tiếp",
    },
    "nodes": [{
        "key": "tinh", "name": "Tính", "type": "agent",
        "prompt": "VAI_TRO_CON so sánh {{input.question}} trên biểu đồ {{input.chart_id}}",
        "tools": [{"tool": "total_measure"}, {"tool": "research_web"}, {"tool": "get_chart_data"}],
    }],
}


def _flow(body: dict, key: str) -> Flow:
    return Flow.model_validate({**upgrade_body(copy.deepcopy(body), key=key, name=key),
                                "key": key, "name": key})


def _row(key: str, version: int, *, status="published", flow_type="skill", name="So sánh kỳ"):
    return SimpleNamespace(brain_key=key, version=version, status=status,
                           flow_type=flow_type, name=name, description="")


@pytest.fixture()
def skill_db(monkeypatch):
    """A resolvable Skill `so_sanh` v2 (and archived v1), plus a SQLite run store."""
    engine = create_engine("sqlite://")
    for t in (AgentFlowRun.__table__, AgentFlowRunContent.__table__, AgentFlowRunStep.__table__):
        t.create(engine)
    session = sessionmaker(bind=engine)()
    registry = {("so_sanh", 2): (_row("so_sanh", 2), _flow(SKILL_BODY, "so_sanh")),
                ("so_sanh", 1): (_row("so_sanh", 1, status="archived"), _flow(SKILL_BODY, "so_sanh"))}

    def resolve(db, key, version):
        if version is None:
            version = max((v for k, v in registry if k == key), default=None)
        return registry.get((key, version))

    monkeypatch.setattr(skills, "resolve_skill", resolve)
    # Who may still build on which Skill, re-asked at every invocation
    # (`skills.caller_may_use`). This store has no flow table, so sharing is
    # modelled here explicitly — and a test can revoke it mid-life.
    shared = {"so_sanh"}
    monkeypatch.setattr(skills, "caller_may_use", lambda db, caller, key: key in shared)
    yield SimpleNamespace(db=session, registry=registry, shared=shared)
    session.close()


# ── the model and the tools ──────────────────────────────────────────────────
class _Model:
    """Parent and child agents, told apart by their prompts."""

    def __init__(self, parent_script, child_script):
        self.scripts = {"VAI_TRO_CHA": list(parent_script), "VAI_TRO_CON": list(child_script)}
        self.rounds = {"VAI_TRO_CHA": 0, "VAI_TRO_CON": 0}
        self.offered: dict[str, list[list[str]]] = {"VAI_TRO_CHA": [], "VAI_TRO_CON": []}

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            role = "VAI_TRO_CON" if "VAI_TRO_CON" in system_prompt else "VAI_TRO_CHA"
            i = self.rounds[role]
            self.rounds[role] += 1
            self.offered[role].append([t.get("name") for t in (tools or [])])
            step = self.scripts[role][i] if i < len(self.scripts[role]) else ("text", "xong")
            if step[0] == "calls" and not tools:
                # A real model cannot call a tool it was not offered.
                step = ("text", "Trả lời bằng những gì đã có.")
            if step[0] == "calls":
                for j, (name, args) in enumerate(step[1]):
                    yield AgentEvent(type="tool_call", tool_call_id=f"{role}{i}{j}",
                                     tool_name=name, tool_args=args)
            else:
                text = step[1]
                if callable(text):
                    text = text(messages)
                yield AgentEvent(type="text", text=text)
            yield AgentEvent(type="usage", extra={"prompt_tokens": 7, "completion_tokens": 3})
        return fake


def _tools(ctx, name, args, allowed=None, use_cache=True):
    """The REAL gates, then fake data: scope, grant and capability refusals are the
    registry's own code, so what these tests pin is the governance, not a stub."""
    if allowed is not None and name not in allowed:
        return {"ok": False, "error_code": "not_granted", "error": "not granted"}
    spec = tool_registry.all_tools().get(name)
    refused = tool_registry._capability_refusal(ctx, spec)
    if refused:
        return refused
    cid = (args or {}).get("chart_id")
    if cid is not None and int(cid) not in ctx.allowed_chart_ids:
        return {"ok": False, "error_code": "chart_out_of_scope", "error": "out of scope",
                "retryable": False}
    return {"ok": True, "kind": "value", "data": {"value": 1234.5, "measure": "revenue"}}


PARENT_GRANTING_SKILL = {
    "answer_node": "tra_loi",
    "requirements": {"items": []},
    "nodes": [{
        "key": "tra_loi", "name": "Trả lời", "type": "agent",
        "prompt": "VAI_TRO_CHA trả lời câu hỏi",
        "tools": [{"tool": "total_measure"}, {"tool": "skill:so_sanh", "version": 2}],
    }],
}


def _run(monkeypatch, db, body, model, *, ctx=None, envelope=None, budget=None, key="cha",
         store_content=True):
    monkeypatch.setattr(AH, "_stream", model.stream())
    monkeypatch.setattr(tool_registry, "execute", _tools)
    flow = _flow(body, key)
    env = H._envelope(envelope or {"envelope": {"request": {"id": "run-parent-1", "trigger": "studio_test"}}})
    inp = FlowInput.model_validate(env)
    ctx = ctx or H._Ctx([41])
    holder = {}

    async def go():
        out = None
        async for ev in executor.run_flow(inp, flow=flow, ctx=ctx, api_key="k",
                                          base_system_prompt="BASE", db=db, budget=budget,
                                          store_content=store_content,
                                          on_state=lambda s: holder.setdefault("state", s)):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    return asyncio.run(go()), holder.get("state"), ctx


def _children(db):
    return db.query(AgentFlowRun).filter(AgentFlowRun.parent_run_key.isnot(None)).all()


SKILL_CALL = ("calls", [("skill__so_sanh", {"question": "Doanh thu tháng 9 so với tháng 8?", "chart_id": 41})])


# ── 1. Agent → Skill → child run ─────────────────────────────────────────────
def test_an_agent_invokes_a_pinned_skill_as_a_recorded_child_run(monkeypatch, skill_db):
    model = _Model(
        parent_script=[SKILL_CALL, ("text", "Doanh thu là 1234.5.")],
        child_script=[("calls", [("total_measure", {"chart_id": 41})]), ("text", "Đã so sánh: 1234.5")],
    )
    # A REAL reader turn: a session and a public link. The child must carry
    # neither, or the reader's thumb could land on it.
    reader = {"envelope": {
        "request": {"id": "run-parent-1", "trigger": "public_chat"},
        "conversation": {"session_key": "sess-reader-1"},
        "binding": {"id": 1, "flow_version": 1, "allowed_chart_ids": [41], "link_token": "tok-link-1",
                    "capabilities": {"web_search": False, "read_rows": True}},
    }}
    env, state, _ = _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model, envelope=reader)

    assert "skill__so_sanh" in model.offered["VAI_TRO_CHA"][0]
    kids = _children(skill_db.db)
    assert len(kids) == 1
    child = kids[0]
    assert (child.brain_key, child.version) == ("so_sanh", 2)
    assert child.parent_run_key == "run-parent-1"
    assert child.parent_step_key == "tra_loi"
    assert child.invoked_as == "agent_capability"
    assert child.trigger == "skill"
    assert child.session_key is None and child.link_token is None
    steps = skill_db.db.query(AgentFlowRunStep).filter(AgentFlowRunStep.run_id == child.id).all()
    assert [s.node_key for s in steps] == ["tinh"]
    # The parent's trace names the exact version it ran.
    parent_calls = ((env.get("trace") or {}).get("steps") or [{}])[0].get("tool_calls") or []
    assert "skill:so_sanh@v2" in parent_calls
    # The child's trusted figure is the parent's evidence: the answer verifies.
    assert 1234.5 in state.evidence
    assert "figures_unverified" not in {n.get("code") for n in env.get("notices") or []}


def test_the_skill_result_the_parent_sees_names_its_child_run(monkeypatch, skill_db):
    seen = {}

    def capture(messages):
        seen["result"] = [m.get("result") for m in messages if m.get("role") == "tool"][-1]
        return "xong"

    model = _Model(parent_script=[SKILL_CALL, ("text", capture)],
                   child_script=[("text", "Kết quả của Skill")])
    _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model)
    data = seen["result"]["data"]
    assert data["skill"] == "so_sanh" and data["version"] == 2
    assert data["answer"] == "Kết quả của Skill"
    assert data["child_run_key"] == _children(skill_db.db)[0].run_key
    # This parent holds no `compute`, so it is not shown references (review P2).
    assert "evidence_ref" not in seen["result"]


# ── 2. the deterministic surfaces share the same path ────────────────────────
def _skill_step_flow(in_lane: bool = False) -> dict:
    step = {"key": "chay_skill", "name": "Chạy Skill", "type": "skill", "skill_key": "so_sanh",
            "version": 2, "output_var": "ket_qua",
            "inputs": {"question": {"source": "literal", "value": "So sánh tháng 9"},
                       "chart_id": {"source": "literal", "value": 41}}}
    answer = {"key": "tra_loi", "name": "Trả lời", "type": "agent",
              "prompt": "VAI_TRO_CHA nói lại {{ket_qua}}"}
    if not in_lane:
        return {"answer_node": "tra_loi", "nodes": [step, answer]}
    coord = {"type": "coordinate", "key": "dieu_phoi", "name": "Điều phối", "max_specialists": 1,
             "specialists": [{"key": "cg_so_sanh", "name": "So sánh", "when": "câu hỏi so sánh hai kỳ",
                              "body": [step]},
                             {"key": "cg_khac", "name": "Khác", "when": "mọi câu hỏi còn lại",
                              "body": [{"key": "khac", "type": "set_var", "var": "x", "value": "1"}]}]}
    return {"answer_node": "tra_loi", "nodes": [coord, answer]}


def test_a_skill_step_runs_the_same_governed_child_without_a_model_deciding(monkeypatch, skill_db):
    model = _Model(parent_script=[("text", "Đã nói lại.")],
                   child_script=[("text", "Kết quả Skill")])
    env, state, _ = _run(monkeypatch, skill_db.db, _skill_step_flow(), model)
    [child] = _children(skill_db.db)
    assert child.invoked_as == "skill_node" and child.parent_step_key == "chay_skill"
    assert state.vars["ket_qua"]["answer"] == "Kết quả Skill"
    # The parent answering step ran once; the Skill step itself called no model.
    assert model.rounds["VAI_TRO_CHA"] == 1


def test_a_skill_inside_a_coordinator_lane_is_recorded_as_that_lanes_work(monkeypatch, skill_db):
    planner = ("text", "cg_so_sanh")
    model = _Model(parent_script=[planner, ("text", "Xong.")], child_script=[("text", "Kết quả")])
    _run(monkeypatch, skill_db.db, _skill_step_flow(in_lane=True), model)
    [child] = _children(skill_db.db)
    assert child.invoked_as == "coordinator_lane"


# ── 3. authority: caller ∩ Skill ─────────────────────────────────────────────
def test_the_child_cannot_exceed_the_callers_web_rows_or_charts(monkeypatch, skill_db):
    """Parent link: no web, no raw rows, chart 41 only. The Skill's agent is
    GRANTED research_web and get_chart_data and asks for chart 99."""
    model = _Model(
        parent_script=[SKILL_CALL, ("text", "Xong.")],
        child_script=[("calls", [("research_web", {"query": "gdp"}),
                                 ("get_chart_data", {"chart_id": 41}),
                                 ("total_measure", {"chart_id": 99})]),
                      ("text", "Không lấy được.")],
    )
    ctx = H._Ctx([41], read_rows=False, web_search=False)
    _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model, ctx=ctx)
    [child] = _children(skill_db.db)
    [step] = skill_db.db.query(AgentFlowRunStep).filter(AgentFlowRunStep.run_id == child.id).all()
    calls = step.tool_calls or []
    # research_web and get_chart_data are INELIGIBLE on this caller (never shown);
    # invoked anyway they are refused by the registry. chart 99 is out of scope.
    assert "research_web(not_granted)" in calls
    assert "get_chart_data(not_granted)" in calls
    assert "total_measure(chart_out_of_scope)" in calls


def test_the_childs_knowledge_reach_is_bounded_by_the_callers_scope():
    ctx = SimpleNamespace(knowledge_ceiling={"doc_ids": [1, 2], "dataset_ids": [],
                                             "metric_names": [], "term_fqns": []})
    empty = {"doc_ids": [], "dataset_ids": [], "metric_names": [], "term_fqns": []}
    assert bounded_scope(ctx, {**empty, "doc_ids": [2, 3]})["doc_ids"] == [2]
    assert bounded_scope(ctx, {**empty, "doc_ids": [3]})["doc_ids"] == [-1], \
        "no overlap must mean NOTHING, not 'everything' (an empty list)"
    assert bounded_scope(ctx, empty)["doc_ids"] == [1, 2]
    assert bounded_scope(SimpleNamespace(), {**empty, "doc_ids": [3]})["doc_ids"] == [3]


def test_the_skill_owners_rights_are_never_consulted_at_run_time(monkeypatch, skill_db):
    from app.services.agent_flows import permissions

    def forbidden(*a, **k):  # pragma: no cover - the assertion is that it is not called
        raise AssertionError("a Skill run consulted owner-based scope")

    monkeypatch.setattr(permissions, "run_scope", forbidden)
    monkeypatch.setattr(permissions, "usable_brains", forbidden)
    model = _Model(parent_script=[SKILL_CALL, ("text", "Xong.")], child_script=[("text", "ok")])
    _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model)
    assert len(_children(skill_db.db)) == 1


def test_the_child_gets_its_inputs_and_nothing_else_of_the_parents_context(monkeypatch, skill_db):
    seen = {}
    real = skills.invoke_skill

    async def spy(state, rctx, **kw):
        async for ev in real(state, rctx, **kw):
            yield ev

    captured = {}
    real_run_flow = executor.run_flow

    def run_flow_spy(inp, **kw):
        if inp.request.trigger == "skill":
            captured["inp"] = inp
            on_state = kw.get("on_state")

            def keep(s):
                on_state(s)
                captured["vars"] = s.vars
            kw["on_state"] = keep
        return real_run_flow(inp, **kw)

    monkeypatch.setattr(executor, "run_flow", run_flow_spy)
    env = {"envelope": {"request": {"id": "run-parent-1", "trigger": "studio_test"},
                        "conversation": {"session_key": "sess-9",
                                         "history": [{"role": "user", "content": "câu trước"}]},
                        "binding": {"id": 1, "flow_version": 1, "allowed_chart_ids": [41],
                                    "defaults": {"bi_mat": "của flow cha"},
                                    "capabilities": {"web_search": False, "read_rows": True}}}}
    model = _Model(parent_script=[SKILL_CALL, ("text", "Xong.")], child_script=[("text", "ok")])
    _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model, envelope=env)
    child_inp = captured["inp"]
    assert child_inp.question.raw == "Doanh thu tháng 9 so với tháng 8?"
    assert child_inp.conversation.history == [] and child_inp.conversation.session_key == ""
    assert "bi_mat" not in captured["vars"]
    assert captured["vars"]["input"] == {"question": "Doanh thu tháng 9 so với tháng 8?", "chart_id": 41.0}


def test_a_missing_required_input_is_refused_before_any_child_runs(monkeypatch, skill_db):
    model = _Model(parent_script=[("calls", [("skill__so_sanh", {"question": "x"})]), ("text", "Xong.")],
                   child_script=[("text", "không được chạy")])
    env, _, _ = _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model)
    assert _children(skill_db.db) == []
    calls = ((env.get("trace") or {}).get("steps") or [{}])[0].get("tool_calls") or []
    assert "skill__so_sanh(bad_argument)" in calls


def test_an_ungranted_skill_is_refused(monkeypatch, skill_db):
    body = copy.deepcopy(PARENT_GRANTING_SKILL)
    body["nodes"][0]["tools"] = [{"tool": "total_measure"}]
    model = _Model(parent_script=[SKILL_CALL, ("text", "Xong.")], child_script=[("text", "x")])
    env, _, _ = _run(monkeypatch, skill_db.db, body, model)
    assert _children(skill_db.db) == []
    calls = ((env.get("trace") or {}).get("steps") or [{}])[0].get("tool_calls") or []
    assert "skill__so_sanh(not_granted)" in calls


# ── 4. the stack: cycles and depth ───────────────────────────────────────────
def _invoke(rctx, **over):
    state = SimpleNamespace(budget=Budget(), evidence=[], evidence_labels=set(),
                            evidence_sources=set(), prompt_tokens=0, completion_tokens=0,
                            citations=[], tool_log=[], lane_depth=0)
    outcome: dict = {}

    async def go():
        async for _ in skills.invoke_skill(state, rctx, skill_key="so_sanh", version=2,
                                           inputs={"question": "q", "chart_id": 41},
                                           invoked_as="skill_node", parent_step_key="s",
                                           outcome=outcome, **over):
            pass
    asyncio.run(go())
    return outcome["result"]


def test_a_skill_already_on_the_stack_is_a_cycle_at_run_time(skill_db):
    rctx = SimpleNamespace(db=skill_db.db, flow=SimpleNamespace(key="cha"),
                           skill_stack=(("khac", 1), ("so_sanh", 2)))
    assert _invoke(rctx)["error_code"] == "skill_cycle"


def test_a_skill_calling_itself_is_a_cycle(skill_db):
    rctx = SimpleNamespace(db=skill_db.db, flow=SimpleNamespace(key="so_sanh"), skill_stack=())
    assert _invoke(rctx)["error_code"] == "skill_cycle"


def test_skill_call_depth_is_bounded_separately_from_flow_nesting(skill_db):
    rctx = SimpleNamespace(db=skill_db.db, flow=SimpleNamespace(key="cha"),
                           skill_stack=(("a", 1), ("b", 1), ("c", 1)))
    assert _invoke(rctx)["error_code"] == "skill_depth_exceeded"


def test_the_pinned_graph_is_checked_for_cycles_at_publish(monkeypatch):
    """A@v7 → B@v3 → C@v2 → B@v3 is a cycle by version identity."""
    def body_calling(key, version):
        return {"answer_node": "n", "skill": SKILL_BODY["skill"], "nodes": [{
            "key": "n", "type": "skill", "skill_key": key, "version": version,
            "inputs": {"question": {"source": "literal", "value": "q"},
                       "chart_id": {"source": "literal", "value": 1}}}]}

    graph = {("b", 3): body_calling("c", 2), ("c", 2): body_calling("b", 3)}
    monkeypatch.setattr(skills, "resolve_skill", lambda db, k, v: (
        (_row(k, v), _flow(graph[(k, v)], k)) if (k, v) in graph else None))
    parent = _flow(body_calling("b", 3), "a")
    problems = skills.skill_graph_problems(None, parent, self_key="a")
    assert any("Vòng lặp Skill" in p and "b@v3" in p for p in problems), problems


def test_a_chain_deeper_than_the_limit_is_refused_at_publish(monkeypatch):
    def body_calling(key):
        return {"answer_node": "n", "skill": SKILL_BODY["skill"], "nodes": [{
            "key": "n", "type": "skill", "skill_key": key, "version": 1,
            "inputs": {"question": {"source": "literal", "value": "q"},
                       "chart_id": {"source": "literal", "value": 1}}}]}
    graph = {("s1", 1): body_calling("s2"), ("s2", 1): body_calling("s3"),
             ("s3", 1): body_calling("s4"), ("s4", 1): {**SKILL_BODY}}
    monkeypatch.setattr(skills, "resolve_skill", lambda db, k, v: (
        (_row(k, 1), _flow(graph[(k, 1)], k)) if (k, 1) in graph else None))
    problems = skills.skill_graph_problems(None, _flow(body_calling("s1"), "top"), self_key="top")
    assert any("sâu quá" in p for p in problems), problems


def test_a_flow_referencing_itself_as_a_skill_is_refused_at_publish(skill_db):
    body = copy.deepcopy(PARENT_GRANTING_SKILL)
    problems = skills.skill_graph_problems(None, _flow(body, "so_sanh"), self_key="so_sanh")
    assert any("chính flow này" in p for p in problems)


# ── 5. budget: the parent's, never a new one ─────────────────────────────────
def test_the_child_spends_the_parents_budget_and_leaves_it_its_answer(monkeypatch, skill_db):
    budget = Budget(max_llm_calls=12, max_tool_calls=12, max_seconds=60)
    many = ("calls", [("total_measure", {"chart_id": 41})] * 8)
    model = _Model(parent_script=[SKILL_CALL, ("text", "Xong.")],
                   child_script=[many, many, ("text", "ok")])
    _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model, budget=budget)
    [child] = _children(skill_db.db)
    # Every child call is a parent call: the parent's counters include them.
    assert budget.tool_calls >= 1 + child.tool_calls
    assert budget.llm_calls >= 2 + child.llm_calls
    # Never past the parent's own answer reserve for tools...
    assert child.tool_calls <= 12 - min(6, 12 // 3) - 1
    # ...and the parent still had its answer round: the run answered.
    assert budget.llm_calls <= budget.max_llm_calls


def test_a_skill_budget_cannot_be_spent_past_its_cap():
    parent = Budget(max_llm_calls=10, max_tool_calls=10, max_seconds=60)
    child = skills.child_budget(parent)
    for _ in range(child.max_tool_calls):
        child.spend_tool()
    from app.services.agent_flows.runtime.state import BudgetExhausted

    with pytest.raises(BudgetExhausted):
        child.spend_tool()
    assert parent.tool_calls == child.max_tool_calls


# ── 6. pinning ───────────────────────────────────────────────────────────────
def test_publish_pins_the_exact_skill_version_into_the_parent(skill_db):
    body = copy.deepcopy(PARENT_GRANTING_SKILL)
    body["nodes"][0]["tools"][1].pop("version")
    body["nodes"].insert(0, {"key": "st", "type": "skill", "skill_key": "so_sanh",
                             "inputs": {}})
    pinned = skills.pin_skill_versions(skill_db.db, body)
    assert pinned["nodes"][1]["tools"][1]["version"] == 2
    assert pinned["nodes"][0]["version"] == 2
    assert "version" not in body["nodes"][1]["tools"][1], "the input body is not mutated"


def test_an_existing_pin_is_kept_and_still_resolves_after_the_skill_moves_on(skill_db):
    body = copy.deepcopy(PARENT_GRANTING_SKILL)
    body["nodes"][0]["tools"][1]["version"] = 1
    assert skills.pin_skill_versions(skill_db.db, body)["nodes"][0]["tools"][1]["version"] == 1
    row, _ = skills.resolve_skill(skill_db.db, "so_sanh", 1)
    assert row.status == "archived"


# ── 7. the run history links both ────────────────────────────────────────────
def test_run_detail_links_parent_and_child(monkeypatch, skill_db):
    model = _Model(parent_script=[SKILL_CALL, ("text", "Xong.")], child_script=[("text", "ok")])
    env, _, _ = _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model)
    out = executor  # noqa: F841 - keep import used
    from app.services.agent_flows.envelope import FlowOutput

    parent_inp = FlowInput.model_validate(H._envelope(
        {"envelope": {"request": {"id": "run-parent-1", "trigger": "studio_test"}}}))
    pid = runs_service.record(skill_db.db, inp=parent_inp, out=FlowOutput.model_validate(env),
                              brain_key="cha", version=1, binding_id=1)
    monkeypatch.setattr(runs_service, "_configs_for_version", lambda db, **k: {})
    monkeypatch.setattr(runs_service, "_version_diagnosis", lambda db, **k: ([], {}))
    monkeypatch.setattr(runs_service, "_not_executed", lambda db, **k: [])
    detail = runs_service.run_detail(skill_db.db, brain_key="cha", run_id=pid)
    [child] = detail["children"]
    assert child["brain_key"] == "so_sanh" and child["invoked_as"] == "agent_capability"
    assert detail["steps"][0]["children"][0]["run_key"] == child["run_key"]
    child_detail = runs_service.run_detail(skill_db.db, brain_key="so_sanh", run_id=child["id"])
    assert child_detail["parent"]["run_key"] == "run-parent-1"
    assert child_detail["parent"]["brain_key"] == "cha"


def test_preflight_cost_counts_skill_invocations():
    from app.services.agent_flows.binding import SKILL_COST, estimate_cost

    with_skill = estimate_cost(_flow(_skill_step_flow(), "c"))
    without = estimate_cost(_flow({"answer_node": "tra_loi", "nodes": [_skill_step_flow()["nodes"][1]]}, "c"))
    assert with_skill["max_llm_calls"] - without["max_llm_calls"] == SKILL_COST[0]
    granted = estimate_cost(_flow(PARENT_GRANTING_SKILL, "c"))
    assert granted["max_tool_calls"] >= SKILL_COST[1]


def test_a_skill_keeps_its_last_model_call_for_its_answer(monkeypatch, skill_db):
    """Measured live on a link funded for 6 model calls: the Skill got 2, spent
    both on tool rounds, and failed with nothing to hand back. Its last model
    call is now its answer — no tools are offered on it."""
    budget = Budget(max_llm_calls=6, max_tool_calls=30, max_seconds=60)
    keep_calling = ("calls", [("total_measure", {"chart_id": 41})])
    model = _Model(parent_script=[SKILL_CALL, ("text", "Xong.")],
                   child_script=[keep_calling, keep_calling, keep_calling, ("text", "Kết quả Skill")])
    _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model, budget=budget)
    [child] = _children(skill_db.db)
    assert child.status in ("ok", "partial"), child.status
    # The child's final round was offered no tools.
    assert model.offered["VAI_TRO_CON"][-1] == []
    b = skills.child_budget(Budget(max_llm_calls=3, max_tool_calls=30))
    assert b.max_llm_calls == 2          # 3 left, 1 kept for the parent's answer
    assert b.llm_available() == 2        # round 1 is not the last: tools offered
    b.spend_llm()
    assert b.tools_left() > 0 and b.llm_available() == 1   # round 2 is the last: it answers
    b.spend_llm()
    assert b.llm_available() == 0 and b.tools_left() == 0


def test_an_empty_caller_scope_still_bounds_the_skills_explicit_grants(monkeypatch):
    """Found by review: with the caller in entitlement mode (empty lists), a
    Skill's attached document 77 — checked against the SKILL author's rights,
    outside this report — passed straight through as an explicit grant, and an
    explicit grant may reach outside the report."""
    from app.services.dashboard_ai_bot import govern_tools

    monkeypatch.setattr(govern_tools, "_entitled_doc_ids", lambda ctx: {1, 2})
    monkeypatch.setattr(govern_tools, "_scope", lambda ctx: (set(), {5}))
    empty = {"doc_ids": [], "dataset_ids": [], "metric_names": [], "term_fqns": []}
    ctx = SimpleNamespace(knowledge_ceiling=dict(empty))
    assert bounded_scope(ctx, {**empty, "doc_ids": [77]})["doc_ids"] == [-1]
    assert bounded_scope(ctx, {**empty, "doc_ids": [2, 77]})["doc_ids"] == [2]
    assert bounded_scope(ctx, {**empty, "dataset_ids": [9]})["dataset_ids"] == [-1]
    assert bounded_scope(ctx, {**empty, "dataset_ids": [5, 9]})["dataset_ids"] == [5]
    assert bounded_scope(ctx, {**empty, "term_fqns": ["g.t"]})["term_fqns"] == []
    # A caller that narrowed documents does not thereby open datasets.
    ctx2 = SimpleNamespace(knowledge_ceiling={**empty, "doc_ids": [1]})
    assert bounded_scope(ctx2, {**empty, "dataset_ids": [9]})["dataset_ids"] == [-1]


def test_when_entitlement_cannot_be_computed_the_child_reads_nothing_extra(monkeypatch):
    from app.services.dashboard_ai_bot import govern_tools

    def boom(ctx):
        raise RuntimeError("no db")
    monkeypatch.setattr(govern_tools, "_entitled_doc_ids", boom)
    empty = {"doc_ids": [], "dataset_ids": [], "metric_names": [], "term_fqns": []}
    ctx = SimpleNamespace(knowledge_ceiling=dict(empty))
    assert bounded_scope(ctx, {**empty, "doc_ids": [77]})["doc_ids"] == [-1]



# ── found by review: a child run carries its caller's data ───────────────────
def test_a_child_run_obeys_the_callers_content_setting(monkeypatch, skill_db):
    """A link with store_question_content=False still had its question and answer
    stored — under the Skill, where the Skill's sharees could read them."""
    model = _Model(parent_script=[SKILL_CALL, ("text", "Xong.")], child_script=[("text", "ok")])
    _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model, store_content=False)
    [child] = _children(skill_db.db)
    assert skill_db.db.query(AgentFlowRunContent).filter(
        AgentFlowRunContent.run_id == child.id).count() == 0


def test_a_skills_run_list_does_not_list_its_callers_runs(monkeypatch, skill_db):
    model = _Model(parent_script=[SKILL_CALL, ("text", "Xong.")], child_script=[("text", "ok")])
    _run(monkeypatch, skill_db.db, PARENT_GRANTING_SKILL, model)
    assert len(_children(skill_db.db)) == 1
    listed = runs_service.list_runs(skill_db.db, brain_key="so_sanh", include_tests=True,
                                    since_hours=24 * 365)
    assert listed["runs"] == []


def test_a_child_runs_detail_also_requires_access_to_the_parent_flow(monkeypatch):
    from app.modules.agent_flows import api

    checked: list[str] = []
    monkeypatch.setattr(api, "_may_read_flow", lambda db, user, key: checked.append(key))
    monkeypatch.setattr(api.runs_service, "run_detail", lambda db, **k: {
        "id": 9, "parent": {"run_key": "r1", "brain_key": "cha", "step_key": "s", "id": 3}})
    api.brain_run_detail("so_sanh", 9, db=None, user=None)
    assert checked == ["so_sanh", "cha"]
    checked.clear()
    monkeypatch.setattr(api.runs_service, "run_detail", lambda db, **k: {"id": 9, "parent": None})
    api.brain_run_detail("so_sanh", 9, db=None, user=None)
    assert checked == ["so_sanh"]


# ── P2 hardening from review ─────────────────────────────────────────────────
def test_the_skill_budget_check_between_nodes_does_not_cut_off_steps_that_need_no_model():
    b = skills.SkillBudget(Budget(max_llm_calls=10, max_tool_calls=10), tool_cap=0, llm_cap=0)
    b.check()   # a Skill made only of deterministic steps is not refused up front
    from app.services.agent_flows.runtime.state import BudgetExhausted

    with pytest.raises(BudgetExhausted):
        b.spend_llm()


def test_without_a_database_no_skill_resolves():
    assert skills.resolve_skill(None, "so_sanh", None) is None


def test_skill_inputs_are_validated_by_their_declared_type():
    from app.services.agent_flows.contract import SkillContract

    contract = SkillContract(when_to_use="khi cần kiểm tra đầu vào", inputs=[
        {"name": "c", "type": "chart_ref"}, {"name": "d", "type": "date"}, {"name": "t", "type": "text"}])
    ok, err = skills._validate_inputs(contract, {"c": "41", "d": "2024-09", "t": "x"})
    assert err == "" and ok == {"c": 41, "d": "2024-09", "t": "x"}
    assert skills._validate_inputs(contract, {"c": "abc", "d": "2024", "t": "x"})[1]
    assert skills._validate_inputs(contract, {"c": 1, "d": "tháng 9", "t": "x"})[1]
    assert skills._validate_inputs(contract, {"c": 1, "d": "2024", "t": "x" * 5000})[1]


def test_a_skill_result_vouches_for_no_number_itself():
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    state.record_evidence({"ok": True, "kind": "value", "data": {
        "skill": "s", "answer": "13590000", "evidence_values": []}}, tool="skill:s")
    assert 13590000.0 not in state.evidence
