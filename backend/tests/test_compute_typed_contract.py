# -*- coding: utf-8 -*-
"""`compute` is a capability with a typed contract — not only a safe calculator.

AI WRITES THE FORMULA. RUNTIME OWNS THE NUMBER. (`test_compute_owns_the_number.py`
pins provenance and expression safety.) This file pins the CONTRACT around it, so
that what compute returns can be relied on by a consumer with no model in between:

  output      every result shape — certified, tainted, literal-only, step-
              referenced — fits the declared `output_schema`, key and type
  input       variables are `{ref, path}` (Agents) or `{step, path}` (authored
              ToolNodes); a bad reference fails closed, never as data
  typed use   ToolNode → compute({step}) → a typed binding `{{calc.result}}`
              downstream; a result that does not fit its schema stops the step
  Skill       a Skill declared `returns: number` hands its parent ONE figure read
              by the runtime from its own step, with provenance intact — a figure
              built on a typed number stays uncertified across the boundary
  stability   deterministic, JSON round-trip stable, never cached, no cross-run
              reference

This file is the CI verifier named in `test_tool_output_contract.VERIFIED_IN_CI`.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
from types import SimpleNamespace

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import pytest  # noqa: E402

import replay_harness as H  # noqa: E402
from test_skills_run_as_governed_children import _children, _row, skill_db  # noqa: E402,F401

from app.services.agent_flows import skills  # noqa: E402
from app.services.agent_flows.contract import Flow, SkillContract, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.agent_flows.runtime.state import RunState  # noqa: E402
from app.services.agent_flows.tools import compute as compute_tool  # noqa: E402
from app.services.agent_flows.tools.schema_check import problems as schema_check  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402

SPEC = tool_registry.all_tools()["compute"]
REAL_EXECUTE = tool_registry.execute


def _store() -> dict:
    """A run's evidence store, filled the way the runtime fills it."""
    state = RunState()
    state.evidence_source = "tong"
    state.record_evidence({"ok": True, "kind": "value", "data": {"value": 1200.0, "chart_id": 41}},
                          tool="total_measure")
    state.evidence_source = "ky_truoc"
    state.record_evidence({"ok": True, "kind": "value", "data": {"value": 1000.0}}, tool="total_measure")
    return state.evidence_store


def _compute(args: dict, store: dict | None = None) -> dict:
    return compute_tool.tool_compute(SimpleNamespace(evidence_store=_store() if store is None else store), args)


SHAPES = {
    "certified": {"expression": "(a - b) / b * 100",
                  "vars": {"a": {"ref": "e1", "path": "value"}, "b": {"ref": "e2", "path": "value"}}},
    "tainted": {"expression": "a / b", "vars": {"a": {"ref": "e1", "path": "value"}, "b": 1000}},
    "literal_only": {"expression": "100 * 12", "vars": {}},
    "step_referenced": {"expression": "(a - b) / b * 100",
                        "vars": {"a": {"step": "tong", "path": "value"}, "b": {"step": "ky_truoc", "path": "value"}}},
    "decorative_reference": {"expression": "a * 0 + 7", "vars": {"a": {"ref": "e1", "path": "value"}}},
}


# ── the declared contract ───────────────────────────────────────────────────
def test_compute_declares_a_typed_output_schema():
    schema = SPEC.output_schema
    assert schema["properties"]["result"]["type"] == "number"
    assert schema["properties"]["inputs"]["items"]["required"] == ["name", "value", "referenced"]
    assert set(schema["required"]) >= {"expression", "result", "inputs", "provenance", "evidence_values"}
    assert SPEC.cacheable is False and SPEC.deterministic is False


@pytest.mark.parametrize("shape", sorted(SHAPES))
def test_every_result_shape_fits_the_declared_schema(shape):
    out = _compute(SHAPES[shape])
    assert out["ok"] is True, out
    assert schema_check(out["data"], SPEC.output_schema) == [], shape


