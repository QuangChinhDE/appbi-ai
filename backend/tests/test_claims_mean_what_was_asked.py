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
    # 100% has no proportion behind it; the total is the WHOLE report's, and the
    # report has no revenue by state — both said to the reader.
    assert _why(state, ctx, "Bang SP chiếm 100% tổng doanh thu, tức 13.591.643,70.") == [
        (100.0, "unsupported"), (13591643.7, "whole_as_member")]


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


def test_an_honest_refusal_keeps_its_total_published(world):
    """The total is TRUE as the total; the report has no revenue by state. Since
    flagged figures are WITHHELD, flagging it would hide a correct total the
    answer never gave to SP (production pilot brief: a total may be mentioned
    when it is plainly the report's). CONTRACT CHANGE, declared: was flagged
    `whole_as_member` with a neutral note."""
    ctx, state = world(STATE_Q)
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    text = "Báo cáo không tách được doanh thu theo bang; tổng doanh thu là 13.591.643,70."
    assert _why(state, ctx, text) == []
    assert (13591643.7, "whole_as_member") in _why(state, ctx, "Bang SP có doanh thu 13.591.643,70.")


def test_a_total_given_as_the_top_state_is_flagged(world):
    """D2 live: "Bang có doanh thu cao nhất là bang mà tổng doanh thu đạt 13,59M"."""
    ctx, state = world("Bang nào có doanh thu cao nhất?")
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    assert _why(state, ctx, "Bang có doanh thu cao nhất đạt 13.591.643,70.") == [(13591643.7, "whole_as_member")]


def test_orders_by_state_do_not_deliver_revenue_by_state(world):
    """Review round 6's P0: the delivery test was measure-blind."""
    ctx, state = world(STATE_Q)
    _rec(state, "get_chart_data", {"ok": True, "kind": "table", "data": {
        "chart_id": STATE_ORDERS_CHART, "columns": STATE_COLS, "rows": STATE_ROWS}},
        {"chart_id": STATE_ORDERS_CHART})
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    assert _why(state, ctx, "Doanh thu của bang SP là 13.591.643,70.") == [(13591643.7, "whole_as_member")]


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
                                          credentials=H.fixed_credentials("k"), base_system_prompt="BASE"):
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


def test_a_figure_the_model_will_not_fix_is_withheld_never_published(monkeypatch, undeclared):
    """Acceptance brief: a wrong figure is not published beside a warning. The
    digits are withheld in the public answer; the draft stays in the audit trace."""
    model = _Model(obey=False)
    env = _flow_run(monkeypatch, undeclared, model)
    answer = _answer(env)
    assert "19,78" not in answer and "19.78" not in answer
    assert answer.startswith("GMV tăng [đã ẩn: chưa kiểm chứng] so với tháng trước.")
    assert "Đã ẩn số chưa kiểm chứng" in answer
    step = next(s for s in (env.get("trace") or {}).get("steps") or [] if s["key"] == "tl")
    assert "19,78%" in ((step.get("capabilities") or {}).get("claims") or {}).get("draft", "")
    assert env["status"] == "partial"
    assert any(n.get("code") == "claims_unverified" for n in env.get("notices") or [])


# ── review round 7: never empty the answer; described-or-read is supported ──

def test_a_distribution_share_and_its_stated_basis_are_proportions(world):
    ctx, state = world("Doanh thu giữa các danh mục có tập trung không?")
    res = AT.tool_describe_distribution(ctx, {"chart_id": CATEGORY_CHART})
    _rec(state, "describe_distribution", res, {"chart_id": CATEGORY_CHART})
    share = round(res["data"]["top10_share_pct"], 2)
    assert _why(state, ctx, f"Top 10% danh mục chiếm {share}% doanh thu.".replace(".", ",")) == []


def test_a_figure_the_evidence_holds_is_never_called_invented(world):
    """The claim ledger describes what it has adapters for; the evidence ledger
    holds everything read — a nested anomaly row, an ambiguous-dot reading."""
    ctx, state = world("Có danh mục nào bất thường không?")
    _rec(state, "detect_anomaly", {"ok": True, "kind": "list", "data": {
        "chart_id": CATEGORY_CHART, "measure": "total_revenue", "anomalies": [
            {"row": {"cat": "health_beauty", "total_revenue": 1258681.34}, "value": 1258681.34}]}},
        {"chart_id": CATEGORY_CHART})
    assert _why(state, ctx, "health_beauty có doanh thu 1.258.681,34.") == []
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "measure": "avg_review", "value": 4.0864, "rows_counted": 1}}, {"chart_id": KPI})
    assert _why(state, ctx, "Điểm trung bình là 4.086.") == []


def test_a_rate_column_in_rows_is_a_proportion(world):
    ctx, state = world("Tỷ lệ hủy đơn của bang SP là bao nhiêu?", asked=("cancel_rate",))
    _rec(state, "get_chart_data", {"ok": True, "kind": "table", "data": {
        "chart_id": STATE_ORDERS_CHART, "columns": ["customer_state", "cancel_rate"],
        "rows": [["SP", 3.12], ["RJ", 4.4]]}}, {"chart_id": STATE_ORDERS_CHART})
    assert _why(state, ctx, "Tỷ lệ hủy đơn của bang SP là 3,12%.") == []


def test_a_flagged_draft_on_the_last_round_is_kept_not_emptied(monkeypatch):
    """Review round 7: a draft flagged on the LAST round was dropped and the
    answer came back empty — the reader had already seen it stream."""
    from app.services.agent_flows.runtime.strategies.tool_calling import ToolCallingStrategy

    class RT:
        is_answering = True
        view = None
        tools_offered = True
        recoveries_ignored = False

        def __init__(self):
            self.calls = 0
            self.last_reply = None

        def can_ask(self):
            return True

        def next_round_is_final(self, last=False):
            return last

        async def ask(self, system, messages, stream_text, last=False):
            self.calls += 1
            self.last_reply = type("R", (), {"text": "Bang SP chiếm 19,78%.", "tool_calls": [],
                                             "timed_out": False})()
            if False:
                yield None

        def review_draft(self, text):
            return "send it back"

    strategy = ToolCallingStrategy.__new__(ToolCallingStrategy)
    strategy.max_rounds, strategy.messages, strategy.collected, strategy.system = 1, [], "", "S"
    strategy.node = type("N", (), {"output_format": "chat"})()
    strategy._reminder = None
    monkeypatch.setattr(ToolCallingStrategy, "build_request", lambda self: None)
    rt = RT()

    async def go():
        async for _ in strategy.run(rt):
            pass
    asyncio.run(go())
    assert rt.calls == 1 and strategy.collected == "Bang SP chiếm 19,78%."


def test_a_correct_month_on_month_with_period_labels_and_a_worded_sign(world):
    """Browser, f6eb6caa: '2018-08 … 2018-07 … giảm 5.23%' — the dates were read as
    claims of 8 and 7 and the decrease (-5.23 in the evidence) did not match."""
    from app.services.dashboard_ai_bot.verifier import extract_answer_claims, verify_answer

    text = "GMV 2018-08 là 1,003,308.47 so với 2018-07 là 1,058,728.03, giảm 5.23% (tháng 08/2018)."
    assert [v for v, _ in extract_answer_claims(text)] == [1003308.47, 1058728.03, 5.23]
    assert verify_answer(text, [1003308.47, 1058728.03, -5.23]).unmatched == []
    ctx, state = world(MOM_Q, asked=("gmv",))
    res = _compare(1003308.47, 1058728.03, -5.23)
    # FIXTURE DATA FIX (declared): 1,003,308.47 is 2018-08 and 1,058,728.03 is
    # 2018-07, as the text says; the helper's default labels were a month off.
    res["data"]["current"]["label"], res["data"]["baseline"]["label"] = "2018-08", "2018-07"
    _rec(state, "compare_periods", res, {"chart_id": MONTHLY})
    assert _why(state, ctx, text) == []


def test_the_reader_note_goes_before_the_follow_up_lines():
    """Live D2: the note was appended after [FOLLOWUP] lines and cut off with them."""
    text = "Tổng doanh thu là 13.591.643,70.\n[FOLLOWUP] Doanh thu theo danh mục?\n[FOLLOWUP] Theo tháng?"
    out = CC.with_reader_note(text, "⚠️ Số của toàn bộ báo cáo: 13,591,643.7")
    body = out.split("[FOLLOWUP]")[0]
    assert "⚠️ Số của toàn bộ báo cáo" in body and out.count("[FOLLOWUP]") == 2
    assert CC.with_reader_note("Không có số.", "") == "Không có số."


# ── acceptance: withheld figures, direction ──────────────────────────────────

