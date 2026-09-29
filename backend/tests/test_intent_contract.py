# -*- coding: utf-8 -*-
"""The Question Intent Contract (runtime/intent.py).

Design: docs/features/agent-flow-v3-pilot/intent-contract.md. The runtime resolves
what a turn asks for ONCE, from the report's own vocabulary, and the claim check
judges figures against it instead of re-deriving intent from the answer's prose.
Each P0 class it exists for is checked negative AND positive through the real
claim check.
"""
from __future__ import annotations

import asyncio
import json
import os

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"

from test_claims_mean_what_was_asked import (  # noqa: E402,F401
    KPI, MONTHLY, STATE_ORDERS_CHART, _rec, _states, _value, _why, undeclared, world,
)

from app.services.agent_flows.runtime import intent as I  # noqa: E402

VOCAB = {"measures": {"on_time_rate": "On time rate", "total_revenue": "Total revenue",
                      "order_count": "Order count", "gmv": "Gmv"},
         "dimensions": {"customer_state": ["Olist · Số đơn theo bang (khách)"],
                        "seller_state": ["Olist · Doanh thu theo bang (người bán)"]}}


# ── validation: only the report's vocabulary survives ──────────────────────────

def test_choices_outside_the_reports_vocabulary_are_dropped():
    got = I.validate({"measures": ["conversion_rate", "gmv"], "dimension": "city",
                      "periods": [{"grain": "m", "year": 2017, "n": 13},
                                  {"grain": "m", "year": 2017, "n": 10}]}, VOCAB)
    assert got["measures"] == ["gmv"] and got["dimension"] is None
    assert got["periods"] == [("m", 2017, 10)]
    assert any("dropped" in n for n in got["notes"])


def test_absent_stands_only_when_no_report_measure_was_chosen():
    assert I.validate({"measures": [], "absent": "tỷ lệ chuyển đổi"}, VOCAB)["absent"] == "tỷ lệ chuyển đổi"
    assert I.validate({"measures": ["on_time_rate"], "absent": "x"}, VOCAB)["absent"] is None


def test_periods_the_question_names_override_the_models():
    model = I.validate({"periods": [{"grain": "m", "year": 2017, "n": 9}]}, VOCAB)
    merged = I.merge(model, I.empty_intent(), "GMV tháng 10/2017 là bao nhiêu?")
    assert merged["periods"] == [("m", 2017, 10)]
    follow = I.merge(model, I.empty_intent(), "Còn tháng trước đó thì sao?")
    assert follow["periods"] == [("m", 2017, 9)], "a follow-up takes the resolved period"


def test_no_vendor_call_in_the_test_environment_unless_replaced(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    assert I._model_enabled() is False
    monkeypatch.setattr(I, "_model_call", lambda **kw: None)
    assert I._model_enabled() is True


def test_resolution_reads_the_model_and_survives_its_failure(monkeypatch, world):
    ctx, state = world("Tỷ lệ chuyển đổi của website là bao nhiêu?")

    async def ok(**kw):
        return json.dumps({"measures": [], "absent": "tỷ lệ chuyển đổi của website"})
    monkeypatch.setattr(I, "_model_call", ok)
    got = asyncio.run(I.resolve(state, ctx, question=ctx.question, previous="", provider="openai",
                                api_key="k", model="m"))
    assert got["source"] == "model" and got["absent"] == "tỷ lệ chuyển đổi của website"

    async def boom(**kw):
        raise RuntimeError("provider down")
    monkeypatch.setattr(I, "_model_call", boom)
    got = asyncio.run(I.resolve(state, ctx, question=ctx.question, previous="", provider="openai",
                                api_key="k", model="m"))
    assert got["source"] == "heuristic", "a failed call leaves the heuristics, never an error"


# ── the claim check judged against the contract ────────────────────────────────

def _model_intent(**kw):
    out = I.empty_intent()
    out.update(source="model", **kw)
    return out


def test_an_absent_measure_is_never_given_another_ones_figure(world):
    """Live 4164/4879/4928/5051: the on-time rate published as the conversion rate."""
    ctx, state = world("Tỷ lệ chuyển đổi của website là bao nhiêu?", asked=("on_time_rate",))
    state.intent = _model_intent(absent="tỷ lệ chuyển đổi của website")
    _rec(state, "total_measure", {"ok": True, "kind": "value", "data": {
        "chart_id": KPI, "value": 91.89, "measure": "dataset_table_437.on_time_rate"}}, {"chart_id": KPI})
    assert (91.89, "measure_absent") in _why(state, ctx, "Tỷ lệ chuyển đổi của website là 91.89%.")
    honest = "Báo cáo không có tỷ lệ chuyển đổi của website. Tỷ lệ giao đúng hẹn là 91.89%."
    assert _why(state, ctx, honest) == []


def test_a_member_named_in_words_is_judged_by_its_resolved_code(world):
    """Live 4245/4901/4943: SP's figure published as Minas Gerais's. Resolved to MG,
    a correct answer that never writes "MG" is published; SP's figure is not."""
    ctx, state = world("Doanh thu của Minas Gerais là bao nhiêu?", asked=("order_count",))
    state.intent = _model_intent(members=[{"said": "Minas Gerais", "code": "MG"}])
    _states(ctx, state)
    assert (41746.0, "other_member") in _why(state, ctx, "Minas Gerais có 41,746 đơn hàng.")
    assert _why(state, ctx, "Minas Gerais có 11,635 đơn hàng.") == []


def test_a_follow_ups_resolved_period_judges_a_row_backed_figure(world):
    """Live 4368/4756/4849: "Còn tháng trước đó thì sao?" answered with another month's
    row; the contract resolved the period to 2017-10."""
    ctx, state = world("Còn tháng trước đó thì sao?", asked=("gmv",))
    state.intent = _model_intent(periods=[("m", 2017, 10)], followup=True)
    _rec(state, "get_chart_data", {"ok": True, "kind": "table", "data": {
        "chart_id": MONTHLY, "columns": ["year_month", "gmv"],
        "rows": [["2017-01", 56808.84], ["2017-10", 769312.37]]}}, {"chart_id": MONTHLY})
    assert (56808.84, "wrong_period") in _why(state, ctx, "GMV là 56808.84.")
    assert _why(state, ctx, "GMV là 769,312.37.") == []


def test_the_answering_step_is_told_what_was_resolved():
    text = I.describe_for_prompt(_model_intent(
        absent="tỷ lệ chuyển đổi", members=[{"said": "Minas Gerais", "code": "MG"}],
        periods=[("m", 2017, 10)]))
    assert "tỷ lệ chuyển đổi" in text and "KHÔNG có trong báo cáo" in text
    assert "Minas Gerais (MG)" in text and "2017-10" in text
    assert I.describe_for_prompt(I.empty_intent()) == "", "heuristic intent is never asserted to the model"


def test_the_resolved_intent_is_on_the_answering_steps_trace(monkeypatch, undeclared):
    """The author sees what the runtime decided was asked, next to the verdict."""
    import test_publication_boundary as P

    async def call(**kw):
        return json.dumps({"measures": ["gmv"], "periods": [{"grain": "m", "year": 2018, "n": 7}]})
    monkeypatch.setattr(I, "_model_call", call)
    events = P._events(monkeypatch, undeclared, P._Model(obey=True))
    env = next(e.extra["envelope"] for e in events if e.type == "result")
    step = next(s for s in (env.get("trace") or {}).get("steps") or [] if s["key"] == "tl")
    intent = (step.get("capabilities") or {}).get("intent") or {}
    assert intent.get("source") == "model" and intent.get("measures") == ["gmv"]
