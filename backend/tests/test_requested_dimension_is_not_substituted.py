# -*- coding: utf-8 -*-
"""Asked which STATE, the assistant must not answer about a product category.

    question:  "Bang nào có doanh thu cao nhất?"
    answer:    "health_beauty" — a product CATEGORY

Reproduced live on this branch twice in a row before this file existed. The
arithmetic was right and the semantic dimension was wrong, which is the worst
shape a BI answer can have: indistinguishable from a correct one.

TWO DEFECTS, AND THE FIRST ONE INVALIDATES A PREVIOUS "FIXED".

1. THE MATCHER READ A JSON BLOB. `_charts_on_table` decided `dimension_match` by
   asking whether the column name appeared anywhere in `json.dumps(chart.config)`.
   A real chart config carries the dataset's whole column vocabulary in
   `baseFilters` and friends, so EVERY chart of that dataset "matches" EVERY
   column. Measured on report 67:

       resolve_chart_candidates(measure=total_revenue, dimension=customer_state)
         -> 684 GMV by month          match=both  complete=True
         -> 685 orders by status      match=both  complete=True
         -> 686 revenue by CATEGORY   match=both  complete=True
         -> 687 orders by STATE       match=dimension  complete=False

   The one chart that genuinely groups by state was the only one not reported
   complete, and the identical candidate set came back for
   `dimension=product_category_name_english`. The existing unit test passed
   because its fixture used a hand-built `{"measures": [...], "dimensions": [...]}`
   config with no extraneous columns — a fixture agreeing with the code about a
   payload neither had checked with the producer.

   The structured grouping key already exists: `roleConfig.dimension`, surfaced
   as `ctx.chart_meta[id]["fields"]["dimensions"]` by
   `extract_chart_field_semantics`. The configs below are built in that real
   shape, POLLUTED the way real ones are, and the meta is produced by that real
   extractor rather than written by hand.

2. NOTHING STOPPED THE AGENT ANYWAY. Even with a correct matcher, the answering
   Agent calls `rank_values(chart_id=…)` directly; the report-read step that
   would have resolved the question ran in report-order mode, which is a valid
   authoring choice. So the guard has to sit where the tool is executed, not
   where the charts were chosen.

WHAT IS DELIBERATELY NOT GATED. A question with no breakdown in it. A scalar
tool. A chart outside the binding — that is a SCOPE refusal and must keep its own
reason, because "you may not read this" and "this does not answer what you asked"
send an operator to different places.
"""
from __future__ import annotations

import json
import os

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.agent_flows.tools import registry as R  # noqa: E402
from app.services.agent_flows.tools.context import (  # noqa: E402
    extract_chart_field_semantics,
)
from app.services.agent_flows.tools.packs import discover as D  # noqa: E402


# ── the report, in the shape the database actually stores ───────────────────
#
# `baseFilters` is where the pollution lives: it names columns the chart does NOT
# group by. Drop it and this whole file passes against the broken code.

_POLLUTION = [
    {"field": "dataset_table_441.customer_state", "op": "in", "values": []},
    {"field": "dataset_table_445.product_category_name_english", "op": "in",
     "values": []},
    {"field": "dataset_table_437.order_status", "op": "in", "values": []},
]


def _config(dimension: str, measure: str) -> dict:
    return {
        "chartType": "BAR",
        "dataset_id": 111,
        "queryMode": "role",
        "roleConfig": {
            "metrics": [{"field": measure, "agg": "auto"}],
            "dimension": dimension,
        },
        "baseFilters": list(_POLLUTION),
        "filters": [],
        "styleConfig": {},
    }


CHARTS = {
    684: ("Olist · GMV theo tháng",
          _config("dataset_table_437__order_purchase_date__date_dim.year_month",
                  "dataset_table_438.gmv")),
    685: ("Olist · Đơn theo trạng thái",
          _config("dataset_table_437.order_status",
                  "dataset_table_437.order_count")),
    686: ("Olist · Doanh thu theo danh mục",
          _config("dataset_table_445.product_category_name_english",
                  "dataset_table_438.total_revenue")),
    687: ("Olist · Số đơn theo bang (khách)",
          _config("dataset_table_441.customer_state",
                  "dataset_table_437.order_count")),
    701: ("Olist · Doanh thu theo bang",
          _config("dataset_table_441.customer_state",
                  "dataset_table_438.total_revenue")),
}

