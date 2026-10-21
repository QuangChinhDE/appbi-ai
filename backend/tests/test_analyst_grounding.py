"""The plan must answer THE QUESTION (services/analyst/grounding.py).

Every case is a failure of the independent real-model holdout (2026-10-21, 40 new
questions on a multi-fact rig, gpt-4o-mini), reduced to the plan the model
returned and the outcome the server must reach instead."""
from __future__ import annotations

from types import SimpleNamespace

from app.services.analyst.catalog import CatalogExplore, CatalogField
from app.services.analyst.grounding import fold, ground
from app.services.analyst.planner import Plan
from app.services.analyst.service import _repair_filter_values

FIELDS = [
    CatalogField("o.order_count", "measure", "count_distinct", "Số đơn hàng"),
    CatalogField("l.net_sales", "measure", "sum", "Doanh số"),
    CatalogField("i.revenue", "measure", "sum", "Revenue"),
    CatalogField("o.channel", "dimension", "string", "Kênh bán"),
    CatalogField("o.status", "dimension", "string", "Trạng thái đơn"),
    CatalogField("o.order_date", "dimension", "date", "Ngày đặt hàng"),
    CatalogField("c.region", "dimension", "string", "Vùng"),
    CatalogField("c.segment", "dimension", "string", "Phân khúc khách hàng"),
    CatalogField("l.quantity", "dimension", "number", "quantity"),
    CatalogField("p.category", "dimension", "string", "category"),
]
EX = CatalogExplore(explore_id=1, model_id=1, dataset_id=1, dataset_name="Commerce", dataset_table_id=1,
                    base_view="l", source_type="postgresql", label="Commerce", fields=FIELDS)


def _plan(measures, dims=(), grains=None, filters=None, covered=None):
    return Plan(explore=EX, dimensions=list(dims), measures=list(measures), time_grains=dict(grains or {}),
                filters=dict(filters or {}), covered=dict(covered or {}))


def test_a_metric_the_data_does_not_have_is_refused_not_substituted():
    # N01 "Lợi nhuận theo ngành hàng" was answered with sales
    p, why = ground(_plan(["l.net_sales"], ["p.category"]), "Lợi nhuận theo ngành hàng",
                    covered={"lợi nhuận": "l.net_sales", "ngành hàng": "p.category"})
    assert p is None and why


def test_a_conversion_rate_is_not_an_order_count():
    p, why = ground(_plan(["o.order_count"], ["o.order_date", "o.channel"], {"o.order_date": "month"}),
                    "Tỷ lệ chuyển đổi của website theo tháng")
    assert p is None


def test_a_forecast_is_not_history():
    p, why = ground(_plan(["l.net_sales"], ["o.order_date"], {"o.order_date": "quarter"}), "Dự báo doanh số quý tới")
    assert p is None and "du" in fold(why) or "dự" in why


def test_a_filter_the_plan_dropped_is_a_refusal_naming_it():
    # F01: "khách hàng doanh nghiệp" silently dropped
    p, why = ground(_plan(["l.net_sales"], ["c.region"]), "Doanh số của khách hàng doanh nghiệp theo vùng")
    assert p is None and "nghiệp" in why


def test_a_breakdown_nobody_asked_for_is_removed():
    # A05 "Chi phí ... theo kênh" came back by month too; M01 grouped by a numeric column
    p, _ = ground(_plan(["l.net_sales"], ["o.order_date", "o.channel"], {"o.order_date": "month"}),
                  "Doanh số theo kênh bán")
    assert p.dimensions == ["o.channel"] and p.time_grains == {}
    p, _ = ground(_plan(["l.net_sales"], ["p.category", "l.quantity"]), "Doanh số theo ngành hàng",
                  covered={"ngành hàng": "p.category"})
    assert p.dimensions == ["p.category"]


def test_a_filter_whose_value_is_its_own_label_is_removed():
    # A06 "Số đơn hàng theo trạng thái" -> status eq "Trạng thái đơn"
    p, _ = ground(_plan(["o.order_count"], ["o.status"], filters={"o.status": {"operator": "eq", "value": "Trạng thái đơn"}}),
                  "Số đơn hàng theo trạng thái")
    assert p is not None and p.filters == {}


def test_a_vietnamese_question_over_english_labels_is_bridged_by_real_phrases():
    p, why = ground(_plan(["i.revenue"], ["p.category", "o.order_date"], {"o.order_date": "month"}),
                    "Doanh thu các nhóm sản phẩm theo tháng gần đây đang thay đổi như thế nào?",
                    covered={"doanh thu": "i.revenue", "nhóm sản phẩm": "p.category"})
    assert p is not None, why
    assert p.dimensions == ["p.category", "o.order_date"]


