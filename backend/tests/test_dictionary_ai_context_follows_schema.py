"""Dictionary notes for a deleted table or a removed column never reach AI context.

Notes are keyed by table id + column name and nothing migrates or prunes them
when a table is deleted or a column is renamed / removed / dropped at source.
``build_dictionary_context`` (the compiled AI context) still emitted them — a
deleted table as "Table 12", a removed column with its old meaning — and the AI
bot's knowledge context described columns that no longer exist. The notes stay
stored (the author can repair them); the AI context is filtered to the live schema.
"""
from __future__ import annotations

from types import SimpleNamespace

from app.services.dataset_dictionary_service import build_dictionary_context, live_column_names

ORDERS = SimpleNamespace(
    id=11, display_name="orders", source_table_name="orders",
    columns_cache={"columns": [{"name": "id"}, {"name": "amount"}]},
    transformations=[{"type": "add_column", "enabled": True, "params": {"newField": "net", "expression": "[amount]"}}],
)
DATASET = SimpleNamespace(name="Sales", description=None, dictionary={"table_notes": [
    {"table_id": 11, "owner_note": "fact table", "column_notes": [
        {"column_name": "amount", "description": "gross amount"},
        {"column_name": "net", "description": "amount after refunds"},
        {"column_name": "discount_pct", "description": "REMOVED COLUMN MEANING"},
    ]},
    {"table_id": 12, "owner_note": "DELETED TABLE NOTE"},
]})


def test_ai_context_describes_only_the_live_schema():
    ctx = build_dictionary_context(DATASET, [ORDERS])
    assert "gross amount" in ctx and "amount after refunds" in ctx
    assert "REMOVED COLUMN MEANING" not in ctx
    assert "DELETED TABLE NOTE" not in ctx and "Table 12" not in ctx


def test_an_uncached_table_is_not_filtered_on_a_guess():
    bare = SimpleNamespace(id=11, display_name="orders", source_table_name="orders",
                           columns_cache=None, transformations=[])
    assert live_column_names(bare) is None
    assert "REMOVED COLUMN MEANING" in build_dictionary_context(DATASET, [bare])
