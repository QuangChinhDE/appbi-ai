"""The plan must answer THE QUESTION (services/analyst/grounding.py).

Every case is a failure of the independent real-model holdout (2026-10-21, 40 new
questions on a multi-fact rig, gpt-4o-mini), reduced to the plan the model
returned and the outcome the server must reach instead."""
from __future__ import annotations

from types import SimpleNamespace

from app.services.analyst.catalog import CatalogExplore, CatalogField
from app.services.analyst.grounding import fold, ground
from app.services.analyst.planner import Plan
from app.services.analyst.service import _check_filter_values

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
    fixed, options = _check_filter_values(p, _values(["Hoàn tất", "Huỷ"]))
    assert fixed.filters == {"o.status": {"operator": "eq", "value": "Huỷ"}} and options == []
    # tone mark placed differently (hủy / huỷ) is the same word
    p = _plan(["o.order_count"], filters={"o.status": {"operator": "eq", "value": "Hủy"}})
    assert _check_filter_values(p, _values(["Hoàn tất", "Huỷ"]))[0].filters["o.status"]["value"] == "Huỷ"


def test_no_or_several_matching_values_is_a_choice_for_the_person():
    p = _plan(["o.order_count"], filters={"o.status": {"operator": "eq", "value": "đang giao"}})
    fixed, options = _check_filter_values(p, _values(["Hoàn tất", "Huỷ"]))
    assert fixed is None and options == ["Hoàn tất", "Huỷ"]
    p = _plan(["o.order_count"], filters={"c.region": {"operator": "eq", "value": "miền"}})
    fixed, options = _check_filter_values(p, _values(["Miền Bắc", "Miền Nam"]))
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


def _ex(eid, base, refs, ds=1):
    return CatalogExplore(explore_id=eid, model_id=1, dataset_id=ds, dataset_name=f"D{ds}", dataset_table_id=eid,
                          base_view=base, source_type="postgresql", label=f"D{ds}",
                          fields=[CatalogField(r, "measure" if r.endswith(("sales", "count")) else "dimension",
                                               "sum", r) for r in refs])


def test_the_model_sees_one_entry_per_dataset():
    from app.services.analyst.planner import prompt_catalog

    cat = [_ex(4, "c", ["c.region", "l.net_sales"]), _ex(6, "o", ["o.channel", "c.region", "l.net_sales"]),
           _ex(9, "m", ["m.spend_sales"], ds=2)]
    assert [c.explore_id for c in prompt_catalog(cat)] == [6, 9]


def test_the_plan_runs_from_the_explore_whose_base_owns_the_measure():
    from app.services.analyst.planner import retarget

    cust = _ex(4, "c", ["c.region", "o.order_date", "l.net_sales"])
    lines = _ex(7, "l", ["c.region", "o.order_date", "l.net_sales", "p.category"])
    p = Plan(explore=cust, dimensions=["c.region"], measures=["l.net_sales"])
    assert retarget(p, [cust, lines]).explore.explore_id == 7
    # not when the fact explore cannot reach a field the plan uses
    p2 = Plan(explore=cust, dimensions=["c.only_here"], measures=["l.net_sales"])
    cust.fields.append(CatalogField("c.only_here", "dimension", "string", "x"))
    assert retarget(p2, [cust, lines]).explore.explore_id == 4


def test_a_bridged_identifier_yields_to_the_field_the_question_names():
    ex = CatalogExplore(explore_id=1, model_id=1, dataset_id=1, dataset_name="C", dataset_table_id=1, base_view="l",
                        source_type="postgresql", label="C", fields=[
                            CatalogField("l.units", "measure", "sum", "Số lượng bán"),
                            CatalogField("p.product_id", "dimension", "string", "product id"),
                            CatalogField("p.product_name", "dimension", "string", "Tên sản phẩm")])
    p = Plan(explore=ex, dimensions=["p.product_id"], measures=["l.units"],
             covered={"sản phẩm": "p.product_id", "số lượng bán": "l.units"})
    out, why = ground(p, "Số lượng bán theo sản phẩm", covered=p.covered)
    assert out is not None and out.dimensions == ["p.product_name"], why


