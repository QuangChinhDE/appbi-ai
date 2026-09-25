# -*- coding: utf-8 -*-
"""A figure in the answer must MEAN what the question asks: measure × breakdown ×
member, and a percentage must be one a tool computed.

LIVE FAILURES THIS LOCKS (report 67; ORDERS by state exist, revenue by state does not):

    "Bang SP chiếm bao nhiêu % tổng doanh thu?"
      → "Bang SP … 1,258,681.34 … 9.26%"   health_beauty's revenue and share
      → "Bang SP chiếm 100%"               100 matched `rows_counted: 1` ×100
      → "SP chiếm 41,98% tổng doanh thu"   an ORDERS share, called revenue
    "GMV tháng gần nhất so với tháng trước thay đổi bao nhiêu phần trăm?"
      → "19,78%"                          divided out by the model, wrong months;
                                           the report's comparison says 5,23%

Two earlier designs were withdrawn after adversarial review (7181790a "chart
touched", 8cbe3790 "grain by breakdown", measure-blind). This one describes every
trusted figure by the TOOL THAT PRODUCED IT (`claim_scope`), checks the answer's
figures against the question's target (`claim_check`), sends a failing DRAFT back
while tools remain (`AgentRuntime.review_draft`), and marks what still fails as
unverified for the reader — it never rewrites an answer.

Results below are produced by the REAL tools (`derived`, `build_insight_pack`,
`compute`); only the chart-data fetch is stubbed. Both directions are pinned.
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

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import claim_check as CC  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.agent_flows.runtime.state import RunState  # noqa: E402
from app.services.agent_flows.tools import compute as compute_tool  # noqa: E402
from app.services.agent_flows.tools.packs import derived  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
from app.services.dashboard_ai_bot.insight_pack import build_insight_pack  # noqa: E402
from app.services.dashboard_ai_bot.thinking import advanced_tools as AT  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402

STATE_Q = "Bang SP chiếm bao nhiêu phần trăm tổng doanh thu?"
MOM_Q = "GMV tháng gần nhất so với tháng trước thay đổi bao nhiêu phần trăm?"
KPI = 900
MONTHLY = 684
CAT_COLS = ["dataset_table_445.product_category_name_english", "dataset_table_438.total_revenue"]
CAT_ROWS = [["health_beauty", 1258681.34], ["watches_gifts", 1205005.68], ["bed_bath_table", 1036988.68]] + \
    [[f"cat_{i}", 150000.0 + i * 1000] for i in range(20)]
STATE_COLS = ["dataset_table_441.customer_state", "dataset_table_437.order_count"]
STATE_ROWS = [["SP", 41746], ["RJ", 12852], ["MG", 11635], ["BA", 3380]]


@pytest.fixture
def world(monkeypatch, undeclared):
    """The report as the tools see it, with the question's governed measure."""
    table = {CATEGORY_CHART: (CAT_COLS, CAT_ROWS), STATE_ORDERS_CHART: (STATE_COLS, STATE_ROWS),
             KPI: (["dataset_table_438.total_revenue"], [[13591643.7]])}

    def fetch(ctx, chart_id, **kw):
        cols, rows = table[chart_id]
        return {"columns": list(cols), "rows": [list(r) for r in rows], "filters_applied": []}

    monkeypatch.setattr(derived, "_fetch_chart_data", fetch)
    monkeypatch.setattr(AT, "_fetch_chart_data", fetch)
    measures = {"q": {"total_revenue"}}
    monkeypatch.setattr(CC, "_question_measures", lambda ctx, q: set(measures["q"]))

    def make(question, *, asked=("total_revenue",)):
        measures["q"] = set(asked)
        ctx = undeclared([684, 685, 686, 687], question)
        ctx.db = None
        ctx.allowed_chart_ids.add(KPI)
        ctx.chart_meta[KPI] = {"name": "Olist · Tổng doanh thu · page-1",
                               "fields": {"measures": [{"field": "dataset_table_438.total_revenue"}],
                                          "dimensions": []}}
        state = RunState()
        for cid, meta in ctx.chart_meta.items():
            state.chart_dims[cid] = [d["field"] for d in (meta["fields"].get("dimensions") or [])]
        return ctx, state
    return make


