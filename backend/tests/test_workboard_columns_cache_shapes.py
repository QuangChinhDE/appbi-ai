"""Regression: Workboard Write Service must read BOTH ``columns_cache`` shapes.

``DatasetTable.columns_cache`` is polymorphic (schemas.dataset:
``Union[List[Any], Dict[str, Any]]``). Legacy tables store a bare list; the
modern dataset-publish path stores ``{"columns": [...]}``. ``_table_columns``
used to walk only the list shape, so an object-shaped cache read back as "no
columns" and every write bounced with a false
"primary key columns are missing" error even though the column existed
(bug report: Demo_caseQAQC / ID_PHIEU). In this environment 200/200 cached
tables are object-shaped, so the bug blocked writes on essentially every
modern-dataset workboard.

These tests lock the normaliser and the missing-PK gate for both shapes.
"""
import os
import types

os.environ.setdefault("DATABASE_URL", "postgresql://stub@localhost/stub")

import pytest

from app.modules.workboards.services.write_service import (
    _column_cache_entries,
    _table_columns,
    _table_primary_key_columns,
)


def _tbl(cache):
    return types.SimpleNamespace(columns_cache=cache)


# ── TC01 / TC02: column names from BOTH shapes ─────────────────────────────

def test_tc01_list_shape():
    t = _tbl([{"name": "ID_PHIEU"}, {"name": "NGAY_LAP_PHIEU"}])
    assert _table_columns(t) == ["ID_PHIEU", "NGAY_LAP_PHIEU"]


def test_tc02_object_shape():
    t = _tbl({"columns": [{"name": "ID_PHIEU", "type": "string"},
                          {"name": "NGAY_LAP_PHIEU", "type": "string"}]})
    assert _table_columns(t) == ["ID_PHIEU", "NGAY_LAP_PHIEU"]


def test_bare_string_entries():
    assert _table_columns(_tbl(["A", "B"])) == ["A", "B"]


@pytest.mark.parametrize("cache", [None, [], {}, {"columns": None}, {"foo": 1}, "garbage", 42])
def test_unreadable_shapes_yield_empty_not_crash(cache):
    assert _table_columns(_tbl(cache)) == []
    assert _column_cache_entries(_tbl(cache)) == []


def test_column_cache_entries_both_shapes():
    assert _column_cache_entries(_tbl([{"name": "A"}])) == [{"name": "A"}]
    assert _column_cache_entries(_tbl({"columns": [{"name": "A"}]})) == [{"name": "A"}]


# ── Primary key inference reads both shapes ────────────────────────────────

def test_pk_flagged_object_shape():
    t = _tbl({"columns": [{"name": "ID_PHIEU", "is_primary_key": True}, {"name": "X"}]})
    assert _table_primary_key_columns(t) == ["ID_PHIEU"]


def test_pk_flagged_list_shape():
    t = _tbl([{"name": "ID_PHIEU", "is_primary_key": True}, {"name": "X"}])
    assert _table_primary_key_columns(t) == ["ID_PHIEU"]


def test_pk_falls_back_to_id_then_suffix():
    assert _table_primary_key_columns(_tbl({"columns": [{"name": "id"}, {"name": "x"}]})) == ["id"]
    assert _table_primary_key_columns(_tbl({"columns": [{"name": "order_id"}, {"name": "x"}]})) == ["order_id"]


# ── TC03 / TC04: the missing-PK gate logic (the actual write guard) ────────
# _build_context computes: missing = [c for c in pk_cols if c not in allowed]
# when allowed is non-empty. Model that decision directly against real column
# lists derived from an object-shaped cache.

def _missing_pk(pk_cols, table):
    allowed = _table_columns(table)
    return [c for c in pk_cols if c not in allowed] if allowed else []


def test_tc03_valid_pk_object_cache_not_missing():
    t = _tbl({"columns": [{"name": "ID_PHIEU"}, {"name": "NGAY_LAP_PHIEU"}]})
    assert _missing_pk(["ID_PHIEU"], t) == []   # was ["ID_PHIEU"] before the fix


def test_tc04_unknown_pk_still_blocked():
    t = _tbl({"columns": [{"name": "ID_PHIEU"}]})
    assert _missing_pk(["UNKNOWN_ID"], t) == ["UNKNOWN_ID"]