CATEGORY_CHART = 686
STATE_ORDERS_CHART = 687
STATE_REVENUE_CHART = 701


class _Chart:
    def __init__(self, cid):
        self.id = cid
        self.name, self.config = CHARTS[cid]
        self.dataset_table_id = 1


class _Query:
    def __init__(self, charts):
        self._charts = charts

    def filter(self, *a, **k):
        return self

    def all(self):
        return self._charts


class _Db:
    def __init__(self, charts):
        self._charts = charts

    def query(self, _model):
        return _Query(self._charts)


class _Ctx:
    """A ToolContext stand-in carrying only what the guard and matcher read."""

    def __init__(self, allowed, question=""):
        self.allowed_chart_ids = set(allowed)
        self.db = _Db([_Chart(c) for c in allowed])
        self.knowledge_scope = {}
        self.question = question
        self.chart_meta = {
            cid: {"name": CHARTS[cid][0],
                  "fields": extract_chart_field_semantics(CHARTS[cid][1])}
            for cid in allowed
        }

    def assert_chart_in_scope(self, chart_id):
        if int(chart_id) not in self.allowed_chart_ids:
            from app.services.dashboard_ai_bot.tool_context import ToolError

            raise ToolError(f"chart {chart_id} is not part of this dashboard")


#: What the governed semantic model declares. `kind` is the fact the whole
#: measure/dimension separation rests on.
FIELDS = [
    {"name": "total_revenue", "label": "Doanh thu", "kind": "measure"},
    {"name": "gmv", "label": "GMV", "kind": "measure"},
    {"name": "order_count", "label": "Số đơn hàng", "kind": "measure"},
    {"name": "customer_state", "label": "Bang", "kind": "dimension"},
    {"name": "product_category_name_english", "label": "Danh mục",
     "kind": "dimension"},
    {"name": "order_status", "label": "Trạng thái đơn", "kind": "dimension"},
]


@pytest.fixture(autouse=True)
def _semantic(monkeypatch):
    monkeypatch.setattr(
        "app.services.dashboard_ai_bot.govern_tools.tool_describe_semantic_model",
        lambda ctx, args: {"ok": True, "data": {"fields": FIELDS}},
        raising=False,
    )
    monkeypatch.setattr(
        "app.services.dashboard_ai_bot.govern_tools._scope",
        lambda ctx: ({1}, {}),
        raising=False,
    )


def resolve(ctx, **args):
    res = D.tool_resolve_chart_candidates(ctx, args)
    assert res.get("ok") is True, res
    return res["data"]


def complete_ids(data):
    return sorted(c["chart_id"] for c in data["candidates"] if c["complete"])


# ── 1. the matcher must read the grouping key, not the blob ─────────────────

def test_the_fixture_really_is_polluted():
    """If this stops holding, every case below is testing a tidy config that the
    database never contains, and the bug walks straight back in."""
    blob = json.dumps(CHARTS[CATEGORY_CHART][1], ensure_ascii=False)
    assert "customer_state" in blob, (
        "the category chart's config no longer mentions customer_state — the "
        "pollution that made a blob substring match meaningless is gone from the "
        "fixture, so this file would pass against the broken matcher"
    )
    fields = extract_chart_field_semantics(CHARTS[CATEGORY_CHART][1])
    dims = [d["field"] for d in fields["dimensions"]]
    assert dims == ["dataset_table_445.product_category_name_english"], dims


def test_revenue_by_state_resolves_only_to_the_state_revenue_chart():
    ctx = _Ctx([684, 685, 686, 687, 701])
    data = resolve(ctx, measure="total_revenue", dimension="customer_state")
    assert complete_ids(data) == [STATE_REVENUE_CHART], (
        f"complete candidates were {complete_ids(data)}; a chart that does not "
        "group by state was reported as a complete answer to a state question"
    )


def test_revenue_by_category_resolves_only_to_the_category_chart():
    ctx = _Ctx([684, 685, 686, 687, 701])
    data = resolve(ctx, measure="total_revenue",
                   dimension="product_category_name_english")
    assert complete_ids(data) == [CATEGORY_CHART]