def test_redact_withholds_only_the_flagged_figure():
    text = "Tổng 13.591.643,70; bang SP chiếm 19,78% và RJ 12,1%."
    out = CC.redact(text, [{"value": 19.78, "pct": True, "why": "other_dimension"}], "vi")
    assert "19,78" not in out and "13.591.643,70" in out and "12,1%" in out
    en = CC.redact("SP holds 19.78%.", [{"value": 19.78, "pct": True}], "en")
    assert en == "SP holds [withheld: not verified]."
    assert CC.redact("x 5", [], "vi") == "x 5"


def test_a_decrease_stated_as_an_increase_is_flagged(world):
    ctx, state = world(MOM_Q, asked=("gmv",))
    _rec(state, "compare_periods", _compare(1003308.47, 1058728.03, -5.23), {"chart_id": MONTHLY})
    assert (5.23, "wrong_direction") in _why(state, ctx, "GMV tháng 8 tăng 5,23% so với tháng 7.")
    assert _why(state, ctx, "GMV tháng 8 giảm 5,23% so với tháng 7.") == []


# ── acceptance: a figure of another period (or of all time) ──────────────────

def test_an_all_time_total_given_as_one_quarters_figure_is_flagged(world):
    """Acceptance g4_q4_vs_q3_r67: the all-time total was given for BOTH quarters."""
    ctx, state = world("Doanh thu quý 4/2017 so với quý 3/2017 thế nào?")
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    text = "Doanh thu quý 4/2017 là 13,591,643.7 và quý 3/2017 cũng là 13,591,643.7."
    assert (13591643.7, "wrong_period") in _why(state, ctx, text)


def test_an_all_time_total_framed_as_the_overall_total_is_left_alone(world):
    ctx, state = world("Doanh thu quý 4/2017 là bao nhiêu?")
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    text = "Báo cáo không tách theo quý; tổng doanh thu toàn bộ báo cáo là 13,591,643.7."
    assert _why(state, ctx, text) == []


def test_without_a_named_period_a_total_is_not_a_period_claim(world):
    ctx, state = world("Tổng doanh thu là bao nhiêu?")
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    assert _why(state, ctx, "Tổng doanh thu là 13,591,643.7.") == []


def test_periods_are_read_as_written():
    assert CC._periods("Tỷ lệ giao đúng hẹn tháng 3/2018?") == {("m", 2018, 3)}
    assert CC._periods("quý 4/2017 so với quý 3/2017") == {("q", 2017, 4), ("q", 2017, 3)}
    assert CC._periods("GMV tháng 11 năm 2017") == {("m", 2017, 11)}
    assert CC._periods("Bang nào cao nhất?") == set()


def test_a_change_worked_out_from_two_stated_figures_is_checked_by_arithmetic(world):
    """A correct percentage the model computed from two figures it states and the
    tools read is not "invented"; a wrong one still is.

    DECLARED FIXTURE CHANGE (lineage, not numeric match): the two figures are now
    the two MONTHS' rows. They used to be two whole-report `total_measure` values
    with no period — whose difference arithmetic cannot prove is between the two
    months asked; that shape is the negative control below."""
    ctx, state = world(MOM_Q, asked=("gmv",))
    _months(state)
    good = "GMV tháng 1/2018 là 1,107,301.89, tháng 12/2017 là 863,547.10: tăng 28.23%."
    assert _why(state, ctx, good) == []
    bad = "GMV tháng 1/2018 là 1,107,301.89, tháng 12/2017 là 863,547.10: tăng 31.5%."
    assert (31.5, "unsupported") in _why(state, ctx, bad)


# ── acceptance journeys: two correct answers that were withheld ─────────────

def test_a_change_between_the_asked_periods_is_not_another_periods_figure(world):
    """J9 (coordinator): the lane's correct -5.23% was flagged wrong_period."""
    ctx, state = world("GMV tháng 8/2018 so với tháng 7/2018 thay đổi bao nhiêu phần trăm?", asked=("gmv",))
    res = _compare(1003308.47, 1058728.03, -5.23)
    res["data"]["current"]["label"], res["data"]["baseline"]["label"] = "2018-08", "2018-07"
    _rec(state, "compare_periods", res, {"chart_id": MONTHLY})
    assert _why(state, ctx, "GMV tháng 8/2018 giảm 5.23% so với tháng 7/2018.") == []


def test_a_change_between_other_periods_is_flagged(world):
    """J4 / acceptance: a Skill compared 2018-09 with 2018-08 for a Jan/Dec question."""
    ctx, state = world("GMV tháng 1/2018 so với tháng 12/2017 thay đổi bao nhiêu phần trăm?", asked=("gmv",))
    res = _compare(1003308.47, 1058728.03, -5.23)
    res["data"]["current"]["label"], res["data"]["baseline"]["label"] = "2018-08", "2018-07"
    _rec(state, "compare_periods", res, {"chart_id": MONTHLY})
    assert (5.23, "wrong_period") in _why(state, ctx, "GMV tháng 1/2018 giảm 5.23% so với tháng 12/2017.")


def test_a_definition_word_does_not_make_a_measure_asked(monkeypatch):
    """J14 follow-up: "Nó chiếm bao nhiêu phần trăm?" matched metrics by DEFINITION."""
    from types import SimpleNamespace

    from app.services.agent_flows.tools.packs import discover as D

    monkeypatch.setattr(D, "tool_search_business_assets", lambda ctx, a: {"ok": True, "data": {"results": [
        {"type": "metric", "id": "ty_le_giao_dung_hen", "name": "Tỷ lệ giao đúng hẹn",
         "detail": "Phần trăm đơn giao đúng hẹn, chiếm trong tổng đơn đã giao."}]}})
    monkeypatch.setattr(D, "_vocabulary", lambda ctx, ident, kind: [ident])
    ctx = SimpleNamespace(question="Nó chiếm bao nhiêu phần trăm?")
    assert CC._question_measures(ctx, ctx.question) == set()
    ctx2 = SimpleNamespace(question="Tỷ lệ giao đúng hẹn là bao nhiêu phần trăm?")
    assert CC._question_measures(ctx2, ctx2.question), "the named measure is still found"


# ── acceptance checkpoint (dc618ba0): three more correct answers withheld ────

def _value(state, v, measure):
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "value": v, "measure": measure}}, {"chart_id": KPI})


def test_a_difference_of_two_stated_figures_is_checked_by_arithmetic(world):
    ctx, state = world("GMV lớn hơn doanh thu sản phẩm bao nhiêu?", asked=("gmv", "total_revenue"))
    _value(state, 15843553.24, "dataset_table_438.gmv")
    _value(state, 13591643.7, "dataset_table_438.total_revenue")
    good = "GMV 15,843,553.24 trừ doanh thu 13,591,643.70 là 2,251,909.54."
    assert _why(state, ctx, good) == []
    bad = "GMV 15,843,553.24 trừ doanh thu 13,591,643.70 là 2,241,909.54."
    assert (2241909.54, "unsupported") in _why(state, ctx, bad), "a subtraction error stays withheld"


def test_a_follow_up_does_not_borrow_the_previous_answers_figures(world):
    """Review: history figures let any earlier figure be re-attributed (and a
    public client supplies the history). A follow-up must re-read what it states."""
    ctx, state = world("Còn bang RJ thì sao?")
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    assert (41746.0, "unsupported") in _why(state, ctx, "SP có 41,746 đơn như đã nói.")


def test_a_rates_value_per_period_is_a_proportion(world):
    ctx, state = world("Tỷ lệ giao đúng hẹn tháng 3/2018 so với tháng 2/2018?", asked=("on_time_rate",))
    res = _compare(78.64, 84.0, -5.36)
    res["data"]["measure"] = "dataset_table_437.on_time_rate"
    res["data"]["current"]["label"], res["data"]["baseline"]["label"] = "2018-03", "2018-02"
    _rec(state, "compare_periods", res, {"chart_id": MONTHLY})
    text = "Tháng 3/2018 là 78.64%, tháng 2/2018 là 84.0% — giảm 5.36 điểm phần trăm."
    assert _why(state, ctx, text) == []


def test_a_figure_stated_when_nothing_was_read_is_withheld(world):
    """Acceptance t_zero_ontime: the only data call was refused (empty ledger) and
    an invented 89.48% for September 2016 was published."""
    ctx, state = world("Tỷ lệ giao đúng hẹn tháng 9/2016 là bao nhiêu?", asked=("on_time_rate",))
    assert (89.48, "unsupported") in _why(state, ctx, "Tỷ lệ giao đúng hẹn là 89.48%, trên 23 đơn.")
    assert _why(state, ctx, "Báo cáo không có số liệu cho tháng 9/2016.") == []


