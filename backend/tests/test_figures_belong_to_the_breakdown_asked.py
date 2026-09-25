# -*- coding: utf-8 -*-
"""A figure given to a member of a breakdown must BE a figure of that breakdown.

MEASURED ON THE LIVE EVAL (report 67, "Bang SP chiếm bao nhiêu phần trăm tổng doanh
thu?" — the report has ORDERS by state and no revenue by state), all recorded `ok`:

    get_chart_summary on the revenue-by-CATEGORY chart
        → "Bang SP … 1,258,681.34 … 9.26%"   health_beauty's max and top share
    total_measure, nothing refused
        → "Bang SP chiếm 100% tổng doanh thu" 100 matched `rows_counted: 1`

The first fix ("did the run touch a chart grouped by state?") was withdrawn after
review proved it both missed (a TOTAL of the state chart "touched" state) and broke
correct answers. This one is decided at the EVIDENCE: every trusted figure is sorted
by what it is a figure OF (`runtime/grain.py`), from the tools' own structure, and
the answer is checked against that (`runtime/dimension_attribution.py`).

Both directions are pinned here — the wrong answers are caught AND the right ones are
left alone — with results in the shapes the tools really return.
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
    STATE_ORDERS_CHART,
    _semantic,
    undeclared,
)
from test_skills_run_as_governed_children import skill_db  # noqa: E402,F401

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import dimension_attribution as DA  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.agent_flows.runtime.state import RunState  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402

STATE_Q = "Bang SP chiếm bao nhiêu phần trăm tổng doanh thu?"
CAT = "dataset_table_445.product_category_name_english"
STATE = "dataset_table_441.customer_state"
KPI = 900


def _ctx(undeclared, question, extra_kpi=True):
    ctx = undeclared([684, 685, 686, 687], question)
    if extra_kpi:
        ctx.chart_meta[KPI] = {"name": "Olist · Tổng doanh thu · page-1",
                               "fields": {"measures": [{"field": "dataset_table_438.total_revenue"}],
                                          "dimensions": []}}
    return ctx


# ── results as the tools return them ────────────────────────────────────────

def category_summary():
    """`get_chart_summary` of revenue-by-category (insight pack shape)."""
    return {"ok": True, "kind": "narrative", "data": {
        "chart_id": CATEGORY_CHART, "total_rows": 71, "primary_measure": "total_revenue",
        "primary_dimension": CAT,
        "columns": [{"name": "total_revenue", "kind": "numeric", "total": 13591643.7,
                     "min": 9.59, "max": 1258681.34, "avg": 191431.6, "median": 34521.2,
                     "top_values": []}],
        "top_5": [{"label": "health_beauty", "value": 1258681.34},
                  {"label": "watches_gifts", "value": 1205005.68}],
        "top_share_pct": 9.26,
    }}


def kpi_total():
    """`total_measure` on a KPI tile."""
    return {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "measure": "total_revenue", "value": 13591643.7,
        "formatted": "13.59M", "average": 13591643.7, "min": 13591643.7, "max": 13591643.7,
        "rows_counted": 1, "aggregation": "sum", "unit": None}}


def state_total():
    """`total_measure` on the orders-by-STATE chart: a total over ALL states."""
    return {"ok": True, "kind": "value", "data": {
        "chart_id": STATE_ORDERS_CHART, "measure": "order_count", "value": 99441,
        "average": 3682.9, "min": 46, "max": 41746, "rows_counted": 27,
        "aggregation": "sum", "unit": None}}


def state_rows():
    """`get_chart_data` on the orders-by-state chart: rows labelled by state."""
    return {"ok": True, "kind": "table", "data": {
        "chart_id": STATE_ORDERS_CHART, "columns": ["customer_state", "order_count"],
        "rows": [["SP", 41746], ["RJ", 12852], ["MG", 11635]], "row_count": 27}}


def rate_kpi():
    return {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "measure": "on_time_rate", "value": 0.9212, "format_kind": "percent",
        "aggregation": "avg", "rows_counted": 1}}


def _state(*results):
    state = RunState()
    for tool, res, args in results:
        state.record_evidence(res, tool=tool, args=args)
    return state


# ── 1. the wrong answers are caught ─────────────────────────────────────────

def test_a_categorys_figures_given_to_a_state_are_flagged(undeclared):
    state = _state(("get_chart_summary", category_summary(), {"chart_id": CATEGORY_CHART}))
    fact = DA.check(state, _ctx(undeclared, STATE_Q),
                    "Bang SP có doanh thu 1.258.681,34, chiếm khoảng 9,26% tổng doanh thu.")
    assert fact["delivered"] is False
    assert sorted((f["value"], f["why"]) for f in fact["flagged"]) == [
        (9.26, "member_of"), (1258681.34, "member_of")], fact
    assert all(f["of"] == ["product_category_name_english"] for f in fact["flagged"])


def test_a_row_count_read_as_a_percentage_is_flagged_and_the_total_is_not(undeclared):
    state = _state(("total_measure", kpi_total(), {"chart_id": KPI}))
    fact = DA.check(state, _ctx(undeclared, STATE_Q),
                    "Bang SP chiếm 100% tổng doanh thu, tức 13.591.643,70.")
    assert [(f["value"], f["why"]) for f in fact["flagged"]] == [(100.0, "no_proportion")], fact


def test_a_total_of_the_state_chart_is_not_a_states_figure(undeclared):
    """Review's P0 against the withdrawn fix: this run 'touched' the state chart."""
    state = _state(("total_measure", state_total(), {"chart_id": STATE_ORDERS_CHART}))
    fact = DA.check(state, _ctx(undeclared, STATE_Q), "Bang SP chiếm 100% tổng số đơn.")
    assert fact["delivered"] is False and [f["why"] for f in fact["flagged"]] == ["no_proportion"]