def test_the_two_questions_do_not_return_the_same_candidate_set():
    """The measured symptom: identical candidates for two different breakdowns."""
    ctx = _Ctx([684, 685, 686, 687, 701])
    by_state = complete_ids(resolve(ctx, measure="total_revenue",
                                    dimension="customer_state"))
    by_category = complete_ids(resolve(ctx, measure="total_revenue",
                                       dimension="product_category_name_english"))
    assert by_state != by_category, (
        f"both breakdowns resolved to {by_state} — the matcher is not reading the "
        "grouping key"
    )


def test_the_right_dimension_with_the_wrong_measure_is_only_half():
    """687 groups by state but measures ORDERS. Asked for revenue by state it is
    a half match, and a half match is not an answer."""
    ctx = _Ctx([684, 685, 686, 687])
    data = resolve(ctx, measure="total_revenue", dimension="customer_state")
    by_id = {c["chart_id"]: c for c in data["candidates"]}
    assert by_id[STATE_ORDERS_CHART]["dimension_match"] is True
    assert by_id[STATE_ORDERS_CHART]["measure_match"] is False
    assert complete_ids(data) == [], (
        "with no revenue-by-state chart authorised, nothing is a complete answer"
    )


def test_a_dimension_only_question_finds_the_charts_grouped_by_it():
    ctx = _Ctx([684, 685, 686, 687, 701])
    data = resolve(ctx, dimension="customer_state")
    assert complete_ids(data) == [STATE_ORDERS_CHART, STATE_REVENUE_CHART]


def test_a_measure_only_question_is_not_given_a_dimension_requirement():
    ctx = _Ctx([684, 685, 686, 687, 701])
    data = resolve(ctx, measure="total_revenue")
    assert complete_ids(data) == [CATEGORY_CHART, STATE_REVENUE_CHART]


def test_a_vietnamese_question_reaches_the_english_field_through_the_semantic_model():
    """The viewer writes `bang` and `doanh thu`; the warehouse columns are
    `customer_state` and `total_revenue`.

    THE TRANSLATION IS NOT `resolve_chart_candidates`' JOB, and asserting that it
    is would pin the wrong layer. `search_business_assets` reads the governed
    semantic model, which is where a Vietnamese label and an English column are
    the same field, and publishes the field's own NAME plus its kind. This case
    walks the real two-step: search, then resolve what search returned.
    """
    ctx = _Ctx([684, 685, 686, 687, 701])
    found = D.tool_search_business_assets(
        ctx, {"query": "bang nào có doanh thu cao nhất", "kinds": ["field"]})
    assert found.get("ok") is True, found

    by_kind = {}
    for asset in (found["data"].get("results") or []):
        if asset.get("type") == "field":
            by_kind.setdefault(asset.get("field_kind"), []).append(asset.get("id"))

    assert "customer_state" in (by_kind.get("dimension") or []), (
        f"the Vietnamese word for state did not reach the English field: {by_kind}"
    )
    assert "total_revenue" in (by_kind.get("measure") or []), by_kind

    data = resolve(ctx, measure="total_revenue", dimension="customer_state")
    assert complete_ids(data) == [STATE_REVENUE_CHART]


# ── 2. the direct-Agent guard ───────────────────────────────────────────────

def _run(ctx, tool, **args):
    return R.execute(ctx, tool, args, allowed=None)


DIMENSION_SENSITIVE = ["rank_values", "share_of", "aggregate_chart_data",
                       "compare_segments", "segment_compare", "get_chart_data"]


@pytest.mark.parametrize("tool", DIMENSION_SENSITIVE)
def test_a_grouped_tool_is_refused_on_a_chart_with_the_wrong_grouping(tool):
    """THE LIVE DEFECT. The question asks for state; the Agent reaches for the
    category chart; the numbers that come back are correct FOR CATEGORIES and
    become an answer about states."""
    ctx = _Ctx([684, 685, 686, 687], question="Bang nào có doanh thu cao nhất?")
    res = _run(ctx, tool, chart_id=CATEGORY_CHART)

    assert res.get("ok") is False, (
        f"{tool} ran on a chart grouped by product category while the question "
        "asked for a breakdown by state"
    )
    assert res.get("error_code") == "dimension_mismatch", res
    assert res.get("retryable") is False, (
        "retrying the same chart cannot change its grouping"
    )
    recovery = str(res.get("recovery") or "") + str(res.get("error") or "")
    assert "resolve_chart_candidates" in recovery, (
        "the refusal must say how to find a chart that DOES group by the "
        "requested dimension, or the model can only guess again"
    )