def _pack(chart_id, name, cols, rows):
    p = build_insight_pack(chart_id=chart_id, chart_name=name, chart_type="", description="",
                           columns=cols, rows=rows, total_rows=len(rows), filters_applied=[])
    return {"ok": True, "kind": "narrative", "data": p.to_dict()}


def _rec(state, tool, res, args):
    assert res.get("ok"), res
    return state.record_evidence(res, tool=tool, args=args)


def _why(state, ctx, text):
    return sorted((f["value"], f["why"]) for f in CC.check(state, ctx, text).get("flagged") or [])


def _compare(value_now, value_before, pct):
    return {"ok": True, "kind": "comparison", "data": {
        "chart_id": MONTHLY, "measure": "dataset_table_438.gmv",
        "current": {"label": "2018-07", "value": value_now},
        "baseline": {"label": "2018-06", "value": value_before},
        "delta": round(value_now - value_before, 2), "pct_change": pct, "verdict": "tăng"}}


# ── the wrong answers are caught ────────────────────────────────────────────

def test_a_categorys_figures_given_to_a_state_are_flagged(world):
    ctx, state = world(STATE_Q)
    pack = _pack(CATEGORY_CHART, "Doanh thu theo danh mục", CAT_COLS, CAT_ROWS)
    _rec(state, "get_chart_summary", pack, {"chart_id": CATEGORY_CHART})
    top = pack["data"]["top_share_pct"]
    got = _why(state, ctx, f"Bang SP có doanh thu 1.258.681,34, chiếm khoảng {top}% tổng doanh thu.")
    assert [w for _, w in got] == ["other_dimension", "other_dimension"], got


def test_a_row_count_is_not_a_percentage_and_a_kpi_share_is_not_a_share(world):
    """100 matched `rows_counted: 1` ×100, and every KPI summary carries 100."""
    ctx, state = world(STATE_Q)
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    _rec(state, "get_chart_summary", _pack(KPI, "Tổng doanh thu", ["dataset_table_438.total_revenue"],
                                           [[13591643.7]]), {"chart_id": KPI})
    assert _why(state, ctx, "Bang SP chiếm 100% tổng doanh thu, tức 13.591.643,70.") == [(100.0, "unsupported")]


def test_an_orders_share_called_a_revenue_share_is_flagged(world):
    ctx, state = world(STATE_Q)
    _rec(state, "share_of", derived.tool_share_of(ctx, {"chart_id": STATE_ORDERS_CHART, "item": "SP"}),
         {"chart_id": STATE_ORDERS_CHART, "item": "SP"})
    share = next(e["value"] for e in state.claim_ledger if e["ratio"])
    got = _why(state, ctx, f"Bang SP chiếm {share:.2f}% tổng doanh thu.".replace(".", ","))
    assert got == [(round(share, 2), "other_measure")], got


def test_another_members_figure_is_flagged(world):
    ctx, state = world("Bang SP có bao nhiêu đơn hàng?", asked=("order_count",))
    _rec(state, "rank_values", derived.tool_rank_values(ctx, {"chart_id": STATE_ORDERS_CHART}),
         {"chart_id": STATE_ORDERS_CHART})
    assert _why(state, ctx, "Bang SP có 12.852 đơn hàng.") == [(12852.0, "other_member")]
    assert _why(state, ctx, "Bang SP có 41.746 đơn hàng.") == []


def test_a_change_the_model_divided_out_itself_is_flagged(world):
    ctx, state = world(MOM_Q, asked=("gmv",))
    _rec(state, "compare_periods", _compare(1003308.47 * 0 + 881380.0, 837555.37, 5.23), {"chart_id": MONTHLY})
    assert _why(state, ctx, "GMV tăng 19,78% so với tháng trước.") == [(19.78, "unsupported")]
    assert _why(state, ctx, "GMV tăng 5,23% so với tháng trước.") == []


