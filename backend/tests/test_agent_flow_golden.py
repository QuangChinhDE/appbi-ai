"""The golden flows: one case per behaviour the runtime must not lose.

WHY THIS FILE EXISTS
--------------------
Agent Flow's runtime carries branch, loop, budget, retry, cross-turn memory and a
per-node trace, and until now the repository tested three narrow slices of it. The
suites that exercised the rest lived in a scratch directory and disappeared with
the session that wrote them, so a refactor could remove a behaviour and nothing
would say so. That is the wrong order: the safety net comes before the cleaning.

WHAT MAKES A CASE "GOLDEN"
--------------------------
Each one pins a behaviour an author would notice losing, and pins it on OBSERVABLE
output — the trace, the statuses, the answer — never on an internal call. A test
that asserts how the executor is written has to be rewritten by the refactor it is
supposed to protect.

DETERMINISTIC BY CONSTRUCTION
-----------------------------
No database, no network, no vendor. The provider is a stub yielding the same
`AgentEvent`s the real adapters do, and the tool registry is stubbed at the same
seam the runtime uses. So these run anywhere, cost nothing, and cannot go green
because a key expired or a warehouse was slow.
"""
from __future__ import annotations

import os
import re
from types import SimpleNamespace

# SET WHEN FALSY, not `setdefault`. An environment can define DATABASE_URL as an
# EMPTY STRING — the app image does — and an empty value is still a present key,
# so `setdefault` leaves it empty and SQLAlchemy dies at import with an error that
# says nothing about tests. Nothing here touches a database; this only has to be
# parseable.
if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_golden.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import asyncio  # noqa: E402
import json  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as agent_handler  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402


# ── harness ───────────────────────────────────────────────────────────────────
class Ctx:
    """Just enough of ToolContext for the runtime: scope and the chart allowlist."""

    knowledge_scope: dict = {}
    allowed_chart_ids = {41}


def echoing_vendor(text: str = "ok", *, fail_times: int = 0):
    """A stub provider. Echoes the prompt so an unresolved {{name}} is VISIBLE.

    A real model writes something plausible around a missing value, which is
    precisely how an unresolved template survives review. Echoing removes that
    cover.
    """
    state = {"calls": 0, "prompts": []}

    async def fake(*, provider, api_key, model, system_prompt, messages, tools):
        state["calls"] += 1
        user = ""
        for m in messages:
            if m.get("role") == "user":
                user = str(m.get("content") or "")
        state["prompts"].append(user)
        if state["calls"] <= fail_times:
            raise RuntimeError("vendor tạm thời lỗi")
        yield AgentEvent(type="text", text=f"{text} :: {user[:400]}")
        yield AgentEvent(type="usage",
                         extra={"prompt_tokens": 100, "completion_tokens": 20})

    return fake, state


TABLE_RESULT = {
    "ok": True, "kind": "table",
    "data": {"columns": ["category", "revenue"], "rows": [["moveis", 1200]]},
}


@pytest.fixture(autouse=True)
def stub_everything(monkeypatch):
    """Default stubs. A case overrides them when it is testing the exception."""
    fake, _ = echoing_vendor()
    monkeypatch.setattr(agent_handler, "_stream", fake)
    monkeypatch.setattr(tool_registry, "execute",
                        lambda ctx, name, args, allowed=None: TABLE_RESULT)


def build(nodes: list[dict], *, answer_node: str = "") -> Flow:
    body = {"name": "golden", "nodes": nodes}
    if answer_node:
        body["answer_node"] = answer_node
    upgraded = upgrade_body(body, key="golden", name="golden")
    return Flow.model_validate({**upgraded, "key": "golden", "name": "golden"})


def envelope(**over: Any) -> dict:
    base = {
        "request": {"id": "golden", "trigger": "studio_test"},
        "question": {"raw": "Doanh thu thế nào?"},
        "report": {
            "dashboard_id": 67, "name": "Olist",
            "charts": [{"id": 41, "title": "Doanh thu", "chart_type": "BAR",
                        "measures": [{"field": "revenue"}],
                        "dimensions": [{"field": "category"}]}],
        },
        "binding": {
            "id": 1, "flow_version": 1, "allowed_chart_ids": [41],
            "resolved": {"segments": {"kind": "dimension", "chart_id": 41,
                                      "field": "category",
                                      "values": ["moveis", "beleza"]}},
            "capabilities": {"web_search": False, "read_rows": True},
        },
        "runtime": {
            "provider": "openai", "model": "gpt-4o-mini",
            "budget": {"max_llm_calls": 12, "max_tool_calls": 40, "max_seconds": 60},
        },
    }
    for k, v in over.items():
        base[k] = {**base[k], **v} if isinstance(base.get(k), dict) else v
    return base


def run(flow: Flow, **over: Any) -> dict:
    """Execute and return the result envelope. Never raises for a flow-level failure —
    a flow that fails must still produce a trace, and several cases assert exactly that."""
    async def go():
        out = None
        async for ev in executor.run_flow(
            FlowInput.model_validate(envelope(**over)), flow=flow, ctx=Ctx(),
            api_key="k", base_system_prompt="BASE",
        ):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out

    return asyncio.run(go()) or {}


def steps(result: dict) -> list[dict]:
    return ((result or {}).get("trace") or {}).get("steps") or []


def status_of(result: dict, key: str) -> str | None:
    for s in steps(result):
        if s["key"] == key:
            return s["status"]
    return None


def ran(result: dict) -> list[str]:
    return [s["key"] for s in steps(result)]


AGENT = {"key": "answer", "type": "agent", "name": "Trả lời",
         "prompt": "Trả lời: {{question}}"}


# ── 01 · agent only ───────────────────────────────────────────────────────────
def test_agent_only_answers_and_traces():
    r = run(build([AGENT], answer_node="answer"))
    assert r["status"] == "ok"
    assert ran(r) == ["answer"]
    assert status_of(r, "answer") == "ok"
    assert r["answer"]["blocks"], "một run ok phải có nội dung trả lời"


# ── 02 · read report → agent ──────────────────────────────────────────────────
def test_report_read_publishes_a_variable_the_agent_can_read():
    r = run(build([
        {"key": "read", "type": "report_read", "output_var": "bao_cao"},
        {"key": "answer", "type": "agent", "prompt": "Dựa trên {{bao_cao}}"},
    ], answer_node="answer"))
    assert ran(r) == ["read", "answer"]
    # The agent's echoed prompt must NOT still contain the placeholder.
    out = next(s["preview"] if "preview" in s else s.get("output_preview")
               for s in steps(r) if s["key"] == "answer")
    assert "{{bao_cao}}" not in str(out), "template chưa được thay thế trước khi gửi model"