def test_the_refusal_names_both_dimensions():
    ctx = _Ctx([684, 685, 686, 687], question="Bang nào có doanh thu cao nhất?")
    res = _run(ctx, "rank_values", chart_id=CATEGORY_CHART)
    detail = json.dumps(res, ensure_ascii=False)
    assert "customer_state" in detail and "product_category" in detail, (
        f"the refusal does not say what was asked for and what the chart has: {detail}"
    )


def test_the_agent_recovers_on_a_chart_that_does_group_by_the_request():
    """The guard must leave a way through, or it is an outage rather than a
    correction."""
    ctx = _Ctx([684, 685, 686, 687, 701],
               question="Bang nào có doanh thu cao nhất?")
    res = _run(ctx, "rank_values", chart_id=STATE_REVENUE_CHART)
    assert res.get("error_code") != "dimension_mismatch", res


def test_a_question_with_no_breakdown_gates_nothing():
    """A total is legitimately dimensionless. Gating it would break every KPI
    question on the platform."""
    ctx = _Ctx([684, 685, 686, 687], question="Tổng doanh thu là bao nhiêu?")
    res = _run(ctx, "rank_values", chart_id=CATEGORY_CHART)
    assert res.get("error_code") != "dimension_mismatch", res


def test_a_scalar_tool_is_not_dimension_sensitive():
    ctx = _Ctx([684, 685, 686, 687], question="Bang nào có doanh thu cao nhất?")
    res = _run(ctx, "total_measure", chart_id=CATEGORY_CHART)
    assert res.get("error_code") != "dimension_mismatch", res


def test_a_matching_category_question_is_allowed():
    ctx = _Ctx([684, 685, 686, 687],
               question="Danh mục nào có doanh thu cao nhất?")
    res = _run(ctx, "rank_values", chart_id=CATEGORY_CHART)
    assert res.get("error_code") != "dimension_mismatch", res


def test_an_out_of_scope_chart_keeps_its_scope_reason():
    """Two different problems, two different diagnoses. Collapsing them sends an
    operator to the wrong place."""
    ctx = _Ctx([684, 685, 686], question="Bang nào có doanh thu cao nhất?")
    res = _run(ctx, "rank_values", chart_id=720)
    assert res.get("ok") is False
    assert res.get("error_code") == "chart_out_of_scope", res


def test_no_question_on_the_context_gates_nothing():
    """A flow that never set a question — a scheduled digest, a replay — must not
    start refusing tools."""
    ctx = _Ctx([684, 685, 686, 687], question="")
    res = _run(ctx, "rank_values", chart_id=CATEGORY_CHART)
    assert res.get("error_code") != "dimension_mismatch", res


# ── 3. the guard is only real if the runtime hands it the question ──────────

def test_the_executor_puts_this_turns_question_on_the_context():
    """A gate that reads `ctx.question` does nothing if nothing sets it, and a
    unit test that sets it by hand would never notice. This drives the real
    backbone every dispatch site goes through."""
    import asyncio

    import replay_harness as H
    from app.services.agent_flows.contract import Flow, upgrade_body
    from app.services.agent_flows.envelope import FlowInput
    from app.services.agent_flows.runtime import executor
    from app.services.agent_flows.runtime.handlers import agent as AH
    from app.services.dashboard_ai_bot.events import AgentEvent

    seen = {}

    async def fake_stream(*, provider, api_key, model, system_prompt, messages,
                          tools):
        seen["question"] = getattr(ctx, "question", None)
        yield AgentEvent(type="text", text="ok")
        yield AgentEvent(type="usage",
                         extra={"prompt_tokens": 1, "completion_tokens": 1})

    body = {"answer_node": "answer",
            "nodes": [{"key": "answer", "name": "A", "prompt": "x",
                       "type": "agent"}]}
    flow = Flow.model_validate({
        **upgrade_body(body, key="fx_q", name="q"), "key": "fx_q", "name": "q"})
    env = H._envelope({"envelope": {"question": {"raw": "Bang nào có doanh thu cao nhất?"}}})
    ctx = H._Ctx([41])

    import app.services.agent_flows.runtime.handlers.agent as _agent
    _orig = _agent._stream
    _agent._stream = fake_stream
    try:
        async def go():
            async for _ in executor.run_flow(
                FlowInput.model_validate(env), flow=flow, ctx=ctx,
                api_key="k", base_system_prompt="BASE"):
                pass
        asyncio.run(go())
    finally:
        _agent._stream = _orig
    del AH

    assert seen.get("question") == "Bang nào có doanh thu cao nhất?", (
        f"the executor did not put the question on the context: {seen!r} — the "
        "dimension gate would be silent on every live run"
    )


