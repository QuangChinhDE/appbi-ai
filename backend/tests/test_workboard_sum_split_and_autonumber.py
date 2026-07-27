"""P0: SUM_SPLIT computed columns + Scoped Auto-Number.

Covers the two App Builder primitives shipped together:

* ``SUM_SPLIT(value[, delim])`` in the shared expression engine — sum a
  delimited numeric string ("20;31;25" -> 76), locale-aware, with a strict
  mode that rejects a persisted computed value carrying a non-numeric segment.
* Server-authoritative recompute of FORM ``widget='computed'`` fields — the
  browser value is NEVER trusted; the server re-derives from ``formula`` (the
  tamper guard) and 422s on a strict error.
* Scoped auto-number pure helpers — the (date, scope) bucket keying that makes
  "27/07 + XE01" and "27/07 + XE02" count independently while legacy unscoped
  rules stay byte-for-byte unchanged.

The DB-backed atomic-claim + concurrency proof lives in
``scripts`` run against Postgres (SQLite has no ``ON CONFLICT ... RETURNING``);
see the companion in-container run. These tests are pure and run anywhere.
"""
import os

os.environ.setdefault("DATABASE_URL", "postgresql://stub@localhost/stub")

import pytest
from fastapi import HTTPException

from app.modules.workboards.services.number_parser import (
    parse_locale_number,
    coerce_number,
    sum_split,
)
from app.modules.workboards.services.expr_eval import evaluate, evaluate_detailed
from app.modules.workboards.services import write_service as ws
from app.modules.workboards.schemas import AutoNumberConfig, Screen
from app.modules.workboards.services.rls_service import CallerIdentity
from app.modules.workboards.services.screen_runtime import _apply_field_conditions


# ── number_parser.sum_split (BA acceptance matrix) ─────────────────────────

@pytest.mark.parametrize("value,expected", [
    ("20;31;25", 76.0),
    (" 20; 31;25 ", 76.0),        # surrounding + inner whitespace
    ("20;;31;25;", 76.0),          # empty segments skipped
    ("", 0.0),
    ("   ", 0.0),
    (None, 0.0),
    ("20,5;10,5", 31.0),           # vi-VN comma decimal
    ("1.234,5;10,5", 1245.0),      # vi-VN grouped + decimal
    (42, 42.0),                    # native number passes through
    (42.5, 42.5),
])
def test_sum_split_safe(value, expected):
    assert sum_split(value) == pytest.approx(expected)


def test_sum_split_custom_delimiter():
    assert sum_split("20|31|25", "|") == pytest.approx(76.0)
    # empty delimiter falls back to ';'
    assert sum_split("20;31;25", "") == pytest.approx(76.0)


def test_sum_split_bad_segment_safe_vs_strict():
    # safe mode: a non-numeric segment yields None (rule "doesn't match")
    assert sum_split("20;abc;25") is None
    # strict mode: rejects — the persisted value must never be silently wrong
    with pytest.raises(ValueError):
        sum_split("20;abc;25", strict=True)


def test_sum_split_bool_rejected():
    assert sum_split(True) is None
    with pytest.raises(ValueError):
        sum_split(True, strict=True)


# ── SUM_SPLIT through the expression engine (what computed fields call) ────

def test_sum_split_via_evaluate():
    assert evaluate("SUM_SPLIT(' 20; 31;25 ')", {"row": {}}) == pytest.approx(76.0)
    assert evaluate("SUM_SPLIT(qty)", {"row": {"qty": "20;31;25"}}) == pytest.approx(76.0)
    assert evaluate("SUM_SPLIT('20|31|25','|')", {"row": {}}) == pytest.approx(76.0)


def test_sum_split_detailed_strict_error_and_ok():
    ok = evaluate_detailed("SUM_SPLIT('20;31;25')", {"row": {}})
    assert ok["value"] == pytest.approx(76.0) and "error" not in ok
    bad = evaluate_detailed("SUM_SPLIT('20;abc;25')", {"row": {}})
    assert bad["value"] is None
    assert bad["error"]["code"] == "expr_eval_error"


def test_evaluate_stays_failsafe_on_bad_segment():
    # the fail-safe entry point (used by show_if/required_if) must NOT raise
    assert evaluate("SUM_SPLIT('20;abc;25')", {"row": {}}) is None


def test_arithmetic_is_locale_aware_after_consolidation():
    # expr_eval now shares the vi-VN parser — "1.234,5" + "10,5" = 1245
    assert evaluate("a + b", {"row": {"a": "1.234,5", "b": "10,5"}}) == pytest.approx(1245.0)


# ── FORM computed recompute: the tamper guard ──────────────────────────────

def _form_screen(fields):
    return Screen(
        id="s1",
        kind="form",
        title="Test form",
        form={"fields": fields},
    )


def _identity(role="worker", username="u1"):
    return CallerIdentity(app_user={"username": username, "role": role})


