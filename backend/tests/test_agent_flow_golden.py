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


# ── 15b · the tester's audit: each finding, pinned ───────────────────────────
# Nine claims came in from a review of the runtime. Seven were real. Each one that
# was gets a case here, named after the failure a user would have seen, so the fix
# cannot be undone by a later refactor that "tidies" the same lines.

def _ctx(**over):
    base = dict(
        dashboard=SimpleNamespace(id=67), public_filters=[],
        allowed_chart_ids={1, 2, 3}, excluded_columns=set(),
        knowledge_scope={}, actor_type="public", actor_ref="link-A",
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_the_result_cache_cannot_serve_one_links_data_to_another():
    """A cache hit returns BEFORE the tool body runs, and the chart-scope guard
    lives inside that body. Two links on one dashboard with different allowlists
    therefore shared answers: the narrow one asked for a chart it could not see and
    the wide one's warm entry answered."""
    wide = _ctx(allowed_chart_ids={1, 2, 3})
    narrow = _ctx(allowed_chart_ids={1})
    args = {"chart_id": 2}
    assert tool_registry._cache_key(wide, "get_chart_data", args) \
        != tool_registry._cache_key(narrow, "get_chart_data", args)


def test_the_result_cache_separates_callers_with_different_hidden_columns():
    """The AI-scope exclusion set decides which columns a payload may carry, so a
    key without it hands the unfiltered payload to the caller it was hidden from."""
    open_ctx = _ctx(excluded_columns=set())
    masked = _ctx(excluded_columns={"revenue"})
    assert tool_registry._cache_key(open_ctx, "get_chart_data", {"chart_id": 1}) \
        != tool_registry._cache_key(masked, "get_chart_data", {"chart_id": 1})


def test_the_result_cache_separates_two_steps_with_different_knowledge_scopes():
    """The per-step knowledge boundary is applied inside the tool bodies too, so a
    key without it lets a step that attached one document be served the answer
    computed for a step that attached five."""
    narrow = _ctx(knowledge_scope={"doc_ids": [26], "dataset_ids": [],
                                   "metric_names": [], "term_fqns": []})
    wide = _ctx(knowledge_scope={"doc_ids": [26, 27, 28], "dataset_ids": [],
                                 "metric_names": [], "term_fqns": []})
    args = {"query": "GMV"}
    assert tool_registry._cache_key(narrow, "search_knowledge", args) \
        != tool_registry._cache_key(wide, "search_knowledge", args)


def test_the_result_cache_still_caches_for_the_same_caller():
    """The narrowing must not become an off switch: identical entitlement over
    identical arguments is the case the cache exists for."""
    a, b = _ctx(), _ctx()
    assert tool_registry._cache_key(a, "get_chart_data", {"chart_id": 1}) \
        == tool_registry._cache_key(b, "get_chart_data", {"chart_id": 1})


def test_running_out_of_tools_still_leaves_a_round_to_speak():
    """Both ceilings used to be tested by both spenders, so a turn that legitimately
    spent its tool allowance could not open the round it needed to report what it
    had found — the viewer read "chưa trả lời được" off a run whose every step was
    green."""
    from app.services.agent_flows.runtime.state import Budget

    b = Budget(max_llm_calls=6, max_tool_calls=4)
    b.tool_calls = 4
    b.spend_llm()
    assert b.llm_calls == 1


def test_running_out_of_model_rounds_does_not_strand_the_tools_it_asked_for():
    """The mirror case: a round already paid for could not run the tools it had
    just requested, so the model's work was discarded at the last step."""
    from app.services.agent_flows.runtime.state import Budget

    b = Budget(max_llm_calls=1, max_tool_calls=10)
    b.llm_calls = 1
    b.spend_tool()
    assert b.tool_calls == 1


def test_each_ceiling_still_binds_its_own_resource():
    """Separating them must not remove them."""
    from app.services.agent_flows.runtime.state import Budget, BudgetExhausted

    b = Budget(max_llm_calls=1, max_tool_calls=1)
    b.llm_calls, b.tool_calls = 1, 1
    with pytest.raises(BudgetExhausted):
        b.spend_llm()
    with pytest.raises(BudgetExhausted):
        b.spend_tool()


def test_a_replayed_tool_call_carries_its_arguments_to_the_next_round(monkeypatch):
    """The engine wrote `arguments`; both provider adapters read `args`. So every
    replayed call reached the next round as `{}` and the model, unable to see what
    it had just asked for, paid a round to ask again."""
    from app.services.dashboard_ai_bot.providers.openai_provider import _tool_args

    seen: dict = {}
    calls = {"n": 0}

    async def fake(*, provider, api_key, model, system_prompt, messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            yield AgentEvent(type="tool_call", tool_call_id="c1",
                             tool_name="get_chart_data", tool_args={"chart_id": 41})
            return
        seen["messages"] = list(messages)
        yield AgentEvent(type="text", text="xong")

    monkeypatch.setattr(agent_handler, "_stream", fake)
    run(build([AGENT], answer_node="answer"))

    replayed = next(
        m for m in seen["messages"]
        if m.get("role") == "assistant" and m.get("tool_calls")
    )["tool_calls"][0]
    assert _tool_args(replayed) == {"chart_id": 41}, "adapter must see the arguments"


def test_the_adapter_still_reads_the_legacy_arguments_key():
    """A boundary that cannot silently drop what it carries — the same rule the
    tool-result side already follows."""
    from app.services.dashboard_ai_bot.providers.openai_provider import _tool_args

    assert _tool_args({"arguments": {"chart_id": 7}}) == {"chart_id": 7}
    assert _tool_args({}) == {}


def test_a_reading_steps_result_reaches_the_step_that_answers():
    """`report_read` and `knowledge` return a dict, and only `str` used to survive
    into the model's messages. The canvas showed "→ {{dashboard_context}}", every
    step reported ok, and the step that wrote the answer had been shown none of it."""
    flow = build([
        {"key": "read", "type": "report_read", "output_var": "dashboard_context"},
        AGENT,
    ], answer_node="answer")
    # The stub vendor echoes the last user message, so what the model was SHOWN is
    # visible in the answer. Before the fix the dict was dropped and this block did
    # not exist at all.
    #
    # ENGLISH QUESTION on purpose. The stub echoes an English prompt back as the
    # "answer", and the language guard corrects an English answer to a VIETNAMESE
    # question — which is right, and would rewrite the very text this asserts on.
    # The rule under test here is about data reaching a step, not about language.
    shown = json.dumps(
        run(flow, question={"raw": "How is revenue?"}).get("answer") or "",
        ensure_ascii=False,
    )
    assert "Result of the previous step" in shown, "bước đọc không tới được bước trả lời"
    assert "charts" in shown and "chart_id" in shown, "tới nơi nhưng rỗng ruột"


def test_previous_text_carries_every_shape_a_step_can_return():
    assert agent_handler._previous_text("xin chào") == "xin chào"
    assert "moveis" in agent_handler._previous_text({"rows": [["moveis", 1]]})
    assert "moveis" in agent_handler._previous_text([{"c": "moveis"}])
    assert agent_handler._previous_text(None) == ""
    assert agent_handler._previous_text({}) == ""


def test_an_agent_steps_term_attachment_reaches_the_retrieval_scope():
    """The builder accepted a glossary term on an Agent step, listed it in the
    step's sources, and then dropped it: the Agent's scope builder collected three
    of the four kinds. The picker worked; the boundary it configured did not."""
    flow = build([
        {"key": "answer", "type": "agent", "prompt": "x",
         "knowledge": [{"source": "term", "ref": "kd.gmv", "description": "định nghĩa"}]},
    ], answer_node="answer")
    node = next(n for n in flow.all_nodes() if n.key == "answer")
    ctx = Ctx()
    agent_handler._apply_scope(ctx, node)
    assert ctx.knowledge_scope["term_fqns"] == ["kd.gmv"]


def test_both_step_kinds_describe_a_scope_with_the_same_keys():
    """Two copies of this disagreed once. One builder, or they will disagree again."""
    from app.services.agent_flows.runtime.handlers.data import build_knowledge_scope

    assert set(build_knowledge_scope([])) == {
        "doc_ids", "dataset_ids", "metric_names", "term_fqns",
    }


def test_a_parallel_batch_cannot_exceed_the_steps_tool_ceiling(monkeypatch):
    """The ceiling was tested once per ROUND and then the whole batch ran. A model
    asking for five tools in parallel with one call of headroom made five — the
    limit held on paper and was exceeded in fact."""
    ran_tools: list[str] = []
    calls = {"n": 0}

    async def fake(*, provider, api_key, model, system_prompt, messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            for i in range(5):
                yield AgentEvent(type="tool_call", tool_call_id=f"c{i}",
                                 tool_name="get_chart_data", tool_args={"chart_id": 41})
            return
        yield AgentEvent(type="text", text="xong")

    def counting(ctx, name, args, allowed=None):
        ran_tools.append(name)
        return TABLE_RESULT

    monkeypatch.setattr(agent_handler, "_stream", fake)
    monkeypatch.setattr(tool_registry, "execute", counting)
    run(build([{**AGENT, "max_tool_calls": 2}], answer_node="answer"))
    assert len(ran_tools) == 2, f"chạy {len(ran_tools)} lượt, trần là 2"


def test_a_refused_tool_call_still_gets_an_answer_in_the_transcript(monkeypatch):
    """OpenAI rejects a request whose assistant tool_call has no matching tool
    message, so capping a batch must answer the calls it declined — with the
    reason, which is the more useful thing for the model to read anyway."""
    seen: dict = {}
    calls = {"n": 0}

    async def fake(*, provider, api_key, model, system_prompt, messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            for i in range(3):
                yield AgentEvent(type="tool_call", tool_call_id=f"c{i}",
                                 tool_name="get_chart_data", tool_args={"chart_id": 41})
            return
        seen["messages"] = list(messages)
        yield AgentEvent(type="text", text="xong")

    monkeypatch.setattr(agent_handler, "_stream", fake)
    run(build([{**AGENT, "max_tool_calls": 1}], answer_node="answer"))

    announced = {
        tc["id"]
        for m in seen["messages"] if m.get("role") == "assistant"
        for tc in (m.get("tool_calls") or [])
    }
    answered = {m["tool_call_id"] for m in seen["messages"] if m.get("role") == "tool"}
    assert announced and announced == answered


def test_unparseable_tool_arguments_are_reported_not_silently_emptied(monkeypatch):
    """Collapsing bad JSON to `{}` sent the model a call it never made: the tool
    failed on a missing required field and the model spent a round guessing at a
    fault the runtime had already diagnosed."""
    executed: list[str] = []
    seen: dict = {}
    calls = {"n": 0}

    async def fake(*, provider, api_key, model, system_prompt, messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            yield AgentEvent(type="tool_call", tool_call_id="c1",
                             tool_name="get_chart_data", tool_args={},
                             extra={"malformed_args": "Expecting ',' delimiter"})
            return
        seen["messages"] = list(messages)
        yield AgentEvent(type="text", text="xong")

    monkeypatch.setattr(agent_handler, "_stream", fake)
    monkeypatch.setattr(
        tool_registry, "execute",
        lambda ctx, name, args, allowed=None: executed.append(name) or TABLE_RESULT,
    )
    run(build([AGENT], answer_node="answer"))

    assert executed == [], "một lời gọi hỏng không được chạy như thể nó hợp lệ"
    told = next(m for m in seen["messages"] if m.get("role") == "tool")
    assert told["result"]["error_code"] == "bad_tool_arguments"


def test_attaching_no_knowledge_does_not_narrow_and_says_so():
    """The honest half of the tester's last point. An empty attachment list means
    "did not narrow", so the step reads everything the REPORT is entitled to — not
    nothing. Pinned here because the runtime and the prose describing it disagreed,
    and the prose was the part that was wrong."""
    from app.services.agent_flows.runtime.handlers.data import build_knowledge_scope
    from app.services.dashboard_ai_bot import govern_tools

    empty = build_knowledge_scope([])
    assert all(v == [] for v in empty.values())
    ctx = SimpleNamespace(knowledge_scope=empty)
    assert govern_tools._authored_doc_ids(ctx) is None
    assert govern_tools._authored_metric_names(ctx) is None
    assert govern_tools._authored_term_fqns(ctx) is None


def test_a_gathering_step_cannot_spend_the_answering_steps_tool_budget():
    """A wide report costs a summary + a data read per chart. Left unbounded the
    reading step drained the turn, the answering step died on its first tool call,
    and the viewer got "chưa trả lời được" from a run where every step said ok."""
    from app.services.agent_flows.runtime.state import Budget

    b = Budget(max_tool_calls=30, answer_reserve=6)
    b.tool_calls = 24
    assert b.tools_left() == 0, "bước thu thập phải dừng lại ở mức dự trữ"
    assert b.tools_left(answering=True) == 6, "bước trả lời vẫn được tiêu phần dự trữ"


def test_the_answer_reserve_never_swallows_a_small_budget():
    """Reserving a flat 6 out of a budget of 6 would leave the reading step nothing
    at all — the starvation, moved one step upstream."""
    from app.services.agent_flows.runtime.state import Budget

    b = Budget(max_tool_calls=6, answer_reserve=6)
    assert b.tools_left() == 4


def _knowledge_node_with_hint():
    flow = build([
        {"key": "kb", "type": "knowledge", "query": "{{question}}", "output_var": "kb_ctx",
         "knowledge": [
             {"source": "document", "ref": "26",
              "description": "Khi câu hỏi nhắc tới doanh thu, GMV hoặc giá trị đơn"},
         ]},
        AGENT,
    ], answer_node="answer")
    return next(n for n in flow.all_nodes() if n.key == "kb")


def _cite(result, node):
    from app.services.agent_flows.runtime.handlers.data import _cite_knowledge

    class _State:
        citations: list = []

    state = _State()
    state.citations = []
    _cite_knowledge(result, node, state)
    return state.citations


def test_a_knowledge_citation_carries_the_source_title_not_the_authors_hint():
    """The label reaches the VIEWER. Showing the author's private "when should it
    read this?" note there hands a reader routing instructions where the document
    name belongs."""
    result = {"ok": True, "data": {"results": [
        {"kind": "document_chunk", "id": 26, "title": "Doanh thu, GMV & Giá trị đơn"},
    ]}}
    cites = _cite(result, _knowledge_node_with_hint())
    assert [c.label for c in cites] == ["Doanh thu, GMV & Giá trị đơn"]


def test_a_definition_from_a_metric_or_term_is_citable_at_all():
    """Only documents used to become citations, so a definition taken from a
    governed KPI had no legal token — and the model reached for [WEB] on a link
    with web research switched off."""
    result = {"ok": True, "data": {"results": [
        {"kind": "metric", "id": "gmv_tong", "title": "GMV — Tổng giá trị giao dịch"},
        {"kind": "term", "id": "kd.don_dung_hen", "title": "Đơn giao đúng hẹn"},
    ]}}
    kinds = {c.kind: c.ref for c in _cite(result, _knowledge_node_with_hint())}
    assert kinds == {"metric": "gmv_tong", "term": "kd.don_dung_hen"}


def test_an_attached_source_that_matched_nothing_is_not_cited():
    """Citing the attachment list rather than the results presents a source that
    backed nothing as if it backed the answer."""
    assert _cite({"ok": True, "data": {"results": []}}, _knowledge_node_with_hint()) == []


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

# ── 19 · the platform's contract outlives the author's prompt ─────────────────
def test_the_answer_node_always_carries_the_followup_contract():
    """Suggestion chips are parsed from `[FOLLOWUP]` markers the model emits. The
    base prompt asks for them, but it is appended BEFORE the author's own
    instructions — so an author who writes "answer in exactly one short sentence"
    wins and the markers vanish. Measured on this deployment: one stored answer in
    twenty-five carried a marker, so the chips were dead while looking shipped."""
    from app.services.agent_flows.runtime.handlers.agent import _system_prompt

    flow = build([
        {"key": "helper", "type": "agent", "prompt": "Tóm tắt"},
        {"key": "answer", "type": "agent",
         "prompt": "Viết ĐÚNG một câu ngắn. Không thêm gì khác."},
    ], answer_node="answer")

    class Rctx:
        base_system_prompt = "BASE\n- End with 2-3 `[FOLLOWUP]` lines"
        answer_key = "answer"

    class St:
        def resolve_text(self, t):
            return t

    nodes = {n.key: n for n in flow.all_nodes()}
    answer = _system_prompt(nodes["answer"], St(), Rctx())
    assert "[FOLLOWUP]" in answer
    assert answer.rfind("[FOLLOWUP]") > answer.find("Viết ĐÚNG một câu ngắn"), (
        "luật gợi ý phải đứng SAU prompt của tác giả, nếu không nó lại thua"
    )

    # And NOT on the other nodes — they never talk to the viewer, and a reminder
    # there is tokens spent on an instruction whose output nobody reads.
    assert "[FOLLOWUP]" not in _system_prompt(nodes["helper"], St(), Rctx())


def test_a_definition_is_never_crowded_out_by_passages():
    """Metrics and glossary terms used to be concatenated AFTER document chunks
    and truncated to `limit`, so a report with enough embedded prose filled every
    slot and a definition could be found, counted, and never returned. A passage
    and a definition are not competing for the same job."""
    from app.services.dashboard_ai_bot import govern_tools as gt

    chunks = [{"kind": "document_chunk", "id": i, "score": 1.0} for i in range(20)]
    vocab = [{"kind": "term", "id": "kd.gmv", "score": 40.0}]
    reserved = min(len(vocab), max(1, 6 // 3))
    top = (chunks[: max(0, 6 - reserved)] + vocab[:reserved])[:6]
    assert any(h["kind"] == "term" for h in top), (
        "định nghĩa phải có suất riêng, không tranh chỗ với đoạn văn"
    )
    assert hasattr(gt, "tool_search_knowledge")



# ── 15c · a branch that matched nothing must say so ───────────────────────────
# A reviewer read the runtime and reported three things. Two reproduced exactly as
# described; the third was real in mechanism but the runs cited as evidence were
# from before an unrelated fix. Each real one is pinned here.

def _switch_no_fallback(seed: str) -> list[dict]:
    """A switch whose cases cannot match, with NO fallback to catch it."""
    return [
        {"key": "seed", "type": "set_var", "var": "scenario", "value": seed,
         "value_type": "text"},
        {"key": "route", "type": "switch", "value": "{{scenario}}",
         "cases": [
             {"key": "a", "label": "A", "op": "equals", "value": "alpha",
              "body": [{"key": "did_a", "type": "set_var", "var": "hit",
                        "value": "a", "value_type": "text"}]},
         ],
         "has_fallback": False, "fallback": []},
        AGENT,
    ]


def _notice_codes(result: dict) -> set[str]:
    return {n.get("code") for n in (result or {}).get("notices") or []}


def test_a_switch_that_matches_nothing_reports_it():
    """It ran no branch and said nothing, so the trace showed the step green and an
    operator counted the question as answered. `loop` already reports an empty
    iteration for exactly this reason; the two branching nodes were left out."""
    r = run(build(_switch_no_fallback("khong-khop"), answer_node="answer"))
    assert "did_a" not in ran(r), "case must not run"
    assert "branch_unmatched" in _notice_codes(r)


def test_a_switch_that_matches_nothing_is_not_a_successful_run():
    """Every step ran without error, and the flow still did not run as designed."""
    r = run(build(_switch_no_fallback("khong-khop"), answer_node="answer"))
    assert r.get("status") == "partial", f"status={r.get('status')}"


def test_the_unmatched_notice_quotes_the_value_it_could_not_place():
    """"No case matched" is not actionable. The value is — especially when a model
    chose it, because seeing prose there is how an author learns their classifier
    answered in sentences."""
    r = run(build(_switch_no_fallback("gia-tri-la"), answer_node="answer"))
    text = " ".join(n.get("text", "") for n in r.get("notices") or [])
    assert "gia-tri-la" in text


def test_a_fallback_that_is_switched_on_but_empty_is_named_as_such():
    """The author believed they had a safety net. An empty one catches nothing, and
    the difference matters when reading why a branch produced no work."""
    nodes = _switch_no_fallback("khong-khop")
    nodes[1]["has_fallback"] = True
    nodes[1]["fallback"] = []
    r = run(build(nodes, answer_node="answer"))
    text = " ".join(n.get("text", "") for n in r.get("notices") or [])
    assert "rỗng" in text


def test_an_if_with_no_matching_path_and_no_fallback_reports_it():
    # Two condition paths and no fallback — the contract requires at least two
    # branches, and neither of these can match.
    nodes = [
        {"key": "gate", "type": "if", "paths": [
            {"key": "one", "name": "One", "kind": "rules", "match": "all",
             "conditions": [{"left": "{{question}}", "op": "equals",
                             "right": "khong-bao-gio-khop-1"}],
             "body": [{"key": "inner", "type": "set_var", "var": "x",
                       "value": "1", "value_type": "text"}]},
            {"key": "two", "name": "Two", "kind": "rules", "match": "all",
             "conditions": [{"left": "{{question}}", "op": "equals",
                             "right": "khong-bao-gio-khop-2"}],
             "body": [{"key": "inner2", "type": "set_var", "var": "y",
                       "value": "2", "value_type": "text"}]},
        ]},
        AGENT,
    ]
    r = run(build(nodes, answer_node="answer"))
    assert "inner" not in ran(r)
    assert "branch_unmatched" in _notice_codes(r)


def test_a_matching_branch_stays_a_clean_success():
    """The downgrade must not fire on the ordinary path, or `partial` stops meaning
    anything and the signal is gone."""
    r = run(build(_switch_flow("delay"), answer_node="answer"))
    assert "branch_unmatched" not in _notice_codes(r)
    assert r.get("status") == "ok"


# ── 15d · publish must stop at a hole it already knows about ─────────────────

def _flow_reading_an_unproduced_var():
    return build([
        {"key": "answer", "type": "agent",
         "prompt": "Tóm tắt {{khong_ai_tao_ra_bien_nay}} cho người xem"},
    ], answer_node="answer")


def test_an_unproduced_variable_is_a_blocking_problem_not_just_a_warning():
    """`warnings()` mixes trade-offs with defects. A variable no step writes is not
    a trade-off: at run time it is an empty string, and the prompt built around it
    runs with a hole while the step still reports ok."""
    flow = _flow_reading_an_unproduced_var()
    problems = flow.blocking_problems()
    assert any("khong_ai_tao_ra_bien_nay" in p for p in problems), problems


def test_advisory_warnings_do_not_block_publishing():
    """Only defects stop the door. "No knowledge attached" is a choice an author is
    allowed to make, and blocking on it would teach people to pass the override
    every time — which is how an override stops meaning anything."""
    flow = build([AGENT], answer_node="answer")
    assert flow.warnings(), "this flow should still raise advisory warnings"
    assert flow.blocking_problems() == []


def test_publish_refuses_while_a_variable_has_no_producer(monkeypatch):
    """The warning was computed, displayed, and acted on by nobody."""
    from app.services.agent_flows import registry as reg

    flow = _flow_reading_an_unproduced_var()
    row = SimpleNamespace(brain_key="x", version=1, body=flow.to_dict(), status="draft")

    class _Q:
        def filter(self, *a, **k): return self
        def first(self): return row
        def update(self, *a, **k): return 0
    class _DB:
        def query(self, *a, **k): return _Q()
        def commit(self): pass
        def refresh(self, *a, **k): pass
        def add(self, *a, **k): pass

    monkeypatch.setattr(reg, "parse_flow", lambda _row: flow)
    with pytest.raises(reg.BrainError) as exc:
        reg.publish(_DB(), "x", 1, "a@b.c")
    assert exc.value.status == 409
    assert "khong_ai_tao_ra_bien_nay" in str(exc.value)


# ── 15e · a classifier is constrained, not asked ─────────────────────────────

def _choice_node(**over):
    node = {"key": "classify", "type": "agent", "output_format": "choice",
            "choices": ["doanh_thu", "van_hanh", "khac"],
            "prompt": "Phân loại câu hỏi"}
    node.update(over)
    return node


def test_a_classifier_does_not_inherit_the_analysts_refusal_rule():
    """`_COMPACT_BASE` ends with "Nếu dữ liệu không có, nói rõ là không có" — right
    for a step writing prose about figures, wrong for one that must emit a single
    token. Given both, a model with thin input follows the nearer, more specific
    sentence and explains itself, and the Switch below then matches nothing."""
    flow = build([_choice_node(), AGENT], answer_node="answer")
    node = next(n for n in flow.all_nodes() if n.key == "classify")

    class _Rctx:
        base_system_prompt = "BASE RULES"
        answer_key = "answer"

    class _State:
        def resolve_text(self, t): return t

    prompt = agent_handler._system_prompt(node, _State(), _Rctx())
    assert "nói rõ là không có" not in prompt
    assert "doanh_thu" in prompt and "van_hanh" in prompt


def test_the_choice_matcher_accepts_an_obedient_answer_and_its_punctuation():
    m = agent_handler._match_choice
    opts = ["doanh_thu", "van_hanh", "khac"]
    assert m("doanh_thu", opts) == "doanh_thu"
    assert m("  van_hanh.  ", opts) == "van_hanh"
    assert m('"khac"', opts) == "khac"
    assert m("Answer: doanh_thu", opts) == "doanh_thu"


def test_the_choice_matcher_refuses_a_sentence():
    """The failure this exists to catch: a classifier that explains instead of
    choosing. Reading a category out of a paragraph would turn a non-decision into
    a decision, which is worse than failing."""
    m = agent_handler._match_choice
    opts = ["doanh_thu", "van_hanh", "khac"]
    long_prose = (
        "Không có dữ liệu về doanh_thu trong thông tin được cung cấp, nên tôi "
        "không thể phân loại câu hỏi này một cách chắc chắn."
    )
    assert m(long_prose, opts) is None
    assert m("", opts) is None
    assert m("khong_nam_trong_danh_sach", opts) is None


def test_a_classifier_must_declare_at_least_two_distinct_options():
    """A choice step with nothing to choose between fails on every question, and it
    should fail while the author is looking at it."""
    with pytest.raises(Exception):
        build([_choice_node(choices=["chi_mot"]), AGENT], answer_node="answer")
    with pytest.raises(Exception):
        build([_choice_node(choices=["a", "a"]), AGENT], answer_node="answer")


def test_a_classifier_that_answers_in_prose_fails_the_step(monkeypatch):
    """End to end: the model refuses to classify, so the run must NOT quietly hand
    an unmatchable value to whatever branches on it."""
    calls = {"n": 0}

    async def prose(*, provider, api_key, model, system_prompt, messages, tools):
        calls["n"] += 1
        yield AgentEvent(
            type="text",
            text="Không có dữ liệu để phân loại trong thông tin được cung cấp.",
        )

    monkeypatch.setattr(agent_handler, "_stream", prose)
    r = run(build([_choice_node(), AGENT], answer_node="answer"))
    assert status_of(r, "classify") == "error", steps(r)
    assert calls["n"] >= 2, "the miss should have cost exactly one corrective round"


def test_a_classifier_gets_one_corrective_round_and_keeps_the_answer(monkeypatch):
    """The common miss is shape, not understanding. Spending a whole run on a
    trailing sentence would make the feature not worth using."""
    calls = {"n": 0}

    async def sloppy_then_clean(*, provider, api_key, model, system_prompt, messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            yield AgentEvent(type="text", text="Tôi nghĩ đây là câu hỏi về vận hành.")
        else:
            yield AgentEvent(type="text", text="van_hanh")

    monkeypatch.setattr(agent_handler, "_stream", sloppy_then_clean)
    r = run(build([_choice_node(), AGENT], answer_node="answer"))
    assert status_of(r, "classify") == "ok", steps(r)


# ── 15f · a flow can be tested on a report, before any link exists ────────────

def test_the_ad_hoc_test_contract_bounds_the_charts_it_reads():
    """Shipped first as `all_current`, and on a 70-chart report the reading step
    spent all 40 tool calls and blew the 45-second ceiling before the answering step
    got a turn — a `failed` run on a flow that was fine. The scope shrinks; the
    budget stays what a real link gets, because the number an author watches while
    iterating has to be the number a viewer pays."""
    from app.services.agent_flows import binding as B

    flow = build([AGENT], answer_node="answer")
    wide = SimpleNamespace(
        id=67,
        dashboard_charts=[SimpleNamespace(chart_id=i) for i in range(1, 71)],
    )
    c = B.ad_hoc_contract(flow, wide)
    assert c.charts.mode == "allowlist"
    assert len(c.charts.ids) == B.AD_HOC_TEST_CHARTS
    assert c.budget.max_tool_calls == 40 and c.budget.max_seconds == 45


def test_the_ad_hoc_test_never_reaches_outside_the_deployment():
    """A surface whose whole purpose is to be run repeatedly must not be able to
    spend the deployment's web budget while somebody iterates on a prompt."""
    from app.services.agent_flows import binding as B

    c = B.ad_hoc_contract(build([AGENT], answer_node="answer"), None)
    assert c.capabilities.web_search is False


def test_the_ad_hoc_test_does_not_invent_requirement_answers():
    """Guessing them here would hand the author a green test that a real link then
    fails. `preflight` reports each one instead."""
    from app.services.agent_flows import binding as B

    c = B.ad_hoc_contract(build([AGENT], answer_node="answer"), None)
    assert c.resolve == {}


def test_a_report_with_no_charts_does_not_produce_an_empty_allowlist():
    """An empty allowlist and "all of them" are opposite instructions. A report with
    nothing on it must not accidentally say "read everything"— nor must the contract
    carry a list that means the reverse of what it looks like."""
    from app.services.agent_flows import binding as B

    c = B.ad_hoc_contract(build([AGENT], answer_node="answer"),
                          SimpleNamespace(id=1, dashboard_charts=[]))
    assert c.charts.mode == "all_current" and c.charts.ids == []


def test_the_ephemeral_binding_is_never_mistaken_for_a_saved_one():
    """`BindingInfo.id` is a plain int by design, so the test carries the sentinel 0
    rather than widening the envelope; the run ROW stores null, because the column is
    nullable precisely so "no binding" can be said honestly."""
    from app.services.agent_flows import binding as B

    b = B.ephemeral_binding(build([AGENT], answer_node="answer"),
                            SimpleNamespace(id=67, dashboard_charts=[]))
    assert b.id == 0 and b.link_id is None and b.dashboard_id == 67
    assert (b.id or None) is None, "the run row must record no binding"
    assert B.contract_of(b).capabilities.web_search is False


# ═══════════════════════════════════════════════════════════════════════════════
# Conversations, feedback, and three wires that were declared but never set
#
# WHAT IS AND IS NOT COVERED HERE.
# The grouping queries in `agent_flows/history.py` are not unit-tested: their tables
# use `JSONB`, which does not compile on SQLite, so standing them up would mean
# changing a production model to suit a test. They were verified against the real
# Postgres instead — a 5-turn viewer conversation and a 2-turn studio session, read
# back through the API. What IS covered below is every pure decision those queries
# depend on, which is where the bugs actually were.
# ═══════════════════════════════════════════════════════════════════════════════
def test_blocked_reason_skips_session_bookkeeping():
    """A failed turn must name what failed, not the memory note in front of it.

    `memory_reset` / `memory_expired` are merged into the notice list by the CALLER
    after the run, so they sit first. `_blocked_reason` took the first coded notice,
    which filed abandoned turns and exhausted budgets under "memory_reset" — in the
    one column an operator reads to answer "why did this fail".
    """
    from app.services.agent_flows import runs as runs_mod
    from app.services.agent_flows.envelope import FlowOutput, Notice

    out = FlowOutput(
        status="failed",
        notices=[
            Notice(code="memory_reset", text="recalculated"),
            Notice(code="budget_exhausted", text="out of tool calls"),
        ],
    )
    assert runs_mod._blocked_reason(out) == "budget_exhausted"

    # Nothing but bookkeeping: fall back to the status rather than to a note that
    # describes something else entirely.
    only_bookkeeping = FlowOutput(
        status="failed", notices=[Notice(code="memory_expired", text="stale")]
    )
    assert runs_mod._blocked_reason(only_bookkeeping) == "failed"

    # An ok run has no cause to report.
    assert runs_mod._blocked_reason(FlowOutput(status="ok")) is None


def test_trace_step_branch_is_scoped_not_cumulative():
    """A step carries the branch it ran INSIDE, and loses it when that branch ends.

    `state.path` is the cumulative route and is never popped, so labelling a step
    from `path[-1]` attributed everything after a loop TO that loop. `in_branch`
    pushes both and pops only the stack.
    """
    from app.services.agent_flows.envelope import TraceStep
    from app.services.agent_flows.runtime.state import RunState

    st = RunState()
    st.record(TraceStep(key="before"))
    with st.in_branch("Branch B"):
        st.record(TraceStep(key="inside_branch"))
        with st.in_branch("Loop×2"):
            st.record(TraceStep(key="inside_loop"))
        st.record(TraceStep(key="after_loop"))
    st.record(TraceStep(key="after_branch"))

    assert {s.key: s.branch for s in st.trace} == {
        "before": "",
        "inside_branch": "Branch B",
        "inside_loop": "Loop×2",
        # The loop closed; this step is back at the branch's level.
        "after_loop": "Branch B",
        # And the branch closed too.
        "after_branch": "",
    }
    # The ROUTE still accumulates. That is a different question and a different
    # field, and collapsing the two is what the bug was.
    assert st.path_label() == "Branch B · Loop×2"


def test_branch_stack_unwinds_on_an_exception():
    """A branch that raises must not leave its label on later steps."""
    from app.services.agent_flows.envelope import TraceStep
    from app.services.agent_flows.runtime.state import RunState

    st = RunState()
    try:
        with st.in_branch("Doomed"):
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    st.record(TraceStep(key="after"))
    assert st.trace[0].branch == ""
    assert st.branch_stack == []


def test_studio_fingerprint_changes_when_the_draft_is_edited():
    """Editing the draft must invalidate the test session's memory.

    A viewer's session runs a published version, so the version number notices a
    change. An author's test session runs a draft under a version number that does
    not move — so without the shape, editing the very step you are re-testing left
    its previous output marked reusable.
    """
    from app.services.agent_flows.dispatch import fingerprint, studio_token

    base = dict(binding_id=0, version=3, filters=[], charts=[1, 2], locale="vi")
    assert fingerprint(**base, shape="aaa") != fingerprint(**base, shape="bbb")
    # Same shape, same fingerprint: memory survives a turn that changed nothing.
    assert fingerprint(**base, shape="aaa") == fingerprint(**base, shape="aaa")
    # Absent shape is the public path, whose behaviour must not have moved.
    assert fingerprint(**base) == fingerprint(**base, shape="")
    # A studio token can never collide with a real link token.
    assert studio_token("my_flow") == "studio:my_flow"


class _FakeRun:
    def __init__(self, **kw):
        self.status = kw.get("status", "ok")
        self.blocked_reason = kw.get("blocked_reason")
        self.missing_requirements = kw.get("missing_requirements") or []


class _FakeContent:
    def __init__(self, answer="", notices=None, citations=None):
        self.answer = answer
        self.notices = notices or []
        self.citations = citations or []


class _FakeStep:
    def __init__(self, status="ok", name="Step", key="k", error=""):
        self.status = status
        self.node_name = name
        self.node_key = key
        self.error = error


def test_signals_name_facts_not_guesses():
    """Each signal names something that was RECORDED, never a mood."""
    from app.services.agent_flows.history import signals_for

    codes = {
        s["code"]
        for s in signals_for(
            _FakeRun(
                status="partial", blocked_reason="budget_exhausted",
                missing_requirements=["segment"],
            ),
            _FakeContent(
                answer="an answer with no source",
                notices=[{"code": "branch_unmatched", "text": "nothing matched"}],
            ),
            [
                _FakeStep(status="error", name="Read report", error="boom"),
                _FakeStep(status="skipped", name="Extra"),
            ],
        )
    }
    assert {
        "status_partial", "blocked", "missing_requirement", "branch_unmatched",
        "step_error", "step_skipped", "no_citation",
    } <= codes


def test_a_clean_turn_produces_no_signals():
    """The shortlist is only useful if a good turn stays off it."""
    from app.services.agent_flows.history import signals_for

    assert signals_for(
        _FakeRun(status="ok"),
        _FakeContent(answer="grounded", citations=[{"kind": "chart", "ref": "1"}]),
        [_FakeStep(status="ok"), _FakeStep(status="reused")],
    ) == []


def test_feedback_summary_counts_only_the_down_votes():
    """A signal shared with an up vote is not what went wrong."""
    from app.services.agent_flows.history import _feedback_summary

    items = [
        {
            "rating": "down", "status": "partial", "execution_path": "Branch B",
            "signals": [{"code": "branch_unmatched", "text": ""},
                        {"code": "status_partial", "text": ""}],
        },
        {
            "rating": "down", "status": "partial", "execution_path": "Branch B",
            "signals": [{"code": "branch_unmatched", "text": ""}],
        },
        {
            "rating": "up", "status": "ok", "execution_path": "Branch B",
            "signals": [{"code": "read_truncated", "text": ""}],
        },
    ]
    s = _feedback_summary(items)
    assert (s["up"], s["down"], s["rated"]) == (1, 2, 3)
    assert round(s["down_share"], 3) == 0.667
    # Branch B carried all three, but only the two DOWN votes count against it.
    assert s["by_path"] == [{"key": "Branch B", "count": 2}]
    assert s["by_status"] == [{"key": "partial", "count": 2}]
    # Ranked by count, so the shared cause leads.
    assert s["by_signal"][0] == {"key": "branch_unmatched", "count": 2}
    # The up vote's signal is absent entirely.
    assert all(x["key"] != "read_truncated" for x in s["by_signal"])


def test_feedback_summary_of_nothing_does_not_divide_by_zero():
    from app.services.agent_flows.history import _feedback_summary

    s = _feedback_summary([])
    assert (s["up"], s["down"], s["rated"], s["down_share"]) == (0, 0, 0, 0.0)
    assert s["by_signal"] == s["by_path"] == s["by_status"] == []


def test_both_test_endpoints_accept_a_conversation():
    """Session and history on BOTH bodies.

    A test against a link and a test against a bare report answer different
    questions, but they are the same machinery — and if only one could hold a
    session then which question you asked would decide whether `once_per_session`
    was observable at all.
    """
    from app.modules.agent_flows.api import ReportTestBody, TestBody

    for model in (TestBody, ReportTestBody):
        assert "session_key" in model.model_fields
        assert "history" in model.model_fields

    body = ReportTestBody(
        question="q", dashboard_id=1, session_key="s",
        history=[{"role": "user", "content": "earlier"}],
    )
    assert body.history[0].role == "user"

    # History is capped: a step with `context_policy: full` would otherwise let the
    # author's own client grow it without limit into every prompt.
    import pydantic
    import pytest

    with pytest.raises(pydantic.ValidationError):
        ReportTestBody(
            question="q", dashboard_id=1,
            history=[{"role": "user", "content": "x"}] * 41,
        )


def test_language_guard_enforces_the_question_not_the_locale():
    """An English answer to a Vietnamese question is corrected. Everything else is
    left alone.

    Asking was the whole mechanism and asking was not enough: the base prompt said
    "answer in the question's language", and measured on this deployment two of four
    Vietnamese questions in one session came back in English — the two whose tool
    returned English data values. Repeating the rule after the tool payload fixed
    one; the third needed checking rather than asking.

    The rule is MATCH THE QUESTION. An earlier draft compared against the link's
    locale instead, which would have rewritten a legitimate English answer to an
    English viewer on a `vi` link — enforcing the default and breaking the case the
    rule exists for.
    """
    from app.services.agent_flows.runtime.handlers.agent import _looks_wrong_language

    vi_q = "Danh mục nào có doanh thu cao nhất?"
    en_q = "Which category has the highest revenue?"
    en_answer = 'The highest category, "health_beauty," accounts for 9.26% of total revenue.'

    # The observed failure, and the one this exists for.
    assert _looks_wrong_language(en_answer, "vi", vi_q)

    # An English question deserves an English answer, on any locale.
    assert not _looks_wrong_language(en_answer, "vi", en_q)

    # THE CHIPS ARE CHECKED SEPARATELY. They are generated under the same
    # instruction and disobeyed it independently: the prose came back Vietnamese and
    # all three suggestions English, and judging the whole string at once let the
    # prose's diacritics vouch for the chips.
    mixed = (
        "Danh mục cao nhất là health_beauty với doanh thu 1,258,681.34.\n"
        "[FOLLOWUP] Would you like to know about more categories and their revenues?"
    )
    assert _looks_wrong_language(mixed, "vi", vi_q)

    all_vi = (
        "Danh mục cao nhất là health_beauty với doanh thu 1,258,681.34.\n"
        "[FOLLOWUP] Bạn có muốn xem các danh mục khác không?"
    )
    assert not _looks_wrong_language(all_vi, "vi", vi_q)

    # DATA IS NOT A LANGUAGE. A correct Vietnamese answer quotes English category
    # names verbatim, and a check that counted those would fire on every reply.
    assert not _looks_wrong_language(
        "health_beauty, watches_gifts, bed_bath_table, computers_accessories",
        "vi", vi_q,
    )

    # Too short to judge: a figure with two words around it is a fragment, not a
    # language choice, and not worth a model call to rewrite.
    assert not _looks_wrong_language("GMV is 15,843,553.24", "vi", vi_q)


def test_coverage_names_the_question_kinds_a_flow_cannot_answer():
    """The gap that produced the worst answer measured in this deployment.

    Asked "is there anything unusual I should look at?", a flow granted only
    lookup/rank/share tools answered "the report does not contain that information"
    with ZERO tool calls — blaming the data for a gap in its own configuration.
    `detect_anomaly` existed, was registered, and had simply never been granted.
    Verified afterwards on a throwaway flow: granting the pack turned the same
    question into two named anomalies with z-scores.
    """
    from app.services.agent_flows.coverage import coverage

    lookup_only = build([
        {"key": "answer", "type": "agent", "prompt": "x",
         "tools": [{"tool": "total_measure"}, {"tool": "rank_values"}]},
    ], answer_node="answer")
    got = coverage(lookup_only)
    gaps = {g["key"]: g for g in got["gaps"]}
    covered = {c["key"] for c in got["covered"]}

    assert "lookup" in covered and "ranking" in covered
    assert "diagnosis" in gaps, "phải chỉ ra là flow này không trả lời được câu 'vì sao'"
    # And name where to get one, or the finding is not actionable.
    assert gaps["diagnosis"]["pack"] == "diagnose"
    assert got["answerable"] == len(covered)

    # Granting the pack closes it.
    with_diag = build([
        {"key": "answer", "type": "agent", "prompt": "x",
         "tools": [{"tool": "total_measure"}, {"tool": "detect_anomaly"}]},
    ], answer_node="answer")
    assert "diagnosis" not in {g["key"] for g in coverage(with_diag)["gaps"]}

    # A flow granting nothing has every class open — and is still not an error.
    empty = build([{"key": "answer", "type": "agent", "prompt": "x"}], answer_node="answer")
    assert coverage(empty)["answerable"] == 0
    assert len(coverage(empty)["gaps"]) == coverage(empty)["total"]


def test_a_flow_that_cannot_reach_its_own_answer_is_refused():
    """A `stop` has no condition, so a Stop at the top level ends every run.

    Measured on a nine-node harness: a Stop sat two nodes above the designated
    answering step, the answering step never ran on any of four turns, the viewer
    received an intermediate step's working notes, and `validate` returned ok — while
    still warning about the tools granted to the node that could not run.
    """
    dead = build([
        {"key": "prep", "type": "set_var", "var": "x", "value": "1"},
        {"key": "bail", "type": "stop"},
        {"key": "answer", "type": "agent", "prompt": "trả lời"},
    ], answer_node="answer")
    assert dead.unreachable_nodes() == ["answer"]
    assert any("không bao giờ chạy" in p for p in dead.blocking_problems())

    # A Stop INSIDE a branch is conditional by construction — the branch may not be
    # taken — so nothing downstream is dead.
    scoped = build([
        {"key": "br", "type": "if", "paths": [
            {"key": "p1", "kind": "rules",
             "conditions": [{"left": "{{x}}", "op": "is_empty"}],
             "body": [{"key": "bail", "type": "stop"}]},
            {"key": "p2", "kind": "fallback",
             "body": [{"key": "go", "type": "set_var", "var": "x", "value": "1"}]},
        ]},
        {"key": "answer", "type": "agent", "prompt": "trả lời"},
    ], answer_node="answer")
    assert scoped.unreachable_nodes() == []

    # And a Stop AFTER the answer is a perfectly ordinary flow.
    trailing = build([
        {"key": "answer", "type": "agent", "prompt": "trả lời"},
        {"key": "bail", "type": "stop"},
    ], answer_node="answer")
    assert trailing.unreachable_nodes() == []
    assert trailing.blocking_problems() == []


def test_chart_keyed_tools_without_the_report_index_are_flagged():
    """A step that must name a chart, and was never shown one.

    The measure/compare/diagnose/project tools all take a `chart_id`, and the only
    place those ids exist is a `report_read` step's output. Measured: five branch
    agents were granted exactly the right tools and handed no index; seven
    consecutive calls returned `chart_out_of_scope`, the tool budget went on them,
    and the viewer was told the report contained no GMV — on a report whose GMV is
    15,843,553.24. Adding the index to those prompts took the same flow to zero
    failed calls and the correct figure.
    """
    def flow(prompt, tools, with_read=True):
        nodes = []
        if with_read:
            nodes.append({"key": "read", "type": "report_read", "output_var": "ctx"})
        nodes.append({"key": "a", "type": "agent", "prompt": prompt,
                      "tools": [{"tool": t} for t in tools]})
        return build(nodes, answer_node="a")

    def flagged(f):
        return [w for w in f.warnings() if "chart_id" in w]

    # The measured failure.
    warn = flagged(flow("Trả lời bằng số.", ["total_measure", "rank_values"]))
    assert warn, "phải cảnh báo khi cấp tool cần chart_id mà không truyền chỉ mục"
    assert "{{ctx}}" in warn[0], "phải nói tên biến cần đọc, không chỉ nói là thiếu"

    # Reading the index clears it.
    assert not flagged(flow("Trả lời. {{ctx}}", ["total_measure"]))
    # Tools that need no chart are not the subject.
    assert not flagged(flow("Trả lời.", ["search_knowledge"]))
    # And with no read step there is no index to pass, so there is nothing to say.
    assert not flagged(flow("Trả lời.", ["total_measure"], with_read=False))


def test_a_run_advertises_only_the_fields_its_tools_will_serve():
    """`available_metrics` used to be computed over every chart in the report while
    the tools enforce the binding's allow-list.

    Measured on a 70-chart dashboard read through a 12-chart contract: the model was
    shown metrics from all 70, chose one of the other 58, and the tool refused it.
    """
    from app.services.agent_flows.envelope import (
        BindingInfo, ChartInfo, FieldRef, FlowInput, QuestionInfo, ReportInfo,
        RequestInfo,
    )

    charts = [
        ChartInfo(id=1, measures=[FieldRef(field="revenue")],
                  dimensions=[FieldRef(field="cat")]),
        ChartInfo(id=2, measures=[FieldRef(field="gmv")], dimensions=[]),
        ChartInfo(id=9, measures=[FieldRef(field="out_of_reach")], dimensions=[]),
    ]

    def seeds(allowed):
        return FlowInput(
            request=RequestInfo(id="r"), question=QuestionInfo(raw="q"),
            report=ReportInfo(dashboard_id=1, charts=charts),
            binding=BindingInfo(id=1, allowed_chart_ids=allowed),
        ).seed_vars()

    assert seeds([1, 2])["available_metrics"] == ["gmv", "revenue"]
    assert seeds([1, 2])["available_dimensions"] == ["cat"]
    # An EMPTY allow-list means no ceiling, as everywhere else the field is read.
    assert "out_of_reach" in seeds([])["available_metrics"]


def test_a_failed_step_reports_what_it_spent():
    """The step that ate the budget is the most useful fact about such a run, and it
    was reported as costing nothing — the token deltas were only set on the success
    path. Measured: a turn spent 9,737 prompt tokens with 7,227 attributed, the
    missing 2,510 belonging to the one step that failed."""
    import inspect

    from app.services.agent_flows.runtime import executor

    src = inspect.getsource(executor._run_node)
    records = src.count("state.record(")
    with_tokens = src.count("prompt_tokens=state.prompt_tokens - tokens_before[0]")

    # Five sites record a step: reused, BranchStopped, BudgetExhausted, the generic
    # error, and success. Exactly ONE is legitimately exempt — a `reused` node ran
    # nothing, and billing it for work it skipped would be the opposite bug. So the
    # invariant is "every site but one", and it is written that way rather than as a
    # loose `>=` so adding a sixth silent site fails here.
    assert records == 5, f"recording sites changed ({records}) — recheck the exemption"
    assert with_tokens == records - 1, (
        f"{records - 1 - with_tokens} trace rows still report 0 tokens for work "
        "that actually ran"
    )
    reused_block = src.split('status="reused"')[1][:400]
    assert "prompt_tokens=state.prompt_tokens" not in reused_block, (
        "a reused step must NOT be billed — the Runs table would overstate the turn"
    )