# ── 4. and the cases that must pass THROUGH the gate reach the tool body ────
#
# Asserting only `error_code != "dimension_mismatch"` is satisfied by a tool that
# is broken in some other way, so these pin that the call actually got past the
# gate: on this fixture the body then fails to load chart data, and that failure
# is the proof it was reached.

@pytest.mark.parametrize("question,chart", [
    ("Tổng doanh thu là bao nhiêu?", CATEGORY_CHART),        # no breakdown asked
    ("Danh mục nào có doanh thu cao nhất?", CATEGORY_CHART),  # matching breakdown
    ("", CATEGORY_CHART),                                     # no question at all
    ("Bang nào có doanh thu cao nhất?", STATE_REVENUE_CHART),  # correct chart
])
def test_an_allowed_call_reaches_the_tool_body(question, chart):
    ctx = _Ctx([684, 685, 686, 687, 701], question=question)
    res = _run(ctx, "rank_values", chart_id=chart)
    assert res.get("error_code") == "query_failed", (
        f"expected the call to pass the gate and fail in the body on this stub, "
        f"got {res.get('error_code')!r}: {res}"
    )


# ── 5. the path that actually runs live: NO declared dimensions ─────────────
#
# MEASURED on the certification deployment: `describe_semantic_model` returns 24
# fields and every single one is `kind="measure"`. Not one dimension is declared.
# A gate that waits for a declared dimension is a gate that never fires on the
# exact report the defect was found on — so the fallback below is the code path
# under test in production, and the cases above exercise the one that is not.

MEASURES_ONLY = [f for f in FIELDS if f["kind"] == "measure"]

#: Chart names as an author writes them, which is where the Vietnamese lives.
#: The auto-humanised label is "Customer state" and matches no Vietnamese
#: question; "Olist · Số đơn theo bang (khách)" is where the word `bang` is.
LIVE_NAMES = {
    684: "Olist · GMV theo tháng · page-1",
    685: "Olist · Đơn theo trạng thái · page-1",
    686: "Olist · Doanh thu theo danh mục · page-1",
    687: "Olist · Số đơn theo bang (khách) · page-1",
    701: "Olist · Doanh thu theo bang · page-1",
}


@pytest.fixture()
def undeclared(monkeypatch):
    """The semantic model as this deployment really answers: measures only."""
    monkeypatch.setattr(
        "app.services.dashboard_ai_bot.govern_tools.tool_describe_semantic_model",
        lambda ctx, args: {"ok": True, "data": {"fields": MEASURES_ONLY}},
        raising=False,
    )

    def make(allowed, question):
        ctx = _Ctx(allowed, question=question)
        for cid in allowed:
            ctx.chart_meta[cid]["name"] = LIVE_NAMES[cid]
        return ctx

    return make


def test_the_question_resolves_through_chart_names_when_nothing_is_declared(
        undeclared):
    from app.services.agent_flows.tools import dimension_gate as G

    ctx = undeclared([684, 685, 686, 687], "Bang nào có doanh thu cao nhất?")
    assert G.requested_dimension(ctx) == "dataset_table_441.customer_state", (
        "with no governed dimension declared, the breakdowns the charts offer "
        "are the only vocabulary there is — and the author wrote 'bang' in the "
        "chart's name"
    )


def test_the_measure_words_do_not_win_the_dimension_ranking(undeclared):
    """THE TRAP THAT MADE THE FIRST VERSION PICK THE WRONG CHART. A BI title
    reads '<measure> theo <dimension>', so 'Olist · Doanh thu theo danh mục'
    shares `doanh` and `thu` with the question — two tokens against the one the
    state chart shares — and the question about STATES ranked the chart about
    CATEGORIES first."""
    from app.services.agent_flows.tools import dimension_gate as G

    ctx = undeclared([684, 685, 686, 687], "Bang nào có doanh thu cao nhất?")
    got = G.requested_dimension(ctx)
    assert "product_category" not in str(got), (
        f"the measure half of the question chose the breakdown: {got}"
    )


