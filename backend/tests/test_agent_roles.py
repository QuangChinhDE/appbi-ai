# -*- coding: utf-8 -*-
"""Specialized Agent roles and explicit step inputs — the contract and the runtime.

Roles (`app/services/agent_flows/roles.py`) bound an Agent step's tools. These
tests lock the three places that promise is kept — save, publish, run — and the
explicit `inputs` handoff that lets step 3 or 4 read step 1 without everything in
between being pasted into every prompt.

Run through the real executor with a scripted model (no network): what each step
was OFFERED and what it was HANDED is recorded from the provider call itself.
"""
from __future__ import annotations

import asyncio
import copy
import os
import sys

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_agent_roles.db")
os.environ.setdefault("DATA_DIR", ".testdata")
sys.path.insert(0, os.path.dirname(__file__))

import pytest  # noqa: E402

import replay_harness as H  # noqa: E402
from app.services.agent_flows import roles  # noqa: E402
from app.services.agent_flows.contract import AgentNode, Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402


# ── the profiles themselves ─────────────────────────────────────────────────
def test_every_role_tool_exists_in_the_live_registry():
    """A renamed tool must fail here, not silently fall out of a role."""
    known = set(tool_registry.all_tools())
    for r in roles.ROLES.values():
        assert set(r.allowed_tools) <= known, (r.key, set(r.allowed_tools) - known)
        assert set(r.default_tools) <= set(r.allowed_tools), r.key


def test_no_role_reaches_outside_or_holds_a_skill():
    """External tools and Skills stay with the custom agent, where the author
    grants them deliberately."""
    external = {name for name, spec in tool_registry.all_tools().items()
                if getattr(spec, "reaches_outside", False)}
    assert external, "the registry must still mark outside-reaching tools"
    for r in roles.ROLES.values():
        assert not (set(r.allowed_tools) & external), r.key
        assert not any(t.startswith("skill:") for t in r.allowed_tools), r.key


def test_every_chart_keyed_role_can_find_a_chart_itself():
    """The dependency: a measuring tool needs a chart_id, so a role holding one by
    default also holds a lookup by default (test_grant_has_a_way_in.py)."""
    from app.services.agent_flows.contract import _CHART_KEYED_TOOLS, _CHART_LOOKUP_TOOLS

    for r in roles.ROLES.values():
        if set(r.default_tools) & _CHART_KEYED_TOOLS:
            assert set(r.default_tools) & _CHART_LOOKUP_TOOLS, r.key


def test_the_answer_writer_has_no_tools_and_says_so():
    r = roles.get("answer_writer")
    assert r.allowed_tools == () and r.default_tools == ()
    assert "không có công cụ" in r.charter


# ── the boundary: contract ─────────────────────────────────────────────────
def _agent(key, *, role="", tools=(), knowledge=None, inputs=None, prompt=None, **kw):
    out = {"key": key, "name": key, "type": "agent", "prompt": prompt or f"MARK_{key} làm việc",
           "role": role, "tools": [{"tool": t} for t in tools], "max_tool_calls": 6, **kw}
    if knowledge is not None:
        out["knowledge"] = knowledge
    if inputs is not None:
        out["reads_from"] = inputs
    return out


def _flow(nodes, answer=None, key="fx_roles") -> Flow:
    body = {"nodes": nodes, **({"answer_node": answer} if answer else {})}
    return Flow.model_validate({**upgrade_body(copy.deepcopy(body), key=key, name=key),
                                "key": key, "name": key})


def test_a_grant_outside_the_role_is_a_save_error():
    f = _flow([_agent("rr", role="report_reader", tools=["list_charts", "research_web"])])
    errs = f.role_grant_errors()
    assert errs and "research_web" in errs[0]


def test_an_unknown_role_is_a_save_error():
    assert _flow([_agent("x", role="sorcerer", tools=["list_charts"])]).role_grant_errors()


def test_a_custom_agent_is_unbounded_as_before():
    f = _flow([_agent("c", tools=["list_charts", "research_web", "skill:abc"])])
    assert f.role_grant_errors() == []
    assert f.nodes[0].tool_names() == ["list_charts", "research_web", "skill:abc"]