def test_the_schema_check_is_not_a_rubber_stamp():
    good = _compute(SHAPES["certified"])["data"]
    for broken in ({**good, "result": "12"}, {k: v for k, v in good.items() if k != "provenance"},
                   {**good, "provenance": "maybe"}, {**good, "inputs": [{"name": "a"}]}):
        assert schema_check(broken, SPEC.output_schema), broken


def test_provenance_by_shape():
    assert _compute(SHAPES["certified"])["data"]["provenance"] == "referenced"
    assert _compute(SHAPES["step_referenced"])["data"]["provenance"] == "referenced"
    for shape in ("tainted", "literal_only", "decorative_reference"):
        data = _compute(SHAPES[shape])["data"]
        assert data["provenance"] == "unreferenced" and data["evidence_values"] == [], shape


# ── inputs fail closed ──────────────────────────────────────────────────────
@pytest.mark.parametrize("vars_,code", [
    ({"a": {"ref": "e9", "path": "value"}}, "evidence_ref_unknown"),
    ({"a": {"ref": "e1", "path": "rows[0].x"}}, "evidence_path_missing"),
    ({"a": {"ref": "e1", "path": "chart_id"}}, "evidence_not_numeric"),
    ({"a": {"step": "chua_chay", "path": "value"}}, "evidence_ref_unknown"),
    ({"a": {"step": "tong", "path": "chart_id"}}, "evidence_not_numeric"),
])
def test_a_bad_reference_is_refused_not_computed(vars_, code):
    out = _compute({"expression": "a + 1", "vars": vars_})
    assert out["ok"] is False and out["error_code"] == code and out.get("retryable") is False
    assert "data" not in out or not out.get("data")


def test_a_step_with_several_results_must_be_named_by_reference():
    store = _store()
    store["e3"] = {"tool": "rank_values", "source": "tong", "result": {"ok": True, "data": {"value": 5}}}
    out = _compute({"expression": "a", "vars": {"a": {"step": "tong", "path": "value"}}}, store)
    assert out["error_code"] == "evidence_ref_ambiguous" and "e1" in out["error"] and "e3" in out["error"]


def test_a_reference_from_another_run_does_not_resolve():
    """Each run has its own store; `e1` of run A is not a thing in run B."""
    out = _compute({"expression": "a", "vars": {"a": {"ref": "e1", "path": "value"}}}, store={})
    assert out["error_code"] == "evidence_ref_unknown"


# ── stability ───────────────────────────────────────────────────────────────
def test_deterministic_and_json_stable():
    a = _compute(SHAPES["certified"])
    b = _compute(SHAPES["certified"])
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    again = json.loads(json.dumps(a))
    assert again == a, "survives serialisation (a replay reads what was stored)"
    assert a["data"]["result"] == 20.0


# ── a typed consumer: ToolNode → compute → typed binding ────────────────────
def _tools(monkeypatch, *, compute=None):
    def fake(ctx, name, args, allowed=None, use_cache=True):
        if name == "compute":
            if compute is not None:
                return compute
            return REAL_EXECUTE(ctx, name, args, allowed=allowed, use_cache=False)
        return {"ok": True, "kind": "value", "data": {"value": 1200.0 if args.get("chart_id") == 41 else 1000.0,
                                                      "formatted": "x", "rows_counted": 3}}
    monkeypatch.setattr(tool_registry, "execute", fake)


class _Echo:
    def __init__(self):
        self.systems = []

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            self.systems.append(system_prompt)
            yield AgentEvent(type="text", text="Xong.")
        return fake


def _run_flow(monkeypatch, body, model=None, db=None):
    model = model or _Echo()
    monkeypatch.setattr(AH, "_stream", model.stream())
    flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx_c", name="c"),
                                "key": "fx_c", "name": "c"})
    env = H._envelope({"envelope": {"runtime": {"provider": "openai", "model": "m"}}})
    holder = {}

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=H._Ctx([41, 42]),
                                          api_key="k", base_system_prompt="BASE", db=db,
                                          on_state=lambda s: holder.setdefault("s", s)):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    return asyncio.run(go()), model, holder.get("s")