# ── the right answers are left alone ────────────────────────────────────────

def test_state_rows_answer_an_orders_question(world):
    ctx, state = world("Bang SP có bao nhiêu đơn hàng?", asked=("order_count",))
    _rec(state, "get_chart_data", {"ok": True, "kind": "table", "data": {
        "chart_id": STATE_ORDERS_CHART, "columns": STATE_COLS, "rows": STATE_ROWS}},
        {"chart_id": "687"})
    assert _why(state, ctx, "Bang SP có 41.746 đơn hàng, chiếm phần lớn.") == []


def test_an_honest_refusal_that_states_the_total_is_left_alone(world):
    ctx, state = world(STATE_Q)
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    assert _why(state, ctx, "Báo cáo không tách được doanh thu theo bang; tổng doanh thu là 13.591.643,70.") == []


def test_a_certified_compute_rate_is_a_percentage_even_on_a_spurious_breakdown(world):
    """Review round 6's P0: 'khách' resolved to state; the correct 3,12% was rewritten."""
    ctx, state = world("Tỷ lệ khách hàng quay lại là bao nhiêu phần trăm?", asked=())
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "measure": "repeat_customers", "value": 2997, "rows_counted": 1}}, {"chart_id": KPI})
    ref_a = state.claim_ledger[0]["ref"]
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "measure": "customers", "value": 96096, "rows_counted": 1}}, {"chart_id": KPI})
    ref_b = next(e["ref"] for e in state.claim_ledger if e["value"] == 96096)
    ctx.evidence_store = state.evidence_store
    res = compute_tool.tool_compute(ctx, {"expression": "a / b * 100", "vars": {
        "a": {"ref": ref_a, "path": "value"}, "b": {"ref": ref_b, "path": "value"}}})
    assert res.get("ok") and res["data"]["provenance"] == "referenced", res
    _rec(state, "compute", res, {})
    assert _why(state, ctx, "Tỷ lệ khách hàng quay lại là 3,12% (2.997 / 96.096 khách).") == []


def test_a_month_on_month_answer_from_the_comparison_is_left_alone(world):
    ctx, state = world(MOM_Q, asked=("gmv",))
    _rec(state, "compare_periods", _compare(881380.0, 837555.37, 5.23), {"chart_id": MONTHLY})
    assert _why(state, ctx, "GMV tháng 7/2018 là 881.380 so với 837.555,37 tháng 6, tăng 5,23%.") == []


def test_a_category_question_answered_from_the_category_chart(world):
    ctx, state = world("Danh mục nào có doanh thu cao nhất?")
    _rec(state, "rank_values", derived.tool_rank_values(ctx, {"chart_id": CATEGORY_CHART}),
         {"chart_id": CATEGORY_CHART})
    assert _why(state, ctx, "health_beauty dẫn đầu với 1.258.681,34.") == []


def test_a_numeric_skill_result_keeps_the_meaning_of_its_figure(world):
    """Review round 6: a Skill's `{value}` laundered a category figure to whole."""
    ctx, state = world(STATE_Q)
    _rec(state, "rank_values", derived.tool_rank_values(ctx, {"chart_id": CATEGORY_CHART}),
         {"chart_id": CATEGORY_CHART})
    _rec(state, "skill:v", {"ok": True, "kind": "value", "data": {
        "value": 1258681.34, "evidence_values": [1258681.34], "evidence_paths": ["value"]}}, {})
    assert _why(state, ctx, "Bang SP có doanh thu 1.258.681,34.") == [(1258681.34, "other_dimension")]


def test_percent_in_words_is_a_percentage(world):
    ctx, state = world(STATE_Q)
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    assert _why(state, ctx, "Bang SP chiếm 100 phần trăm tổng doanh thu.") == [(100.0, "unsupported")]


# ── end to end: the draft goes back while tools remain ──────────────────────