# ── adversarial review round ────────────────────────────────────────────────

def test_redact_hides_a_percentage_written_in_words_and_spares_labels():
    out = CC.redact("Tỷ lệ tháng 3/2018 là 91,89 phần trăm [chart:3].", [{"value": 91.89, "pct": True}])
    assert "91,89" not in out and "3/2018" in out and "[chart:3]" in out
    out = CC.redact("Tháng 3/2018 có 3 đơn.", [{"value": 3.0, "pct": False}])
    assert "3/2018" in out


def test_overall_words_are_whole_words(world):
    ctx, state = world("Doanh thu quý 4/2017 là bao nhiêu?")
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    for text in ("Nhìn chung, doanh thu quý 4/2017 là 13,591,643.7.",
                 "Doanh thu quý 4/2017 là 13,591,643.7 (số liệu đã kiểm chứng)."):
        assert (13591643.7, "wrong_period") in _why(state, ctx, text), text


def test_a_share_of_withheld_figures_is_withheld(world):
    ctx, state = world("Doanh thu quý 4/2017 chiếm bao nhiêu phần trăm tổng?")
    _value(state, 13591643.7, "dataset_table_438.total_revenue")
    _value(state, 3397910.93, "dataset_table_438.total_revenue")
    text = "Quý 4/2017 là 3,397,910.93 trên tổng 13,591,643.70, tức 25%."
    assert (25.0, "unsupported") in _why(state, ctx, text)


def test_a_worked_out_change_in_the_wrong_direction_is_withheld(world):
    ctx, state = world(MOM_Q, asked=("gmv",))
    _months(state)                       # declared fixture change: rows, not unscoped values
    assert (28.23, "unsupported") in _why(state, ctx, "Tháng này 1,107,301.89, tháng trước 863,547.10: giảm 28.23%.")
    assert _why(state, ctx, "Tháng này 1,107,301.89, tháng trước 863,547.10: tăng 28.23%.") == []


def test_same_period_last_year_is_not_month_on_month(world):
    from app.services.time_semantics import comparison_baseline

    assert comparison_baseline("tháng 3/2018 so với cùng kỳ năm trước", ("m", 2018, 3)) == ("m", 2017, 3)
    assert comparison_baseline("tháng 3/2018 so với tháng trước", ("m", 2018, 3)) == ("m", 2018, 2)
    ctx, state = world("GMV tháng 3/2018 so với cùng kỳ năm trước thay đổi bao nhiêu?", asked=("gmv",))
    res = _compare(1000.0, 1100.0, -9.09)
    res["data"]["current"]["label"], res["data"]["baseline"]["label"] = "2018-03", "2018-02"
    _rec(state, "compare_periods", res, {"chart_id": MONTHLY})
    assert (9.09, "wrong_period") in _why(state, ctx, "GMV tháng 3/2018 giảm 9.09% so với cùng kỳ.")


def test_a_read_filtered_to_the_period_is_that_periods_figure(world):
    ctx, state = world("Doanh thu tháng 3/2018 là bao nhiêu?")
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "value": 1160785.48, "measure": "dataset_table_438.total_revenue",
        "filters_applied": [{"field": "year_month", "op": "in", "values": ["2018-03"]}]}}, {"chart_id": KPI})
    assert _why(state, ctx, "Doanh thu tháng 3/2018 là 1,160,785.48.") == []


def test_periods_named_together_share_their_year():
    assert CC._periods("tháng 3 và tháng 4 năm 2018") == {("m", 2018, 3), ("m", 2018, 4)}
    assert CC._periods("Q4 2017 vs Q3") == {("q", 2017, 4), ("q", 2017, 3)}
    assert CC._periods("Doanh thu Việt Nam 2018") == set()


def test_a_worked_out_change_never_replaces_the_computed_one(world):
    """Browser, link 39 (run 3786): compare_periods gave -5.23%; the answer listed
    July then August and published "tăng 5.52%" — the reversed baseline."""
    ctx, state = world("GMV tháng 8/2018 so với tháng 7/2018 thay đổi bao nhiêu phần trăm?", asked=("gmv",))
    res = _compare(1003308.47, 1058728.03, -5.23)
    res["data"]["current"]["label"], res["data"]["baseline"]["label"] = "2018-08", "2018-07"
    _rec(state, "compare_periods", res, {"chart_id": MONTHLY})
    text = "Tháng 7/2018 là 1,058,728.03, tháng 8/2018 là 1,003,308.47: tăng 5.52%."
    assert (5.52, "unsupported") in _why(state, ctx, text)
    assert _why(state, ctx, "Tháng 7/2018 là 1,058,728.03, tháng 8/2018 là 1,003,308.47: giảm 5.23%.") == []


def test_a_refusal_detail_dict_is_never_a_reader_sentence():
    from app.services.agent_flows.runtime.handlers.data import _why

    assert _why({"ok": False, "error_code": "dimension_mismatch", "error": "x",
                 "detail": {"requested_dimension": "a", "charts_with_dimension": [686]}}) == ""
    assert _why({"ok": False, "error": "failed to load", "detail": {"k": 1}}) == "failed to load"
    assert _why({"ok": False, "error": "e", "detail": "column x missing"}) == "column x missing"


# ── production pilot round: reversed baseline from the tool itself ───────────

def test_a_tool_change_measured_backwards_is_withheld(world):
    """Acceptance run 4176: compare_periods called with period_a=Q3, period_b=Q4;
    the tool reported -29.85% (Q4 → Q3) and it was published for "Q4 so với Q3"."""
    ctx, state = world("Doanh thu quý 4/2017 so với quý 3/2017 tăng hay giảm bao nhiêu phần trăm?")
    res = _compare(1696404.85, 2418404.97, -29.85)
    res["data"]["measure"] = "dataset_table_438.total_revenue"
    res["data"]["current"]["label"], res["data"]["baseline"]["label"] = "2017-Q3", "2017-Q4"
    _rec(state, "compare_periods", res, {"chart_id": MONTHLY})
    assert (29.85, "wrong_period") in _why(state, ctx, "Doanh thu giảm 29.85% so với quý trước.")


def test_the_same_change_measured_forwards_is_published(world):
    ctx, state = world("Doanh thu quý 4/2017 so với quý 3/2017 tăng hay giảm bao nhiêu phần trăm?")
    res = _compare(2418404.97, 1696404.85, 42.56)
    res["data"]["measure"] = "dataset_table_438.total_revenue"
    res["data"]["current"]["label"], res["data"]["baseline"]["label"] = "2017-Q4", "2017-Q3"
    _rec(state, "compare_periods", res, {"chart_id": MONTHLY})
    assert _why(state, ctx, "Doanh thu quý 4/2017 tăng 42.56% so với quý 3/2017.") == []


# ── production pilot round: the sentence says whose figure it is ─────────────

def _states(ctx, state):
    _rec(state, "rank_values", derived.tool_rank_values(ctx, {"chart_id": STATE_ORDERS_CHART, "n": 5}),
         {"chart_id": STATE_ORDERS_CHART})


def test_one_members_figure_given_to_a_member_named_in_words_is_withheld(world):
    """Acceptance run 4245: SP's figure published as Minas Gerais's."""
    ctx, state = world("Bang Minas Gerais có bao nhiêu đơn hàng?", asked=("order_count",))
    _states(ctx, state)
    assert (41746.0, "other_member") in _why(state, ctx, "Bang Minas Gerais có 41,746 đơn hàng.")


def test_a_members_figure_named_with_its_data_label_is_published(world):
    ctx, state = world("Bang Minas Gerais có bao nhiêu đơn hàng?", asked=("order_count",))
    _states(ctx, state)
    assert _why(state, ctx, "Bang Minas Gerais (MG) có 11,635 đơn hàng.") == []
    assert _why(state, ctx, "MG có 11,635 đơn hàng.") == []


def test_the_whole_total_given_to_the_asked_member_is_withheld_but_framed_as_whole_is_not(world):
    """Acceptance runs 4465/4507: the report total published as SP's revenue."""
    ctx, state = world("Bang SP có bao nhiêu đơn hàng?", asked=("order_count",))
    _value(state, 99441.0, "dataset_table_437.order_count")
    assert (99441.0, "whole_as_member") in _why(state, ctx, "Bang SP có 99,441 đơn hàng.")
    assert _why(state, ctx, "Báo cáo không tách theo bang; tổng số đơn của toàn báo cáo là 99,441.") == []