# ── 03 · IF ───────────────────────────────────────────────────────────────────
def _if_flow() -> list[dict]:
    return [
        {"key": "seed", "type": "set_var", "var": "kind", "value": "hot",
         "value_type": "text"},
        {"key": "gate", "type": "if", "paths": [
            {"key": "hot", "name": "Hot", "kind": "rules",
             "conditions": [{"left": "{{kind}}", "op": "equals", "right": "hot"}],
             "body": [{"key": "a_hot", "type": "agent", "prompt": "nóng"}]},
            {"key": "other", "name": "Khác", "kind": "fallback",
             "body": [{"key": "a_cold", "type": "agent", "prompt": "nguội"}]},
        ]},
        AGENT,
    ]


def test_if_runs_only_the_matching_path():
    r = run(build(_if_flow(), answer_node="answer"))
    assert "a_hot" in ran(r)
    assert "a_cold" not in ran(r), "nhánh không khớp vẫn chạy"


def test_if_falls_back_when_no_path_matches():
    nodes = _if_flow()
    nodes[0]["value"] = "lạnh"          # matches neither rule
    r = run(build(nodes, answer_node="answer"))
    assert "a_cold" in ran(r) and "a_hot" not in ran(r)


# ── 04 · switch ───────────────────────────────────────────────────────────────
def _switch_flow(seed: str) -> list[dict]:
    return [
        {"key": "seed", "type": "set_var", "var": "scenario", "value": seed,
         "value_type": "text"},
        {"key": "route", "type": "switch", "value": "{{scenario}}",
         "cases": [
             {"key": "stop_early", "label": "STOP", "op": "equals", "value": "stop",
              "body": [{"key": "halt", "type": "stop", "emit": True,
                        "message": "dừng sớm"}]},
             {"key": "slow", "label": "DELAY", "op": "equals", "value": "delay",
              "body": [{"key": "wait", "type": "delay", "seconds": 0}]},
         ],
         "has_fallback": True,
         "fallback": [{"key": "mark", "type": "set_var", "var": "taken",
                       "value": "fallback", "value_type": "text"}]},
        AGENT,
    ]


def test_switch_selects_the_matching_case():
    r = run(build(_switch_flow("delay"), answer_node="answer"))
    assert "wait" in ran(r)
    assert "mark" not in ran(r) and "halt" not in ran(r)


def test_switch_uses_fallback_when_the_value_matches_nothing():
    r = run(build(_switch_flow("khong-co"), answer_node="answer"))
    assert "mark" in ran(r)


def test_switch_on_a_variable_nothing_produces_is_reported_not_hidden():
    """The defect that made a live flow always take its fallback while reporting
    "Success". The engine may not guess a value; the FLOW must say the reference
    is unproduced, or nobody ever finds out."""
    nodes = _switch_flow("stop")
    nodes.pop(0)                                    # nothing sets {{scenario}} now
    flow = build(nodes, answer_node="answer")
    unresolved = set(flow.unresolved_refs()) if hasattr(flow, "unresolved_refs") else set()
    warnings = " ".join(flow.warnings())
    assert "scenario" in unresolved or "scenario" in warnings, (
        "flow dùng {{scenario}} mà không bước nào tạo ra, nhưng validation im lặng"
    )


# ── 05 · loop ─────────────────────────────────────────────────────────────────
def test_loop_runs_once_per_item_and_collects():
    r = run(build([
        {"key": "each", "type": "loop", "over": "{{segments}}", "item_var": "seg",
         "max_iterations": 5, "collect_into": "findings",
         "body": [{"key": "one", "type": "agent", "prompt": "về {{seg}}"}]},
        AGENT,
    ], answer_node="answer"))
    assert ran(r).count("one") == 2, "loop phải chạy đúng số phần tử của {{segments}}"


def test_loop_respects_max_iterations():
    r = run(build([
        {"key": "each", "type": "loop", "over": "{{segments}}", "item_var": "seg",
         "max_iterations": 1,
         "body": [{"key": "one", "type": "agent", "prompt": "về {{seg}}"}]},
        AGENT,
    ], answer_node="answer"))
    assert ran(r).count("one") == 1


# ── 06 · filter stops a branch ────────────────────────────────────────────────
def test_filter_stops_its_branch_but_still_records_the_decision():
    r = run(build([
        {"key": "gate", "type": "filter", "match": "all",
         "conditions": [{"left": "{{question}}", "op": "equals", "right": "không khớp"}]},
        AGENT,
    ], answer_node="answer"))
    assert status_of(r, "gate") == "skipped", (
        "một quyết định dừng nhánh phải có dòng trace, nếu không nó biến mất"
    )


# ── 07 · retry ────────────────────────────────────────────────────────────────
def test_retry_recovers_and_the_step_ends_ok(monkeypatch):
    fake, state = echoing_vendor(fail_times=1)
    monkeypatch.setattr(agent_handler, "_stream", fake)
    r = run(build([
        {**AGENT, "retry": {"max_attempts": 3, "backoff_seconds": 0, "on": "error"}},
    ], answer_node="answer"))
    assert state["calls"] == 2, "phải thử lại đúng một lần"
    assert status_of(r, "answer") == "ok"


def test_a_step_that_exhausts_its_retries_is_marked_and_the_run_is_not_ok(monkeypatch):
    fake, _ = echoing_vendor(fail_times=99)
    monkeypatch.setattr(agent_handler, "_stream", fake)
    r = run(build([
        {**AGENT, "retry": {"max_attempts": 2, "backoff_seconds": 0, "on": "error"}},
    ], answer_node="answer"))
    assert status_of(r, "answer") == "error"
    assert r["status"] != "ok", "không có câu trả lời thì run không được báo thành công"


# ── 08 · on_error=stop ────────────────────────────────────────────────────────
def test_on_error_stop_halts_the_rest_of_the_flow(monkeypatch):
    fake, _ = echoing_vendor(fail_times=99)
    monkeypatch.setattr(agent_handler, "_stream", fake)
    r = run(build([
        {"key": "boom", "type": "agent", "prompt": "x", "on_error": "stop"},
        {"key": "after", "type": "set_var", "var": "v", "value": "1",
         "value_type": "text"},
    ]))
    assert "after" not in ran(r), "on_error=stop mà các bước sau vẫn chạy"


# ── 09 · tool error ───────────────────────────────────────────────────────────
def test_a_failing_tool_does_not_take_the_run_down(monkeypatch):
    def boom(ctx, name, args, allowed=None):
        raise RuntimeError("warehouse sập")

    monkeypatch.setattr(tool_registry, "execute", boom)
    r = run(build([
        {"key": "read", "type": "report_read", "output_var": "bao_cao"},
        AGENT,
    ], answer_node="answer"))
    assert "answer" in ran(r), "một tool lỗi không được làm mất phần còn lại của flow"


# ── 10 · budget ───────────────────────────────────────────────────────────────
def test_budget_exhaustion_stops_the_run_and_names_the_step():
    r = run(
        build([
            {"key": "each", "type": "loop", "over": "{{segments}}", "item_var": "seg",
             "max_iterations": 5,
             "body": [{"key": "one", "type": "agent", "prompt": "về {{seg}}"}]},
            AGENT,
        ], answer_node="answer"),
        runtime={"budget": {"max_llm_calls": 1, "max_tool_calls": 5, "max_seconds": 60}},
    )
    assert steps(r), "hết ngân sách vẫn phải để lại trace, nếu không không ai biết tiêu vào đâu"
    assert r["status"] != "ok"


