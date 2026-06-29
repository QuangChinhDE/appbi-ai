"""Cascade regression — a slicer's distinct-values dropdown must never be
constrained by a filter on its OWN field.

The public path merges the dashboard's saved slicer/filter defaults into the
cascade context (`_build_public_chart_filters`), which would re-inject a
filter on the dropdown's own field and pin it to its current value. The BE
strips that via `_distinct_filter_targets_self`, mirroring the FE's
`getDistinctValueFilterContext`. Other fields (dashboard filters, sibling
slicers) MUST still cascade in.
"""

import os
os.environ.setdefault("DATABASE_URL", "postgresql://stub@localhost/stub")

from app.services.dataset_model_service import _distinct_filter_targets_self as targets_self


def test_self_field_qualified_is_excluded():
    assert targets_self("city", "name", {"semanticField": "city.name", "operator": "in", "value": ["A"]})


def test_other_field_qualified_is_kept():
    # Dashboard filter on a DIFFERENT field must still cascade into the slicer.
    assert not targets_self("city", "name", {"semanticField": "region.name", "value": ["North"]})


def test_same_field_name_different_view_not_a_false_match():
    # orders.country must not be mistaken for users.country.
    assert not targets_self("users", "country", {"semanticField": "orders.country", "value": ["VN"]})


def test_bare_field_self_match_when_unqualified():
    assert targets_self("city", "name", {"field": "name", "value": "x"})


def test_bare_field_ignored_when_qualified_ref_present():
    # A qualified fieldKey pointing elsewhere wins over a bare `field` that
    # happens to collide with the target's field_name.
    assert not targets_self("users", "country", {"fieldKey": "orders.country", "field": "country"})


def test_linked_field_targeting_self_is_excluded():
    assert targets_self("city", "name", {"semanticField": "region.name", "linkedFields": ["city.name"]})


def test_empty_condition_is_kept():
    assert not targets_self("city", "name", {})
