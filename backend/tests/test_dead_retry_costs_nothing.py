# -*- coding: utf-8 -*-
"""The whole loop, not the helper: a dead repeat must cost nothing and end.

WHAT THE HELPER TEST PROVED, AND WHAT IT DID NOT.

`test_nonrecoverable_retry_policy.py` calls `_call_with_retry_policy` directly
and shows that a second identical request never reaches the tool. That is true
and it was not enough. In `run()` the accounting sat TWO LINES ABOVE the guard:

    for call in runnable:
        state.budget.spend_tool()      # ← here
        calls_made += 1
        ...
        result = _call_with_retry_policy(...)   # ← and the guard here

So the registry was spared and the budget was spent anyway. The helper could not
see that, because the helper is not where the budget lives. Only a test that runs
the node can tell the difference between "the tool did not run" and "the call was
free", and those are different claims.

AND A SECOND THING THE FIRST FIX DID NOT SOLVE. Making the repeat free removed
its cost and not its loop: the model that asked six times for the same
unreachable chart id could now ask sixty, each answer free, until MAX_ROUNDS ran
out and the node ended having produced nothing. A refusal the model will not read
has to stop being offered.

MEASURED ORIGIN: on a grant of three tools with no way to discover a chart id,
the model guessed an id, got `chart_out_of_scope`, and called `rank_values` with
the SAME arguments six times until "đã dùng hết số lượt gọi mô hình". Two of
three questions ended `failed` having produced nothing but six identical
refusals.
"""
from __future__ import annotations

import asyncio
import os

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import replay_harness as H  # noqa: E402

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402


DEAD_CALL = {"name": "rank_values", "args": {"chart_id": 999, "top_n": 5}}
LIVE_CALL = {"name": "rank_values", "args": {"chart_id": 41, "top_n": 5}}

FLOW_BODY = {
    "answer_node": "answer",
    "nodes": [{
        "key": "answer",
        "name": "Tra loi",
        "prompt": "Xep hang giup toi",
        "type": "agent",
        "tools": [{"tool": "rank_values"}],
    }],
}


class _Persistent:
    """A model that does not take no for an answer.

    The harness's own stub emits its tool calls on round ONE only, which is
    exactly the behaviour that cannot reproduce this bug. This one repeats the
    script every round, for as many rounds as the runtime is willing to give it —
    which is the thing under test.
    """

    def __init__(self, script: list[dict]):
        self.script = script
        self.rounds = 0
        self.tools_offered: list[int] = []

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            self.rounds += 1
            # HOW MANY TOOLS THE RUNTIME IS STILL OFFERING. The stop policy works
            # by taking the schemas away, so this is where it becomes visible.
            self.tools_offered.append(len(tools or []))
            if tools:
                for i, call in enumerate(self.script):
                    yield AgentEvent(
                        type="tool_call",
                        tool_call_id=f"r{self.rounds}_c{i}",
                        tool_name=call["name"],
                        tool_args=dict(call.get("args") or {}),
                    )
            yield AgentEvent(type="text", text="đã trả lời")
            yield AgentEvent(type="usage",
                             extra={"prompt_tokens": 10, "completion_tokens": 5})

        return fake


class _CountingRegistry:
    """Every execution the registry actually performs, in order."""

    def __init__(self, results: dict | None = None, default: dict | None = None):
        self.calls: list[tuple[str, dict]] = []
        self.results = results or {}
        self.default = default or {
            "ok": False,
            "error_code": "chart_out_of_scope",
            "error": "chart_id 999 is not part of this dashboard.",
        }

    def execute(self, ctx, name, args, allowed=None, use_cache=True):
        self.calls.append((name, dict(args or {})))
        key = f"{name}:{(args or {}).get('chart_id')}"
        return dict(self.results.get(key, self.default))