def test_the_asked_member_phrase_is_read_from_the_question():
    from types import SimpleNamespace

    ctx = SimpleNamespace(allowed_chart_ids={686}, chart_meta={686: {
        "name": "Olist · Doanh thu theo danh mục",
        "fields": {"dimensions": [{"field": "dataset_table_445.product_category_name_english"}]}}})
    t = {"dimension": "product_category_name_english"}
    got = CC._asked_member(ctx, t, "Danh mục đồ giường và phòng tắm (bed bath table) có doanh thu bao nhiêu?")
    assert got == ["dogiuongvaphongtam", "bedbathtable"]


def test_a_stray_figure_given_a_named_period_is_withheld(world):
    """Acceptance runs 4216 / 4368: "GMV tháng 12/2017 là 19.62" — 19.62 was read
    somewhere (a tool with no claim adapter), never as December's GMV."""
    ctx, state = world("GMV tháng 1/2018 so với tháng 12/2017 thay đổi bao nhiêu phần trăm?", asked=("gmv",))
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    state.add_evidence({"score": 19.62})         # READ, but described by no claim adapter
    assert 19.62 in (getattr(state, "evidence", None) or []), "fixture: the figure is in evidence"
    assert (19.62, "unsupported") in _why(state, ctx, "GMV của tháng 12/2017 là 19.62.")
    assert _why(state, ctx, "Một chỉ số phụ trong dữ liệu là 19.62.") == [],         "no period or member given: still 'read, meaning unknown'"


def test_the_same_periods_real_figure_is_published(world):
    ctx, state = world("GMV tháng 1/2018 so với tháng 12/2017 thay đổi bao nhiêu phần trăm?", asked=("gmv",))
    res = _compare(1107301.89, 863547.23, 28.23)
    res["data"]["current"]["label"], res["data"]["baseline"]["label"] = "2018-01", "2017-12"
    _rec(state, "compare_periods", res, {"chart_id": MONTHLY})
    state.add_evidence({"score": 19.62})
    assert _why(state, ctx, "GMV tháng 12/2017 là 863,547.23, tháng 1/2018 là 1,107,301.89: tăng 28.23%.") == []


# ── production pilot round: correct figures that were withheld ───────────────

def test_a_members_count_answers_a_question_about_that_member(world):
    """Acceptance (5 runs): 96,478 delivered orders withheld as other_measure."""
    ctx, state = world("Có bao nhiêu đơn ở trạng thái đã giao (delivered)?", asked=("delivered_orders",))
    _rec(state, "rank_values", {"ok": True, "kind": "ranking", "data": {
        "chart_id": 685, "measure": "dataset_table_437.order_count", "dimension": "dataset_table_437.order_status",
        "items": [{"label": "delivered", "value": 96478.0}, {"label": "shipped", "value": 1107.0}]}},
        {"chart_id": 685})
    assert _why(state, ctx, "Có 96,478 đơn ở trạng thái delivered.") == []
    assert (1107.0, "other_measure") in _why(state, ctx, "Có 1,107 đơn đã giao."), \
        "another member's count is still not the asked member's"


def test_the_complement_of_a_supported_rate_is_published_and_of_an_unsupported_one_is_not(world):
    """Acceptance runs 4072/4309: late 8.11% = 100% − 91.89% on-time, withheld."""
    ctx, state = world("Tỷ lệ giao trễ là bao nhiêu?", asked=("on_time_rate",))
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "value": 91.89, "measure": "dataset_table_437.on_time_rate"}}, {"chart_id": KPI})
    assert _why(state, ctx, "Tỷ lệ giao đúng hẹn là 91.89%, nên tỷ lệ giao trễ là 8.11%.") == []
    assert (8.11, "unsupported") in _why(state, ctx, "Tỷ lệ A là 91.5%, nên tỷ lệ B là 8.11%.") or \
        (91.5, "unsupported") in _why(state, ctx, "Tỷ lệ A là 91.5%, nên tỷ lệ B là 8.11%.")


def test_a_rate_measures_member_value_is_a_proportion(world):
    """Acceptance run 3935: a correct 78.64% from a member list was withheld."""
    ctx, state = world("Tỷ lệ giao đúng hẹn tháng 3/2018 là bao nhiêu?", asked=("on_time_rate",))
    _rec(state, "rank_values", {"ok": True, "kind": "ranking", "data": {
        "chart_id": 712, "measure": "dataset_table_437.on_time_rate",
        "dimension": "dataset_table_437__order_purchase_date__date_dim.year_month",
        "items": [{"label": "2018-03", "value": 78.6377}, {"label": "2018-02", "value": 84.0}]}},
        {"chart_id": 712})
    assert _why(state, ctx, "Tỷ lệ giao đúng hẹn tháng 3/2018 là 78.64%.") == []


# ── live at df54303b: the asked member without a cue word ────────────────────

def test_a_proper_noun_in_the_question_is_the_asked_member(world):
    """Live runs 4707/4742/4770: the delivered count and the report total
    published as São Paulo's for "São Paulo có bao nhiêu đơn hàng?"."""
    ctx, state = world("São Paulo có bao nhiêu đơn hàng?", asked=("order_count",))
    _value(state, 99441.0, "dataset_table_437.order_count")
    assert (99441.0, "whole_as_member") in _why(state, ctx, "Số đơn hàng tại São Paulo là 99,441.")
    assert _why(state, ctx, "Báo cáo không tách theo bang; tổng số đơn là 99,441.") == []


def test_a_report_word_in_title_case_is_not_a_member(world):
    ctx, state = world("Doanh thu của Olist là bao nhiêu?")
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    assert _why(state, ctx, "Doanh thu của Olist là 13,591,643.70.") == []


def test_a_qualifier_the_report_uses_is_the_asked_member(world):
    """Live runs 4608/4627/4676: total reviews 99,224 published as 5-star reviews."""
    ctx, state = world("Có bao nhiêu lượt đánh giá 5 sao?", asked=("review_count",))
    ctx.chart_meta[717] = {"name": "Olist · Tỷ lệ 5 sao (%) · page-5",
                           "fields": {"measures": [{"field": "dataset_table_440.pct_five_star"}], "dimensions": []}}
    _value(state, 99224.0, "dataset_table_440.review_count")
    assert (99224.0, "whole_as_member") in _why(state, ctx, "Có 99,224 lượt đánh giá 5 sao.")
    assert _why(state, ctx, "Có tổng cộng 99,224 lượt đánh giá (mọi mức sao).") == []


def test_a_follow_up_figure_given_a_period_needs_that_periods_support(world):
    """Live runs 4756/4765: "Còn tháng trước đó thì sao?" → "GMV tháng 10/2017 là 56808.84"."""
    ctx, state = world("Còn tháng trước đó thì sao?", asked=("gmv",))
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    state.add_evidence({"x": 56808.84})
    assert (56808.84, "unsupported") in _why(state, ctx, "GMV tháng 10/2017 là 56808.84.")


def test_a_metric_resolves_to_the_field_it_is_bound_to_by_its_name(monkeypatch):
    """Live df54303b: "Doanh thu sản phẩm trung bình mỗi đơn" resolved the metric
    gia_tri_don_trung_binh, but only its IDENTIFIER went to `_vocabulary`, which
    keeps identifiers as they are — so the chart field `aov` never became an asked
    measure and a correct 137.75 was withheld."""
    from types import SimpleNamespace

    from app.services.agent_flows.tools.packs import discover as D

    monkeypatch.setattr(D, "tool_search_business_assets", lambda ctx, a: {"ok": True, "data": {"results": [
        {"type": "metric", "id": "gia_tri_don_trung_binh", "name": "Giá trị đơn trung bình",
         "detail": "Doanh thu sản phẩm chia cho số đơn có hàng."}]}})
    bound = {"Giá trị đơn trung bình": ["aov"]}
    monkeypatch.setattr(D, "_vocabulary", lambda ctx, phrase, kind: [phrase] + bound.get(phrase, []))
    ctx = SimpleNamespace(question="Doanh thu sản phẩm trung bình mỗi đơn là bao nhiêu?")
    assert "aov" in CC._question_measures(ctx, ctx.question)