class _Model:
    """Draft 1 divides the change out itself; told why, it calls compare_periods."""

    def __init__(self, obey=True):
        self.obey = obey
        self.reviews: list[str] = []

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            last = str(next((m.get("content") for m in reversed(messages) if m.get("role") == "user"), ""))
            tool_msgs = [m for m in messages if m.get("role") == "tool"]
            if "Kiểm tra số liệu trước khi trả lời" in last:
                self.reviews.append(last)
            if tools and not tool_msgs:
                yield AgentEvent(type="tool_call", tool_call_id="t1", tool_name="total_measure",
                                 tool_args={"chart_id": MONTHLY})
            elif tools and self.obey and self.reviews and len(tool_msgs) == 1:
                yield AgentEvent(type="tool_call", tool_call_id="t2", tool_name="compare_periods",
                                 tool_args={"chart_id": MONTHLY})
            elif len(tool_msgs) >= 2:
                yield AgentEvent(type="text", text="GMV tháng 7/2018 tăng 5,23% so với tháng 6.")
            else:
                yield AgentEvent(type="text", text="GMV tăng 19,78% so với tháng trước.")
            yield AgentEvent(type="usage", extra={"prompt_tokens": 5, "completion_tokens": 2})
        return fake


def _flow_run(monkeypatch, undeclared, model):
    results = {"total_measure": {"ok": True, "kind": "value", "data": {
                   "chart_id": MONTHLY, "measure": "dataset_table_438.gmv", "value": 1003308.47,
                   "rows_counted": 1}},
               "compare_periods": _compare(881380.0, 837555.37, 5.23)}
    monkeypatch.setattr(AH, "_stream", model.stream())
    monkeypatch.setattr(tool_registry, "execute",
                        lambda ctx, name, args, allowed=None, use_cache=True: results[name])
    monkeypatch.setattr(CC, "_question_measures", lambda ctx, q: {"gmv"})
    ctx = H._Ctx([684, 685, 686, 687])
    ctx.chart_meta = undeclared([684, 685, 686, 687], MOM_Q).chart_meta
    body = {"answer_node": "tl", "nodes": [{
        "key": "tl", "name": "tl", "type": "agent", "prompt": "Trả lời câu hỏi.", "max_tool_calls": 6,
        "tools": [{"tool": "total_measure"}, {"tool": "compare_periods"}]}]}
    flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx_cc", name="fx_cc"),
                                "key": "fx_cc", "name": "fx_cc"})
    env = H._envelope({"envelope": {"question": {"raw": MOM_Q}, "runtime": {
        "provider": "openai", "model": "m", "budget": {"max_llm_calls": 8, "max_tool_calls": 10,
                                                        "max_seconds": 60}}}})

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=ctx,
                                          api_key="k", base_system_prompt="BASE"):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}
    return asyncio.run(go())


def _answer(env):
    return "".join(b.get("markdown") or b.get("text") or "" for b in ((env.get("answer") or {}).get("blocks") or []))


def test_the_draft_goes_back_and_the_model_fetches_the_right_figure(monkeypatch, undeclared):
    model = _Model(obey=True)
    env = _flow_run(monkeypatch, undeclared, model)
    [review] = model.reviews
    assert "19.78%" in review and "compare_periods" in review
    assert _answer(env) == "GMV tháng 7/2018 tăng 5,23% so với tháng 6."
    assert env["status"] == "ok"
    step = next(s for s in (env.get("trace") or {}).get("steps") or [] if s["key"] == "tl")
    assert "compare_periods" in (step.get("tool_calls") or [])
    assert (step.get("capabilities") or {}).get("claim_review", {}).get("flagged")


def test_a_figure_the_model_will_not_fix_is_shown_unverified_never_rewritten(monkeypatch, undeclared):
    model = _Model(obey=False)
    env = _flow_run(monkeypatch, undeclared, model)
    answer = _answer(env)
    assert answer.startswith("GMV tăng 19,78% so với tháng trước."), "the model's words are kept"
    assert "Chưa kiểm chứng: 19.78%" in answer
    assert env["status"] == "partial"
    assert any(n.get("code") == "claims_unverified" for n in env.get("notices") or [])
