# -*- coding: utf-8 -*-
"""The breakdown a question names must reach the ANSWER, not only the verdict.

MEASURED ON THE FINAL LIVE EVAL (link 39, report 67, 3 reps × 3 arms), question
"Bang SP chiếm bao nhiêu phần trăm tổng doanh thu?" — the report has ORDERS by
state and no revenue by state:

    run 2039  get_chart_summary ×2 on the revenue-by-CATEGORY chart
              → "Bang SP … 1,258,681.34 … 9.26%"      health_beauty, as a state   (ok)
    run 1966  total_measure ×2, no grouped call, no refusal
              → "Bang SP chiếm 100% tổng doanh thu"    the all-states total        (ok)
    run 1994  share_of refused (dimension_mismatch), gap open
              → "Doanh thu từ bang SP cũng là 13,591,643.70 … 100%"              (partial)

Three routes, one class — a figure attributed to a member of a breakdown the run
never read — and each closed at the layer it escaped from:

  * the summary of a grouped chart IS a grouped result → the tool gate
    (`dimension_gate.DIMENSION_SENSITIVE`), exactly as `get_chart_data` before it;
  * a run that never touched the breakdown at all opens the gap from the question
    (`note_question_dimension_gap`) — facts only: the gate's own resolution of the
    question, and the grouping of every chart a successful call read;
  * an open gap reaches the answer as one correction round, the same shape as the
    figure and qualifier retries, kept only if it adds no unsupported figure.

WHAT MUST STAY SILENT: a question that names no breakdown; a month question answered
from the monthly chart (it touched "month" whatever tool it used); a run that read a
chart grouped by what was asked. The measure half (orders read as revenue) is NOT
gated here — see the architecture doc's limits.
"""
from __future__ import annotations

import asyncio
import copy
import os

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import pytest  # noqa: E402

import replay_harness as H  # noqa: E402
from test_requested_dimension_is_not_substituted import (  # noqa: E402,F401
    CATEGORY_CHART,
    CHARTS,
    LIVE_NAMES,
    STATE_ORDERS_CHART,
    _semantic,
    undeclared,
)

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import agent_runtime as AR  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.agent_flows.runtime.state import RunState  # noqa: E402
from app.services.agent_flows.tools import registry as R  # noqa: E402
from app.services.agent_flows.tools.context import extract_chart_field_semantics  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402

STATE_Q = "Bang SP chiếm bao nhiêu phần trăm tổng doanh thu?"
MONTH_Q = "GMV tháng gần nhất so với tháng trước thay đổi bao nhiêu phần trăm?"
TOTAL_Q = "Tổng doanh thu là bao nhiêu?"
KPI_CHART = 900


def _kpi(ctx):
    """A KPI tile: a measure, no grouping."""
    ctx.chart_meta[KPI_CHART] = {"name": "Olist · Tổng doanh thu · page-1",
                                 "fields": {"measures": [{"field": "dataset_table_438.total_revenue"}],
                                            "dimensions": []}}
    ctx.allowed_chart_ids.add(KPI_CHART)
    return ctx


# ── 1. the summary of a grouped chart is a grouped result ───────────────────

def test_the_category_chart_summary_is_refused_for_a_state_question(undeclared):
    """Run 2039: the summary's top values of the CATEGORY chart became a state's."""
    ctx = undeclared([684, 685, 686, 687], STATE_Q)
    res = R.execute(ctx, "get_chart_summary", {"chart_id": CATEGORY_CHART}, allowed=None)
    assert res.get("error_code") == "dimension_mismatch", res
    assert res.get("retryable") is False


def test_a_summary_is_still_served_where_nothing_conflicts(undeclared):
    # The breakdown the question names…
    ctx = undeclared([684, 685, 686, 687], "Danh mục nào có doanh thu cao nhất?")
    res = R.execute(ctx, "get_chart_summary", {"chart_id": CATEGORY_CHART}, allowed=None)
    assert res.get("error_code") != "dimension_mismatch", res
    # …a KPI tile, which has no grouping to conflict with…
    ctx = _kpi(undeclared([684, 685, 686, 687], STATE_Q))
    res = R.execute(ctx, "get_chart_summary", {"chart_id": KPI_CHART}, allowed=None)
    assert res.get("error_code") != "dimension_mismatch", res
    # …and a question that names no breakdown at all.
    ctx = undeclared([684, 685, 686, 687], TOTAL_Q)
    res = R.execute(ctx, "get_chart_summary", {"chart_id": CATEGORY_CHART}, allowed=None)
    assert res.get("error_code") != "dimension_mismatch", res


