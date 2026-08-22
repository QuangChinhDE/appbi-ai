"""Top-N / Bottom-N filter → dataLimit convergence (chart render path).

A Top-N control can be authored two ways: as `styleConfig.dataLimit` (the
canonical surface) OR as a filter with operator `top_n` / `bottom_n` (what
FilterBuilder now renders, and what the AI bot sometimes emits). The semantic
SQL builder does NOT treat top_n/bottom_n as a WHERE predicate — left alone it
is a SILENT no-op (the chart shows every row). `_top_n_from_filters` is the
bridge that folds the filter form into the SAME (n, direction) the render path
already applies for dataLimit, so both forms behave identically.

Unit-level: exercises the pure helper, no DB / no BigQuery.
"""
import os
import sys
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_top_n_filter_convergence.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.chart_service import _top_n_from_filters


def test_top_n_filter_yields_desc_limit():
    n, direction = _top_n_from_filters([{"field": "users.name", "operator": "top_n", "value": 10}])
    assert (n, direction) == (10, "desc")


def test_bottom_n_filter_yields_asc_limit():
    n, direction = _top_n_from_filters([{"field": "users.name", "operator": "bottom_n", "value": 5}])
    assert (n, direction) == (5, "asc")


def test_value_read_from_string():
    # A numeric string (some FE inputs serialize N as text) still parses.
    assert _top_n_from_filters([{"operator": "top_n", "value": "25"}]) == (25, "desc")


def test_value_read_from_legacy_object():
    # Legacy shape {"n": N} authored before the value became a bare number.
    assert _top_n_from_filters([{"operator": "top_n", "value": {"n": 7}}]) == (7, "desc")


def test_operator_case_insensitive():
    assert _top_n_from_filters([{"operator": "TOP_N", "value": 3}]) == (3, "desc")


def test_non_top_n_filters_ignored():
    # WHERE-predicate filters never contribute a limit.
    filters = [
        {"field": "orders.status", "operator": "eq", "value": "paid"},
        {"field": "orders.amount", "operator": "gt", "value": 100},
    ]
    assert _top_n_from_filters(filters) == (0, "")


def test_invalid_or_nonpositive_n_yields_no_limit():
    assert _top_n_from_filters([{"operator": "top_n", "value": "abc"}]) == (0, "")
    assert _top_n_from_filters([{"operator": "top_n", "value": 0}]) == (0, "")
    assert _top_n_from_filters([{"operator": "top_n", "value": -3}]) == (0, "")
    assert _top_n_from_filters([{"operator": "top_n"}]) == (0, "")


def test_last_valid_top_n_wins():
    # Two Top-N filters (shouldn't normally happen) — deterministic: last wins.
    filters = [
        {"operator": "top_n", "value": 10},
        {"operator": "bottom_n", "value": 4},
    ]
    assert _top_n_from_filters(filters) == (4, "asc")


def test_empty_and_none_inputs():
    assert _top_n_from_filters([]) == (0, "")
    assert _top_n_from_filters(None) == (0, "")
