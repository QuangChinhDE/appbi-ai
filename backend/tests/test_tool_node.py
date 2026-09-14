# -*- coding: utf-8 -*-
"""V3.2 — a step that calls one tool, decided by the author, with no model.

WHY IT MATTERS
--------------
Twenty of the tools need a `chart_id`, and most questions an author builds a flow
for are already decided. "Top 5 categories" does not need a model to work out that
`rank_values` is the tool — but today it costs a model round to choose it and
another to read the result, and every tool granted to an agent is schema text in
every prompt of that step. That is why a catalogue of hundreds cannot be reached
through agents alone, and why `ToolSpec.self_sufficient` has been documented as a
LATENT property: real, checkable, and unspendable until a node could call a tool
directly.

WHY MOST OF THIS FILE IS SECURITY
---------------------------------
A new execution path is exactly how a gate gets bypassed. ToolNode is the first new
path since the P0 work, so the bulk of what follows asks one question in several
ways: does the node take the SAME road as the agent, or a shortcut?
"""
from __future__ import annotations

import asyncio
import os
from typing import Any

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_tool_node.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.agent_flows.contract import Flow, ToolInput, ToolNode, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import executor, nodes  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as agent_handler  # noqa: E402
from app.services.agent_flows.runtime.handlers import data as data_handler  # noqa: E402
from app.services.agent_flows.tools import registry as tool_registry  # noqa: E402
from app.services.agent_flows.tools.context import ToolContext  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402


# ── the world ───────────────────────────────────────────────────────────────


class Ctx:
    allowed_chart_ids = {41}
    knowledge_scope: dict = {}
    read_rows = True
    web_search = True
    dashboard = None
    max_result_tokens = 4000
    max_rows_per_call = 50
    public_filters: list = []
    pages: list = []
    chart_meta = {41: {"name": "Doanh thu", "chart_type": "BAR"}}
    assert_chart_in_scope = ToolContext.assert_chart_in_scope


def _flow(nodes_: list[dict], answer: str = "answer") -> Flow:
    body = {"name": "t", "nodes": nodes_, "answer_node": answer}
    up = upgrade_body(body, key="t", name="t")
    return Flow.model_validate({**up, "key": "t", "name": "t"})


def _envelope(**over) -> dict:
    base = {
        "request": {"id": "t", "trigger": "studio_test"},
        "question": {"raw": "Doanh thu?"},
        "report": {"dashboard_id": 67, "name": "Olist",
                   "charts": [{"id": 41, "title": "Doanh thu", "chart_type": "BAR"}]},
        "binding": {"id": 1, "flow_version": 1, "allowed_chart_ids": [41],
                    "resolved": {},
                    "capabilities": {"web_search": True, "read_rows": True}},
        "runtime": {"provider": "openai", "model": "gpt-4o-mini",
                    "budget": {"max_llm_calls": 6, "max_tool_calls": 20,
                               "max_seconds": 60}},
    }
    for k, v in over.items():
        base[k] = {**base.get(k, {}), **v} if isinstance(v, dict) else v
    return base


ANSWER = {"key": "answer", "type": "agent", "name": "Trả lời", "prompt": "{{question}}"}


@pytest.fixture(autouse=True)
def stub_provider(monkeypatch):
    async def fake(*, provider, api_key, model, system_prompt, messages, tools):
        yield AgentEvent(type="text", text="ok")
        yield AgentEvent(type="usage",
                         extra={"prompt_tokens": 10, "completion_tokens": 2})

    monkeypatch.setattr(agent_handler, "_stream", fake)


def run(flow: Flow, ctx=None, **over) -> dict:
    async def go():
        out = None
        async for ev in executor.run_flow(
            FlowInput.model_validate(_envelope(**over)), flow=flow, ctx=ctx or Ctx(),
            api_key="k", base_system_prompt="BASE",
        ):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out

    return asyncio.run(go()) or {}


def _step(result: dict, key: str) -> dict:
    for s in ((result or {}).get("trace") or {}).get("steps") or []:
        if s["key"] == key:
            return s
    return {}


# ── it exists and it is one node ────────────────────────────────────────────


def test_the_node_type_is_registered_with_a_handler():
    """The registry refuses a type with no handler, so registration IS the
    assertion that the palette cannot offer a step that does nothing."""
    assert nodes.handler_for("tool") is not None


def test_it_does_not_cost_a_model_call():
    """The reason the node exists. If this ever needs an LLM, it has become an
    agent with one tool and the saving is gone."""
    spec = next(s for s in data_handler.SPECS if s.type == "tool")

    assert spec.costs_llm is False


# ── typed bindings ──────────────────────────────────────────────────────────