def test_a_summary_grouped_by_the_request_closes_a_refusal_gap():
    state = RunState()
    state.dimension_gap = {"requested": "customer_state", "satisfied": False}
    AR._note_dimension_outcome(state, {"ok": True, "data": {
        "primary_dimension": "dataset_table_441.customer_state"}})
    assert state.dimension_gap["satisfied"] is True


# ── 2. a run that never touched the breakdown ───────────────────────────────

def test_a_run_that_never_touched_the_breakdown_opens_the_gap_from_the_question(undeclared):
    """Run 1966: only scalar totals were read; nothing was ever refused."""
    ctx = _kpi(undeclared([684, 685, 686, 687], STATE_Q))
    state = RunState()
    state.record_evidence({"ok": True, "data": {"value": 13591643.7}}, tool="total_measure",
                          args={"chart_id": KPI_CHART})
    state.record_evidence({"ok": True, "data": {"value": 13591643.7}}, tool="total_measure",
                          args={"chart_id": CATEGORY_CHART})
    fact = AR.note_question_dimension_gap(state, ctx)
    assert fact == {"requested": "customer_state", "label": fact["label"], "delivered": False,
                    "gap_source": "question"}, fact
    assert state.dimension_gap == {"requested": "customer_state", "label": fact["label"],
                                   "satisfied": False, "source": "question"}


def test_a_run_that_read_a_chart_grouped_by_the_request_has_touched_it(undeclared):
    """The orders-by-state chart groups by state: whatever it measures, the run HAS
    the breakdown (the measure half is a separate, documented limit)."""
    ctx = undeclared([684, 685, 686, 687], STATE_Q)
    state = RunState()
    state.record_evidence({"ok": True, "data": {"value": 41746}}, tool="total_measure",
                          args={"chart_id": STATE_ORDERS_CHART})
    fact = AR.note_question_dimension_gap(state, ctx)
    assert fact["delivered"] is True and state.dimension_gap == {}


def test_a_result_declaring_the_breakdown_counts_even_without_a_chart_id(undeclared):
    ctx = undeclared([684, 685, 686, 687], STATE_Q)
    state = RunState()
    state.record_evidence({"ok": True, "data": {"dimension": "customer_state", "items": []}},
                          tool="rank_values", args={})
    assert AR.note_question_dimension_gap(state, ctx)["delivered"] is True


def test_a_refused_read_does_not_count_as_touching(undeclared):
    ctx = undeclared([684, 685, 686, 687], STATE_Q)
    state = RunState()
    state.record_evidence({"ok": False, "error_code": "query_failed"}, tool="get_chart_data",
                          args={"chart_id": STATE_ORDERS_CHART})
    assert state.charts_read == set()
    assert AR.note_question_dimension_gap(state, ctx)["delivered"] is False


def test_a_month_question_answered_from_the_monthly_chart_is_never_flagged(undeclared):
    ctx = undeclared([684, 685, 686, 687], MONTH_Q)
    state = RunState()
    state.record_evidence({"ok": True, "data": {"current": 1.0, "previous": 1.0}},
                          tool="compare_periods", args={"chart_id": 684})
    AR.note_question_dimension_gap(state, ctx)
    assert state.dimension_gap == {}


def test_a_question_that_names_no_breakdown_opens_nothing(undeclared):
    ctx = _kpi(undeclared([684, 685, 686, 687], TOTAL_Q))
    state = RunState()
    state.record_evidence({"ok": True, "data": {"value": 1.0}}, tool="total_measure",
                          args={"chart_id": KPI_CHART})
    assert AR.note_question_dimension_gap(state, ctx) == {}
    assert state.dimension_gap == {}


def test_a_gap_a_refusal_opened_is_reported_not_overwritten(undeclared):
    ctx = undeclared([684, 685, 686, 687], STATE_Q)
    state = RunState()
    state.dimension_gap = {"requested": "customer_state", "label": "Bang", "satisfied": False}
    fact = AR.note_question_dimension_gap(state, ctx)
    assert fact["gap_source"] == "refusal" and fact["delivered"] is False
    assert "source" not in state.dimension_gap