def test_the_runtime_bounds_a_body_that_bypassed_save():
    """A body written straight to the database (or before the check existed) still
    cannot call outside its role: `tool_names()` is what the runtime reads."""
    n = AgentNode.model_validate(_agent("rr", role="report_reader",
                                        tools=["list_charts", "research_web", "skill:x"]))
    assert n.tool_names() == ["list_charts"]
    assert [g.tool for g in n.effective_grants()] == ["list_charts"]


def test_a_retired_role_fails_closed_without_breaking_the_parse():
    n = AgentNode.model_validate(_agent("rr", role="retired_role", tools=["list_charts"]))
    assert n.tool_names() == []


def test_registry_execute_refuses_the_out_of_role_tool():
    n = AgentNode.model_validate(_agent("rr", role="report_reader",
                                        tools=["list_charts", "total_measure"]))
    ctx = H._Ctx([41])
    got = tool_registry.execute(ctx, "total_measure", {"chart_id": 41},
                                allowed=set(n.tool_names()))
    assert got.get("ok") is False and got.get("error_code") == "not_granted"


def test_a_knowledge_reader_with_nothing_attached_reads_nothing_and_cannot_publish():
    """An empty knowledge scope is OPEN; a Docs specialist must not search every
    document its owner can see because nobody attached one."""
    f = _flow([_agent("kr", role="knowledge_reader", tools=["search_knowledge"])])
    assert f.nodes[0].tool_names() == []
    assert any("chưa đính kèm" in p for p in f.role_dependency_problems())
    attached = _flow([_agent("kr", role="knowledge_reader", tools=["search_knowledge"],
                             knowledge=[{"source": "document", "ref": "26",
                                         "description": "Quy ước tính GMV của Olist"}])])
    assert attached.nodes[0].tool_names() == ["search_knowledge"]
    assert attached.role_dependency_problems() == []


def test_role_problems_block_publish_and_cannot_be_acknowledged():
    import inspect
    from app.services.agent_flows import registry as reg

    src = inspect.getsource(reg.publish)
    hard_at = src.index("hard += flow.role_grant_errors()")
    assert hard_at < src.index("if hard:"), "role problems must be in the hard list"
    assert "role_grant_errors()" in inspect.getsource(reg.save_draft)


# ── inputs: validation ─────────────────────────────────────────────────────
def test_inputs_must_name_an_earlier_real_step():
    f = _flow([
        _agent("a", inputs=["c"]),          # later
        _agent("b", inputs=["ghost", "b"]),  # missing, self
        _agent("c", inputs=["a"]),           # fine
    ])
    probs = " | ".join(f.input_problems())
    assert "chạy SAU" in probs and "ghost" in probs and "chính nó" in probs
    assert len(f.input_problems()) == 3, "step c's valid input must not be flagged"


def test_an_input_from_a_reader_satisfies_the_chart_id_dependency():
    marker = "công cụ cần chart_id"
    no_way = _flow([_agent("ma", tools=["total_measure"])])
    assert any(marker in w for w in no_way.warnings())
    via_input = _flow([
        _agent("rr", role="report_reader", tools=["list_charts"]),
        _agent("ma", tools=["total_measure"], inputs=["rr"]),
    ])
    assert not any(marker in w for w in via_input.warnings())


# ── the runtime: what each step is offered and handed ──────────────────────
class _Model:
    """Each step answers with a fixed sentence naming itself; records what it saw."""

    def __init__(self, fail_key: str = ""):
        self.calls: list[dict] = []
        self.fail_key = fail_key

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            who = next((w for w in ("rr", "kr", "ma", "da", "aw") if f"MARK_{w}" in system_prompt), "?")
            self.calls.append({"who": who, "system": system_prompt,
                               "offered": [t.get("name") for t in (tools or [])],
                               "handed": "\n".join(str(m.get("content")) for m in messages)})
            if who == self.fail_key:
                raise RuntimeError("provider exploded")
            yield AgentEvent(type="text", text=f"KQ_{who}: đã xử lý xong phần việc")
            yield AgentEvent(type="usage", extra={"prompt_tokens": 5, "completion_tokens": 2})
        return fake

    def of(self, who):
        return [c for c in self.calls if c["who"] == who]