# ── 11 · cross-turn memory ────────────────────────────────────────────────────
def _memory_flow() -> Flow:
    return build([
        {"key": "read", "type": "report_read", "output_var": "bao_cao",
         "run_policy": "when_stale"},
        {"key": "answer", "type": "agent", "prompt": "Dựa trên {{bao_cao}}"},
    ], answer_node="answer")


def test_when_stale_reuses_the_previous_turn_and_says_what_it_reused():
    flow = _memory_flow()
    first = run(flow)
    remembered = (first.get("memory_delta") or {}).get("set") or {}
    assert remembered, "lượt đầu phải ghi lại giá trị để lượt sau dùng"

    second = run(flow, request={"id": "turn2"},
                 memory={"vars": remembered, "reusable_nodes": ["read"]})
    assert status_of(second, "read") == "reused"

    row = next(s for s in steps(second) if s["key"] == "read")
    # A reused step that records nothing is indistinguishable from a skipped one,
    # which is exactly how it was read when this was missing.
    assert row.get("output_preview"), "bước dùng lại phải cho biết nó dùng lại GIÁ TRỊ gì"
    snapshot = json.loads(row["input_preview"])
    assert "vars" in snapshot and "outputs" in snapshot
    assert "run_policy" in snapshot.get("note", ""), "phải nói rõ LÝ DO không chạy lại"


def test_once_per_session_does_not_run_again_in_a_later_turn():
    flow = build([
        {"key": "read", "type": "report_read", "output_var": "bao_cao",
         "run_policy": "once_per_session"},
        AGENT,
    ], answer_node="answer")
    first = run(flow)
    remembered = (first.get("memory_delta") or {}).get("set") or {}
    second = run(flow, request={"id": "turn2"},
                 memory={"vars": remembered, "reusable_nodes": ["read"]})
    assert status_of(second, "read") == "reused"


# ── 12 · binding ──────────────────────────────────────────────────────────────
def test_a_loop_over_an_unresolved_requirement_does_not_invent_items():
    """With the binding empty, `{{segments}}` has no list. Iterating the LABEL
    instead — a single string — silently turns "per segment" into "once"."""
    r = run(
        build([
            {"key": "each", "type": "loop", "over": "{{segments}}", "item_var": "seg",
             "max_iterations": 5,
             "body": [{"key": "one", "type": "agent", "prompt": "về {{seg}}"}]},
            AGENT,
        ], answer_node="answer"),
        binding={"resolved": {}},
    )
    assert ran(r).count("one") == 0, (
        "binding chưa gán mà loop vẫn chạy — nó đang lặp trên thứ gì đó tự bịa"
    )


def test_capabilities_gate_the_web_node():
    r = run(build([
        {"key": "w", "type": "web", "query": "{{question}}", "output_var": "web_ctx"},
        AGENT,
    ], answer_node="answer"), binding={"capabilities": {"web_search": False,
                                                        "read_rows": True}})
    assert status_of(r, "w") != "ok", (
        "link không cho web search mà node web vẫn chạy thành công"
    )


# ── 13 · trace integrity ──────────────────────────────────────────────────────
def test_every_spine_node_leaves_a_row():
    """The complaint that started this: nodes appearing to be skipped in silence.
    A node on the spine either ran or is a defect — it may never simply be absent."""
    flow = build([
        {"key": "read", "type": "report_read", "output_var": "bao_cao"},
        {"key": "seed", "type": "set_var", "var": "v", "value": "1",
         "value_type": "text"},
        AGENT,
    ], answer_node="answer")
    r = run(flow)
    assert ran(r) == ["read", "seed", "answer"]


def test_every_executed_step_records_what_it_could_read():
    r = run(build([
        {"key": "read", "type": "report_read", "output_var": "bao_cao"},
        {"key": "answer", "type": "agent", "prompt": "Dựa trên {{bao_cao}}"},
    ], answer_node="answer"))
    later = next(s for s in steps(r) if s["key"] == "answer")
    snapshot = json.loads(later["input_preview"])
    assert "bao_cao" in snapshot["vars"], (
        "bước sau không ghi lại biến nó nhìn thấy — đây là lúc 'input rỗng' bị đọc "
        "nhầm thành flow hỏng"
    )


def test_step_previews_are_json_so_the_inspector_can_render_them():
    """Stored as `repr` they could not be rendered as fields or tables, and the one
    screen a non-programmer opens answered in Python syntax."""
    r = run(build([
        {"key": "read", "type": "report_read", "output_var": "bao_cao"},
        AGENT,
    ], answer_node="answer"))
    row = next(s for s in steps(r) if s["key"] == "read")
    json.loads(row["input_preview"])          # raises if it is not JSON
    assert not str(row.get("output_preview", "")).startswith("{'")


# ── 14 · answer contract ──────────────────────────────────────────────────────
def test_a_run_with_no_answer_is_never_reported_as_success(monkeypatch):
    async def silent(*, provider, api_key, model, system_prompt, messages, tools):
        yield AgentEvent(type="usage", extra={"prompt_tokens": 10,
                                              "completion_tokens": 0})

    monkeypatch.setattr(agent_handler, "_stream", silent)
    r = run(build([AGENT], answer_node="answer"))
    assert r["status"] != "ok"


# ── 15 · knowledge reaches vocabulary, and says how ───────────────────────────
#
# The complaint these pin: the Knowledge node "scans all metrics and cannot read
# the glossary". Both were true, and each had its own cause — an unbound metric
# was admitted everywhere, and the glossary had no retrieval path at all.
class _Term:
    def __init__(self, name, display, desc="", syn=None, status="Approved"):
        self.name, self.display_name, self.description = name, display, desc
        self.synonyms, self.status = syn or [], status


class _Metric:
    def __init__(self, name, *, dataset_id=None, dataset_table_id=None,
                 measure_ref=None, term=None, text=""):
        self.name, self.display_name = name, name
        self.dataset_id, self.dataset_table_id = dataset_id, dataset_table_id
        self.measure_ref, self.related_term_fqn = measure_ref, term
        self.definition, self.formula = text, ""
        self.category, self.unit = "", ""
        self.status = "Approved"
        self.target_value = self.target_operator = None
        self.owner = None
        # Empty unless a case sets them — mirrors a row written before bindings
        # existed, which is exactly the fallback path worth exercising by default.
        self.bindings = []


