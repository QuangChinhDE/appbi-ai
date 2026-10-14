# -*- coding: utf-8 -*-
"""ONE PUBLICATION BOUNDARY: nothing reaches the reader before it is verified.

Found in the pilot review (2026-09-29): the answering step forwarded the
model's tokens to the reader AS THEY ARRIVED (`AgentRuntime.ask`, `stream_text`),
while the claim check and redaction ran only afterwards and changed only the
final envelope. On SSE the reader saw the unverified draft — including a figure
later withheld, and drafts the in-loop review sent back to the model, which are
never meant to be published at all.

The test runs a real flow through the executor with a model that will not fix an
unsupported figure, and inspects EVERY event a reader-facing client receives.
"""
from __future__ import annotations

import asyncio
import copy
import os

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"

import replay_harness as H  # noqa: E402
from test_claims_mean_what_was_asked import (  # noqa: E402,F401
    MOM_Q, MONTHLY, _compare, _Model, undeclared,
)

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import claim_check as CC  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402


def _events(monkeypatch, undeclared, model):
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
    flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx_pub", name="fx_pub"),
                                "key": "fx_pub", "name": "fx_pub"})
    env = H._envelope({"envelope": {"question": {"raw": MOM_Q}, "runtime": {
        "provider": "openai", "model": "m", "budget": {"max_llm_calls": 8, "max_tool_calls": 10,
                                                        "max_seconds": 60}}}})

    async def go():
        seen = []
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=ctx,
                                          credentials=H.fixed_credentials("k"), base_system_prompt="BASE"):
            seen.append(ev)
        return seen
    return asyncio.run(go())


def _answer(events) -> str:
    env = next((e.extra.get("envelope") for e in events if e.type == "result"), {}) or {}
    return "".join(b.get("markdown") or b.get("text") or "" for b in ((env.get("answer") or {}).get("blocks") or []))


def test_no_event_carries_a_figure_the_answer_withheld(monkeypatch, undeclared):
    events = _events(monkeypatch, undeclared, _Model(obey=False))
    streamed = "".join(e.text or "" for e in events if e.type == "text")
    assert "[đã ẩn: chưa kiểm chứng]" in _answer(events), "the final answer withholds 19,78%"
    assert "19,78" not in streamed and "19.78" not in streamed, (
        "the reader's stream carried the withheld figure before the verdict")


def test_a_draft_sent_back_for_review_never_reaches_the_reader(monkeypatch, undeclared):
    """The model obeys the review and fetches the right figure; the first draft
    (19,78%) existed only between the model and the runtime."""
    events = _events(monkeypatch, undeclared, _Model(obey=True))
    streamed = "".join(e.text or "" for e in events if e.type == "text")
    assert "19,78" not in streamed and "19.78" not in streamed
    assert streamed.strip() == _answer(events).strip(), "the reader's text IS the published answer"


class _JsonModel:
    """Reads a total, then answers with typed blocks: a metric whose delta no
    tool produced (19.78%) and a correct table cell (1,003,308.47)."""

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            from app.services.dashboard_ai_bot.events import AgentEvent
            import json as _json
            if tools and not any(m.get("role") == "tool" for m in messages):
                yield AgentEvent(type="tool_call", tool_call_id="t1", tool_name="total_measure",
                                 tool_args={"chart_id": MONTHLY})
                return
            yield AgentEvent(type="text", text=_json.dumps({"blocks": [
                {"type": "metric", "label": "GMV tháng này", "value": 1003308.47, "format": "number",
                 "delta": {"value": 19.78, "format": "percent", "direction": "up"}},
                {"type": "table", "columns": [{"key": "m", "label": "Tháng"}, {"key": "g", "label": "GMV"}],
                 "rows": [{"m": "tháng này", "g": 1003308.47}]},
            ]}, ensure_ascii=False))
        return fake


def test_a_typed_metric_delta_nothing_produced_is_withheld_everywhere(monkeypatch, undeclared):
    import app.services.agent_flows.runtime.handlers.agent as AHm

    orig = executor.run_flow

    def patched_body(body):
        body["nodes"][0]["output_format"] = "json"
        return body
    monkeypatch.setattr(AHm, "_stream", _JsonModel().stream())
    monkeypatch.setattr(tool_registry, "execute", lambda ctx, name, args, allowed=None, use_cache=True: {
        "ok": True, "kind": "value", "data": {"chart_id": MONTHLY, "measure": "dataset_table_438.gmv",
                                              "value": 1003308.47, "rows_counted": 1}})
    monkeypatch.setattr(CC, "_question_measures", lambda ctx, q: {"gmv"})
    ctx = H._Ctx([684, 685, 686, 687])
    ctx.chart_meta = undeclared([684, 685, 686, 687], MOM_Q).chart_meta
    body = patched_body({"answer_node": "tl", "nodes": [{
        "key": "tl", "name": "tl", "type": "agent", "prompt": "Trả lời câu hỏi.", "max_tool_calls": 4,
        "tools": [{"tool": "total_measure"}]}]})
    flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx_json", name="fx_json"),
                                "key": "fx_json", "name": "fx_json"})
    env = H._envelope({"envelope": {"question": {"raw": MOM_Q}, "runtime": {
        "provider": "openai", "model": "m", "budget": {"max_llm_calls": 6, "max_tool_calls": 6,
                                                        "max_seconds": 60}}}})

    async def go():
        return [ev async for ev in orig(FlowInput.model_validate(env), flow=flow, ctx=ctx,
                                        credentials=H.fixed_credentials("k"), base_system_prompt="BASE")]
    events = asyncio.run(go())
    result = next(e.extra["envelope"] for e in events if e.type == "result")
    blocks = (result.get("answer") or {}).get("blocks") or []
    metric = next(b for b in blocks if b.get("type") == "metric")
    table = next(b for b in blocks if b.get("type") == "table")
    assert metric.get("delta") is None, "the delta no tool produced is withheld from the metric"
    assert table["rows"][0]["g"] == 1003308.47, "the correct cell is kept"
    everything = "".join(e.text or "" for e in events if e.type == "text") + str(blocks)
    assert "19.78" not in everything and "19,78" not in everything
    assert result.get("status") == "partial"