def test_a_metric_another_dataset_names_word_for_word_is_a_choice():
    from app.services.analyst.grounding import other_source_named

    sales = CatalogExplore(explore_id=1, model_id=1, dataset_id=1, dataset_name="Sales", dataset_table_id=1,
                           base_view="i", source_type="postgresql", label="Sales",
                           fields=[CatalogField("i.revenue", "measure", "sum", "Revenue")])
    commerce = CatalogExplore(explore_id=2, model_id=2, dataset_id=2, dataset_name="Commerce", dataset_table_id=2,
                              base_view="l", source_type="postgresql", label="Commerce",
                              fields=[CatalogField("l.net_sales", "measure", "sum", "Doanh số")])
    p = Plan(explore=sales, dimensions=[], measures=["i.revenue"])
    # each choice carries the Dataset it pins, so the person's pick re-asks THAT source
    assert other_source_named(p, "Xu hướng doanh số theo tháng", [sales, commerce]) == [
        {"label": "Revenue — Sales", "dataset_id": 1}, {"label": "Doanh số — Commerce", "dataset_id": 2}]
    # "doanh thu" only shares a word with "Doanh số": not a second match
    assert other_source_named(p, "Doanh thu các nhóm sản phẩm theo tháng", [sales, commerce]) == []


def test_a_filter_value_made_of_field_labels_is_dropped_and_the_breakdown_kept():
    # holdout set 3 A03: "Tiền hoàn trả theo trạng thái đơn" -> status eq "đơn hoàn trả", no breakdown
    ex = CatalogExplore(explore_id=1, model_id=1, dataset_id=1, dataset_name="C", dataset_table_id=1, base_view="r",
                        source_type="postgresql", label="C", fields=[
                            CatalogField("r.refund_total", "measure", "sum", "Tiền hoàn trả"),
                            CatalogField("o.status", "dimension", "string", "Trạng thái đơn")])
    p = Plan(explore=ex, dimensions=["o.status"], measures=["r.refund_total"],
             filters={"o.status": {"operator": "eq", "value": "đơn hoàn trả"}})
    out, why = ground(p, "Tiền hoàn trả theo trạng thái đơn")
    assert out is not None and out.filters == {} and out.dimensions == ["o.status"], why


def test_a_follow_up_filter_does_not_change_the_metric_or_lose_the_breakdown():
    # holdout set 3 U01: "Chỉ khách hàng cá nhân" after "Doanh số theo ngành hàng"
    previous = {"dimensions": ["p.category"], "measures": ["l.net_sales"], "time_grains": {}, "filters": {}}
    p = _plan(["c.customer_count"], [], filters={"c.segment": {"operator": "eq", "value": "Khách hàng cá nhân"}})
    by = {f.ref for f in p.explore.fields}
    if "c.customer_count" not in by:
        p.explore.fields.append(CatalogField("c.customer_count", "measure", "count_distinct", "Số khách hàng"))
    out, why = ground(p, "Chỉ khách hàng cá nhân", carried=["p.category", "l.net_sales"], previous=previous)
    assert out is not None, why
    assert out.measures == ["l.net_sales"] and out.dimensions == ["p.category"]


def test_a_value_that_exists_nowhere_is_a_choice_before_anything_runs():
    p = _plan(["c.customer_count"], filters={"c.segment": {"operator": "eq", "value": "Khách hàng cá nhân"}})
    fixed, _ = _check_filter_values(p, _values(["Cá nhân", "Doanh nghiệp"]))
    assert fixed.filters["c.segment"]["value"] == "Cá nhân"
    p = _plan(["c.customer_count"], filters={"c.segment": {"operator": "eq", "value": "Đối tác"}})
    fixed, options = _check_filter_values(p, _values(["Cá nhân", "Doanh nghiệp"]))
    assert fixed is None and options == ["Cá nhân", "Doanh nghiệp"]


def test_naming_the_dataset_is_not_a_missing_field():
    from app.services.analyst.grounding import is_function_phrase, syllables

    assert is_function_phrase("slow archive", has_time=False, source_words=syllables("Rig Slow Archive"))
    p, why = ground(_plan(["l.net_sales"], ["c.region"]), "Doanh số theo vùng trong Commerce")
    assert p is not None, why


