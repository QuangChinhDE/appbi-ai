"""Meaning-changing words oblige the plan (services/analyst/grounding.py).

PO directive (quality recovery): negation, comparison, a time boundary and "only"
used to sit in the no-meaning word list, so a plan for "đơn CHƯA hoàn tất" and
one for "đơn hoàn tất" were indistinguishable to the server. Each pair below is
the question and its opposite: the right plan is accepted, the opposite plan is
refused - never answered. No model is called.
"""
from __future__ import annotations

import pytest

from app.services.analyst.catalog import CatalogExplore, CatalogField
from app.services.analyst.grounding import check_obligations, ground, intent_obligations
from app.services.analyst.planner import Plan

FIELDS = [
    CatalogField("o.order_count", "measure", "count_distinct", "Số đơn hàng"),
    CatalogField("o.status", "dimension", "string", "Trạng thái đơn"),
    CatalogField("o.payment", "dimension", "string", "Thanh toán"),
    CatalogField("o.channel", "dimension", "string", "Kênh bán"),
    CatalogField("o.amount", "dimension", "number", "Giá trị đơn"),
    CatalogField("o.order_date", "dimension", "date", "Ngày đặt hàng"),
]
EX = CatalogExplore(explore_id=1, model_id=1, dataset_id=1, dataset_name="Commerce", dataset_table_id=1,
                    base_view="o", source_type="postgresql", label="Commerce", fields=FIELDS)


def _plan(filters, dims=("o.channel",)):
    return Plan(explore=EX, dimensions=list(dims), measures=["o.order_count"], filters=dict(filters))


EQ = lambda f, v: {f: {"operator": "eq", "value": v}}            # noqa: E731
NE = lambda f, v: {f: {"operator": "ne", "value": v}}            # noqa: E731
OP = lambda f, op, v: {f: {"operator": op, "value": v}}          # noqa: E731
RANGE = {"o.order_date": {"operator": "date_range", "value": {"from": "2025-01-01", "to": "2025-07-01"}}}


@pytest.mark.parametrize("question, filters, ok", [
    # completed / not completed
    ("Số đơn đã hoàn tất theo kênh bán", EQ("o.status", "Hoàn tất"), True),
    ("Số đơn chưa hoàn tất theo kênh bán", EQ("o.status", "Hoàn tất"), False),     # the opposite plan
    ("Số đơn chưa hoàn tất theo kênh bán", NE("o.status", "Hoàn tất"), True),
    # paid / unpaid (the negation lives in the value itself)
    ("Số đơn chưa thanh toán theo kênh bán", EQ("o.payment", "Chưa thanh toán"), True),
    ("Số đơn đã thanh toán theo kênh bán", EQ("o.payment", "Đã thanh toán"), True),
    ("Số đơn chưa thanh toán theo kênh bán", EQ("o.payment", "Đã thanh toán"), False),
    # include / exclude
    ("Số đơn ngoại trừ kênh Online theo trạng thái", NE("o.channel", "Online"), True),
    ("Số đơn ngoại trừ kênh Online theo trạng thái", EQ("o.channel", "Online"), False),
    ("Số đơn kênh Online theo trạng thái", NE("o.channel", "Online"), False),     # an invented exclusion
    # equal / different
    ("Số đơn có kênh khác Online", OP("o.channel", "not_in", ["Online"]), True),
    ("Số đơn có kênh khác Online", EQ("o.channel", "Online"), False),
    # before / after
    ("Số đơn trước tháng 7/2025 theo kênh", RANGE, True),
    ("Số đơn trước tháng 7/2025 theo kênh", {}, False),
    ("Số đơn từ 01/03/2025 đến 31/03/2025", RANGE, True),
    # greater / smaller, at least / at most
    ("Số đơn có giá trị lớn hơn 5000000", OP("o.amount", "gt", 5000000), True),
    ("Số đơn có giá trị lớn hơn 5000000", {}, False),
    ("Số đơn có giá trị ít nhất 2 triệu", OP("o.amount", "gte", 2000000), True),
    ("Số đơn có giá trị tối đa 2 triệu", OP("o.amount", "lte", 2000000), True),
    ("Số đơn có giá trị tối đa 2 triệu", {}, False),
    # only
    ("Chỉ tính kênh Online", EQ("o.channel", "Online"), True),
    ("Chỉ tính kênh Online", {}, False),
])
def test_a_plan_must_honour_the_questions_meaning_changing_words(question, filters, ok):
    broken = check_obligations(question, filters)
    assert (broken is None) is ok, (question, filters, broken)


@pytest.mark.parametrize("question", [
    "Doanh số tháng này có tăng không?",                 # yes/no particle, not a negation
    "Chi phí marketing theo kênh",                       # "chi phí" is not "chỉ"
    "Chỉ số doanh số theo vùng",                         # "chỉ số" is not "chỉ"
    "Tôi muốn xem số đơn theo kênh",                     # "tôi" is not "tối đa"
    "Kênh nào có số đơn cao nhất?",                      # a ranking, no comparison value
])
def test_ordinary_words_are_not_mistaken_for_obligations(question):
    ob = intent_obligations(question)
    assert not ob["negation"] and not ob["comparison"] and not ob["time_bound"] and not ob["only"], ob


def test_one_period_and_several_periods_are_different_plans():
    assert check_obligations("Số đơn từ tháng 1 đến tháng 3 năm 2025", RANGE) is None
    assert check_obligations("Số đơn từ tháng 1 đến tháng 3 năm 2025", {}) is not None


def test_a_follow_up_only_keeps_the_filter_it_refines():
    assert check_obligations("Chỉ kênh Online thôi", {}, carried_filters=["o.channel"]) is None


def test_ground_refuses_the_opposite_plan_end_to_end():
    p, why = ground(_plan(EQ("o.status", "Hoàn tất")), "Số đơn chưa hoàn tất theo kênh bán",
                    covered={"số đơn": "o.order_count", "kênh bán": "o.channel", "hoàn tất": "o.status"})
    assert p is None and "chưa" in why


def test_a_field_outside_the_model_is_still_refused():
    p, why = ground(_plan({}), "Số đơn theo nhân viên bán hàng")
    assert p is None


def test_a_value_that_does_not_exist_is_a_choice_not_an_answer():
    from types import SimpleNamespace

    from app.services.analyst.service import _check_filter_values

    def values_of(ref):
        return SimpleNamespace(columns=[SimpleNamespace(name="v", ref=ref)], rows=[{"v": "Hoàn tất"}, {"v": "Huỷ"}])

    fixed, options = _check_filter_values(_plan(EQ("o.status", "Đang giao")), values_of)
    assert fixed is None and options == ["Hoàn tất", "Huỷ"]