def test_the_live_defect_is_refused_on_the_undeclared_path(undeclared):
    ctx = undeclared([684, 685, 686, 687], "Bang nào có doanh thu cao nhất?")
    res = _run(ctx, "rank_values", chart_id=CATEGORY_CHART)
    assert res.get("error_code") == "dimension_mismatch", res


def test_the_category_question_still_reaches_the_category_chart(undeclared):
    ctx = undeclared([684, 685, 686, 687],
                     "Danh mục nào có doanh thu cao nhất?")
    res = _run(ctx, "rank_values", chart_id=CATEGORY_CHART)
    assert res.get("error_code") == "query_failed", (
        f"the matching breakdown was refused: {res}"
    )


def test_a_total_question_gates_nothing_on_the_undeclared_path(undeclared):
    ctx = undeclared([684, 685, 686, 687], "Tổng doanh thu là bao nhiêu?")
    res = _run(ctx, "rank_values", chart_id=CATEGORY_CHART)
    assert res.get("error_code") == "query_failed", res


def test_a_chart_whose_own_breakdown_is_named_is_never_refused(undeclared):
    """The safety valve. Ranking picks ONE best dimension; a question can name a
    breakdown the ranking did not choose, and refusing a call that answers
    exactly what was asked would be worse than the bug."""
    ctx = undeclared([684, 685, 686, 687],
                     "Cho tôi doanh thu theo danh mục và theo bang")
    res = _run(ctx, "rank_values", chart_id=CATEGORY_CHART)
    assert res.get("error_code") == "query_failed", res


# ── 6. the gap has to survive to the verdict ────────────────────────────────
#
# MEASURED after the tool gate landed: the substitution stopped — no run came
# back with a product category — and two of three then answered about monthly
# GMV instead. Neither the answer nor an admission that the report cannot give
# it. A refusal at the tool boundary can only stop one dishonest route; it cannot
# make the answer honest.

def test_a_refusal_opens_a_gap_naming_the_requested_dimension():
    from app.services.agent_flows.runtime.handlers.agent import (
        _note_dimension_outcome,
    )
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    _note_dimension_outcome(state, {
        "ok": False, "error_code": "dimension_mismatch",
        "detail": {"requested_dimension": "customer_state"},
    })
    assert state.dimension_gap["requested"] == "customer_state"
    assert state.dimension_gap["satisfied"] is False
    assert "label" in state.dimension_gap, (
        "the gap must carry a reader-facing label as well as the column path"
    )


def test_a_grouped_result_on_the_requested_dimension_closes_the_gap():
    from app.services.agent_flows.runtime.handlers.agent import (
        _note_dimension_outcome,
    )
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    _note_dimension_outcome(state, {
        "ok": False, "error_code": "dimension_mismatch",
        "detail": {"requested_dimension": "dataset_table_441.customer_state"},
    })
    _note_dimension_outcome(state, {
        "ok": True,
        "data": {"dimension": "dataset_table_441.customer_state", "items": []},
    })
    assert state.dimension_gap["satisfied"] is True


def test_a_grouped_result_on_a_different_dimension_does_not_close_it():
    """The whole point. Answering from SOME chart is not answering from the one
    that was asked about."""
    from app.services.agent_flows.runtime.handlers.agent import (
        _note_dimension_outcome,
    )
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    _note_dimension_outcome(state, {
        "ok": False, "error_code": "dimension_mismatch",
        "detail": {"requested_dimension": "customer_state"},
    })
    _note_dimension_outcome(state, {
        "ok": True, "data": {"dimension": "year_month", "items": []}})
    assert state.dimension_gap["satisfied"] is False


def test_an_unsatisfied_gap_downgrades_the_run_and_is_reported():
    from app.services.agent_flows.runtime import executor as EX
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    state.dimension_gap = {"requested": "dataset_table_441.customer_state",
                           "satisfied": False}
    out: dict = {}
    EX._note_dimension_gap(state, out)
    assert out["grounding"]["dimension_gap"] is True
    assert EX._status_after_verification(
        "ok", {"grounding": out["grounding"]}) == "partial"


def test_a_satisfied_gap_says_nothing():
    from app.services.agent_flows.runtime import executor as EX
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    state.dimension_gap = {"requested": "customer_state", "satisfied": True}
    out: dict = {}
    EX._note_dimension_gap(state, out)
    assert out == {}
    assert EX._status_after_verification("ok", {"grounding": {}}) == "ok"