CHAIN = {"answer_node": "tl", "nodes": [
    {"key": "tong", "type": "tool", "tool": "total_measure", "output_var": "tong", "run_policy": "every_turn",
     "inputs": {"chart_id": {"source": "literal", "value": 41}}},
    {"key": "truoc", "type": "tool", "tool": "total_measure", "output_var": "truoc", "run_policy": "every_turn",
     "inputs": {"chart_id": {"source": "literal", "value": 42}}},
    {"key": "calc", "type": "tool", "tool": "compute", "output_var": "calc", "run_policy": "every_turn",
     "inputs": {"expression": {"source": "literal", "value": "(a - b) / b * 100"},
                "vars": {"source": "literal", "value": {"a": {"step": "tong", "path": "value"},
                                                         "b": {"step": "truoc", "path": "value"}}}}},
    {"key": "pct", "type": "set_var", "var": "pct", "value": "{{calc.result}}", "value_type": "number"},
    {"key": "tl", "type": "agent", "prompt": "Tăng {{calc.result}}% ({{calc.provenance}})"},
]}


def test_a_toolnode_chain_computes_over_named_steps_and_binds_a_typed_field(monkeypatch):
    _tools(monkeypatch)
    env, model, state = _run_flow(monkeypatch, CHAIN)
    calc = state.outputs["calc"]
    assert calc["result"] == 20.0 and calc["provenance"] == "referenced"
    assert [i["step"] for i in calc["inputs"]] == ["tong", "truoc"], "lineage names the real steps"
    assert "Tăng 20.0% (referenced)" in model.systems[-1]
    assert 20.0 in state.evidence, "a certified figure is in the trusted ledger"


def test_a_typed_binding_can_read_one_field_of_a_result(monkeypatch):
    _tools(monkeypatch)
    body = copy.deepcopy(CHAIN)
    body["nodes"].insert(3, {"key": "lai", "type": "tool", "tool": "compute", "output_var": "lai",
                             "run_policy": "every_turn",
                             "inputs": {"expression": {"source": "literal", "value": "x * 2"},
                                        "vars": {"source": "literal",
                                                 "value": {"x": {"step": "calc", "path": "result"}}}}})
    body["nodes"][-1]["prompt"] = "Gấp đôi: {{lai.result}}"
    env, model, state = _run_flow(monkeypatch, body)
    assert state.outputs["lai"]["result"] == 40.0 and state.outputs["lai"]["provenance"] == "referenced"


def test_a_result_that_does_not_fit_its_schema_stops_the_step(monkeypatch):
    _tools(monkeypatch, compute={"ok": True, "kind": "value", "data": {"result": "hai mươi"}})
    env, _, state = _run_flow(monkeypatch, CHAIN)
    calc = next(s for s in env["trace"]["steps"] if s["key"] == "calc")
    assert calc["status"] == "error" and "không đúng kiểu" in calc["error"]
    assert "calc" not in state.vars, "nothing mistyped reaches the next step"


def test_a_binding_to_a_variable_nothing_produces_is_a_publish_problem():
    flow = Flow.model_validate({**upgrade_body({"answer_node": "tl", "nodes": [
        {"key": "t", "type": "tool", "tool": "total_measure",
         "inputs": {"chart_id": {"source": "variable", "ref": "khong_ai_tao.id"}}},
        {"key": "tl", "type": "agent", "prompt": "x"}]}, key="fx", name="fx"), "key": "fx", "name": "fx"})
    assert any("khong_ai_tao" in p for p in flow.blocking_problems())


