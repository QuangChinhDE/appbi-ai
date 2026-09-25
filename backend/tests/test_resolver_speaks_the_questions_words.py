# -*- coding: utf-8 -*-
"""`resolve_chart_candidates` keeps the promise its definition makes.

Its `measure` argument is documented as "a measure or field name AS THE QUESTION
PHRASES IT — e.g. 'gmv', 'doanh thu' … Works without anything being registered
first." It matched only a field's exact name or label. Measured live on the Olist
report: an Agent asked it for measure "doanh thu" by dimension "danh mục sản
phẩm"; it answered "No chart on this report shows 'doanh thu' broken down by
'danh mục sản phẩm'" — with chart 686, revenue by product category, in scope —
and the step told the viewer the report had no such data. The routed eval arm
lost its ranking questions to this, while the full arm happened to use
`list_charts` and never asked.

The bridge is the governed vocabulary `search_business_assets` already uses —
semantic fields of the right kind, and governed metrics' bindings — never a word
list and never a model. And the structural rule stays: a chart must PLOT the
measure and BE BROKEN DOWN BY the dimension.
"""
from __future__ import annotations

from test_dimension_is_not_a_measure import ids, report, resolve  # noqa: F401


def test_a_vietnamese_measure_and_breakdown_reach_the_chart_that_has_both(report):
    data = resolve(report, measure="doanh thu", dimension="danh mục")
    assert ids(data, match="both") == [686]
    assert data["coverage"]["exact"] == 1
    assert "revenue" in data["coverage"]["matched_via"]["measure"]
    assert "product_category_name_english" in data["coverage"]["matched_via"]["dimension"]


def test_the_same_measure_by_another_breakdown_is_the_other_chart(report):
    data = resolve(report, measure="doanh thu", dimension="bang")
    assert ids(data, match="both") == [684]


def test_a_breakdown_the_report_does_not_have_is_still_not_substituted(report):
    data = resolve(report, measure="doanh thu", dimension="thành phố")
    assert data["coverage"]["exact"] == 0 and ids(data, match="both") == []
    assert "do NOT substitute" in (data["coverage"].get("note") or "")


def test_a_word_the_vocabulary_does_not_know_matches_nothing(report):
    data = resolve(report, measure="lợi nhuận", dimension="danh mục")
    assert ids(data, match="both") == [] and ids(data, match="measure") == []


def test_a_measure_phrase_never_matches_a_dimension_field(report):
    """Kind still decides: 'danh mục' is a breakdown, so as a MEASURE it finds
    nothing — the historical category-as-figure collapse cannot come back."""
    data = resolve(report, measure="danh mục")
    assert ids(data, match="measure") == []


def test_an_exact_identifier_is_matched_exactly_as_before(report):
    data = resolve(report, measure="revenue", dimension="customer_state")
    assert ids(data, match="both") == [684]


# ── when the semantic model has no word for the breakdown ───────────────────
def _unlabelled(report, monkeypatch):
    """The Olist deployment: dimensions carry no label, charts carry titles."""
    import test_dimension_is_not_a_measure as T

    fields = [f for f in T.FIELDS if f["kind"] == "measure"] + [
        {"name": "customer_state", "label": "", "kind": "dimension"},
        {"name": "product_category_name_english", "label": "", "kind": "dimension"}]
    monkeypatch.setattr(
        "app.services.dashboard_ai_bot.govern_tools.tool_describe_semantic_model",
        lambda ctx, args: {"ok": True, "data": {"fields": fields}}, raising=False)
    return report


def test_the_charts_own_title_names_the_breakdown_when_nothing_else_does(report, monkeypatch):
    ctx = _unlabelled(report, monkeypatch)
    data = resolve(ctx, measure="doanh thu", dimension="danh mục")
    [best] = [c for c in data["candidates"] if c["complete"]]
    assert best["chart_id"] == 686 and best["dimension_match_basis"] == "chart_title"
    assert best["confidence"] == "medium", "weaker than a field match, and says so"


def test_a_title_never_supplies_the_measure_half(report, monkeypatch):
    """Revenue by STATE: the state chart's title says 'bang' but it counts ORDERS,
    so it is not an answer — the substitution the B2 fix exists to stop."""
    ctx = _unlabelled(report, monkeypatch)
    data = resolve(ctx, measure="doanh thu", dimension="bang")
    complete = [c["chart_id"] for c in data["candidates"] if c["complete"]]
    assert 690 not in complete