def test_a_seller_states_figure_is_not_the_customer_states(world):
    """Live run 4723: "Doanh thu của bang Minas Gerais" answered 1,011,564.74 —
    MG in the SELLER-state chart (get_chart_summary top_5), while the question's
    breakdown resolves to customer state; nothing in the sentence says 'seller'."""
    ctx, state = world("Doanh thu của bang Minas Gerais là bao nhiêu?")
    ctx.allowed_chart_ids.add(703)
    ctx.chart_meta[703] = {"name": "Olist · Doanh thu theo bang (người bán) · page-3", "fields": {
        "measures": [{"field": "dataset_table_438.total_revenue"}],
        "dimensions": [{"field": "dataset_table_443.seller_state"}]}}
    state.chart_dims[703] = ["dataset_table_443.seller_state"]
    summary = {"ok": True, "kind": "summary", "data": {
        "chart_id": 703, "primary_measure": "dataset_table_438.total_revenue",
        "primary_dimension": "dataset_table_443.seller_state",
        "top_5": [{"dataset_table_443.seller_state": "SP", "dataset_table_438.total_revenue": 8753396.21},
                  {"dataset_table_443.seller_state": "MG", "dataset_table_438.total_revenue": 1011564.74}]}}
    _rec(state, "get_chart_summary", summary, {"chart_id": 703})
    got = _why(state, ctx, "Doanh thu của bang Minas Gerais là 1,011,564.74.")
    assert got and got[0][0] == 1011564.74, got
    from app.services.agent_flows.runtime import claim_scope
    [row] = [e for e in claim_scope.describe("get_chart_summary", summary, chart_dims=state.chart_dims)
             if e["value"] == 1011564.74]
    assert row["member"] == "MG" and row["dimension"] == "seller_state", "a summary row keeps its member"


# ── live at 94e1db2d: relabelled member, shared cue word, follow-up period ───

def test_a_member_relabelled_as_the_asked_one_is_withheld(world):
    """Live runs 4901/4943: "Doanh thu bang Minas Gerais (SP) là 8,753,396.21"."""
    ctx, state = world("Bang Minas Gerais có bao nhiêu đơn hàng?", asked=("order_count",))
    _states(ctx, state)
    assert (41746.0, "other_member") in _why(state, ctx, "Bang Minas Gerais (SP) có 41,746 đơn hàng.")
    assert _why(state, ctx, "Bang Minas Gerais (MG) có 11,635 đơn hàng.") == []


def test_another_period_row_in_a_follow_up_is_withheld(world):
    """Live runs 4849/4874: follow-up "Còn tháng trước đó thì sao?" →
    "GMV tháng 10/2017 là 56808.84", a figure of ANOTHER month's row."""
    ctx, state = world("Còn tháng trước đó thì sao?", asked=("gmv",))
    _rec(state, "get_chart_data", {"ok": True, "kind": "table", "data": {
        "chart_id": MONTHLY, "columns": ["year_month", "gmv"],
        "rows": [["2017-01", 56808.84], ["2017-10", 769312.37], ["2017-11", 1179143.77]]}},
        {"chart_id": MONTHLY})
    assert (56808.84, "wrong_period") in _why(state, ctx, "GMV tháng 10/2017 là 56808.84.")
    assert _why(state, ctx, "GMV tháng 1/2017 là 56808.84.") == []
    assert _why(state, ctx, "GMV tháng 10/2017 là 769,312.37.") == []


def test_a_breakdown_is_named_by_what_distinguishes_it(world):
    """Live run 4907: "bang" names both the customer- and the seller-state chart."""
    from app.services.agent_flows.runtime import claim_check

    ctx, _state = world("Doanh thu của bang Minas Gerais là bao nhiêu?")
    ctx.allowed_chart_ids.add(703)
    ctx.chart_meta[703] = {"name": "Olist · Doanh thu theo bang (người bán) · page-3", "fields": {
        "measures": [{"field": "dataset_table_438.total_revenue"}],
        "dimensions": [{"field": "dataset_table_443.seller_state"}]}}
    assert not claim_check._names_dimension(ctx, "seller_state", "customer_state")
    ctx.question = "Doanh thu của người bán ở bang Minas Gerais là bao nhiêu?"
    assert claim_check._names_dimension(ctx, "seller_state", "customer_state")


def test_a_two_digit_month_is_not_also_january():
    assert CC._periods("GMV tháng 10/2017 là 56808.84.") == {("m", 2017, 10)}
    assert CC._periods("tháng 10 và tháng 11 năm 2017") == {("m", 2017, 10), ("m", 2017, 11)}


# ── live at 0abef689: list items, qualifier labels ───────────────────────────

def test_a_list_item_inherits_the_member_its_header_names(world):
    """Live 5072: "Tổng số đơn ở São Paulo …, bao gồm:" then "- Đã giao: 96,478 đơn"
    — whole-report status counts presented as São Paulo's breakdown."""
    ctx, state = world("São Paulo có bao nhiêu đơn hàng?", asked=("order_count",))
    _value(state, 96478.0, "dataset_table_437.order_count")
    text = "Số đơn hàng ở São Paulo như sau:\n- Đã giao: 96,478 đơn\n- Bị hủy: 625 đơn"
    assert (96478.0, "whole_as_member") in _why(state, ctx, text)
    other = "Báo cáo không tách theo bang. Trên toàn báo cáo:\n- Đã giao: 96,478 đơn"
    assert _why(state, ctx, other) == []


def test_the_number_of_an_asked_qualifier_is_a_label():
    """Live 4961/4986: the 5 of "lượt đánh giá 5 sao" was withheld as a figure."""
    assert CC._qualifier_numbers(["5sao"], "Không có số liệu về lượt đánh giá 5 sao.") == {5.0}
    assert CC._qualifier_numbers(["5sao"], "Có 5 lượt đánh giá.") == set()


def test_a_month_outside_the_asked_year_is_the_wrong_period(world):
    """Holdout 5653: asked the lowest month IN 2017, the series' lowest month (2016)
    was published — a month was never compared with an asked year."""
    ctx, state = world("Tháng nào trong năm 2017 có GMV thấp nhất?", asked=("gmv",))
    _rec(state, "get_chart_data", {"ok": True, "kind": "table", "data": {
        "chart_id": MONTHLY, "columns": ["year_month", "gmv"],
        "rows": [["2016-10", 19.62], ["2017-01", 56808.84], ["2017-11", 1179143.77]]}},
        {"chart_id": MONTHLY})
    assert (19.62, "wrong_period") in _why(state, ctx, "GMV thấp nhất là 19.62.")
    assert _why(state, ctx, "Tháng 1/2017 có GMV thấp nhất: 56,808.84.") == []


def _drill(state, match, value):
    from app.services.agent_flows.tools.result import normalise

    res = normalise({"ok": True, "data": {
        "chart_id": 701, "filter": {"column": "dataset_table_441.customer_state", "op": "eq", "match": match},
        "n_rows_total": 27, "n_rows_matching": 1,
        "rows": [{"dataset_table_441.customer_state": match, "dataset_table_438.total_revenue": value}],
        "totals": {"measure": "dataset_table_438.total_revenue", "sum": value, "avg": value,
                   "min": value, "max": value, "n": 1}}}, kind="table")
    state.record_evidence(res, tool="smart_drilldown",
                          args={"chart_id": 701, "column": "customer_state", "match": match})


def test_a_drilldowns_figure_is_its_members(world):
    """Browser run 6080 (ce6d6313): the correct 1,824,092.67 for RJ was withheld as
    unsupported — the ledger never described a drilldown's rows or totals. The
    same figure given to the member it was NOT filtered on is still caught."""
    from app.services.agent_flows.runtime import intent as I

    ctx, state = world("Doanh thu của khách hàng ở Rio de Janeiro là bao nhiêu?", asked=("total_revenue",))
    state.intent = {**I.empty_intent(), "source": "model", "measures": ["total_revenue"],
                    "dimension": "customer_state", "members": [{"said": "Rio de Janeiro", "code": "RJ"}]}
    _drill(state, "RJ", 1824092.67)
    assert _why(state, ctx, "Doanh thu của khách hàng ở Rio de Janeiro (RJ) là 1,824,092.67.") == []

    ctx, state = world("Doanh thu của khách hàng ở Rio de Janeiro là bao nhiêu?", asked=("total_revenue",))
    state.intent = {**I.empty_intent(), "source": "model", "measures": ["total_revenue"],
                    "dimension": "customer_state", "members": [{"said": "Rio de Janeiro", "code": "RJ"}]}
    _drill(state, "SP", 5202955.05)
    assert _why(state, ctx, "Doanh thu của khách hàng ở Rio de Janeiro (RJ) là 5,202,955.05."), \
        "SP's figure published as RJ's"



def _months(state):
    _rec(state, "get_chart_data", {"ok": True, "kind": "table", "data": {
        "chart_id": MONTHLY, "columns": ["year_month", "gmv"],
        "rows": [["2017-12", 863547.10], ["2018-01", 1107301.89]]}}, {"chart_id": MONTHLY})


def test_a_change_between_two_unscoped_figures_is_not_proven(world):
    """Negative control for lineage: two whole-report values of one measure differ
    only by a scope the ledger cannot see — arithmetic alone does not make their
    change the change between the periods the answer names."""
    ctx, state = world(MOM_Q, asked=("gmv",))
    _value(state, 1107301.89, "dataset_table_438.gmv")
    _value(state, 863547.10, "dataset_table_438.gmv")
    assert (28.23, "unsupported") in _why(
        state, ctx, "Tháng này 1,107,301.89, tháng trước 863,547.10: tăng 28.23%.")


