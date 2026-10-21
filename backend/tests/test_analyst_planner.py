"""The planner's output is validated by the server against the person's catalog.

From the real-model BigQuery evaluation (2026-10-21, datasource 52):
  * the model qualified a field with the wrong view (`orders_view.x` written as
    `items_view.x`). When the field NAME is unique in the explore, the server
    resolves it to the one catalog field; when it is not unique, it refuses.
  * a grain on a field the semantic model types as string is refused with a
    reason that names the field, not a generic "invalid".
  * a model that filtered an unrelated field with invented values got 0 rows
    back; an empty result under a filter is never presented as an answer.
"""
from __future__ import annotations

from app.services.analyst.catalog import CatalogExplore, CatalogField
from app.services.analyst.planner import Plan, Unsupported, validate
from app.services.analyst.service import no_match_message


def _explore():
    return CatalogExplore(explore_id=7, model_id=1, dataset_id=3, dataset_name="Sales", dataset_table_id=11,
                          base_view="items", source_type="bigquery", label="Sales", fields=[
                              CatalogField("items.revenue", "measure", "sum", "Revenue"),
                              CatalogField("items.seller_id", "dimension", "string", "Seller"),
                              CatalogField("orders.purchased_at", "dimension", "date", "Purchased at"),
                              CatalogField("orders.purchase_text", "dimension", "string", "Purchase text"),
                              CatalogField("items.status", "dimension", "string", "Item status"),
                              CatalogField("orders.status", "dimension", "string", "Order status"),
                          ])


def _raw(**kw):
    base = {"status": "plan", "explore_id": 7, "dimensions": [], "measures": ["items.revenue"]}
    base.update(kw)
    return base


def test_a_wrongly_qualified_but_unique_field_is_resolved():
    p = validate(_raw(dimensions=["items.purchased_at"], time_grains={"items.purchased_at": "month"}), [_explore()])
    assert isinstance(p, Plan)
    assert p.dimensions == ["orders.purchased_at"] and p.time_grains == {"orders.purchased_at": "month"}


def test_an_ambiguous_field_name_is_not_guessed():
    out = validate(_raw(dimensions=["x.status"]), [_explore()])
    assert isinstance(out, Unsupported)


def test_a_field_outside_the_catalog_is_refused():
    assert isinstance(validate(_raw(dimensions=["items.channel"]), [_explore()]), Unsupported)


def test_a_grain_on_a_string_field_names_the_field():
    out = validate(_raw(dimensions=["orders.purchase_text"], time_grains={"orders.purchase_text": "month"}),
                   [_explore()])
    assert isinstance(out, Unsupported) and "Purchase text" in out.reason


def test_an_empty_result_under_a_filter_is_not_an_answer():
    p = validate(_raw(dimensions=["items.seller_id"],
                      filters={"items.seller_id": {"operator": "in", "value": ["Facebook", "Google Ads"]}}),
                 [_explore()])
    msg = no_match_message(p)
    assert "Seller" in msg and "Facebook" in msg


def test_the_prompt_marks_identifiers_and_carries_synonyms():
    """Real-model run: grouping by a key column listed items instead of the category
    the person asked for; identifiers are marked and business synonyms reach the model."""
    from app.services.analyst.catalog import CatalogField

    key = CatalogField("items.product_id", "dimension", "string", "Product").as_prompt()
    cat = CatalogField("products.category", "dimension", "string", "category",
                       synonyms=("nhóm sản phẩm", "danh mục")).as_prompt()
    assert key.get("identifier") is True and "identifier" not in cat
    assert cat["synonyms"] == ["nhóm sản phẩm", "danh mục"]


def test_the_same_question_twice_gives_two_savable_draft_names():
    import datetime as dt

    from app.services.analyst.service import draft_title

    q = "Doanh thu theo tháng?"
    a = draft_title(q, dt.datetime(2026, 10, 21, 9, 0, 0))
    b = draft_title(q, dt.datetime(2026, 10, 21, 9, 0, 1))
    assert a != b and a.startswith(q) and len(draft_title("x" * 500)) <= 130


def test_the_interpretation_is_written_by_the_server_from_the_plan():
    """Real-model browser run: a question about sales channel and province (no such
    fields) was answered by month while the model's interpretation CLAIMED the
    channel/province breakdown. The interpretation shown is derived from the
    validated plan, never the model's prose."""
    p = validate(_raw(dimensions=["orders.purchased_at"], time_grains={"orders.purchased_at": "month"},
                      interpretation="Revenue by sales channel and province"), [_explore()])
    assert isinstance(p, Plan)
    assert "channel" not in p.interpretation and "Revenue" in p.interpretation
    assert "Purchased at" in p.interpretation and "month" in p.interpretation


def test_a_breakdown_the_model_could_not_map_is_refused_by_name():
    out = validate(_raw(dimensions=["items.seller_id"],
                        covered={"kênh bán hàng": None, "người bán": "items.seller_id"}), [_explore()])
    assert isinstance(out, Unsupported) and "kênh bán hàng" in out.reason


def test_a_covered_phrase_must_point_into_the_plan():
    out = validate(_raw(dimensions=["items.seller_id"], covered={"tỉnh": "orders.status"}), [_explore()])
    assert isinstance(out, Unsupported) and "tỉnh" in out.reason


def test_a_grain_on_a_field_used_only_as_a_filter_is_ignored_not_a_refusal():
    """Holdout: "doanh số theo vùng năm 2025" — the model put a year grain on the
    date it filtered by but did not group by; the whole question was refused."""
    out = validate(_raw(dimensions=["items.seller_id"], time_grains={"orders.purchased_at": "year"}), [_explore()])
    assert isinstance(out, Plan) and out.time_grains == {}


def test_a_date_range_operator_is_not_in_the_governed_contract():
    out = validate(_raw(filters={"orders.purchased_at": {"operator": "between", "value": ["2025-01-01", "2025-12-31"]}}),
                   [_explore()])
    assert isinstance(out, Unsupported)


def test_a_measure_listed_only_among_dimensions_is_the_measure():
    out = validate(_raw(dimensions=["items.seller_id", "items.revenue"], measures=[]), [_explore()])
    assert isinstance(out, Plan) and out.measures == ["items.revenue"] and out.dimensions == ["items.seller_id"]
