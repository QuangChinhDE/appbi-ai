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


# ── holdout findings (run_422b8fd2) ─────────────────────────────────────────────

MEMBERS = {"customer_state": ["SP", "RJ", "MG"], "payment_type": ["credit_card", "boleto"],
           "product_category_name_english": ["sports_leisure", "health_beauty"]}


def test_a_member_is_resolved_to_the_value_the_rows_carry():
    """Holdout 5657/5665: "sports leisure" and "Rio de Janeiro" left without a code,
    so the answering step filtered rows by words the data does not contain."""
    got = I.validate({"members": [{"said": "sports leisure", "code": None},
                                  {"said": "Rio de Janeiro", "code": "rj"}]},
                     {**VOCAB, "members": MEMBERS})
    assert [m["code"] for m in got["members"]] == ["sports_leisure", "RJ"]


def test_a_measure_or_period_is_never_a_member():
    """Holdout 5653/5664: "GMV thấp nhất" and "payment method" were returned as members."""
    got = I.validate({"members": [{"said": "GMV thấp nhất", "code": "gmv"},
                                  {"said": "payment method", "code": None}]},
                     {**VOCAB, "members": MEMBERS})
    assert got["members"] == [] and any("dropped member" in n for n in got["notes"])
    free = I.validate({"members": [{"said": "Bahia", "code": "BA"}]}, VOCAB)
    assert free["members"] == [{"said": "Bahia", "code": "BA"}], "without read values the model's code stands"


def test_the_vocabulary_pairs_measures_with_the_breakdowns_that_carry_them():
    """Holdout 5664: "money by payment method" resolved to total_revenue, which no
    payment chart carries; the pairing is what lets the resolver pick total_payment."""
    class Ctx:
        chart_meta = {1: {"name": "Thanh toán theo hình thức", "fields": {
            "measures": [{"field": "dataset_table_439.total_payment"}],
            "dimensions": [{"field": "dataset_table_439.payment_type"}]}},
            2: {"name": "Doanh thu theo bang", "fields": {
                "measures": [{"field": "dataset_table_438.total_revenue"}],
                "dimensions": [{"field": "dataset_table_441.customer_state"}]}}}
    v = I.vocabulary(Ctx())
    assert v["measures_by_dimension"]["payment_type"] == ["total_payment"]
    assert v["measures_by_dimension"]["customer_state"] == ["total_revenue"]


def test_member_values_are_read_from_a_chart_grouped_by_that_breakdown_alone(monkeypatch):
    from app.services.agent_flows.tools import context as C

    class Ctx:
        chart_meta = {7: {"fields": {"dimensions": [{"field": "t.customer_state"}, {"field": "t.order_status"}]}},
                      8: {"fields": {"dimensions": [{"field": "t.customer_state"}]}},
                      9: {"fields": {"dimensions": [{"field": "t.year_month"}]}}}
    read = []

    def fetch(ctx, cid, **kw):
        read.append(cid)
        return {"columns": ["t.customer_state", "t.gmv"], "rows": [["SP", 1.0], ["RJ", 2.0]]}
    monkeypatch.setattr(C, "_fetch_chart_data", fetch)
    got = I.member_values(Ctx(), {"customer_state": [], "year_month": []})
    assert got == {"customer_state": ["SP", "RJ"]} and read == [8], (got, read)


def test_an_absent_quantity_is_a_thing_to_check_not_a_verdict():
    """Holdout 5660: a share of payment value was called absent and the answering
    step refused without reading anything. The claim check keeps the verdict."""
    text = I.describe_for_prompt(_model_intent(absent="share paid by boleto"))
    assert "kiểm tra bằng công cụ trước khi kết luận" in text


NAMED = {"measures": {"total_freight": "Total freight", "on_time_rate": "On time rate",
                      "review_count": "Review count", "total_payment": "Total payment"},
         "dimensions": {}, "measure_names": {
             "total_freight": ["Olist · Tổng phí vận chuyển · page-2"],
             "on_time_rate": ["Olist · Giao đúng hẹn (%) · page-1"],
             "review_count": ["Olist · Số đánh giá · page-5"],
             "total_payment": ["Olist · Thanh toán theo hình thức · page-5"]}}


def test_a_quantity_the_report_measures_is_never_absent():
    """Holdout 5667/5668/5676/5660: the report's own freight, review count, 1-star
    reviews and payment share were resolved absent and refused with no tool call."""
    for asked in ("Tổng phí vận chuyển", "total reviews", "lượt đánh giá 1 sao",
                  "share of payment value paid by boleto"):
        got = I.validate({"measures": [], "absent": asked}, NAMED)
        assert got["absent"] is None, asked
        assert any("not absent" in n for n in got["notes"]), asked


def test_a_generic_word_or_one_syllable_does_not_make_a_quantity_present():
    """"tỷ lệ" is how the on-time rate is counted, and "chuyển" in "vận chuyển" is
    not "chuyển đổi": the conversion rate stays absent (live 4164/4879)."""
    for asked in ("tỷ lệ chuyển đổi của website", "Lợi nhuận gộp", "customer churn rate"):
        assert I.validate({"measures": [], "absent": asked}, NAMED)["absent"] == asked, asked


def test_a_member_named_without_a_code_is_kept():
    """Smoke 6040: "Rio de Janeiro" came back with no code, rows say "RJ", and the
    member was dropped — the claim check then had no member to judge by."""
    got = I.validate({"members": [{"said": "Rio de Janeiro", "code": None},
                                  {"said": "tháng trước đó", "code": None}]},
                     {**VOCAB, "members": MEMBERS})
    assert got["members"] == [{"said": "Rio de Janeiro", "code": None}], got


TITLED = {"measures": {"avg_delay_days": "Avg delay days", "avg_delivery_days": "Avg delivery days",
                       "total_revenue": "Total revenue"},
          "dimensions": {}, "measure_names": {
              "avg_delay_days": ["Olist · Lệch hẹn giao TB theo bang"],
              "avg_delivery_days": ["Olist · Số ngày giao TB theo bang"],
              "total_revenue": ["Olist · Doanh thu theo bang (khách)"]}}


def test_the_questions_own_words_name_the_measure_over_the_models_pick():
    """Live a2d2e68b 6675: "lệch hẹn giao" resolved to avg_delivery_days; delivery
    days were published as the delay. A pair shared by many titles ("theo bang")
    decides nothing; a pick the question does name is kept."""
    q = "Bang nào có lệch hẹn giao trung bình thấp nhất?"
    assert I.titled_measure(q, ["avg_delivery_days"], TITLED) == "avg_delay_days"
    assert I.titled_measure("Số ngày giao TB theo bang?", ["avg_delivery_days"], TITLED) is None
    assert I.titled_measure("Doanh thu theo bang là bao nhiêu?", ["total_revenue"], TITLED) is None