def test_a_count_of_rows_is_never_the_denominator_of_a_measure(world):
    """Live a2d2e68b g3_rev_per_order: "13,591,643.70 trong 72 đơn hàng" = 188,772.83
    — 72 was the CATEGORY count of the ranking, described as a revenue figure."""
    ctx, state = world("Doanh thu trung bình mỗi đơn hàng là bao nhiêu?", asked=("total_revenue",))
    _rec(state, "rank_values", {"ok": True, "kind": "ranking", "data": {
        "chart_id": CATEGORY_CHART, "measure": "dataset_table_438.total_revenue",
        "dimension": "product_category_name_english", "total": 13591643.70, "group_count": 72,
        "items": [{"label": "health_beauty", "value": 1258681.34}]}}, {"chart_id": CATEGORY_CHART})
    bad = "Doanh thu trung bình mỗi đơn hàng là 188,772.83, từ tổng 13,591,643.70 trong 72 đơn hàng."
    assert (188772.83, "unsupported") in _why(state, ctx, bad)


def test_a_share_is_a_members_value_over_its_whole(world):
    """Positive and negative control for a worked-out share: SP over the report total
    in one measure stands; a label ("1" of "1 sao") over a total does not."""
    ctx, state = world(STATE_Q, asked=("order_count",))
    _states(ctx, state)
    _value(state, 99441.0, "dataset_table_437.order_count")
    assert _why(state, ctx, "SP có 41,746 trên tổng 99,441 đơn, tức 41.98%.") == []
    ctx, state = world("Tỷ lệ đánh giá 1 sao là bao nhiêu?", asked=("review_count",))
    _value(state, 99224.0, "dataset_table_440.review_count")
    assert (0.00101, "unsupported") in [(round(v, 5), w) for v, w in _why(
        state, ctx, "Tỷ lệ đánh giá 1 sao là 1/99,224, tức 0.00101%.")]


def test_a_formula_over_a_count_is_not_a_measures_figure(world):
    """Point B of the pilot brief: a formula over REFERENCED inputs is not thereby
    meaningful. revenue / the ranking's category count (72) was certified as a
    revenue figure — the count input was skipped and the other input's measure
    inherited. The same formula over two measures (revenue / orders) stands."""
    ctx, state = world("Doanh thu trung bình mỗi đơn hàng là bao nhiêu?", asked=("total_revenue",))
    _rec(state, "rank_values", {"ok": True, "kind": "ranking", "data": {
        "chart_id": CATEGORY_CHART, "measure": "dataset_table_438.total_revenue",
        "dimension": "product_category_name_english", "total": 13591643.70, "group_count": 72,
        "items": [{"label": "health_beauty", "value": 1258681.34}]}}, {"chart_id": CATEGORY_CHART})
    ref = state.claim_ledger[-1]["ref"]
    ctx.evidence_store = state.evidence_store
    bad = compute_tool.tool_compute(ctx, {"expression": "a / b", "vars": {
        "a": {"ref": ref, "path": "total"}, "b": {"ref": ref, "path": "group_count"}}})
    assert bad.get("ok"), bad
    _rec(state, "compute", bad, {})
    assert (188772.83, "invalid_lineage") in _why(state, ctx, "Doanh thu trung bình mỗi đơn là 188,772.83.")

    ctx, state = world("Doanh thu trung bình mỗi đơn hàng là bao nhiêu?", asked=("total_revenue",))
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "measure": "dataset_table_438.total_revenue", "value": 13591643.70}}, {"chart_id": KPI})
    ref_a = state.claim_ledger[-1]["ref"]
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "measure": "dataset_table_437.order_count", "value": 99441}}, {"chart_id": KPI})
    ref_b = state.claim_ledger[-1]["ref"]
    ctx.evidence_store = state.evidence_store
    good = compute_tool.tool_compute(ctx, {"expression": "a / b", "vars": {
        "a": {"ref": ref_a, "path": "value"}, "b": {"ref": ref_b, "path": "value"}}})
    _rec(state, "compute", good, {})
    assert _why(state, ctx, "Doanh thu trung bình mỗi đơn là 136.68.") == []


def test_a_number_in_a_discovery_result_is_not_a_figures_support(world):
    """Live a2d2e68b run 7047: the only data call failed; "89.48%" for March 2018 was
    published because the number sat in a resolve_chart_candidates payload."""
    ctx, state = world("Tỷ lệ giao đúng hẹn tháng 3/2018 là bao nhiêu?", asked=("on_time_rate",))
    _rec(state, "resolve_chart_candidates", {"ok": True, "kind": "list", "data": {
        "candidates": [{"chart_id": KPI, "preview_value": 89.48, "measure_match": True}]}}, {})
    assert (89.48, "unsupported") in _why(state, ctx, "Tỷ lệ giao đúng hẹn tháng 3/2018 là 89.48%.")


def _intent(**kw):
    from app.services.agent_flows.runtime import intent as I

    return {**I.empty_intent(), "source": "model", **kw}


def test_a_whole_figure_is_not_the_breakdown_that_was_asked(world):
    """Live a2d2e68b 6616/6667: the all-time average given "theo từng tháng", the
    report total given "theo bang"; the breakdown was never read."""
    ctx, state = world("Doanh thu theo bang của người bán là bao nhiêu?", asked=("total_revenue",))
    state.intent = _intent(measures=["total_revenue"], dimension="seller_state")
    _value(state, 13591643.7, "dataset_table_438.total_revenue")
    assert (13591643.7, "whole_as_breakdown") in _why(
        state, ctx, "Tổng doanh thu của người bán theo bang là 13,591,643.7.")
    # Framed as the whole report it is true, and stands.
    assert _why(state, ctx, "Báo cáo không chia theo bang người bán; doanh thu toàn bộ báo cáo "
                            "là 13,591,643.7.") == []
    ctx, state = world("Điểm đánh giá trung bình theo từng tháng thế nào?", asked=("avg_review_score",))
    state.intent = _intent(measures=["avg_review_score"], dimension="year_month")
    _value(state, 4.0864, "dataset_table_440.avg_review_score")
    assert (4.0864, "whole_as_breakdown") in _why(
        state, ctx, "Điểm đánh giá trung bình theo từng tháng là 4.0864.")


def test_a_delivered_breakdown_still_answers(world):
    """Positive control: the months were read, so a month's figure stands."""
    ctx, state = world("GMV theo từng tháng thế nào?", asked=("gmv",))
    state.intent = _intent(measures=["gmv"], dimension="year_month")
    _months(state)
    assert _why(state, ctx, "GMV tháng 1/2018 là 1,107,301.89.") == []


def test_a_rank_answer_carries_a_members_figure_not_the_total(world):
    """Live a2d2e68b/a7354461 link 39: "Bang có doanh thu cao nhất là bang tương ứng với
    tổng doanh thu là 13,591,643.7" — the report total given as the top state's
    value, although the state breakdown WAS read. Controls: the top member's own
    figure stands; the total framed as the population stands."""
    ctx, state = world("Bang nào có nhiều đơn hàng nhất?", asked=("order_count",))
    _states(ctx, state)
    _value(state, 99441.0, "dataset_table_437.order_count")
    assert (99441.0, "whole_as_member") in _why(
        state, ctx, "Bang có nhiều đơn hàng nhất là bang tương ứng với tổng số đơn là 99,441.")
    assert _why(state, ctx, "SP có nhiều đơn hàng nhất với 41,746 đơn.") == []
    assert _why(state, ctx, "SP dẫn đầu với 41,746 đơn, trên tổng 99,441 đơn.") == []


def test_a_total_is_never_the_per_unit_average(world):
    """Live a7354461 g3_rev_per_order: "Doanh thu sản phẩm trung bình mỗi đơn là
    13,591,643.70" — the total given as the per-order average. Controls: an average
    measure framed as an average stands; the total in its own clause stands."""
    ctx, state = world("Doanh thu trung bình mỗi đơn là bao nhiêu?", asked=("total_revenue", "aov"))
    _value(state, 13591643.70, "dataset_table_438.total_revenue")
    _value(state, 137.75, "dataset_table_438.aov")
    assert (13591643.7, "aggregation_mismatch") in _why(
        state, ctx, "Doanh thu sản phẩm trung bình mỗi đơn là 13,591,643.70.")
    assert _why(state, ctx, "Giá trị đơn trung bình (AOV) là 137.75.") == []
    assert _why(state, ctx, "Tổng doanh thu là 13,591,643.70.") == []