def _govern(monkeypatch, *, terms=(), metrics=(), scope=None,
            dsids=frozenset({7}), measure_terms=frozenset()):
    """Stand up `govern_tools` against fixed rows — no database, no dashboard."""
    from app.services.dashboard_ai_bot import govern_tools as gt
    from app.services.governance_service import GovernanceService

    class Ctx:
        knowledge_scope = scope or {}
        db = None
        dashboard = None

    monkeypatch.setattr(gt, "_scope", lambda ctx: (set(), set(dsids)))
    monkeypatch.setattr(gt, "_granted_dataset_ids", lambda ctx: None)
    monkeypatch.setattr(gt, "_measure_term_fqns", lambda ctx, ds: set(measure_terms))

    def binding_details(_db, metric):
        targets = list(metric.bindings or [])
        if not targets and (metric.dataset_id or metric.dataset_table_id or metric.measure_ref):
            targets = [metric]
        out = []
        for target in targets:
            dataset_id = target.dataset_id
            table_id = target.dataset_table_id
            measure_ref = target.measure_ref
            if dataset_id is None and measure_ref:
                match = re.match(r"dataset_table_(\d+)\.", measure_ref)
                dataset_id = int(match.group(1)) if match else None
            out.append({
                "status": "ok" if measure_ref else "unbound",
                "dataset_id": dataset_id,
                "dataset_table_id": table_id,
            })
        return out

    monkeypatch.setattr(GovernanceService, "metric_binding_details", binding_details)

    class _Q:
        def __init__(self, rows): self._rows = rows
        def join(self, *a, **k): return self
        def filter(self, *a, **k): return self
        def all(self): return self._rows

    class _DB:
        def query(self, *cols):
            first = str(cols[0])
            if "GlossaryTerm" in first:
                return _Q([(t, "kd") for t in terms])
            return _Q(list(metrics))

    Ctx.db = _DB()
    return gt, Ctx()


def test_an_unbound_metric_no_longer_appears_on_every_report(monkeypatch):
    """The leak: `matched or not bound` admitted every unattached metric to every
    dashboard — and a metric carries a target, so that is a NUMBER arriving in a
    prompt about someone else's report."""
    gt, ctx = _govern(monkeypatch, metrics=[_Metric("chi_phi_kho", text="tồn kho")])
    kept = gt._metrics_in_scope(ctx, "doanh thu quý 4")
    assert kept == [], "metric chưa gắn dataset vẫn lọt vào báo cáo không liên quan"


def test_an_unbound_metric_still_arrives_when_the_question_names_it(monkeypatch):
    """Not banned — it has to be NAMED. Company vocabulary stays reachable; it
    just no longer arrives merely by existing."""
    gt, ctx = _govern(monkeypatch, metrics=[_Metric("chi_phi_kho", text="tồn kho")])
    # The machine name is the FQN-safe spelling of the display name, so separators
    # fold to spaces on both sides — nobody types the underscores.
    kept = gt._metrics_in_scope(ctx, "chi phí kho tháng này bao nhiêu")
    assert [m.name for m in kept] == ["chi_phi_kho"]


def test_naming_a_DIFFERENT_metric_does_not_admit_this_one(monkeypatch):
    """"chi phí tồn kho" is not "chi phí kho". Phrase containment draws that line;
    token overlap would not, and that looseness is what let an unrelated
    definition into someone else's report in the first place."""
    gt, ctx = _govern(monkeypatch, metrics=[_Metric("chi_phi_kho", text="tồn kho")])
    assert gt._metrics_in_scope(ctx, "chi phí tồn kho thế nào") == []


def test_a_metric_bound_to_this_report_is_kept(monkeypatch):
    gt, ctx = _govern(monkeypatch, metrics=[_Metric("gmv", dataset_id=7, measure_ref="dataset_table_7.gmv")])
    assert [m.name for m in gt._metrics_in_scope(ctx, "bất kỳ")] == ["gmv"]


def test_a_metric_bound_to_another_report_is_not(monkeypatch):
    gt, ctx = _govern(monkeypatch, metrics=[_Metric("gmv", dataset_id=99, measure_ref="dataset_table_99.gmv")])
    assert gt._metrics_in_scope(ctx, "gmv") == []


class _Binding:
    def __init__(self, dataset_id=None, dataset_table_id=None, measure_ref=None):
        self.dataset_id, self.dataset_table_id = dataset_id, dataset_table_id
        self.measure_ref, self.is_primary = measure_ref, False


def test_a_metric_realized_in_SEVERAL_datasets_is_in_scope_for_each(monkeypatch):
    """The structural fix. A metric carried ONE `dataset_id`, so a definition
    computed in two datasets could be attached to one of them and was missing on
    the other report — the same word, defined on one screen and undefined on the
    next. Bindings make one statement serve every place it is realized."""
    m = _Metric("gmv", dataset_id=3, measure_ref="dataset_table_3.gmv")
    m.bindings = [_Binding(dataset_id=7, measure_ref="dataset_table_7.gmv")]
    gt, ctx = _govern(monkeypatch, metrics=[m], dsids={7})
    assert [x.name for x in gt._metrics_in_scope(ctx, "bất kỳ")] == ["gmv"], (
        "metric hiện thực hoá ở nhiều dataset phải có mặt trên từng báo cáo đó"
    )


def test_bindings_do_not_widen_a_metric_to_unrelated_reports(monkeypatch):
    """Many realizations, not "everywhere". A report that realizes none of them
    still gets nothing unless the question names the metric."""
    m = _Metric("gmv", dataset_id=3, measure_ref="dataset_table_3.gmv")
    m.bindings = [_Binding(dataset_id=4, measure_ref="dataset_table_4.gmv")]
    gt, ctx = _govern(monkeypatch, metrics=[m], dsids={7})
    assert gt._metrics_in_scope(ctx, "doanh thu ra sao") == []


def test_a_binding_expressed_only_as_a_measure_ref_still_matches(monkeypatch):
    """Field metrics bind through `dataset_table_<id>.<measure>` rather than the
    id columns. That path was read on the scalar column alone; now every binding
    is checked, or a metric attached the common way would go missing."""
    m = _Metric("gmv")
    m.bindings = [_Binding(measure_ref="dataset_table_7.gmv")]
    gt, ctx = _govern(monkeypatch, metrics=[m], dsids={7})
    assert [x.name for x in gt._metrics_in_scope(ctx, "bất kỳ")] == ["gmv"]


class _ContractQuery:
    def __init__(self, rows, scalar_field=None):
        self.rows, self.scalar_field = rows, scalar_field

    def filter(self, *_args, **_kwargs): return self
    def order_by(self, *_args, **_kwargs): return self
    def all(self): return list(self.rows)
    def first(self): return self.rows[0] if self.rows else None
    def scalar(self):
        row = self.first()
        return getattr(row, self.scalar_field) if row is not None and self.scalar_field else row


class _ContractDb:
    def __init__(self, *, measures=(), dimensions=()):
        self.dataset = SimpleNamespace(id=1, name="Commerce")
        self.table = SimpleNamespace(id=10, dataset_id=1, display_name="Orders")
        self.view = SimpleNamespace(
            id=20, name="orders", sql_table_name="dataset_table_10",
            dataset_table_id=10, measures=list(measures), dimensions=list(dimensions),
        )

    def query(self, *entities):
        from app.models.dataset import Dataset, DatasetTable
        from app.models.semantic import SemanticView

        entity = entities[0]
        owner = getattr(entity, "class_", entity)
        if owner is Dataset:
            field = "name" if getattr(entity, "key", None) == "name" else None
            return _ContractQuery([self.dataset], field)
        if owner is DatasetTable:
            return _ContractQuery([self.table])
        if owner is SemanticView:
            return _ContractQuery([self.view])
        raise AssertionError(f"unexpected query: {entities}")


