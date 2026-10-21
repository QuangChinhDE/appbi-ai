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