def _five_star(state):
    from app.services.agent_flows.runtime import intent as I

    state.intent = {**I.empty_intent(), "source": "model", "measures": ["review_count"],
                    "dimension": "review_score", "members": [{"said": "5 sao", "code": "5"}]}
    _rec(state, "share_of", {"ok": True, "kind": "value", "data": {
        "chart_id": 720, "measure": "dataset_table_440.review_count",
        "dimension": "dataset_table_440.review_score", "item": "5", "value": 57328.0,
        "rank": 1, "group_count": 5, "total": 99224.0, "share_pct": 57.78}}, {"chart_id": 720})
    _rec(state, "share_of", {"ok": True, "kind": "value", "data": {
        "chart_id": 720, "measure": "dataset_table_440.review_count",
        "dimension": "dataset_table_440.review_score", "item": "1", "value": 11424.0,
        "rank": 3, "group_count": 5, "total": 99224.0, "share_pct": 11.51}}, {"chart_id": 720})


def test_a_one_character_resolved_code_is_the_asked_member(world):
    """Live 3ac706e6 run 7208: review score "5" was dropped by the two-character floor
    meant for spoken words; the correct 57,328 was withheld as another member's.
    Control: the 1-star count given as the 5-star count is still caught."""
    ctx, state = world("Có bao nhiêu lượt đánh giá 5 sao?", asked=("review_count",))
    _five_star(state)
    assert _why(state, ctx, "Có tổng cộng 57,328 lượt đánh giá 5 sao.") == []
    assert _why(state, ctx, "Có tổng cộng 11,424 lượt đánh giá 5 sao.")


def test_a_qualifier_the_question_names_is_a_label(world):
    """Live 3ac706e6 run 7247: asked about SP's 5-star rate, the "5" of "5 sao" was
    withheld as an unsupported figure."""
    ctx, state = world("Tỷ lệ đánh giá 5 sao của bang SP là bao nhiêu?", asked=("pct_five_star",))
    _rec(state, "share_of", {"ok": True, "kind": "value", "data": {
        "chart_id": 724, "measure": "dataset_table_440.pct_five_star",
        "dimension": "dataset_table_441.customer_state", "item": "SP", "value": 60.29,
        "rank": 2, "group_count": 27}}, {"chart_id": 724})
    assert (5.0, "unsupported") not in _why(state, ctx, "Tỷ lệ đánh giá 5 sao của bang SP là 60.29.")


def test_two_measures_called_equal_that_the_evidence_says_are_not(world):
    """Live 85fc3626 g3_gmv_minus_rev: "GMV và doanh thu sản phẩm đều có giá trị bằng
    nhau là 13,591,643.70" — revenue's figure also claimed as GMV (15,843,553.24 was
    read). Controls: the two figures stated apart stand; their difference stands."""
    ctx, state = world("GMV lớn hơn doanh thu sản phẩm bao nhiêu?", asked=("gmv", "total_revenue"))
    _value(state, 15843553.24, "dataset_table_438.gmv")
    _value(state, 13591643.70, "dataset_table_438.total_revenue")
    assert _why(state, ctx, "GMV và doanh thu sản phẩm đều có giá trị bằng nhau là 13,591,643.70.")
    assert _why(state, ctx, "GMV là 15,843,553.24 và doanh thu sản phẩm là 13,591,643.70.") == []
    # Existing contract: a worked-out figure shows its operands.
    assert _why(state, ctx, "GMV (15,843,553.24) lớn hơn doanh thu sản phẩm (13,591,643.70) "
                            "là 2,251,909.54.") == []


def test_shares_of_one_whole_add_up(world):
    """Live 85fc3626 g3_top3_share: the top three categories' combined 25.76% was
    withheld (sums of ratios were refused). Shares of ONE whole add; a wrong sum is
    still flagged."""
    ctx, state = world("Top 3 danh mục chiếm bao nhiêu phần trăm doanh thu?", asked=("total_revenue",))
    for item, v, pct in (("health_beauty", 1258681.34, 9.26), ("watches_gifts", 1205005.68, 8.87),
                         ("bed_bath_table", 1036988.68, 7.63)):
        _rec(state, "share_of", {"ok": True, "kind": "value", "data": {
            "chart_id": CATEGORY_CHART, "measure": "dataset_table_438.total_revenue",
            "dimension": "dataset_table_445.product_category_name_english", "item": item,
            "value": v, "share_pct": pct, "total": 13591643.70, "group_count": 72}},
            {"chart_id": CATEGORY_CHART})
    good = "Top 3 chiếm 25.76%: health_beauty 9.26%, watches_gifts 8.87%, bed_bath_table 7.63%."
    assert (25.76, "unsupported") not in _why(state, ctx, good)
    assert (30.1, "unsupported") in _why(state, ctx, good.replace("25.76%", "30.1%"))


def test_a_grouped_charts_mean_is_the_per_group_average(world):
    """Live 774b3341 run 7612: "Trung bình mỗi bang có bao nhiêu đơn hàng?" — the
    summary's avg over the states (3,683 = 99,441 / 27) was described as a whole
    figure of order_count and withheld as a sum called an average. Control: the same
    summary's TOTAL called the per-state average is still flagged."""
    ctx, state = world("Trung bình mỗi bang có bao nhiêu đơn hàng?", asked=("order_count",))
    pack = _pack(STATE_ORDERS_CHART, "Số đơn theo bang", STATE_COLS, STATE_ROWS)
    _rec(state, "get_chart_summary", pack, {"chart_id": STATE_ORDERS_CHART})
    mean = sum(r[1] for r in STATE_ROWS) / len(STATE_ROWS)
    total = sum(r[1] for r in STATE_ROWS)
    assert _why(state, ctx, f"Trung bình mỗi bang có {mean:,.2f} đơn hàng.") == []
    assert (float(total), "aggregation_mismatch") in _why(
        state, ctx, f"Trung bình mỗi bang có {total:,} đơn hàng.")


def test_a_measures_words_are_never_the_member_asked_about(world):
    """Live 3bf8e3f3 P0 (g8_refuse_then_orders, 5 of 10 runs): "Vậy theo số đơn hàng
    thì bang nào nhiều nhất?" — "số" was a cue of customer_state ("Số đơn theo
    bang"), "đơn hàng" became the state asked about, and SP's correct 41,746 was
    withheld as another member's; the answer fell back to the previous refusal.
    The report's own single-value tile "Số đơn hàng" makes those words a measure's.
    Controls: a real member after the real cue is still read, and another state's
    figure given to it is still flagged."""
    ctx, state = world("Vậy theo số đơn hàng thì bang nào nhiều nhất?", asked=("order_count",))
    ctx.allowed_chart_ids.add(680)
    ctx.chart_meta[680] = {"name": "Olist · Số đơn hàng · page-1",
                           "fields": {"measures": [{"field": "dataset_table_437.order_count"}], "dimensions": []}}
    _rec(state, "rank_values", {"ok": True, "kind": "ranking", "data": {
        "chart_id": STATE_ORDERS_CHART, "measure": "dataset_table_437.order_count",
        "dimension": "dataset_table_441.customer_state", "order": "desc", "total": 69613.0, "group_count": 4,
        "items": [{"label": "SP", "value": 41746.0, "rank": 1}, {"label": "RJ", "value": 12852.0, "rank": 2}]}},
        {"chart_id": STATE_ORDERS_CHART})
    assert _why(state, ctx, "Theo số đơn hàng, SP là bang nhiều nhất với 41,746 đơn hàng.") == []
    t = {"member": None, "measures": ["order_count"], "dimension": "customer_state", "intent": {}}
    assert CC._asked_member(ctx, t, "Số đơn của bang Minas Gerais là bao nhiêu?") == ["minasgerais", "mg"]
    ctx.question = "Số đơn của bang Minas Gerais là bao nhiêu?"
    assert (12852.0, "other_member") in _why(state, ctx, "Bang Minas Gerais có 12,852 đơn.")