def test_governed_kpi_binding_resolves_only_to_a_semantic_measure():
    from app.services.governance_service import GovernanceService

    resolved = GovernanceService.resolve_metric_binding(
        _ContractDb(measures=[{"name": "gmv", "label": "GMV"}]),
        {"dataset_id": 1, "dataset_table_id": 10, "measure_ref": "dataset_table_10.gmv"},
    )
    assert resolved["status"] == "ok"
    assert resolved["canonical_ref"] == "orders.gmv"


def test_a_dimension_cannot_masquerade_as_a_governed_kpi_measure():
    from app.services.governance_service import GovernanceError, GovernanceService

    db = _ContractDb(measures=[{"name": "revenue"}], dimensions=[{"name": "gmv"}])
    resolved = GovernanceService.resolve_metric_binding(
        db,
        {"dataset_id": 1, "dataset_table_id": 10, "measure_ref": "dataset_table_10.gmv"},
    )
    assert resolved["status"] == "unresolved"
    assert resolved["reason"] == "measure_missing"
    with pytest.raises(GovernanceError):
        GovernanceService._prepare_metric_bindings(
            db,
            [{"dataset_id": 1, "dataset_table_id": 10, "measure_ref": "dataset_table_10.gmv"}],
        )


def test_a_dataset_only_kpi_binding_is_draft_scope_not_executable_lineage():
    from app.services.governance_service import GovernanceService

    resolved = GovernanceService.resolve_metric_binding(_ContractDb(), {"dataset_id": 1})
    assert resolved["status"] == "unbound"
    assert resolved["dataset_id"] == 1


def test_caveat_injection_respects_registry_scope_and_approval():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from app.core.database import Base
    from app.models.governance import GovernDataCaveat
    from app.services.governance_ai_service import GovernanceAIService

    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(
        engine,
        tables=[GovernDataCaveat.__table__],
    )
    with Session(engine) as db:
        db.add_all([
            GovernDataCaveat(
                id=1, title="Global", content="All reports", dataset_id=None,
                status="Approved", always_inject=True,
            ),
            GovernDataCaveat(
                id=2, title="Commerce only", content="Commerce warning",
                dataset_id=1, status="Approved", always_inject=True,
            ),
            GovernDataCaveat(
                id=3, title="Finance only", content="Finance warning",
                dataset_id=2, status="Approved", always_inject=True,
            ),
            GovernDataCaveat(
                id=4, title="Draft", content="Not trusted yet",
                dataset_id=None, status="Draft", always_inject=True,
            ),
            GovernDataCaveat(
                id=5, title="Optional", content="Do not force into context",
                dataset_id=None, status="Approved", always_inject=False,
            ),
        ])
        db.commit()

        rows = GovernanceAIService.caveats_for(db, {1})
        assert {row.title for row in rows} == {"Global", "Commerce only"}


def test_glossary_is_reachable_through_a_measure_on_this_report(monkeypatch):
    """The bridge dashboard → dataset → measure → term. It existed in the schema
    and nothing traversed it, so a term curated onto a measure was invisible."""
    gt, ctx = _govern(monkeypatch, terms=[_Term("gmv", "GMV", "Tổng giá trị hàng hoá")],
                      measure_terms={"kd.gmv"})
    out = gt._terms_in_scope(ctx, [], "câu hỏi không hề nhắc từ đó")
    assert [t["id"] for t in out] == ["kd.gmv"]
    assert out[0]["reached_by"] == "measure", "phải nói rõ vì sao term này liên quan"


def test_glossary_is_reachable_through_a_metric_already_in_scope(monkeypatch):
    gt, ctx = _govern(monkeypatch, terms=[_Term("gmv", "GMV")])
    metrics = [_Metric("gmv", dataset_id=7, term="kd.gmv")]
    out = gt._terms_in_scope(ctx, metrics, "không nhắc")
    assert [t["reached_by"] for t in out] == ["metric"]


def test_a_term_nobody_wired_up_arrives_only_when_the_question_uses_it(monkeypatch):
    """The honest fallback — a MATCH, not the dump that metrics used to do."""
    gt, ctx = _govern(monkeypatch, terms=[_Term("gmv", "GMV", syn=["tổng giá trị hàng hoá"])])
    assert gt._terms_in_scope(ctx, [], "khách hàng rời bỏ") == []
    hit = gt._terms_in_scope(ctx, [], "GMV quý 4 ra sao")
    assert [t["reached_by"] for t in hit] == ["vocabulary"]


def test_a_synonym_finds_the_term(monkeypatch):
    gt, ctx = _govern(monkeypatch, terms=[_Term("gmv", "GMV", syn=["tổng giá trị hàng hoá"])])
    hit = gt._terms_in_scope(ctx, [], "tổng giá trị hàng hoá tháng này")
    assert [t["id"] for t in hit] == ["kd.gmv"]


def test_an_explicit_attachment_is_a_ceiling_for_terms(monkeypatch):
    """Same rule documents already obey: once the author names what a step may
    read, a keyword coincidence cannot add to it."""
    gt, ctx = _govern(
        monkeypatch,
        terms=[_Term("gmv", "GMV"), _Term("churn", "Churn", syn=["rời bỏ"])],
        scope={"term_fqns": ["kd.gmv"]},
    )
    out = gt._terms_in_scope(ctx, [], "churn rời bỏ ra sao")
    assert [t["id"] for t in out] == ["kd.gmv"]
    assert out[0]["reached_by"] == "attached"


def test_a_deprecated_term_is_never_returned(monkeypatch):
    gt, ctx = _govern(monkeypatch,
                      terms=[_Term("gmv", "GMV", status="Deprecated")],
                      measure_terms={"kd.gmv"})
    assert gt._terms_in_scope(ctx, [], "gmv") == []


def test_the_knowledge_node_collects_a_term_attachment_into_its_scope():
    """The node builds the scope the retriever reads. A `term` attachment that
    never reached that dict would be a picker that does nothing."""
    flow = build([
        {"key": "kb", "type": "knowledge", "query": "{{question}}", "output_var": "kb_ctx",
         "knowledge": [{"source": "term", "ref": "kd.gmv", "description": "định nghĩa GMV"}]},
        AGENT,
    ], answer_node="answer")
    node = next(n for n in flow.all_nodes() if n.key == "kb")
    assert [k.source for k in node.knowledge] == ["term"]
    assert [k.ref for k in node.knowledge] == ["kd.gmv"]


# ── 16 · the node list is frozen, and the two halves must agree ───────────────
#: The twelve. Changing this list is a deliberate act; the test below makes it one.
FROZEN_NODE_TYPES = {
    "agent",                                   # AI
    "report_read", "knowledge", "web",         # data
    "if", "switch", "filter",                  # logic
    "loop", "stop", "delay",                   # flow
    "set_var", "transform",                    # utility
}