def test_a_run_that_never_hit_the_gate_is_untouched():
    from app.services.agent_flows.runtime import executor as EX
    from app.services.agent_flows.runtime.state import RunState

    out: dict = {}
    EX._note_dimension_gap(RunState(), out)
    assert out == {}


def test_rows_from_a_chart_grouped_by_something_else_are_refused(undeclared):
    """THE SECOND SUBSTITUTION ROUTE, measured. With the grouped tools gated, the
    model read ROWS from the monthly GMV chart and answered "doanh thu cao nhất
    là 1,179,143.77 vào tháng 11 năm 2017" — a month offered as the answer to a
    question about states. Rows carrying a grouping column are a grouped result
    with one more step in front of them."""
    ctx = undeclared([684, 685, 686, 687], "Bang nào có doanh thu cao nhất?")
    res = _run(ctx, "get_chart_data", chart_id=684)
    assert res.get("error_code") == "dimension_mismatch", res


def test_rows_are_still_served_when_the_breakdown_matches(undeclared):
    """`read_rows` is granted on this binding and a row request must not become
    a refusal — the eval's `rows` case says so explicitly."""
    ctx = undeclared([684, 685, 686, 687],
                     "Cho tôi vài dòng dữ liệu doanh thu theo danh mục.")
    res = _run(ctx, "get_chart_data", chart_id=CATEGORY_CHART)
    assert res.get("error_code") != "dimension_mismatch", res


def test_rows_from_a_chart_with_no_grouping_are_never_gated(undeclared):
    """A KPI tile has no dimension to conflict with."""
    ctx = undeclared([684, 685, 686, 687], "Bang nào có doanh thu cao nhất?")
    ctx.chart_meta[684]["fields"] = {"measures": [], "dimensions": []}
    res = _run(ctx, "get_chart_data", chart_id=684)
    assert res.get("error_code") != "dimension_mismatch", res


# ── 7. what a READER is shown ───────────────────────────────────────────────

def test_the_refusal_carries_a_human_label_not_only_a_column_path(undeclared):
    """SEEN IN THE BROWSER. The first version of the reader notice printed the
    raw field, so a viewer on the public link read "Câu hỏi của bạn hỏi theo
    'customer_state'" — an internal identifier on a business surface. The column
    path stays in the trace, where an author is the reader."""
    ctx = undeclared([684, 685, 686, 687], "Bang nào có doanh thu cao nhất?")
    res = _run(ctx, "rank_values", chart_id=CATEGORY_CHART)
    detail = res.get("detail") or {}
    assert detail.get("requested_dimension") == "customer_state", detail
    label = detail.get("requested_label") or ""
    assert label, detail
    assert "_" not in label and "dataset_table" not in label, (
        f"the reader-facing label is still an identifier: {label!r}"
    )


def test_the_reader_notice_never_prints_a_column_path():
    from app.services.agent_flows.runtime import executor as EX
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    state.dimension_gap = {"requested": "dataset_table_441.customer_state",
                           "label": "Customer state", "satisfied": False}
    out: dict = {}
    EX._note_dimension_gap(state, out)
    assert out["grounding"]["dimension_label"] == "Customer state"


def test_a_gap_with_no_label_still_reads_as_words():
    """The fallback has to be readable too — `customer_state` becomes
    `customer state`, never the raw path."""
    from app.services.agent_flows.tools import dimension_gate as G

    class Bare:
        chart_meta: dict = {}

    assert G.dimension_label(Bare(), "dataset_table_441.customer_state") \
        == "customer state"


def test_the_requested_dimension_is_resolved_per_question(undeclared):
    """Found by review: a Skill's child context is a shallow copy of its caller's
    and shared the cache, so a child asked "Tổng doanh thu là bao nhiêu?" was gated
    by its parent's breakdown."""
    import copy as _copy
    from app.services.agent_flows.tools import dimension_gate as G

    parent = undeclared([684, 685, 686, 687], "Bang nào có doanh thu cao nhất?")
    assert G.requested_dimension(parent) == "dataset_table_441.customer_state"
    child = _copy.copy(parent)
    child.question = "Tổng doanh thu là bao nhiêu?"
    assert G.requested_dimension(child) is None
    res = _run(child, "rank_values", chart_id=CATEGORY_CHART)
    assert res.get("error_code") != "dimension_mismatch", res
    assert G.requested_dimension(parent) == "dataset_table_441.customer_state"