def test_a_phrase_that_is_not_in_the_question_is_not_believed():
    p, _ = ground(_plan(["i.revenue"], ["p.category"]), "Doanh thu theo nhóm hàng",
                  covered={"doanh thu": "i.revenue", "nhóm sản phẩm": "p.category"})
    assert p is None  # "sản phẩm" is not in the question: category stays unexplained


def test_the_whole_question_mapped_to_one_field_is_not_a_mapping():
    p, _ = ground(_plan(["i.revenue"], ["c.region"]), "Doanh thu khách hàng doanh nghiệp theo vùng",
                  covered={"Doanh thu khách hàng doanh nghiệp theo vùng": "i.revenue"})
    assert p is None


def test_a_follow_up_keeps_the_breakdown_it_refines():
    # U01 "Chỉ tính các đơn đã hoàn tất" after "Số đơn hàng theo kênh bán"
    p, why = ground(_plan(["o.order_count"], ["o.channel"], filters={"o.status": {"operator": "eq", "value": "Hoàn tất"}}),
                    "Chỉ tính các đơn đã hoàn tất", carried=["o.order_count", "o.channel"])
    assert p is not None, why
    assert p.dimensions == ["o.channel"] and p.filters == {"o.status": {"operator": "eq", "value": "Hoàn tất"}}


def _values(real):
    def values_of(ref):
        return SimpleNamespace(columns=[SimpleNamespace(name="v", ref=ref)], rows=[{"v": x} for x in real])
    return values_of


def test_a_filter_value_is_matched_to_the_one_real_value():
    # F02 "đơn bị huỷ" -> status eq "bị huỷ"; the data says "Huỷ"
    p = _plan(["o.order_count"], ["o.channel"], filters={"o.status": {"operator": "eq", "value": "huỷ"}})
    fixed, options = _repair_filter_values(p, _values(["Hoàn tất", "Huỷ"]))
    assert fixed.filters == {"o.status": {"operator": "eq", "value": "Huỷ"}} and options == []
    # tone mark placed differently (hủy / huỷ) is the same word
    p = _plan(["o.order_count"], filters={"o.status": {"operator": "eq", "value": "Hủy"}})
    assert _repair_filter_values(p, _values(["Hoàn tất", "Huỷ"]))[0].filters["o.status"]["value"] == "Huỷ"


def test_no_or_several_matching_values_is_a_choice_for_the_person():
    p = _plan(["o.order_count"], filters={"o.status": {"operator": "eq", "value": "đang giao"}})
    fixed, options = _repair_filter_values(p, _values(["Hoàn tất", "Huỷ"]))
    assert fixed is None and options == ["Hoàn tất", "Huỷ"]
    p = _plan(["o.order_count"], filters={"c.region": {"operator": "eq", "value": "miền"}})
    fixed, options = _repair_filter_values(p, _values(["Miền Bắc", "Miền Nam"]))
    assert fixed is None and options == ["Miền Bắc", "Miền Nam"]


def test_a_phrase_that_names_no_data_is_not_a_missing_field():
    from app.services.analyst.grounding import is_function_phrase

    assert is_function_phrase("biến động ra sao", has_time=True)
    assert is_function_phrase("tổng cộng", has_time=False)
    assert is_function_phrase("theo tháng", has_time=True) and not is_function_phrase("theo tháng", has_time=False)
    assert not is_function_phrase("lợi nhuận", has_time=True)


def test_a_measure_is_named_by_a_shared_word_a_breakdown_is_not():
    # F02 "Số đơn bị huỷ theo kênh": "đơn" names the order count ...
    p, why = ground(_plan(["o.order_count"], ["o.channel"], filters={"o.status": {"operator": "eq", "value": "Huỷ"}}),
                    "Số đơn bị huỷ theo kênh")
    assert p is not None and p.measures == ["o.order_count"], why
    # ... but "đặt hàng" is not asked by "số đơn hàng" (A06 grew an order-date breakdown)
    p, _ = ground(_plan(["o.order_count"], ["o.status", "o.order_date"], {"o.order_date": "month"}),
                  "Số đơn hàng theo trạng thái")
    assert p.dimensions == ["o.status"]


def test_a_value_the_plan_left_out_becomes_its_filter_only_when_one_field_has_it():
    calls = []

    def lookup(question, unexplained, used):
        calls.append(sorted(unexplained))
        return ("p.category", "Nội thất")

    p, why = ground(_plan(["l.net_sales"], ["c.region"]), "Doanh số theo vùng của ngành Nội thất",
                    covered={"ngành": "p.category"}, value_lookup=lookup)
    assert p is not None, why
    assert p.filters == {"p.category": {"operator": "eq", "value": "Nội thất"}} and p.dimensions == ["c.region"]
    assert calls and "noi" in calls[0]
    p, why = ground(_plan(["l.net_sales"], ["c.region"]), "Doanh số theo vùng của ngành Nội thất",
                    value_lookup=lambda *_a: None)
    assert p is None and "Nội" in why