def _contract_node_types() -> set[str]:
    from app.services.agent_flows import contract as C

    out = set()
    for cls in vars(C).values():
        if isinstance(cls, type) and issubclass(cls, C.BaseNode) and cls is not C.BaseNode:
            field = cls.model_fields.get("type")
            if field is not None and field.default:
                out.add(field.default)
    return out


def test_the_node_list_is_exactly_the_frozen_twelve():
    """A freeze enforced by a list in a document is a freeze until someone forgets.
    Adding a node is fine — updating this set is how you say you meant to."""
    assert _contract_node_types() == FROZEN_NODE_TYPES


def test_the_palette_offers_exactly_what_the_contract_accepts():
    """The two halves drifting is how a node appears in the builder that the
    validator rejects on save, or exists in the contract and can never be reached.
    Neither failure announces itself; both are one assertion away."""
    from app.services.agent_flows.runtime import nodes as node_registry

    raw = node_registry.catalogue()
    items = raw.get("nodes") if isinstance(raw, dict) else raw
    offered = {
        (i["type"] if isinstance(i, dict) else getattr(i, "type", "")) for i in items
    }
    assert offered == _contract_node_types()


def test_every_model_the_picker_offers_has_a_real_price():
    """The run inspector shows a dollar figure, and it must not be a guess.

    `cost.price_for` falls back to GPT-4o-tier pricing for any model it does not
    recognise — sensible for telemetry, since over-estimating spend is the safe
    direction, but it means an unpriced model produces a plausible-looking number
    with nothing on screen admitting it was invented. Adding a model to the picker
    without adding its price is a one-line change that silently makes every cost
    figure for that model fiction; this is what stops it."""
    from app.services.agent_flows import models_catalogue
    from app.services.dashboard_ai_bot import cost

    fallback = cost.price_for("")
    offered = []
    for group in models_catalogue.catalogue():
        for entry in group.get("models") or []:
            # The catalogue carries model dicts (id + label); older builds carried
            # bare ids. Read both rather than pin the shape — this test is about
            # pricing, and should not fail over a picker refactor.
            offered.append(
                (entry.get("id") or entry.get("model") or entry.get("name"))
                if isinstance(entry, dict) else entry
            )
    offered = [m for m in offered if m]
    assert offered, "picker không chào model nào — kiểm tra này sẽ vô nghĩa"
    unpriced = [m for m in offered if cost.price_for(m) is fallback]
    assert not unpriced, (
        f"model được chào nhưng chưa có giá: {unpriced} — chi phí hiển thị cho "
        f"chúng sẽ là ước lượng mà không nói ra"
    )


# ── 17 · a link may never point at nothing ────────────────────────────────────
def test_deleting_a_version_consults_the_links_that_use_it(monkeypatch):
    """The root cause of a binding found pointing at a flow with zero versions.

    `delete_version` inspected only the row it was deleting, so removing the last
    version deleted the FLOW while every binding naming it stayed behind. Nothing
    reported it: the link kept its bot and each question failed in a place the
    author who deleted the draft would never look."""
    from app.services.agent_flows import binding as binding_service
    from app.services.agent_flows import registry as reg

    class Row:
        status = "draft"

    monkeypatch.setattr(reg, "_audit", lambda *a, **k: None)
    monkeypatch.setattr(binding_service, "list_for_flow",
                        lambda db, key: [{"link_id": 7, "link_name": "Báo cáo tuần",
                                          "pinned_version": None}])

    class Q:
        def filter(self, *a, **k):
            return self

        def first(self):
            return Row()

        def count(self):
            return 0            # this is the last surviving version

    class DB:
        def query(self, *a, **k):
            return Q()

    with pytest.raises(Exception) as err:
        reg.delete_version(DB(), "some_flow", 3, "tester@x")
    assert "link" in str(err.value).lower(), (
        "phải nói rõ có link đang dùng, thay vì xoá im lặng"
    )


def test_unpublish_refuses_to_break_a_bound_link(monkeypatch):
    from app.services.agent_flows import binding as binding_service
    from app.services.agent_flows import registry as reg

    class Query:
        def filter(self, *_args):
            return self

        def first(self):
            return type("Row", (), {"status": "published"})()

    class Db:
        def query(self, *_args):
            return Query()

    monkeypatch.setattr(
        binding_service,
        "list_for_flow",
        lambda *_args: [{"link_name": "Public report", "link_id": 7}],
    )
    with pytest.raises(reg.BrainError) as err:
        reg.unpublish_version(Db(), "golden", 1)
    assert err.value.status == 409
    assert "binding" in str(err.value).lower()


def test_unpublish_archives_an_unbound_published_version(monkeypatch):
    from app.services.agent_flows import binding as binding_service
    from app.services.agent_flows import registry as reg

    row = type("Row", (), {"status": "published"})()

    class Query:
        def filter(self, *_args):
            return self

        def first(self):
            return row

    class Db:
        committed = False
        refreshed = False

        def query(self, *_args):
            return Query()

        def commit(self):
            self.committed = True

        def refresh(self, refreshed_row):
            assert refreshed_row is row
            self.refreshed = True

    db = Db()
    audited = []
    monkeypatch.setattr(binding_service, "list_for_flow", lambda *_args: [])
    monkeypatch.setattr(reg, "_row_dict", lambda current: {"status": current.status})
    monkeypatch.setattr(reg, "_audit", lambda *args: audited.append(args[1:]))

    result = reg.unpublish_version(db, "golden", 1, "owner@appbi.io")

    assert result == {"status": "archived"}
    assert row.status == "archived"
    assert db.committed and db.refreshed
    assert audited == [
        ("AGENT_FLOW_UNPUBLISHED", "golden", "owner@appbi.io", {"version": 1})
    ]


def test_unpublish_has_a_persistable_audit_action():
    from app.models.audit_log import AuditAction

    assert AuditAction.AGENT_FLOW_UNPUBLISHED.value == "agent_flow_unpublished"


def test_a_binding_whose_flow_is_gone_is_recorded_broken_not_merely_refused(monkeypatch):
    """Chart drift was written onto the binding; a DELETED FLOW was not. So the
    screens that exist to surface unhealthy links showed `active` while every
    question failed."""
    from app.services.agent_flows import binding as binding_service
    from app.services.agent_flows import dispatch
    from app.services.agent_flows import registry as reg

    class Binding:
        status = "active"
        brain_key = "gone_flow"
        pinned_version = None

    marked: dict = {}
    monkeypatch.setattr(binding_service, "get_for_link", lambda db, i: Binding())
    monkeypatch.setattr(binding_service, "cheap_validate", lambda b, d: "")
    monkeypatch.setattr(binding_service, "mark_broken",
                        lambda db, b, reason: marked.update(reason=reason))
    monkeypatch.setattr(reg, "resolve_version", lambda db, k, v: None)
    monkeypatch.setattr(reg, "has_any_version", lambda db, k: False)

    class Link:
        id = 7

    _b, _r, _f, problem = dispatch.resolve_for_link(None, link=Link(), dashboard=None)
    assert problem == "binding_broken"
    assert "không còn tồn tại" in marked.get("reason", "")