def test_an_identifier_or_a_numeric_column_is_not_a_breakdown_unless_named():
    ex = CatalogExplore(explore_id=1, model_id=1, dataset_id=1, dataset_name="C", dataset_table_id=1, base_view="c",
                        source_type="postgresql", label="C", fields=[
                            CatalogField("c.customer_count", "measure", "count_distinct", "Số khách hàng"),
                            CatalogField("c.segment", "dimension", "string", "Phân khúc khách hàng"),
                            CatalogField("c.customer_id", "dimension", "string", "customer id"),
                            CatalogField("l.quantity", "dimension", "number", "quantity")])
    p = Plan(explore=ex, dimensions=["c.segment", "c.customer_id"], measures=["c.customer_count"],
             covered={"khách": "c.customer_id"})
    out, why = ground(p, "Mỗi phân khúc khách hàng có bao nhiêu khách?", covered=p.covered)
    assert out is not None and out.dimensions == ["c.segment"], why
    p = Plan(explore=ex, dimensions=["c.segment", "l.quantity"], measures=["c.customer_count"],
             covered={"bao nhiêu cái": "l.quantity"})
    out, _ = ground(p, "Số khách hàng theo phân khúc khách hàng", covered=p.covered)
    assert out.dimensions == ["c.segment"]


def test_a_value_inside_a_breakdown_phrase_is_a_filter():
    p = _plan(["l.net_sales"], ["o.channel", "p.category"],
              covered={"kênh Online": "o.channel", "ngành hàng": "p.category", "doanh số": "l.net_sales"})
    out, why = ground(p, "Doanh số kênh Online theo ngành hàng", covered=p.covered,
                      value_lookup=lambda q, words, used: ("o.channel", "Online") if "online" in words else None)
    assert out is not None, why
    assert out.dimensions == ["p.category"] and out.filters == {"o.channel": {"operator": "eq", "value": "Online"}}


def test_a_modifier_in_a_metric_phrase_is_not_explained_by_the_metric():
    # holdout set 5 N04: "Doanh số dự kiến quý 3 năm 2027" answered with history
    p, why = ground(_plan(["l.net_sales"], ["o.order_date"], {"o.order_date": "quarter"}),
                    "Doanh số dự kiến quý 3 năm 2027",
                    covered={"doanh số dự kiến": "l.net_sales", "quý 3 năm 2027": "o.order_date"})
    assert p is None and "dự" in why


def test_a_metric_is_trended_by_its_own_facts_date_unless_another_is_named():
    ex = CatalogExplore(explore_id=1, model_id=1, dataset_id=1, dataset_name="C", dataset_table_id=1, base_view="r",
                        source_type="postgresql", label="C", fields=[
                            CatalogField("r.refund_total", "measure", "sum", "Tiền hoàn trả"),
                            CatalogField("r.return_date", "dimension", "date", "Ngày trả hàng"),
                            CatalogField("o.order_date", "dimension", "date", "Ngày đặt hàng")])
    p = Plan(explore=ex, dimensions=["o.order_date"], measures=["r.refund_total"], time_grains={"o.order_date": "month"})
    out, why = ground(p, "Tiền hoàn trả theo tháng")
    assert out is not None and out.dimensions == ["r.return_date"] and out.time_grains == {"r.return_date": "month"}, why
    out, _ = ground(p, "Tiền hoàn trả theo ngày đặt hàng, từng tháng")
    assert out.dimensions == ["o.order_date"]


def test_a_value_past_the_first_page_is_found_by_a_bounded_search_not_called_absent():
    first_page = [f"Sản phẩm {i:03d}" for i in range(200)]

    def values_of(ref):
        return SimpleNamespace(columns=[SimpleNamespace(name="v", ref=ref)], rows=[{"v": x} for x in first_page],
                               truncated=True)

    searched = []

    def search_of(ref, text):
        searched.append(text)
        hits = ["Laptop 14"] if text == "Laptop 14" else []
        return SimpleNamespace(columns=[SimpleNamespace(name="v", ref=ref)], rows=[{"v": x} for x in hits])

    p = _plan(["l.net_sales"], filters={"p.category": {"operator": "eq", "value": "laptop 14"}})
    fixed, _ = _check_filter_values(p, values_of, search_of)
    assert fixed is not None and fixed.filters["p.category"]["value"] == "Laptop 14"
    assert searched == ["laptop 14", "Laptop 14"]          # as typed, then title-cased; each bounded
    # a field whose values fit one page is never searched
    searched.clear()
    _check_filter_values(_plan(["l.net_sales"], filters={"o.status": {"operator": "eq", "value": "Huỷ"}}),
                         _values(["Huỷ"]), search_of)
    assert searched == []