def test_computed_field_recomputed_ignores_client_value():
    screen = _form_screen([
        {"column": "raw", "widget": "text"},
        {"column": "total", "widget": "computed", "formula": "SUM_SPLIT(raw)"},
    ])
    # Client submits a LIE for `total` (999999) — server must recompute 76.
    out = _apply_field_conditions(
        screen,
        {"raw": "20;31;25", "total": 999999},
        _identity(),
    )
    assert out["total"] == pytest.approx(76.0)


def test_computed_field_recompute_chain():
    # one computed field references another (fixpoint ordering)
    screen = _form_screen([
        {"column": "raw", "widget": "text"},
        {"column": "a", "widget": "computed", "formula": "SUM_SPLIT(raw)"},
        {"column": "b", "widget": "computed", "formula": "a * 2"},
    ])
    out = _apply_field_conditions(screen, {"raw": "10;20"}, _identity())
    assert out["a"] == pytest.approx(30.0)
    assert out["b"] == pytest.approx(60.0)


def test_computed_field_strict_error_rejects_save():
    screen = _form_screen([
        {"column": "raw", "widget": "text"},
        {"column": "total", "widget": "computed", "formula": "SUM_SPLIT(raw)"},
    ])
    with pytest.raises(HTTPException) as ei:
        _apply_field_conditions(screen, {"raw": "20;abc;25"}, _identity())
    assert ei.value.status_code == 422


def test_computed_field_empty_formula_left_unwritten():
    screen = _form_screen([
        {"column": "total", "widget": "computed", "formula": ""},
    ])
    out = _apply_field_conditions(screen, {"total": 5}, _identity())
    # draft/empty formula -> client value stripped, nothing written
    assert "total" not in out


# ── Scoped auto-number pure helpers ────────────────────────────────────────

def test_scope_key_unscoped_is_empty_string():
    cfg = AutoNumberConfig(column="c", pattern="X-{N}")
    assert ws._auto_number_scope_key(cfg, {"anything": 1}) == ""


def test_scope_key_distinct_per_combo_and_stable():
    cfg = AutoNumberConfig(column="c", pattern="X-{N}", scope_columns=["ngay", "xe"])
    k1 = ws._auto_number_scope_key(cfg, {"ngay": "27/07/2026", "xe": "XE01"})
    k1b = ws._auto_number_scope_key(cfg, {"ngay": "27/07/2026", "xe": "XE01"})
    k2 = ws._auto_number_scope_key(cfg, {"ngay": "27/07/2026", "xe": "XE02"})
    assert k1 == k1b            # deterministic
    assert k1 != k2            # different vehicle -> different scope
    assert len(k1) == 64        # sha256 hex


def test_scope_key_missing_column_returns_none():
    cfg = AutoNumberConfig(column="c", pattern="X-{N}", scope_columns=["ngay", "xe"])
    assert ws._auto_number_scope_key(cfg, {"ngay": "27/07/2026", "xe": ""}) is None
    assert ws._auto_number_scope_key(cfg, {"ngay": "27/07/2026"}) is None


def test_scope_key_no_collision_across_value_boundary():
    # "a" + "b|c" must not equal "a|b" + "c" — the \x1e/\x1f separators guard this
    cfg = AutoNumberConfig(column="c", pattern="X-{N}", scope_columns=["p", "q"])
    ka = ws._auto_number_scope_key(cfg, {"p": "a", "q": "b|c"})
    kb = ws._auto_number_scope_key(cfg, {"p": "a|b", "q": "c"})
    assert ka != kb


@pytest.mark.parametrize("raw,y,m,d", [
    ("2026-07-27", 2026, 7, 27),
    ("27/07/2026", 2026, 7, 27),
    ("27-07-2026", 2026, 7, 27),
    ("2026-07-27T09:30:00", 2026, 7, 27),
])
def test_parse_row_date(raw, y, m, d):
    dt = ws._parse_row_date(raw)
    assert (dt.year, dt.month, dt.day) == (y, m, d)


@pytest.mark.parametrize("raw", ["", "   ", "not-a-date", None, "13/40/2026"])
def test_parse_row_date_invalid(raw):
    assert ws._parse_row_date(raw) is None


def test_bucket_period_keys():
    from datetime import datetime
    dt = datetime(2026, 7, 27)
    assert ws._auto_number_bucket("never", dt) == "all"
    assert ws._auto_number_bucket("yearly", dt) == "2026"
    assert ws._auto_number_bucket("monthly", dt) == "2026-07"
    assert ws._auto_number_bucket("daily", dt) == "2026-07-27"


def test_render_pattern_uses_ref_date():
    from datetime import datetime
    dt = datetime(2026, 7, 27)
    out = ws._render_auto_number_pattern("C-{DD}{MM}-{N:3}", 5, dt, 0)
    assert out == "C-2707-005"