def test_a_literal_binding_keeps_its_type(monkeypatch):
    seen: dict = {}

    def spy(ctx, name, args, allowed=None, use_cache=True):
        seen.update(args)
        return {"ok": True, "kind": "value", "data": {"value": 1}}

    monkeypatch.setattr(tool_registry, "execute", spy)
    run(_flow([
        {"key": "t", "type": "tool", "tool": "total_measure", "output_var": "v",
         "run_policy": "every_turn",
         "inputs": {"chart_id": {"source": "literal", "value": 41},
                    "top_n": {"source": "literal", "value": 5}}},
        ANSWER,
    ]))

    assert seen["chart_id"] == 41 and isinstance(seen["chart_id"], int)
    assert seen["top_n"] == 5 and isinstance(seen["top_n"], int)


def test_a_variable_binding_keeps_the_variables_type(monkeypatch):
    """THE WHOLE REASON THE CONTRACT IS NOT `"{{x}}"`.

    Through a template string an int arrives as `"41"`, a list as its text and
    `None` as `""`, and the tool then refuses an argument the author believes they
    supplied.
    """
    seen: dict = {}

    def spy(ctx, name, args, allowed=None, use_cache=True):
        seen.update(args)
        return {"ok": True, "kind": "value", "data": {"value": 1}}

    monkeypatch.setattr(tool_registry, "execute", spy)
    run(_flow([
        {"key": "set", "type": "set_var", "var": "cid", "value": "41",
         "value_type": "number"},
        {"key": "t", "type": "tool", "tool": "total_measure", "output_var": "v",
         "run_policy": "every_turn",
         "inputs": {"chart_id": {"source": "variable", "ref": "cid"}}},
        ANSWER,
    ]))

    assert seen["chart_id"] == 41, f"got {seen['chart_id']!r}"
    assert not isinstance(seen["chart_id"], str)


def test_a_binding_to_a_variable_nobody_created_says_so(monkeypatch):
    """Named at the BINDING, not at the argument. Passing `None` through would
    make the tool complain about `chart_id` and send the author to read the
    tool's documentation instead of their own wiring."""
    monkeypatch.setattr(tool_registry, "execute",
                        lambda *a, **k: {"ok": True, "kind": "value", "data": {}})

    r = run(_flow([
        {"key": "t", "type": "tool", "tool": "total_measure", "output_var": "v",
         "run_policy": "every_turn",
         "inputs": {"chart_id": {"source": "variable", "ref": "khong_ton_tai"}}},
        ANSWER,
    ]))

    err = _step(r, "t").get("error") or ""
    assert "khong_ton_tai" in err
    assert "chưa bước nào tạo ra biến" in err


def test_a_variable_binding_must_name_a_variable():
    with pytest.raises(Exception, match="tên biến"):
        ToolInput(source="variable", ref="")


def test_braces_in_a_ref_are_refused_with_the_fix_in_the_message():
    """An author copying `{{doanh_thu}}` out of a prompt is the obvious mistake;
    the message says what to write instead."""
    with pytest.raises(Exception, match="ngoặc"):
        ToolInput(source="variable", ref="{{doanh_thu}}")


# ── what it publishes ───────────────────────────────────────────────────────


def test_it_publishes_data_not_the_envelope(monkeypatch):
    """`output_schema` describes `result.data`. Publishing the envelope would make
    every binding read `{{r.data.items}}` and make the schema a lie."""
    monkeypatch.setattr(
        tool_registry, "execute",
        lambda *a, **k: {"ok": True, "kind": "ranking", "coverage": {"returned": 3},
                         "data": {"items": [1, 2, 3], "total": 9}},
    )

    r = run(_flow([
        {"key": "t", "type": "tool", "tool": "rank_values", "output_var": "xh",
         "run_policy": "every_turn",
         "inputs": {"chart_id": {"source": "literal", "value": 41}}},
        ANSWER,
    ]))

    out = _step(r, "t").get("output_preview") or ""
    assert "items" in out
    assert '"ok"' not in out and "'ok'" not in out, "the envelope leaked into the variable"


def test_a_failing_tool_fails_the_step_rather_than_publishing_nothing(monkeypatch):
    """A step that publishes an empty value on failure hands the next step
    something it reads as data."""
    monkeypatch.setattr(
        tool_registry, "execute",
        lambda *a, **k: {"ok": False, "error_code": "no_data", "error": "trống"},
    )

    r = run(_flow([
        {"key": "t", "type": "tool", "tool": "rank_values", "output_var": "xh",
         "run_policy": "every_turn", "on_error": "continue",
         "inputs": {"chart_id": {"source": "literal", "value": 41}}},
        ANSWER,
    ]))

    assert _step(r, "t")["status"] == "error"
    assert "rank_values" in (_step(r, "t").get("error") or "")