# ── a Skill that returns a number ───────────────────────────────────────────
NUMBER_SKILL = {
    "answer_node": "noi",
    "skill": {"inputs": [{"name": "question", "type": "text"}],
              "output": "Tỷ lệ tăng trưởng (%)", "when_to_use": "Khi cần tỷ lệ tăng giữa hai kỳ",
              "returns": "number", "value_step": "calc", "value_path": "result"},
    "nodes": [
        {"key": "tong", "type": "tool", "tool": "total_measure", "run_policy": "every_turn",
         "inputs": {"chart_id": {"source": "literal", "value": 41}}},
        {"key": "truoc", "type": "tool", "tool": "total_measure", "run_policy": "every_turn",
         "inputs": {"chart_id": {"source": "literal", "value": 42}}},
        {"key": "calc", "type": "tool", "tool": "compute", "run_policy": "every_turn",
         "inputs": {"expression": {"source": "literal", "value": "(a - b) / b * 100"},
                    "vars": {"source": "literal", "value": {"a": {"step": "tong", "path": "value"},
                                                             "b": {"step": "truoc", "path": "value"}}}}},
        {"key": "noi", "type": "agent", "prompt": "VAI_TRO_CON nói kết quả {{input.question}}"},
    ],
}
PARENT = {"answer_node": "tl", "nodes": [
    {"key": "kiem", "type": "skill", "skill_key": "tang_truong", "version": 1,
     "inputs": {"question": {"source": "literal", "value": "tăng bao nhiêu?"}}},
    {"key": "gap", "type": "tool", "tool": "compute", "run_policy": "every_turn",
     "inputs": {"expression": {"source": "literal", "value": "v * 2"},
                "vars": {"source": "literal", "value": {"v": {"step": "kiem", "path": "value"}}}}},
    {"key": "tl", "type": "agent", "prompt": "VAI_TRO_CHA {{gap.result}}"},
]}


def _register(skill_db, body):
    flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="tang_truong", name="t"),
                                "key": "tang_truong", "name": "t"})
    skill_db.registry[("tang_truong", 1)] = (_row("tang_truong", 1, name="Tăng trưởng"), flow)
    skill_db.shared.add("tang_truong")


def test_a_number_skill_returns_one_verified_figure_the_parent_can_compute_on(monkeypatch, skill_db):
    _register(skill_db, NUMBER_SKILL)
    _tools(monkeypatch)
    env, _, state = _run_flow(monkeypatch, PARENT, db=skill_db.db)
    kiem = state.outputs["kiem"]
    assert kiem["returns"] == "number" and kiem["value"] == 20.0 and kiem["provenance"] == "referenced"
    assert kiem["source"] == {"step": "calc", "path": "result", "tool": "compute"}
    assert state.outputs["gap"]["result"] == 40.0
    assert state.outputs["gap"]["provenance"] == "referenced", "certification crossed the boundary"
    [child] = _children(skill_db.db)
    assert child.version == 1


def test_a_figure_the_skill_built_on_a_typed_number_stays_uncertified(monkeypatch, skill_db):
    body = copy.deepcopy(NUMBER_SKILL)
    body["nodes"][2]["inputs"]["vars"]["value"]["b"] = 1000            # typed, not referenced
    _register(skill_db, body)
    _tools(monkeypatch)
    env, _, state = _run_flow(monkeypatch, PARENT, db=skill_db.db)
    assert state.outputs["kiem"]["provenance"] == "unreferenced"
    assert state.outputs["kiem"]["evidence_values"] == []
    assert state.outputs["gap"]["provenance"] == "unreferenced", "taint crossed the boundary too"


def test_a_skill_that_cannot_produce_its_declared_type_fails(monkeypatch, skill_db):
    body = copy.deepcopy(NUMBER_SKILL)
    body["skill"]["value_path"] = "expression"                            # a string, not a number
    _register(skill_db, body)
    _tools(monkeypatch)
    env, _, _ = _run_flow(monkeypatch, PARENT, db=skill_db.db)
    kiem = next(s for s in env["trace"]["steps"] if s["key"] == "kiem")
    assert kiem["status"] == "error" and "không trả về đúng kiểu" in kiem["error"]


def test_a_number_contract_must_say_where_the_number_is():
    with pytest.raises(ValueError, match="value_step"):
        SkillContract(when_to_use="Khi cần tỷ lệ tăng giữa hai kỳ", returns="number")
    body = copy.deepcopy(NUMBER_SKILL)
    body["skill"]["value_step"] = "khong_co"
    flow = Flow.model_validate({**upgrade_body(body, key="s", name="s"), "key": "s", "name": "s"})
    problems = skills.publish_problems(None, SimpleNamespace(brain_key="s", flow_type="skill"), flow)
    assert any("khong_co" in p for p in problems)