# ── 3. the gap reaches the answer ───────────────────────────────────────────

_CORRECTED = "Báo cáo này không tách được doanh thu theo bang; tổng doanh thu toàn bộ là 13.591.643,70."


class _Model:
    """Reads the category chart's TOTAL, then attributes it to SP — run 1966."""

    def __init__(self, chart_id):
        self.chart_id = chart_id
        self.calls: list[dict] = []

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            last = next((m.get("content") for m in reversed(messages) if m.get("role") == "user"), "")
            self.calls.append({"tools": [t.get("name") for t in tools or []], "last_user": str(last)})
            if tools and not any(m.get("role") == "tool" for m in messages):
                yield AgentEvent(type="tool_call", tool_call_id="t1", tool_name="total_measure",
                                 tool_args={"chart_id": self.chart_id})
            elif "không tách được số liệu được hỏi theo" in str(last):
                yield AgentEvent(type="text", text=_CORRECTED)
            else:
                yield AgentEvent(type="text", text="Bang SP chiếm 100% tổng doanh thu, tức 13.591.643,70.")
            yield AgentEvent(type="usage", extra={"prompt_tokens": 5, "completion_tokens": 2})
        return fake

    def corrections(self):
        return [c for c in self.calls if "không tách được số liệu được hỏi theo" in c["last_user"]]


def _run(monkeypatch, undeclared, chart_id):
    model = _Model(chart_id)
    monkeypatch.setattr(AH, "_stream", model.stream())
    monkeypatch.setattr(tool_registry, "execute",
                        lambda ctx, name, args, allowed=None, use_cache=True:
                        {"ok": True, "kind": "value", "data": {"value": 13591643.7}})
    ctx = H._Ctx([684, 685, 686, 687, KPI_CHART])
    probe = _kpi(undeclared([684, 685, 686, 687], STATE_Q))
    ctx.chart_meta = probe.chart_meta
    body = {"answer_node": "tl", "nodes": [{
        "key": "tl", "name": "tl", "type": "agent", "prompt": "Trả lời câu hỏi.",
        "max_tool_calls": 4, "tools": [{"tool": "total_measure"}]}]}
    flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx_dim", name="fx_dim"),
                                "key": "fx_dim", "name": "fx_dim"})
    env = H._envelope({"question": STATE_Q, "envelope": {"runtime": {
        "provider": "openai", "model": "m", "budget": {"max_llm_calls": 6, "max_tool_calls": 10,
                                                        "max_seconds": 60}}}})
    env.setdefault("question", {})["raw"] = STATE_Q
    env["question"]["normalized"] = STATE_Q

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=ctx,
                                          api_key="k", base_system_prompt="BASE"):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    return asyncio.run(go()), model


def _answer(env):
    return "".join(b.get("markdown") or b.get("text") or ""
                   for b in ((env.get("answer") or {}).get("blocks") or []))


def test_a_total_attributed_to_a_state_the_run_never_read_is_corrected(monkeypatch, undeclared):
    env, model = _run(monkeypatch, undeclared, CATEGORY_CHART)
    assert len(model.corrections()) == 1, "one correction round, naming the breakdown"
    assert "100%" not in _answer(env) and "không tách được" in _answer(env)
    assert env["status"] == "partial", "the question it asked was not answered"
    step = next(s for s in (env.get("trace") or {}).get("steps") or [] if s["key"] == "tl")
    fact = (step.get("capabilities") or {}).get("dimension") or {}
    assert fact.get("requested") == "customer_state" and fact.get("delivered") is False
    assert fact.get("gap_source") == "question" and fact.get("corrected") is True


def test_the_same_run_on_a_chart_grouped_by_state_is_left_alone(monkeypatch, undeclared):
    env, model = _run(monkeypatch, undeclared, STATE_ORDERS_CHART)
    assert model.corrections() == []
    step = next(s for s in (env.get("trace") or {}).get("steps") or [] if s["key"] == "tl")
    assert ((step.get("capabilities") or {}).get("dimension") or {}).get("delivered") is True
