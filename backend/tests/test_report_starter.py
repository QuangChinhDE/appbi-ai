"""Starting a report from data: candidates come from the semantic model, the
model can only choose among them, and nothing it types becomes a figure."""
from app.services import report_starter_service as rs

MODEL = {"views": [
    {"name": "oi", "dataset_table_id": 2, "measures": [
        {"name": "items", "type": "count", "label": "Items"},
        {"name": "revenue", "type": "sum", "label": "Revenue", "format": {"kind": "currency", "currency": "BRL"}},
        {"name": "aov", "type": "formula", "label": "AOV", "format": {"kind": "currency"}},
    ], "dimensions": [
        {"name": "order_id", "type": "string"},
        {"name": "price", "type": "number"},
        {"name": "product_category_name_english", "label": "product_category_name_english", "type": "string"},
    ]},
    {"name": "o", "dataset_table_id": 1, "measures": [], "dimensions": [
        {"name": "order_estimated_delivery_date", "type": "date"},
        {"name": "order_purchase_date", "type": "date"},
        {"name": "customer_city", "type": "string"},
    ]},
]}


def test_candidates_come_from_the_model_and_skip_identifiers():
    cands = rs.enumerate_candidates(MODEL)
    fields = {m["field"] for c in cands for m in c["role"]["metrics"]}
    assert fields == {"oi.items", "oi.revenue", "oi.aov"}
    dims = {c["role"].get("dimension") for c in cands if c["kind"] == "category"}
    assert "oi.order_id" not in dims, "an identifier is not a breakdown"
    assert "oi.price" not in dims, "a numeric column is not a breakdown"


def test_money_leads_and_the_purchase_date_beats_the_estimate():
    cands = rs.enumerate_candidates(MODEL)
    order = [next(c for c in cands if c["id"] == i) for i in rs._deterministic_order(cands)]
    assert order[0]["kind"] == "kpi" and order[0]["measure"] == "Revenue"
    first_time = next(c for c in order if c["kind"] == "time")
    assert first_time["role"]["timeField"] == "o.order_purchase_date"
    first_cat = next(c for c in order if c["kind"] == "category")
    assert first_cat["role"]["dimension"] == "oi.product_category_name_english", "readable breakdown first"
    assert first_cat["dimension_label"] == "Product category", first_cat["dimension_label"]


def test_the_model_chooses_by_id_and_cannot_type_a_figure(monkeypatch):
    cands = rs.enumerate_candidates(MODEL)
    real = cands[0]["id"]
    import app.services.llm_client as llm
    monkeypatch.setattr(llm.LLMClient, "complete_json", staticmethod(lambda **kw: {
        "charts": [{"id": real, "title": "Revenue up 137%"}, {"id": "c999", "title": "Invented"},
                   {"id": cands[1]["id"], "title": "Money we made"}],
        "name": "Q3 2018 review",
    }))
    out = rs._model_order("board review", cands)
    ids = [o["id"] for o in out]
    assert "c999" not in ids, "an id the model invented became a chart"
    assert out[0]["title"] == "", "a typed figure in a title survived"
    assert out[1]["title"] == "Money we made"
    assert "__name__" not in ids, "a report name with digits survived"


def test_no_model_means_the_rules_decide(monkeypatch):
    import app.services.llm_client as llm
    monkeypatch.setattr(llm.LLMClient, "complete_json", staticmethod(lambda **kw: None))
    assert rs._model_order("anything", rs.enumerate_candidates(MODEL)) is None
