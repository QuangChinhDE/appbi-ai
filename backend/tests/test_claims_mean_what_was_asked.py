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


def test_an_honest_refusal_keeps_its_total_with_a_neutral_note(world):
    """The total is TRUE as the total; the report has no revenue by state. The
    check cannot read prose, so it never calls it wrong: the only flag is the
    neutral "whole report" note — never `unsupported`, never a rewrite."""
    ctx, state = world(STATE_Q)
    _rec(state, "total_measure", derived.tool_total_measure(ctx, {"chart_id": KPI}), {"chart_id": KPI})
    text = "Báo cáo không tách được doanh thu theo bang; tổng doanh thu là 13.591.643,70."
    assert _why(state, ctx, text) == [(13591643.7, "whole_as_member")]
    assert "Số của toàn bộ báo cáo" in CC.reader_note(CC.check(state, ctx, text)["flagged"])


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
    _rec(state, "compare_periods", _compare(1003308.47, 1058728.03, -5.23), {"chart_id": MONTHLY})
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
    tools read is not "invented"; a wrong one still is."""
    ctx, state = world(MOM_Q, asked=("gmv",))
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": MONTHLY, "value": 1107301.89, "measure": "dataset_table_438.gmv"}}, {"chart_id": MONTHLY})
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": MONTHLY, "value": 863547.10, "measure": "dataset_table_438.gmv"}}, {"chart_id": MONTHLY})
    good = "GMV tháng 1/2018 là 1,107,301.89, tháng 12/2017 là 863,547.10: tăng 28.23%."
    assert _why(state, ctx, good) == []
    bad = "GMV tháng 1/2018 là 1,107,301.89, tháng 12/2017 là 863,547.10: tăng 31.5%."
    assert (31.5, "unsupported") in _why(state, ctx, bad)
