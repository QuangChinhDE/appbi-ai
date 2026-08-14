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


# ── 15 · the node list is frozen, and the two halves must agree ───────────────
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