def test_the_fallback_answer_goes_through_the_boundary_too(monkeypatch, undeclared):
    """The answering step fails; the executor falls back to an intermediate step's
    prose — which was never claim-checked. It must not carry an unsupported figure."""
    from app.services.dashboard_ai_bot.events import AgentEvent

    def stream():
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            if "TRA_LOI" in system_prompt:
                yield AgentEvent(type="error", text="provider down")
                return
            yield AgentEvent(type="text", text="Doanh thu tăng 19,78% so với tháng trước.")
        return fake
    monkeypatch.setattr(AH, "_stream", stream())
    monkeypatch.setattr(CC, "_question_measures", lambda ctx, q: {"gmv"})
    ctx = H._Ctx([684, 685, 686, 687])
    ctx.chart_meta = undeclared([684, 685, 686, 687], MOM_Q).chart_meta
    body = {"answer_node": "tl", "nodes": [
        {"key": "gom", "name": "gom", "type": "agent", "prompt": "GOM tóm tắt."},
        {"key": "tl", "name": "tl", "type": "agent", "prompt": "TRA_LOI trả lời.", "on_error": "continue"}]}
    flow = Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx_fb", name="fx_fb"),
                                "key": "fx_fb", "name": "fx_fb"})
    env = H._envelope({"envelope": {"question": {"raw": MOM_Q}, "runtime": {
        "provider": "openai", "model": "m", "budget": {"max_llm_calls": 6, "max_tool_calls": 6,
                                                        "max_seconds": 60}}}})

    async def go():
        return [ev async for ev in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=ctx,
                                                     credentials=H.fixed_credentials("k"), base_system_prompt="BASE")]
    events = asyncio.run(go())
    published = _answer(events) + "".join(e.text or "" for e in events if e.type == "text")
    assert "Doanh thu" in published, "the fallback prose is still used"
    assert "19,78" not in published and "19.78" not in published


def test_the_author_trace_names_each_calls_arguments():
    """Holdout triage at 0beabf5d: the trace said `smart_drilldown` ran and was
    answered "no data", but not on which chart or value — the first cause could not
    be read, only guessed. Author-only: the reader envelope drops the trace."""
    from app.services.agent_flows.envelope import TraceStep
    from app.services.agent_flows.runtime.capabilities import args_summary
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    state.evidence_source = "a"
    state.record_evidence({"ok": True, "kind": "table", "data": {"rows": []}}, tool="smart_drilldown",
                          args={"chart_id": 701, "column": "customer_state", "match": "RJ"})
    step = TraceStep(key="a", type="agent")
    state.record(step)
    made = step.capabilities["evidence"]
    assert '"match": "RJ"' in made[0]["args"] and '"chart_id": 701' in made[0]["args"], made
    assert len(args_summary({"q": "x" * 1000})) <= 240


def test_an_english_question_is_answered_in_english():
    """Browser run at ce6d6313: English questions on an English UI were answered in
    Vietnamese; the check only knew the other direction."""
    from app.services.agent_flows.runtime.handlers import agent as A

    assert A.question_language("What is the customer churn rate?", "vi") == "en"
    assert A.question_language("Doanh thu tháng 3 là bao nhiêu?", "en") == "vi"
    assert A.question_language("doanh thu la bao nhieu", "vi") == "vi", "unaccented VI falls to the locale"
    vi_answer = "Xin lỗi, nhưng báo cáo không có dữ liệu về tỷ lệ rời bỏ của khách hàng trong kỳ này."
    assert A._looks_wrong_language(vi_answer, "vi", "What is the customer churn rate?")
    en_answer = "The report has no customer churn rate; it measures the on-time rate (Tổng phí vận chuyển)."
    assert not A._looks_wrong_language(en_answer, "vi", "What is the customer churn rate?")
    assert A._looks_wrong_language("GMV of the month is high and rising fast overall", "vi",
                                   "GMV tháng này là bao nhiêu?"), "the old direction still holds"
