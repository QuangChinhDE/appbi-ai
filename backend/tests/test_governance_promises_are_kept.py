# -*- coding: utf-8 -*-
"""Promises the Agent Flow contract made and the runtime did not keep.

Found by the V3 capabilities audit (docs/features/agent-flow-v3-capabilities),
each one a sentence in the code that nothing enforced:

  1. `ToolSpec.risk` — "`unknown` is not permitted to act". Nothing refused it.
  2. `Flow.uses_capability("web_search")` named three web tools by hand; the
     registry has five that leave AppBI, so preflight was silent about two.
  3. `ToolNode.tool` — "validated against the registry at publish time". It was
     not; an unknown tool surfaced as `unknown_tool` on the first real question.
  4. Coordinators could nest inside coordinator lanes, so one plan could spawn
     another and the cost of a question was no longer readable off the flow.
  5. The preflight cost estimate walked loop/if/switch by hand and priced a
     coordinator — a planner call plus its lanes — at zero.

Each fix derives from ONE source of truth (registry metadata, the canonical
child traversal), which is what these tests pin.
"""
from __future__ import annotations

import dataclasses
import os
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_governance.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest
from pydantic import ValidationError

from app.services.agent_flows.binding import estimate_cost
from app.services.agent_flows.contract import Flow
from app.services.agent_flows.tools import registry as reg


def _agent(key: str, tools: list[str] | None = None, **kw) -> dict:
    return {"type": "agent", "key": key, "name": key, "prompt": "trả lời",
            "tools": [{"tool": t} for t in (tools or [])], **kw}


def _flow(*nodes: dict) -> Flow:
    return Flow.model_validate({"key": "f", "name": "f", "nodes": list(nodes)})


def _ctx(**kw):
    base = dict(web_search=True, read_rows=True)
    base.update(kw)
    return SimpleNamespace(**base)


# ── 1. risk ───────────────────────────────────────────────────────────────────
def test_every_builtin_tool_declares_a_runnable_risk():
    """The inventory taken BEFORE enforcing: enforcing on a registry that still
    had defaulted tools would have been an outage, not a fix."""
    unclassified = sorted(n for n, s in reg.all_tools().items() if s.risk != "read_only")
    assert unclassified == []


@pytest.mark.parametrize("risk,code", [
    ("unknown", "risk_unknown"),
    ("side_effect", "needs_approval"),
    ("destructive", "needs_approval"),
])
def test_a_tool_not_classified_read_only_is_refused_before_it_runs(risk, code):
    spec = dataclasses.replace(reg.all_tools()["search_business_assets"], risk=risk)
    out = reg._capability_refusal(_ctx(), spec)
    assert out is not None and out["error_code"] == code


def test_read_only_tools_are_unaffected():
    spec = reg.all_tools()["search_business_assets"]
    assert reg._capability_refusal(_ctx(), spec) is None


def test_admission_refusal_is_the_same_rule_execute_applies():
    assert reg.admission_refusal(_ctx(web_search=False), "research_web")["error_code"] == "not_granted"
    assert reg.admission_refusal(_ctx(), "research_web") is None
    assert reg.admission_refusal(_ctx(), "no_such_tool")["error_code"] == "unknown_tool"


# ── 2. web capability is derived, not listed ─────────────────────────────────
@pytest.mark.parametrize("tool", sorted(
    n for n, s in reg.all_tools().items() if s.reaches_outside))
def test_every_tool_that_leaves_appbi_makes_the_flow_need_web(tool):
    assert _flow(_agent("a", [tool])).uses_capability("web_search") is True


def test_a_flow_with_no_outside_tool_does_not_need_web():
    assert _flow(_agent("a", ["rank_values", "total_measure"])).uses_capability("web_search") is False


def test_a_tool_step_that_leaves_appbi_also_counts():
    flow = _flow({"type": "tool", "key": "t", "tool": "research_web"}, _agent("a"))
    assert flow.uses_capability("web_search") is True


# ── 3. unknown tools block publish ───────────────────────────────────────────
def test_a_tool_step_naming_a_tool_that_does_not_exist_is_a_blocking_problem():
    flow = _flow({"type": "tool", "key": "t", "tool": "tool_that_was_renamed"}, _agent("a"))
    assert any("tool_that_was_renamed" in p for p in flow.blocking_problems())


def test_an_agent_granted_a_tool_that_does_not_exist_is_a_blocking_problem():
    flow = _flow(_agent("a", ["rank_values", "ghost_tool"]))
    problems = flow.blocking_problems()
    assert any("ghost_tool" in p for p in problems)
    assert not any("rank_values" in p for p in problems)


def test_known_tools_raise_no_problem():
    assert _flow(_agent("a", ["rank_values"])).unknown_capability_problems() == []


# ── 4. bounded coordinators ──────────────────────────────────────────────────
def _coord(key: str, lanes: list[list[dict]]) -> dict:
    return {"type": "coordinate", "key": key, "name": key, "specialists": [
        {"key": f"{key}_s{i}", "name": f"s{i}", "when": "khi câu hỏi cần phần này",
         "body": body} for i, body in enumerate(lanes)]}


def test_a_coordinator_inside_a_coordinator_lane_is_refused():
    inner = _coord("inner", [[_agent("i1")], [_agent("i2")]])
    with pytest.raises(ValidationError, match="điều phối lồng nhau"):
        _flow(_coord("outer", [[inner], [_agent("o2")]]), _agent("answer"))


def test_nesting_is_refused_anywhere_below_a_lane_not_only_directly():
    inner = _coord("inner", [[_agent("i1")], [_agent("i2")]])
    deep = {"type": "if", "key": "br", "name": "br", "paths": [
        {"key": "p1", "name": "p1", "kind": "rules", "match": "all", "body": [inner],
         "conditions": [{"left": "{{question}}", "op": "equals", "right": "x"}]},
        {"key": "p2", "name": "p2", "kind": "fallback", "body": [_agent("x")]},
    ]}
    with pytest.raises(ValidationError, match="điều phối lồng nhau"):
        _flow(_coord("outer", [[deep], [_agent("o2")]]), _agent("answer"))


def test_sibling_coordinators_are_still_allowed():
    _flow(_coord("c1", [[_agent("a1")], [_agent("a2")]]),
          _coord("c2", [[_agent("b1")], [_agent("b2")]]), _agent("answer"))


# ── 5. cost follows the canonical tree ───────────────────────────────────────
def test_a_coordinator_is_priced_as_a_planner_plus_its_lanes():
    lanes = [[_agent(f"s{i}", ["rank_values"], max_tool_calls=2)] for i in range(4)]
    coord = _coord("c", lanes)
    coord["max_specialists"] = 2
    est = estimate_cost(_flow(coord, _agent("answer")))
    # planner 1 + two lanes × (1 + 2 rounds) + answer 1
    assert est["max_llm_calls"] == 1 + 2 * 3 + 1
    assert est["max_tool_calls"] == 2 * 2


def test_existing_container_pricing_is_unchanged():
    loop = {"type": "loop", "key": "l", "name": "l", "over": "{{question}}", "as_var": "muc",
            "max_iterations": 3, "body": [_agent("in", ["rank_values"], max_tool_calls=1)]}
    est = estimate_cost(_flow(loop, _agent("answer")))
    assert est == {"max_llm_calls": 3 * 2 + 1, "max_tool_calls": 3}