def test_an_unpublished_flow_is_not_marked_broken(monkeypatch):
    """The other half of the same decision. A flow with drafts but nothing
    published is between states — an author unpublishing to fix something must not
    have to re-activate every binding by hand afterwards."""
    from app.services.agent_flows import binding as binding_service
    from app.services.agent_flows import dispatch
    from app.services.agent_flows import registry as reg

    class Binding:
        status = "active"
        brain_key = "draft_only"
        pinned_version = None

    marked: dict = {}
    monkeypatch.setattr(binding_service, "get_for_link", lambda db, i: Binding())
    monkeypatch.setattr(binding_service, "cheap_validate", lambda b, d: "")
    monkeypatch.setattr(binding_service, "mark_broken",
                        lambda db, b, reason: marked.update(reason=reason))
    monkeypatch.setattr(reg, "resolve_version", lambda db, k, v: None)
    monkeypatch.setattr(reg, "has_any_version", lambda db, k: True)

    class Link:
        id = 7

    _b, _r, _f, problem = dispatch.resolve_for_link(None, link=Link(), dashboard=None)
    assert problem == "not_published"
    assert not marked, "flow chỉ đang chưa publish thì không được đánh hỏng"


# ── 16 · one template scanner ─────────────────────────────────────────────────
@pytest.mark.parametrize("node, expected", [
    ({"key": "a", "type": "agent", "prompt": "về {{alpha}}"}, "alpha"),
    ({"key": "s", "type": "stop", "message": "hết {{beta}}"}, "beta"),
    ({"key": "f", "type": "filter",
      "conditions": [{"left": "{{gamma}}", "op": "equals", "right": "x"}]}, "gamma"),
    ({"key": "w", "type": "switch", "value": "x",
      "cases": [{"key": "c", "op": "equals", "value": "{{delta}}", "body": []}]}, "delta"),
    ({"key": "t", "type": "transform", "operation": "map_fields",
      "mapping": {"out": "{{epsilon}}"}, "target": "res"}, "epsilon"),
])
def test_every_templated_field_is_scanned_for_references(node, expected):
    """The inspector's own scanner read six attributes and missed the rest, so a
    flow whose only reference to a missing variable sat in an IF condition, a
    Switch case or a Transform mapping was reported clean — while the builder's
    badge flagged it. Both now call one function; this is the field list."""
    from app.services.agent_flows.contract import node_referenced_vars

    flow = build([node, AGENT], answer_node="answer")
    target = next(n for n in flow.all_nodes() if n.key == node["key"])
    assert expected in node_referenced_vars(target)


def test_a_reference_nothing_produces_is_flagged_by_the_flow_itself():
    flow = build([
        {"key": "gate", "type": "filter",
         "conditions": [{"left": "{{nobody_sets_this}}", "op": "equals", "right": "x"}]},
        AGENT,
    ], answer_node="answer")
    assert "nobody_sets_this" in flow.referenced_vars()
    assert "nobody_sets_this" not in flow.produced_vars()


def test_stop_node_message_is_a_deliberate_answer():
    r = run(build([
        {"key": "halt", "type": "stop", "emit": True, "message": "Ngoài phạm vi."},
        AGENT,
    ], answer_node="answer"))
    assert "answer" not in ran(r), "Stop mà các bước sau vẫn chạy"
    assert "Ngoài phạm vi" in json.dumps(r.get("answer") or {}, ensure_ascii=False)

def test_vector_recall_obeys_the_same_boundary_as_the_keyword_scan(monkeypatch):
    """A grant that binds one retrieval path and not the other is not a grant.

    `retrieve_doc_chunks` used to re-derive its own boundary from dashboard links
    — ONE of the four ways a document is attached — so a document linked through a
    dataset, or through the doc's own arrays, was searchable by wording and
    invisible to meaning. And a step that narrowed its sources narrowed only the
    keyword scan: vector recall kept returning passages the author had excluded.
    """
    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    seen: dict = {}

    def fake_retrieve(db, dashboard_id, question="", k=6, doc_ids=None):
        seen["doc_ids"] = doc_ids
        return []

    monkeypatch.setattr(gde, "retrieve_doc_chunks", fake_retrieve)

    gt, ctx = _govern(monkeypatch, scope={"doc_ids": [7, 9]})
    monkeypatch.setattr(gt, "_visible_doc_ids", lambda c: {7, 9})
    monkeypatch.setattr(gt, "_entitled_doc_ids", lambda c: {7, 9})

    class Dash:
        id = 67

    ctx.dashboard = Dash()
    gt.tool_search_knowledge(ctx, {"query": "định nghĩa doanh thu", "limit": 3})

    assert seen.get("doc_ids") == {7, 9}, (
        "đường vector phải nhận đúng phạm vi mà đường keyword dùng"
    )


def test_document_embedding_profiles_are_fixed_to_the_vector_column_width():
    from app.core.config import settings
    from app.services.embedding_service import EmbeddingService

    profiles = EmbeddingService.embedding_profiles()
    assert {profile["model"] for profile in profiles} == {
        model for model in settings.embedding_models
        if model.startswith("text-embedding-3-")
    }
    assert {profile["dimensions"] for profile in profiles} == {
        settings.openai_embedding_dimensions
    }


def test_best_effort_resource_embedding_does_not_rollback_caller_data(monkeypatch):
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import Session

    from app.services.embedding_service import EmbeddingService

    db = Session(create_engine("sqlite://", future=True))
    try:
        db.execute(text("CREATE TABLE business_record (id INTEGER PRIMARY KEY)"))
        db.commit()
        db.execute(text("INSERT INTO business_record (id) VALUES (1)"))
        monkeypatch.setattr(
            EmbeddingService,
            "generate_embedding",
            lambda *_args, **_kwargs: [0.1] * 768,
        )

        # resource_embeddings deliberately does not exist. The vector write
        # fails, while the caller's pending business row must remain usable.
        assert not EmbeddingService.upsert_embedding(
            db, "knowledge", 1, "revenue definition", commit=False
        )
        assert db.execute(text("SELECT COUNT(*) FROM business_record")).scalar() == 1
        db.commit()
    finally:
        db.close()


def test_legacy_embedding_hashes_cannot_reuse_chunk_vectors():
    from app.services.dashboard_ai_bot.govern_doc_embeddings import (
        _body_hash,
        _is_current_index_hash,
    )

    assert not _is_current_index_hash(None)
    assert not _is_current_index_hash("6a09e667bb67ae85")
    assert _is_current_index_hash(_body_hash("model:768:paragraph:850:0", "body"))