# ── 2. the right answers are left alone ─────────────────────────────────────

def test_rows_labelled_by_state_deliver_the_breakdown(undeclared):
    """Review's other P0: refused on the category chart, the model read the state
    chart's ROWS, as the refusal told it to — and its right answer was destroyed."""
    state = _state(("get_chart_data", state_rows(), {"chart_id": "687"}))   # a string id, too
    fact = DA.check(state, _ctx(undeclared, STATE_Q),
                    "Bang SP có 41.746 đơn hàng, khoảng 42% tổng số đơn.")
    assert fact == {"requested": "customer_state", "label": fact["label"], "delivered": True,
                    "flagged": []}


def test_a_ranking_by_state_delivers_the_breakdown(undeclared):
    ranked = {"ok": True, "kind": "ranking", "data": {
        "chart_id": 701, "measure": "total_revenue", "dimension": STATE,
        "items": [{"rank": 1, "label": "SP", "value": 5202955.1, "share_pct": 38.28}]}}
    state = _state(("rank_values", ranked, {"chart_id": 701}))
    fact = DA.check(state, _ctx(undeclared, STATE_Q), "SP chiếm 38,28% với 5.202.955,10.")
    assert fact["delivered"] is True and fact["flagged"] == []


def test_an_honest_refusal_that_states_the_total_is_left_alone(undeclared):
    state = _state(("total_measure", kpi_total(), {"chart_id": KPI}))
    fact = DA.check(state, _ctx(undeclared, STATE_Q),
                    "Báo cáo này không tách được doanh thu theo bang; tổng doanh thu toàn bộ là 13.591.643,70.")
    assert fact["delivered"] is False and fact["flagged"] == []


def test_a_real_rate_is_a_proportion(undeclared):
    """A KPI rate read from a measure declared non-additive is a proportion."""
    state = _state(("total_measure", rate_kpi(), {"chart_id": KPI}))
    fact = DA.check(state, _ctx(undeclared, STATE_Q), "Tỷ lệ giao đúng hẹn toàn bộ là 92,12%.")
    assert fact["flagged"] == []