def test_a_date_range_filter_is_kept_and_explains_the_period():
    # RC3 rig: "Doanh số theo vùng năm 2025" lost its date_range (a dict value was
    # read as a label-only value) and was refused on "năm 2025"
    p = _plan(["l.net_sales"], ["c.region"],
              filters={"o.order_date": {"operator": "date_range", "value": {"from": "2025-01-01", "to": "2026-01-01"}}})
    out, why = ground(p, "Doanh số theo vùng năm 2025?", covered={"năm 2025": "o.order_date"})
    assert out is not None, why
    assert out.filters == p.filters and out.dimensions == ["c.region"]


# ── sealed holdout set 6 (now a development set): rules, not question patches ──

def test_conversational_words_and_a_described_breakdown_are_explained():
    p, why = ground(_plan(["l.net_sales"], ["c.region"]), "Cho mình xem doanh số theo từng vùng miền nhé",
                    covered={"doanh số": "l.net_sales", "vùng miền": "c.region"})
    assert p is not None, why


def test_a_capitalised_word_in_a_breakdown_phrase_still_needs_a_real_value():
    p, why = ground(_plan(["l.net_sales"], ["o.channel"]), "Doanh số kênh Online",
                    covered={"doanh số": "l.net_sales", "kênh Online": "o.channel"},
                    value_lookup=lambda *_a: None)
    assert p is None and "Online" in why


def test_a_metric_phrase_keeps_catalog_words_and_refuses_unknown_modifiers():
    ex = CatalogExplore(explore_id=1, model_id=1, dataset_id=1, dataset_name="C", dataset_table_id=1, base_view="l",
                        source_type="postgresql", label="C", fields=[*FIELDS,
                            CatalogField("p.product_name", "dimension", "string", "Tên sản phẩm"),
                            CatalogField("l.units", "measure", "sum", "Số lượng bán")])
    p0 = Plan(explore=ex, dimensions=["p.category"], measures=["l.units"])
    p, why = ground(p0, "Số lượng sản phẩm bán ra theo category",
                    covered={"số lượng sản phẩm bán ra": "l.units", "category": "p.category"})
    assert p is not None, why  # "sản phẩm" is a word of another field ("Tên sản phẩm"): catalog vocabulary
    p, why = ground(_plan(["l.net_sales"], ["p.category"]), "Doanh số dự kiến theo category",
                    covered={"doanh số dự kiến": "l.net_sales", "category": "p.category"})
    assert p is None and "dự" in why


def test_a_date_range_needs_a_year_and_is_not_also_a_breakdown_unless_asked():
    rng = {"o.order_date": {"operator": "date_range", "value": {"from": "2023-01-01", "to": "2024-01-01"}}}
    p, _ = ground(_plan(["o.order_count"], ["o.channel"], filters=rng), "Số đơn hàng mới theo kênh bán")
    assert p is None or p.filters == {}  # no year in the question: the invented range is not applied
    rng = {"o.order_date": {"operator": "date_range", "value": {"from": "2025-01-01", "to": "2026-01-01"}}}
    p, why = ground(_plan(["l.net_sales"], ["c.region", "o.order_date"], {"o.order_date": "year"}, filters=rng),
                    "Doanh số năm 2025 theo vùng")
    assert p is not None and p.dimensions == ["c.region"], why
    p, why = ground(_plan(["l.net_sales"], ["o.order_date"], {"o.order_date": "month"}, filters=rng),
                    "Doanh số theo tháng trong năm 2025")
    assert p is not None and p.dimensions == ["o.order_date"], why


def test_a_period_phrase_the_model_left_unmapped_is_not_a_missing_field():
    from app.services.analyst.grounding import is_function_phrase

    assert is_function_phrase("Quý 1/2026", has_time=True)
    assert not is_function_phrase("Quý 1/2026", has_time=False)