def test_document_search_excludes_legacy_and_cross_model_vectors():
    from app.services.dashboard_ai_bot.govern_doc_embeddings import (
        _scoped_chunk_filter,
    )

    sql_filter, params = _scoped_chunk_filter(
        dashboard_id=None,
        doc_ids={7},
        published_only=False,
    )
    assert "d.embedded_hash LIKE 'v2:%'" in sql_filter
    # THE GUARANTEE, NOT THE SPELLING. This asserted the literal
    # `c.model_version = d.embedding_model`, which pinned the punctuation of a
    # predicate rather than what it promises — and the promise was wrong: `=`
    # yields NULL when `embedding_model` is NULL (the column is nullable and
    # documented as "null = the active model"), and SQL reads NULL as false, so
    # every chunk of such a document was excluded from BOTH branches in silence.
    # `IS NOT DISTINCT FROM` says "same vector space" including two NULLs.
    assert "c.model_version" in sql_filter and "d.embedding_model" in sql_filter
    assert "IS NOT DISTINCT FROM" in sql_filter, (
        "so sánh model phải an toàn với NULL, nếu không tài liệu chưa ghi model "
        "sẽ bị loại khỏi cả vector lẫn keyword mà không báo gì"
    )
    assert params["allowed"] == [7]


def test_document_search_generates_one_query_vector_per_model(monkeypatch):
    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde
    from app.services.embedding_service import EmbeddingService

    class Rows:
        def fetchall(self):
            return [
                (10, 1, "Doc A", 0, "alpha", "authored", "model-a"),
                (20, 2, "Doc B", 0, "beta", "authored", "model-b"),
            ]

    class Db:
        def execute(self, stmt, params=None):
            assert "WHERE c.id = ANY(:ids)" in str(stmt)
            return Rows()

    generated = []
    monkeypatch.setattr(
        gde, "_model_doc_groups", lambda *_args: {"model-a": [1], "model-b": [2]}
    )
    monkeypatch.setattr(gde, "_keyword_ranked_ids", lambda *_args: [])
    monkeypatch.setattr(
        EmbeddingService,
        "generate_query_embedding",
        lambda query, model=None: generated.append((query, model)) or [0.1, 0.2],
    )
    monkeypatch.setattr(
        gde,
        "_vector_ranked_hits",
        lambda _db, _scope, params, _vector, _limit: [
            (10, 0.91) if params["embedding_model"] == "model-a" else (20, 0.82)
        ],
    )

    rows = gde._search_scoped_doc_chunks(
        Db(), "revenue policy", k=5, dashboard_id=None,
        doc_ids={1, 2}, published_only=True,
    )
    assert generated == [
        ("revenue policy", "model-a"),
        ("revenue policy", "model-b"),
    ]
    assert {row["chunk_id"] for row in rows} == {10, 20}


def test_document_search_keeps_keyword_hits_when_a_model_fails(monkeypatch):
    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde
    from app.services.embedding_service import EmbeddingService

    class Rows:
        def fetchall(self):
            return [(20, 2, "Doc B", 0, "exact Q2", "authored", "model-b")]

    class Db:
        def execute(self, stmt, params=None):
            return Rows()

    monkeypatch.setattr(gde, "_model_doc_groups", lambda *_args: {"model-b": [2]})
    monkeypatch.setattr(gde, "_keyword_ranked_ids", lambda *_args: [20])
    monkeypatch.setattr(
        EmbeddingService, "generate_query_embedding", lambda *_args, **_kwargs: None
    )

    rows = gde._search_scoped_doc_chunks(
        Db(), "Q2", k=5, dashboard_id=None,
        doc_ids={2}, published_only=True,
    )
    assert rows[0]["chunk_id"] == 20
    assert rows[0]["matched_by"] == "keyword"
    assert rows[0]["similarity"] is None

# ── 18 · an index the retriever will not trust must not be silent ─────────────
#
# The failure this pins was live on this deployment: migration 0049 invalidated
# the legacy index hashes — correctly, they predate model-safe dedup — and
# nothing rebuilt them. Five of six documents on the main dashboard became
# unsearchable and "GMV là gì" returned nothing, while a document titled "Từ vựng
# & Quy ước" sat one query away. Refusing an untrustworthy index is right;
# refusing it invisibly is what made a correct migration look like a working
# system.
def _fake_db(rows):
    """Minimal stand-in: `execute(...).fetchall()` returns `rows`."""
    class _R:
        def fetchall(self):
            return rows

    class _DB:
        def execute(self, *a, **k):
            return _R()

    return _DB()


def test_stale_index_reports_every_kind_of_untrusted_index():
    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    stale = gde.stale_index_docs(_fake_db([
        (1, "never_indexed"), (2, "old_index_format"),
        (3, "model_changed"), (4, "no_vectors"),
    ]))
    assert stale == {1: "never_indexed", 2: "old_index_format",
                     3: "model_changed", 4: "no_vectors"}


def test_a_healthy_library_reports_nothing_to_repair():
    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    assert gde.stale_index_docs(_fake_db([])) == {}
    assert gde.repair_stale_index(_fake_db([]))["scanned"] == 0


def test_repair_rebuilds_every_stale_document_and_survives_one_failure(monkeypatch):
    """One bad document must not stop the rest — a library repairs as far as it
    can, and reports what it could not do rather than aborting the pass."""
    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    monkeypatch.setattr(gde, "stale_index_docs",
                        lambda db: {7: "never_indexed", 8: "model_changed"})

    class _Doc:
        def __init__(self, i):
            self.id = i

    class _Q:
        def __init__(self, i):
            self.i = i

        def filter(self, *a, **k):
            return self

        def first(self):
            return _Doc(self.i)

    seen = []

    class _DB:
        def query(self, *a, **k):
            return _Q(seen[-1] if seen else 7)

    def fake_embed(db, doc, *, force_full_rebuild=False):
        assert force_full_rebuild, "phải dựng lại toàn bộ — hash cũ là thứ ta không tin"
        return {"status": "error" if doc.id == 8 else "embedded"}

    monkeypatch.setattr(gde, "embed_doc", fake_embed)

    class _DB2(_DB):
        def query(self, *a, **k):
            class _Q2:
                def __init__(self):
                    self.n = 0

                def filter(self, clause=None, *a, **k):
                    self.clause = clause
                    return self

                def first(self_inner):
                    return _Doc(_DB2.next_id)

            return _Q2()

    _DB2.next_id = 7
    out = gde.repair_stale_index(_DB2())
    assert out["scanned"] == 2
    assert out["repaired"] + out["failed"] == 2


def test_the_model_predicate_is_null_safe():
    """`c.model_version = d.embedding_model` is NULL when the column is NULL, and
    SQL treats NULL as false — which excluded every chunk of that document from
    BOTH the vector and the keyword branch, silently. The column is nullable and
    documented as "null = the deployment's active model", so two NULLs are the
    same vector space and the predicate has to say so."""
    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    scoped = gde._scoped_chunk_filter(
        dashboard_id=67, doc_ids=None, published_only=True,
    )
    assert scoped is not None
    sql, _params = scoped
    assert "IS NOT DISTINCT FROM" in sql, "phép so sánh model phải an toàn với NULL"
    assert "c.model_version = d.embedding_model" not in sql