def test_a_count_question_is_not_flagged_even_when_a_word_resolves_a_dimension(undeclared):
    """Review's P1: "khách" in a chart title made this question 'about states'.
    Its answer is a whole-report figure, so nothing is flagged."""
    q = "Có bao nhiêu khách hàng?"
    whole = {"ok": True, "kind": "value", "data": {"chart_id": KPI, "value": 96096, "rows_counted": 1}}
    state = _state(("total_measure", whole, {"chart_id": KPI}))
    fact = DA.check(state, _ctx(undeclared, q), "Có 96.096 khách hàng.")
    assert (fact or {}).get("flagged", []) == []


def test_a_time_breakdown_is_out_of_scope(undeclared):
    q = "GMV tháng gần nhất so với tháng trước thay đổi bao nhiêu phần trăm?"
    state = _state(("compare_periods", {"ok": True, "data": {"change_pct": 5.2345}}, {"chart_id": 684}))
    ctx = _ctx(undeclared, q)
    from app.services.agent_flows.tools.dimension_gate import requested_dimension
    from app.services.time_semantics import looks_like_time_name

    if requested_dimension(ctx):
        assert looks_like_time_name(requested_dimension(ctx))
    assert DA.check(state, ctx, "GMV tăng 5,23%.") == {}


def test_a_question_that_names_the_other_breakdown_may_use_it(undeclared):
    q = "Cho tôi doanh thu theo danh mục và theo bang"
    state = _state(("get_chart_summary", category_summary(), {"chart_id": CATEGORY_CHART}))
    fact = DA.check(state, _ctx(undeclared, q), "Danh mục health_beauty dẫn đầu với 1.258.681,34.")
    assert fact.get("flagged", []) == []


def test_a_reused_read_restores_what_its_figures_are_of(undeclared):
    """Review's P1: on a follow-up turn the read is reused, and a ledger without
    grain made a correct answer look unsupported."""
    from app.services.agent_flows.runtime.handlers.data import restore_report_read_provenance

    state = RunState()
    restore_report_read_provenance(
        {"charts": [{"chart_id": STATE_ORDERS_CHART, "title": "Số đơn theo bang",
                     "data": state_rows()}]}, state, node_key="bao_cao")
    fact = DA.check(state, _ctx(undeclared, "Còn bang RJ thì sao?"), "Bang RJ có 12.852 đơn hàng.")
    assert fact.get("delivered") is True and fact["flagged"] == []


def test_a_skill_childs_reads_reach_the_parent(monkeypatch, skill_db):
    """Review's P1: evidence merged from a child without its grain."""
    import test_budget_always_reaches_an_answer as B

    monkeypatch.setattr(B, "_tool", lambda ctx, name, args, allowed=None, use_cache=True: state_rows())
    env, model, state = B._run(monkeypatch, B._CALLS_SKILL, llm=8, db=skill_db.db,
                               model=B._calls_skill_whenever_offered())
    assert model.by("VAI_TRO_CON"), "the child ran"
    assert state.member_figures.get("customer_state"), state.member_figures


def test_the_requested_dimension_is_computed_per_question(undeclared):
    """Review's P1: a Skill child's context is a shallow copy and shared the cache."""
    import copy as _copy
    from app.services.agent_flows.tools.dimension_gate import requested_dimension

    parent = _ctx(undeclared, STATE_Q)
    assert requested_dimension(parent) == STATE
    child = _copy.copy(parent)
    child.question = "Tổng doanh thu là bao nhiêu?"
    assert requested_dimension(child) is None
    assert requested_dimension(parent) == STATE


# ── 3. end to end: the answer is corrected, and only when it must be ────────

_HONEST = "Báo cáo này không tách được doanh thu theo bang; tổng doanh thu toàn bộ là 13.591.643,70."