def _run(monkeypatch, script: list[dict], registry: _CountingRegistry,
         *, max_tool_calls: int = 40, max_llm_calls: int = 12,
         node_tool_ceiling: int | None = None):
    """One flow, one agent node, and a model that repeats `script` every round.

    `node_tool_ceiling` matters more than it looks. The node's own default is 8,
    and with a model that calls one tool per round that ceiling ends the loop by
    itself after eight rounds — so a stop-policy case left at the default passes
    whether the policy exists or not. Raising it past MAX_ROUNDS makes the policy
    the only thing that can end the run.
    """
    model = _Persistent(script)
    monkeypatch.setattr(AH, "_stream", model.stream())
    monkeypatch.setattr(tool_registry, "execute", registry.execute)

    # THE BUDGET, WATCHED WHERE IT IS SPENT. `state` is a local of the executor,
    # so counting `spend_tool` calls is how this test reads `budget.tool_calls`
    # without reaching into the run.
    from app.services.agent_flows.runtime.state import Budget

    spent = {"tools": 0}
    real_spend = Budget.spend_tool

    def counting_spend(self):
        real_spend(self)
        spent["tools"] += 1

    monkeypatch.setattr(Budget, "spend_tool", counting_spend)

    body = {**FLOW_BODY, "nodes": [dict(n) for n in FLOW_BODY["nodes"]]}
    if node_tool_ceiling is not None:
        body["nodes"][0]["max_tool_calls"] = node_tool_ceiling
    flow = Flow.model_validate({
        **upgrade_body(body, key="fx_retry", name="retry"),
        "key": "fx_retry", "name": "retry",
    })
    env = H._envelope({"envelope": {"runtime": {
        "provider": "openai", "model": "gpt-4o-mini",
        "budget": {"max_llm_calls": max_llm_calls,
                   "max_tool_calls": max_tool_calls, "max_seconds": 60},
    }}})
    ctx = H._Ctx([41])

    async def go():
        out = None
        async for ev in executor.run_flow(
            FlowInput.model_validate(env), flow=flow, ctx=ctx,
            api_key="k", base_system_prompt="BASE",
        ):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    envelope = asyncio.run(go())
    return {
        "envelope": envelope,
        "registry": registry,
        "model": model,
        "tool_budget_spent": spent["tools"],
    }


# ── the invariant the helper test could not reach ───────────────────────────

def test_a_dead_repeat_reaches_neither_the_registry_nor_the_budget(monkeypatch):
    """THE REOPENED FINDING, stated at the level it failed at."""
    reg = _CountingRegistry()
    out = _run(monkeypatch, [DEAD_CALL], reg)

    assert len(reg.calls) == 1, (
        f"the registry executed {len(reg.calls)} times for one request that "
        "cannot succeed; the guard exists to make this exactly 1"
    )
    assert out["tool_budget_spent"] == 1, (
        f"the tool budget was charged {out['tool_budget_spent']} times for one "
        "executed call. This is the defect the helper-level test could not see: "
        "spend_tool() ran before the refusal guard, so a repeat the runtime "
        "declined still cost a call."
    )


def test_the_model_is_told_why_each_time_it_repeats(monkeypatch):
    """Free is not the same as silent. Each repeat still gets an answer naming
    the original reason, or the model is being refused without being told what to
    change."""
    reg = _CountingRegistry()
    out = _run(monkeypatch, [DEAD_CALL], reg)
    steps = (out["envelope"].get("trace") or {}).get("steps") or []
    logged = [t for s in steps for t in (s.get("tool_calls") or [])]

    assert any("already_refused" in str(t) for t in logged), (
        f"no already_refused row in the trace: {logged}. An audit reading this "
        "run cannot tell a repeat from a first attempt."
    )
    assert any("chart_out_of_scope" in str(t) for t in logged)


# ── and it has to END ───────────────────────────────────────────────────────