def _run(monkeypatch, nodes, *, answer, model):
    monkeypatch.setattr(AH, "_stream", model.stream())
    monkeypatch.setattr(tool_registry, "execute",
                        lambda ctx, name, args, allowed=None, use_cache=True:
                        {"ok": False, "error_code": "not_granted"}
                        if allowed is not None and name not in allowed else
                        {"ok": True, "kind": "value", "data": {"value": 1}})
    env = H._envelope({"envelope": {"runtime": {"provider": "openai", "model": "m", "budget": {
        "max_llm_calls": 20, "max_tool_calls": 20, "max_seconds": 60}}}})

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=_flow(nodes, answer),
                                          ctx=H._Ctx([41]), credentials=H.fixed_credentials("k"),
                                          base_system_prompt="BASE"):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    return asyncio.run(go())


CHAIN = [
    _agent("rr", role="report_reader", tools=["list_charts", "inspect_filters"]),
    _agent("kr", role="knowledge_reader", tools=["search_knowledge"],
           knowledge=[{"source": "document", "ref": "26", "description": "Quy ước tính GMV"}]),
    _agent("ma", role="metric_analyst", tools=["list_charts", "total_measure"], inputs=["rr"]),
    _agent("da", role="diagnostic_analyst", tools=["explain_change"], inputs=["rr", "ma"]),
    _agent("aw", role="answer_writer", inputs=["kr", "ma", "da"]),
]


def test_step_one_reaches_step_four_through_declared_inputs(monkeypatch):
    m = _Model()
    env = _run(monkeypatch, CHAIN, answer="aw", model=m)
    assert env["status"] == "ok", env.get("notices")
    da = m.of("da")[0]["handed"]
    assert "KQ_rr" in da and "KQ_ma" in da, "step 4 must see step 1 and step 3"
    assert "KQ_kr" not in da, "an undeclared step is not pasted in"
    aw = m.of("aw")[0]["handed"]
    assert all(f"KQ_{k}" in aw for k in ("kr", "ma", "da")) and "KQ_rr" not in aw


def test_each_role_is_offered_only_its_bounded_tools_and_its_charter(monkeypatch):
    m = _Model()
    _run(monkeypatch, CHAIN, answer="aw", model=m)
    assert set(m.of("rr")[0]["offered"]) <= set(roles.get("report_reader").allowed_tools)
    assert m.of("aw")[0]["offered"] == [], "the writer is a plain model call"
    assert "VAI TRÒ: ĐỌC BÁO CÁO" in m.of("rr")[0]["system"]
    assert "VAI TRÒ: VIẾT CÂU TRẢ LỜI" in m.of("aw")[0]["system"]


def test_the_handoff_is_recorded_on_the_trace(monkeypatch):
    env = _run(monkeypatch, CHAIN, answer="aw", model=_Model())
    steps = {s["key"]: s for s in env["trace"]["steps"]}
    h = (steps["da"].get("capabilities") or {}).get("handoff")
    assert h and h["mode"] == "inputs" and set(h["included"]) == {"rr", "ma"}


def test_a_failed_input_is_said_and_the_run_is_partial_not_ok(monkeypatch):
    """The failure this exists for: a middle step that received half its input,
    and a run that still reported success."""
    m = _Model(fail_key="ma")
    nodes = copy.deepcopy(CHAIN)
    nodes[2]["retry"] = {"max_attempts": 1}
    env = _run(monkeypatch, nodes, answer="aw", model=m)
    da = m.of("da")[0]["handed"]
    assert "ĐẦU VÀO KHÔNG CÓ" in da and "bị lỗi" in da
    codes = [n.get("code") for n in env.get("notices") or []]
    assert "handoff_input_missing" in codes
    assert env["status"] == "partial"
    h = {s["key"]: s for s in env["trace"]["steps"]}["da"]["capabilities"]["handoff"]
    assert h["missing"][0]["key"] == "ma"


def test_without_inputs_a_step_still_gets_only_the_previous_one(monkeypatch):
    m = _Model()
    nodes = [_agent("rr"), _agent("kr"), _agent("ma"), _agent("aw")]
    _run(monkeypatch, nodes, answer="aw", model=m)
    ma = m.of("ma")[0]["handed"]
    assert "KQ_kr" in ma and "KQ_rr" not in ma
    aw = m.of("aw")[0]["handed"]
    assert all(f"KQ_{k}" in aw for k in ("rr", "kr", "ma")), "answer still gathers all"


