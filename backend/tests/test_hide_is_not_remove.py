"""Hiding a column is visibility, not projection.

Manage Columns' "Hide" saved a ``select_columns`` step and PREPENDED it, so the
compiler emitted a real SELECT without the hidden column: a calculated column
over it then failed ("column no longer exists"), and a measure / relationship
over it either broke or made the hide refused outright. Power BI's Hide keeps
the field in the model and only takes it out of field pickers.

``hide_columns`` is now a no-SQL step; the semantic model marks the fields
``hidden``; a real projection (``select_columns`` / ``remove_columns``) is still
a separate, explicit operation.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.transformation_compiler import TransformationCompiler, TransformationError

SOURCE = ["id", "price", "qty", "customer_id"]
CALC = {"type": "add_column", "enabled": True, "params": {"newField": "revenue", "expression": "[price] * [qty]"}}
HIDE = {"type": "hide_columns", "enabled": True, "params": {"columns": ["price", "customer_id"]}}


def test_a_hidden_column_stays_in_the_relation_and_feeds_a_calculated_column():
    sql, cols = TransformationCompiler.compile_transformations(
        "SELECT * FROM orders", [CALC, HIDE], dialect="postgres", available_columns=SOURCE)
    assert cols == [*SOURCE, "revenue"]
    assert "price" in sql and "customer_id" in sql


def test_hide_order_does_not_matter():
    a = TransformationCompiler.compile_transformations("SELECT * FROM o", [HIDE, CALC], dialect="postgres",
                                                       available_columns=SOURCE)
    b = TransformationCompiler.compile_transformations("SELECT * FROM o", [CALC, HIDE], dialect="postgres",
                                                       available_columns=SOURCE)
    assert a == b


def test_an_explicit_projection_still_removes():
    select = {"type": "select_columns", "enabled": True, "params": {"columns": ["id", "qty"]}}
    with pytest.raises(TransformationError):
        TransformationCompiler.compile_transformations("SELECT * FROM o", [select, CALC], dialect="postgres",
                                                       available_columns=SOURCE)


def test_the_model_marks_hidden_fields_and_keeps_them_resolvable():
    from app.services.dataset_model_service import _semantic_fields_for_table

    table = SimpleNamespace(
        id=11, source_kind="physical_table", transformations=[CALC, HIDE],
        columns_cache={"columns": [{"name": c, "type": "integer" if c != "customer_id" else "string"}
                                   for c in SOURCE]})
    dims, _measures = _semantic_fields_for_table(SimpleNamespace(settings={}), table)
    by = {d["name"]: d for d in dims}
    assert by["price"]["hidden"] is True and by["customer_id"]["hidden"] is True
    assert by["qty"]["hidden"] is False and by["revenue"]["hidden"] is False
    assert by["price"]["sql"] == "price"  # still a real, queryable field


def test_unhiding_restores_visibility_without_touching_the_relation():
    from app.services.dataset_model_service import _semantic_fields_for_table

    table = SimpleNamespace(id=11, source_kind="physical_table", transformations=[CALC],
                            columns_cache={"columns": [{"name": c, "type": "integer"} for c in SOURCE]})
    dims, _ = _semantic_fields_for_table(SimpleNamespace(settings={}), table)
    assert not any(d["hidden"] for d in dims)