def test_an_ignored_recovery_stops_the_node_instead_of_draining_it(monkeypatch):
    """Making the repeat free removed its cost, not its loop."""
    reg = _CountingRegistry()
    # The node ceiling is lifted past MAX_ROUNDS on purpose — see `_run`. At the
    # default of 8 this case passes with no stop policy at all, because the node
    # ceiling ends the loop first and the test would be pinning the wrong guard.
    out = _run(monkeypatch, [DEAD_CALL], reg, max_llm_calls=40,
               node_tool_ceiling=20)
    model = out["model"]

    assert model.rounds < AH.MAX_ROUNDS, (
        f"the node ran {model.rounds} of {AH.MAX_ROUNDS} model rounds on one "
        "permanently dead request — the recovery was ignored and nothing "
        "stopped it"
    )
    assert 0 in model.tools_offered, (
        f"tools were offered on every round ({model.tools_offered}); the stop "
        "policy never took them off the table"
    )
    # Two explanations, then no more tools: the model gets a real chance to read
    # the reason before the door closes.
    assert model.tools_offered.count(0) >= 1
    assert model.tools_offered[0] > 0, "the first round must still offer tools"


def test_the_node_still_answers_rather_than_failing_silently(monkeypatch):
    reg = _CountingRegistry()
    out = _run(monkeypatch, [DEAD_CALL], reg)
    # `answer.blocks[].markdown` — the producer's shape, read off a real run
    # rather than guessed. A fixture that invents the key tests the fixture.
    blocks = ((out["envelope"].get("answer") or {}).get("blocks")) or []
    text = "".join(str(b.get("markdown") or "") for b in blocks).strip()
    assert text, (
        "the node produced no text; being unable to use a tool is not a reason "
        "to hand the viewer nothing"
    )


# ── what must still get through ─────────────────────────────────────────────

def test_a_corrected_call_still_runs(monkeypatch):
    """The stop policy must not punish the model for taking the advice."""
    reg = _CountingRegistry(results={
        "rank_values:41": {"ok": True, "kind": "table",
                           "data": {"columns": ["c"], "rows": [["x"]]}},
    })
    out = _run(monkeypatch, [DEAD_CALL, LIVE_CALL], reg)

    executed = [args.get("chart_id") for _, args in reg.calls]
    assert 41 in executed, (
        f"the corrected call never reached the registry: {executed}"
    )
    assert out["tool_budget_spent"] == len(reg.calls), (
        "budget and registry executions diverged — one of them is counting "
        "something the other is not"
    )


def test_a_working_call_is_charged_exactly_once_per_execution(monkeypatch):
    """The control. If budget stopped being spent altogether, every case above
    would pass for the wrong reason."""
    reg = _CountingRegistry(results={
        "rank_values:41": {"ok": True, "kind": "table",
                           "data": {"columns": ["c"], "rows": [["x"]]}},
    })
    out = _run(monkeypatch, [LIVE_CALL], reg)

    assert len(reg.calls) >= 1
    assert out["tool_budget_spent"] == len(reg.calls), (
        f"{len(reg.calls)} executions but {out['tool_budget_spent']} charged — "
        "moving the accounting inside the executor must not have lost it"
    )


def test_a_transient_failure_is_still_retried_and_still_charged(monkeypatch):
    """A retryable error is not a dead request: it may be asked again, and the
    attempt costs what any attempt costs."""
    reg = _CountingRegistry(default={
        "ok": False, "error_code": "query_failed", "retryable": True,
        "error": "warehouse timed out",
    })
    out = _run(monkeypatch, [DEAD_CALL], reg)

    assert len(reg.calls) > 1, (
        "a transient warehouse failure was treated as permanent — the tool was "
        "never tried again"
    )
    assert out["tool_budget_spent"] == len(reg.calls)


@pytest.mark.parametrize("ceiling", [1, 2])
def test_the_run_budget_still_binds(monkeypatch, ceiling):
    """The ceiling is the other half of the accounting, and it has to keep
    holding now that the spending moved."""
    reg = _CountingRegistry(default={
        "ok": False, "error_code": "query_failed", "retryable": True,
        "error": "warehouse timed out",
    })
    out = _run(monkeypatch, [DEAD_CALL], reg, max_tool_calls=ceiling)
    assert len(reg.calls) <= ceiling, (
        f"{len(reg.calls)} executions against a ceiling of {ceiling}"
    )