def test_a_change_over_a_suspected_incomplete_edge_needs_its_caveat(world):
    """Live 3bf8e3f3 (P0 g6, run 8117): "GMV tháng gần nhất 2018-09 giảm 99,98%" over
    a month of 16 orders (none delivered) — the tool's note that the edge may be
    incomplete was dropped. Controls: the same change WITH the caveat stands, the
    observed value alone stands, and the month-on-month over the two complete months
    before it (which does not stand on the edge) is untouched."""
    ctx, state = world(MOM_Q, asked=("gmv",))
    edge = {"ok": True, "kind": "comparison", "data": {
        "chart_id": MONTHLY, "measure": "dataset_table_438.gmv",
        "current": {"label": "2018-09", "value": 166.46},
        "baseline": {"label": "2018-08", "value": 1003308.47},
        "delta": -1003142.01, "pct_change": -99.98, "verdict": "worsening",
        "edge_period": "2018-09", "edge_completeness": "suspected_incomplete",
        "observed_latest": {"label": "2018-09", "value": 166.46}}}
    _rec(state, "compare_periods", edge, {"chart_id": MONTHLY, "mode": "custom"})
    bare = "GMV tháng 2018-09 giảm 99,98% so với tháng 2018-08."
    assert (99.98, "edge_unqualified") in [(abs(v), w) for v, w in _why(state, ctx, bare)]
    said = bare + " Lưu ý: tháng 2018-09 có thể chưa đầy đủ dữ liệu."
    assert all(w != "edge_unqualified" for _, w in _why(state, ctx, said))
    assert all(w != "edge_unqualified" for _, w in _why(state, ctx, "GMV tháng 2018-09 quan sát được là 166.46."))
    ctx, state = world(MOM_Q, asked=("gmv",))
    stable = _compare(1003308.47, 1058728.03, -5.23)
    stable["data"].update({"edge_completeness": "suspected_incomplete",
                           "observed_latest": {"label": "2018-09", "value": 166.46}})
    _rec(state, "compare_periods", stable, {"chart_id": MONTHLY, "mode": "mom"})
    assert _why(state, ctx, "GMV tháng 2018-07 so với 2018-06 giảm 5,23%.") == []


def test_a_breakdown_is_not_answered_from_another_measures_members(world):
    """Live 3bf8e3f3 (P0 g2, link 39): "Bang nào có doanh thu cao nhất?" with no
    revenue-by-state chart in scope was answered "SP" — read from ORDERS by state.
    The gap opened from the intent closes only on revenue by state; while it is open,
    a state named only by another measure's ranking is sent back. Controls: the honest
    refusal passes, and once revenue by state is read the same member is its own."""
    from app.services.agent_flows.runtime import agent_runtime as AR

    ctx, state = world(STATE_Q, asked=("total_revenue",))
    state.dimension_gap = {"requested": "customer_state", "measures": ["total_revenue"],
                           "label": "", "satisfied": False}
    orders = {"ok": True, "kind": "ranking", "data": {
        "chart_id": STATE_ORDERS_CHART, "measure": "dataset_table_437.order_count",
        "dimension": "dataset_table_441.customer_state", "order": "desc", "total": 69613.0, "group_count": 4,
        "items": [{"label": "SP", "value": 41746.0, "rank": 1}]}}
    _rec(state, "rank_values", orders, {"chart_id": STATE_ORDERS_CHART})
    AR._note_dimension_outcome(state, orders)
    assert state.dimension_gap["satisfied"] is False
    assert CC.borrowed_members(state, "Bang có doanh thu cao nhất là SP.") == ["SP"]
    assert CC.borrowed_members(state, "Báo cáo này không có doanh thu theo bang, nên không xác định được.") == []
    AR._note_dimension_outcome(state, {"ok": True, "data": {"measure": "t.total_revenue",
                                                            "dimension": "t.customer_state"}})
    assert state.dimension_gap["satisfied"] is True
    assert CC.borrowed_members(state, "Bang có doanh thu cao nhất là SP.") == []


class _StateModel:
    """Answers the state question from ORDERS by state; told why, admits it."""

    def __init__(self, obey=True):
        self.obey = obey
        self.reviews: list[str] = []

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            last = str(next((m.get("content") for m in reversed(messages) if m.get("role") == "user"), ""))
            if "KHÔNG có biểu đồ nào có" in last:
                self.reviews.append(last)
            if tools and not [m for m in messages if m.get("role") == "tool"]:
                yield AgentEvent(type="tool_call", tool_call_id="t1", tool_name="rank_values",
                                 tool_args={"chart_id": STATE_ORDERS_CHART})
            elif self.reviews and self.obey:
                yield AgentEvent(type="text", text="Báo cáo này không có doanh thu theo bang, nên không trả lời được.")
            else:
                yield AgentEvent(type="text", text="Bang có doanh thu cao nhất là SP.")
            yield AgentEvent(type="usage", extra={"prompt_tokens": 5, "completion_tokens": 2})
        return fake


def test_the_run_admits_a_breakdown_its_scope_cannot_deliver(monkeypatch, undeclared):
    """Whole run, live 3bf8e3f3 P0 g2: no revenue-by-state chart in scope; the model
    answers "SP" from orders by state. The intent opens the gap, the draft goes back
    once, and the reader is told the breakdown is unavailable. Control: a model that
    will not fix it still gets the requested_breakdown_unavailable notice."""
    import json

    from app.services.agent_flows.runtime import intent as I

    calls = []

    async def intent_call(**kw):
        calls.append(1)
        return json.dumps({"measures": ["total_revenue"], "dimension": "customer_state", "members": [],
                           "periods": [], "absent": None, "baseline": None, "followup": False})
    monkeypatch.setattr(I, "_model_call", intent_call)
    monkeypatch.setattr(CC, "_question_measures", lambda ctx, q: {"total_revenue"})
    orders = {"ok": True, "kind": "ranking", "data": {
        "chart_id": STATE_ORDERS_CHART, "measure": "dataset_table_437.order_count",
        "dimension": "dataset_table_441.customer_state", "order": "desc", "total": 69613.0, "group_count": 4,
        "items": [{"label": "SP", "value": 41746.0, "rank": 1}]}}
    monkeypatch.setattr(tool_registry, "execute", lambda ctx, name, args, allowed=None, use_cache=True: orders)
    q = "Bang nào có doanh thu cao nhất?"

    def run(model):
        monkeypatch.setattr(AH, "_stream", model.stream())
        ctx = H._Ctx([684, 685, 686, 687])
        ctx.chart_meta = undeclared([684, 685, 686, 687], q).chart_meta
        body = {"answer_node": "tl", "nodes": [{
            "key": "tl", "name": "tl", "type": "agent", "prompt": "Trả lời câu hỏi.", "max_tool_calls": 6,
            "tools": [{"tool": "rank_values"}]}]}
        flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx_g2", name="fx_g2"),
                                    "key": "fx_g2", "name": "fx_g2"})
        env = H._envelope({"envelope": {"question": {"raw": q}, "runtime": {
            "provider": "openai", "model": "m", "budget": {"max_llm_calls": 8, "max_tool_calls": 10,
                                                            "max_seconds": 60}}}})

        async def go():
            out = None
            async for ev in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=ctx,
                                              credentials=H.fixed_credentials("k"), base_system_prompt="BASE"):
                if ev.type == "result":
                    out = ev.extra.get("envelope")
            return out or {}
        return asyncio.run(go())

    good = _StateModel(obey=True)
    env = run(good)
    assert calls, "the model intent path must run (not the heuristic fallback)"
    assert len(good.reviews) == 1 and "total_revenue" in good.reviews[0]
    assert "SP" not in _answer(env)
    stubborn = _StateModel(obey=False)
    env = run(stubborn)
    assert any(n.get("code") == "requested_breakdown_unavailable" for n in env.get("notices") or [])


def test_no_figure_stands_in_for_a_period_the_data_does_not_have(world):
    """Live 3bf8e3f3 (P0 g5, 2 of 5 runs): "Doanh thu tháng 12/2025 là bao nhiêu?" —
    "Số liệu 13,591,643.7 … là tổng doanh thu toàn kỳ" was published beside the
    refusal. Framed as the whole period it passes when the asked period EXISTS; when
    it lies outside the data it is a substitute answer. Controls: the honest refusal
    that states the data's range passes; without the fact, the framing still passes."""
    from app.services.agent_flows.runtime import intent as I

    q = "Doanh thu tháng 12/2025 là bao nhiêu?"
    ctx, state = world(q, asked=("total_revenue",))
    _value(state, 13591643.70, "dataset_table_438.total_revenue")
    outside = {"asked": [["m", 2025, 12]], "data_from": "2016-09", "data_to": "2018-10"}
    base = {**I.empty_intent(), "source": "model", "measures": ["total_revenue"], "periods": [("m", 2025, 12)]}
    sub = "Không có số cho tháng 12/2025. Tổng doanh thu toàn kỳ là 13,591,643.70."
    state.intent = {**base, "periods_outside_data": outside}
    assert (13591643.7, "period_absent") in _why(state, ctx, sub)
    assert _why(state, ctx, "Dữ liệu của báo cáo chỉ có từ 2016-09 đến 2018-10, nên không có doanh thu tháng 12/2025.") == []
    state.intent = base
    assert (13591643.7, "period_absent") not in _why(state, ctx, sub)