def test_a_long_previous_result_is_reduced_and_recorded_not_head_sliced():
    class _S:
        trace: list = []
        outputs: dict = {}
        capability_trace: dict = {}
        context_coverage: dict = {}
        notices: list = []
        vars = {"previous": "dòng dữ liệu\n" * 2000}

    class _R:
        answer_key = "other"

        class inp:
            class conversation:
                history: list = []

            class question:
                @staticmethod
                def text():
                    return "q"

    node = AgentNode.model_validate(_agent("mid"))
    msgs = AH._messages(node, _S(), _R())
    body = msgs[-1]["content"]
    assert len(body) < 9000 and "lược bớt" in body
    assert _S.capability_trace["mid"]["handoff"]["reduced"] == ["previous"]


# ── the projection that dropped every figure (found live, pre-existing) ─────
def test_a_read_of_one_row_charts_keeps_its_figures_when_reduced():
    """Measured on the rig: a Report Read of four one-row KPI charts (no list
    longer than one) was reduced to `{"read_ok": true}` — the writer answered "no
    revenue data" beside a read holding 13,591,643.7, with budget unspent. The
    halving loop also spun on `[chart, "… N more"]` without progress."""
    import json
    from app.services.agent_flows.runtime.context import compile_context, StepView

    chart = lambda cid, total: {  # noqa: E731
        "chart_id": cid, "title": f"KPI {cid}",
        "summary": {"columns": [{"name": "revenue", "total": total}]},
        "data": {"ok": True, "data": {"rows": [[total]], "coverage": {"note": "x" * 400}}},
    }
    read = {"read_ok": True, "scope": {"note": "y" * 600},
            "charts": [chart(679, 13591643.7), chart(688, 13591643.7),
                       chart(689, 2251909.54), chart(690, 112650)]}
    other = json.dumps({"ok": True, "passages": [{"text": "GMV gồm phí vận chuyển. " * 60}]},
                       ensure_ascii=False)
    p = compile_context([StepView("doc", "Đọc", json.dumps(read, ensure_ascii=False)),
                         StepView("kb", "Tri thức", other)], 3000)
    assert "13591643.7" in p.text and "2251909.54" in p.text, p.text[:600]
    assert "GMV gồm phí vận chuyển" in p.text
    assert len(p.text) <= 3000 + 600  # headers + scope note


# ── a step's attachment cannot hand back what the run's scope removed ──────
def _scope_after_step(run_ceiling, attachments):
    from types import SimpleNamespace
    from app.services.agent_flows.runtime.agent_runtime import _apply_scope

    ctx = SimpleNamespace(knowledge_scope=dict(run_ceiling or {}), knowledge_ceiling=None,
                          run_scope_ceiling=run_ceiling)
    node = AgentNode.model_validate(_agent("kr", role="knowledge_reader",
                                           tools=["search_knowledge"], knowledge=attachments))
    _apply_scope(ctx, node)
    return ctx.knowledge_scope


DOC26 = [{"source": "document", "ref": "26", "description": "Quy ước tính GMV của Olist"}]


def test_a_caller_without_the_document_does_not_get_it_back_through_the_step():
    """`run_scope` removed doc 26 (the caller may not read it, nothing delegated).
    The step's attachment used to REPLACE the scope with [26] — the confused deputy
    through an intermediate agent."""
    got = _scope_after_step({"doc_ids": [], "dataset_ids": [], "metric_names": []}, DOC26)
    assert 26 not in got["doc_ids"] and "26" not in [str(x) for x in got["doc_ids"]]
    assert got["doc_ids"] == [-1], "an emptied scope must be the NOTHING sentinel, not open"


def test_a_document_the_run_may_read_stays_readable():
    got = _scope_after_step({"doc_ids": [26], "dataset_ids": [], "metric_names": []}, DOC26)
    assert [str(x) for x in got["doc_ids"]] == ["26"]


def test_without_a_recorded_run_scope_behaviour_is_unchanged():
    got = _scope_after_step(None, DOC26)
    assert [str(x) for x in got["doc_ids"]] == ["26"]
