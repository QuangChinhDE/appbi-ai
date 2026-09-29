# -*- coding: utf-8 -*-
"""Two defects the browser found on the Skill surfaces, each where it is produced.

1. The Skill builder's `/validate` call answered 422 ("flow_type: Input should be
   'bot' or 'chat'"), so a Skill never showed "Flow valid" — on every Skill page.
2. "What the AI sees" listed every granted Skill as `skill_not_found`, on a flow
   whose real runs discover and call that Skill: the step preview built its run
   context with `db=None`, and a Skill cannot be resolved without the database.
   The panel says "assembled exactly as a run assembles it"; it was not.
"""
from __future__ import annotations

import os
from types import SimpleNamespace

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from test_skills_run_as_governed_children import SKILL_BODY, skill_db  # noqa: E402,F401

from app.services.agent_flows import dispatch  # noqa: E402
from app.services.agent_flows.contract import AgentNode  # noqa: E402
from app.services.agent_flows.runtime import agent_runtime as AR  # noqa: E402


def test_a_skill_flow_can_be_validated_as_a_skill():
    from app.modules.agent_flows import api

    body = api.ValidateBody(brain_key="so_sanh", name="So sánh kỳ", body=SKILL_BODY, flow_type="skill")
    out = api.validate_flow(body, None)
    assert out["ok"] is True, out


def test_the_step_preview_hands_the_database_to_the_run_context(monkeypatch):
    seen = {}
    monkeypatch.setattr(dispatch, "build_report_info", lambda dashboard, ctx: None, raising=False)
    monkeypatch.setattr(dispatch.binding_service, "build_binding_info",
                        lambda *a, **k: SimpleNamespace(allowed_chart_ids=[]))
    monkeypatch.setattr(dispatch.binding_service, "contract_of", lambda b: None)
    monkeypatch.setattr(dispatch, "_studio_input", lambda **k: SimpleNamespace(
        seed_vars=lambda: {}, runtime=SimpleNamespace(budget=SimpleNamespace(
            max_llm_calls=6, max_tool_calls=8, max_seconds=30))))

    from app.services.agent_flows.runtime.handlers import agent as agent_handler

    monkeypatch.setattr(agent_handler, "preview",
                        lambda node, state, rctx: seen.setdefault("db", rctx.db) and {} or {})
    flow = SimpleNamespace(node=lambda k: SimpleNamespace(type="agent", key=k),
                           answering_key=lambda: "a", all_nodes=lambda: [])
    marker = object()
    try:
        dispatch.preview_step(flow=flow, version=1, node_key="a", binding=None, dashboard=None,
                              ctx=SimpleNamespace(allowed_chart_ids=set()), question="q", db=marker)
    except Exception:                                           # noqa: BLE001
        pass  # only the run context it built matters here
    assert seen.get("db") is marker


def test_with_the_database_a_granted_skill_is_offered_not_missing(skill_db):
    node = AgentNode(key="tl", name="tl", prompt="p",
                     tools=[{"tool": "skill:so_sanh", "version": 2}])
    rctx = SimpleNamespace(db=skill_db.db, skill_stack=(), flow=SimpleNamespace(key="caller"),
                           ctx=SimpleNamespace())
    extras, excluded = AR._skill_capabilities(node, rctx)
    assert [e.name for e in extras] == ["skill__so_sanh"] and excluded == {}
