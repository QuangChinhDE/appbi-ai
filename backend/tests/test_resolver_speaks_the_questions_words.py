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