class _Model:
    def __init__(self, first: str, correction: str = _HONEST):
        self.first, self.correction = first, correction
        self.calls: list[str] = []

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            last = str(next((m.get("content") for m in reversed(messages) if m.get("role") == "user"), ""))
            self.calls.append(last)
            if tools and not any(m.get("role") == "tool" for m in messages):
                yield AgentEvent(type="tool_call", tool_call_id="t1", tool_name="total_measure",
                                 tool_args={"chart_id": KPI})
            elif "không thể là số" in last:
                yield AgentEvent(type="text", text=self.correction)
            else:
                yield AgentEvent(type="text", text=self.first)
            yield AgentEvent(type="usage", extra={"prompt_tokens": 5, "completion_tokens": 2})
        return fake

    def corrections(self):
        return [c for c in self.calls if "không thể là số" in c]


def _run_flow(monkeypatch, undeclared, model, result):
    monkeypatch.setattr(AH, "_stream", model.stream())
    monkeypatch.setattr(tool_registry, "execute",
                        lambda ctx, name, args, allowed=None, use_cache=True: result)
    ctx = H._Ctx([684, 685, 686, 687, KPI])
    ctx.chart_meta = _ctx(undeclared, STATE_Q).chart_meta
    body = {"answer_node": "tl", "nodes": [{
        "key": "tl", "name": "tl", "type": "agent", "prompt": "Trả lời câu hỏi.",
        "max_tool_calls": 4, "tools": [{"tool": "total_measure"}]}]}
    flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx_attr", name="fx_attr"),
                                "key": "fx_attr", "name": "fx_attr"})
    env = H._envelope({"envelope": {"question": {"raw": STATE_Q}, "runtime": {
        "provider": "openai", "model": "m",
        "budget": {"max_llm_calls": 6, "max_tool_calls": 10, "max_seconds": 60}}}})

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=ctx,
                                          api_key="k", base_system_prompt="BASE"):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    return asyncio.run(go())


def _answer(env):
    return "".join(b.get("markdown") or b.get("text") or ""
                   for b in ((env.get("answer") or {}).get("blocks") or []))


def _fact(env):
    step = next(s for s in (env.get("trace") or {}).get("steps") or [] if s["key"] == "tl")
    return (step.get("capabilities") or {}).get("dimension") or {}


def test_a_state_given_the_whole_total_is_corrected_and_marked_partial(monkeypatch, undeclared):
    model = _Model("Bang SP chiếm 100% tổng doanh thu, tức 13.591.643,70.")
    env = _run_flow(monkeypatch, undeclared, model, kpi_total())
    [correction] = model.corrections()
    assert "100" in correction, "the correction names the figure it is about"
    assert _answer(env) == _HONEST
    assert env["status"] == "partial"
    fact = _fact(env)
    assert fact["corrected"] is True and fact["flagged"] == []
    assert [f["why"] for f in fact["flagged_before"]] == ["no_proportion"]


def test_a_correction_that_drops_the_total_is_rejected(monkeypatch, undeclared):
    model = _Model("Bang SP chiếm 100% tổng doanh thu, tức 13.591.643,70.",
                   correction="Báo cáo này không tách được doanh thu theo bang.")
    env = _run_flow(monkeypatch, undeclared, model, kpi_total())
    assert len(model.corrections()) == 1
    assert "100%" in _answer(env), "the rewrite lost the legitimate total, so it was not taken"
    assert env["status"] == "partial" and _fact(env).get("flagged")


def test_a_correct_answer_from_state_rows_is_not_touched(monkeypatch, undeclared):
    model = _Model("Bang SP có 41.746 đơn hàng.")
    env = _run_flow(monkeypatch, undeclared, model, state_rows())
    assert model.corrections() == []
    assert _answer(env) == "Bang SP có 41.746 đơn hàng."
    assert env["status"] == "ok" and _fact(env).get("delivered") is True