# ── THE SECURITY HALF ───────────────────────────────────────────────────────


def test_it_goes_through_execute_and_never_touches_the_body(monkeypatch):
    """THE INVARIANT THE REST DEPENDS ON.

    Every gate lives in `registry.execute()`. A node that reached for `spec.fn`
    would pass all the tests above and bypass all of them.
    """
    fired: list[str] = []
    spec = tool_registry.all_tools()["rank_values"]
    original = spec.fn
    object.__setattr__(spec, "fn", lambda c, a: fired.append("body") or {"ok": True})

    calls: list[str] = []
    real_execute = tool_registry.execute

    def watched(ctx, name, args, allowed=None, use_cache=True):
        calls.append(name)
        return real_execute(ctx, name, args, allowed=allowed, use_cache=False)

    monkeypatch.setattr(tool_registry, "execute", watched)
    try:
        run(_flow([
            {"key": "t", "type": "tool", "tool": "rank_values", "output_var": "x",
             "run_policy": "every_turn",
             "inputs": {"chart_id": {"source": "literal", "value": 41}}},
            ANSWER,
        ]))
    finally:
        object.__setattr__(spec, "fn", original)

    assert calls == ["rank_values"], "the node did not go through execute()"


def test_a_chart_outside_the_binding_is_refused():
    """No stub: the real scope guard, through the real execute()."""
    r = run(_flow([
        {"key": "t", "type": "tool", "tool": "get_chart_summary", "output_var": "x",
         "run_policy": "every_turn", "on_error": "continue",
         "inputs": {"chart_id": {"source": "literal", "value": 999}}},
        ANSWER,
    ]))

    assert _step(r, "t")["status"] == "error"
    assert "not part of this dashboard" in (_step(r, "t").get("error") or "")


def test_a_row_exposing_tool_is_refused_when_the_binding_withholds_rows():
    class NoRows(Ctx):
        read_rows = False

    r = run(_flow([
        {"key": "t", "type": "tool", "tool": "get_chart_data", "output_var": "x",
         "run_policy": "every_turn", "on_error": "continue",
         "inputs": {"chart_id": {"source": "literal", "value": 41}}},
        ANSWER,
    ]), ctx=NoRows())

    assert _step(r, "t")["status"] == "error"
    assert "dòng thô" in (_step(r, "t").get("error") or "")


def test_an_external_tool_is_refused_when_the_binding_withholds_web():
    class NoWeb(Ctx):
        web_search = False

    r = run(_flow([
        {"key": "t", "type": "tool", "tool": "web_search", "output_var": "x",
         "run_policy": "every_turn", "on_error": "continue",
         "inputs": {"query": {"source": "literal", "value": "gdp"}}},
        ANSWER,
    ]), ctx=NoWeb())

    assert _step(r, "t")["status"] == "error"
    assert "web" in (_step(r, "t").get("error") or "").lower()


def test_it_spends_the_tool_budget_like_every_other_caller(monkeypatch):
    """A path that does not spend budget is a path that can loop for free."""
    monkeypatch.setattr(
        tool_registry, "execute",
        lambda *a, **k: {"ok": True, "kind": "value", "data": {"value": 1}},
    )

    r = run(_flow([
        {"key": "t", "type": "tool", "tool": "total_measure", "output_var": "v",
         "run_policy": "every_turn",
         "inputs": {"chart_id": {"source": "literal", "value": 41}}},
        ANSWER,
    ]))

    assert (r.get("usage") or {}).get("tool_calls", 0) >= 1


def test_the_call_is_named_in_the_trace(monkeypatch):
    """An audit that cannot see a tool call is an audit with a hole the size of
    this node."""
    monkeypatch.setattr(
        tool_registry, "execute",
        lambda *a, **k: {"ok": True, "kind": "value", "data": {"value": 1}},
    )

    r = run(_flow([
        {"key": "t", "type": "tool", "tool": "total_measure", "output_var": "v",
         "run_policy": "every_turn",
         "inputs": {"chart_id": {"source": "literal", "value": 41}}},
        ANSWER,
    ]))

    assert "total_measure" in (_step(r, "t").get("tool_calls") or [])


def test_an_unknown_tool_fails_the_step_not_the_run():
    r = run(_flow([
        {"key": "t", "type": "tool", "tool": "khong_co_cong_cu_nay",
         "output_var": "x", "run_policy": "every_turn", "on_error": "continue",
         "inputs": {}},
        ANSWER,
    ]))

    assert _step(r, "t")["status"] == "error"
    assert r["status"] in ("ok", "partial")
