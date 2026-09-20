"""Measure rendering contract — rebuilds the `measure_render` gate.

WHY THIS FILE EXISTS
--------------------
`guardrail_rules.yaml` has demanded a `measure_render` gate for a long time and
named `test_semantic_query_engine_measures.py`. An audit found that file was
never committed: it only ever ran on the machine that wrote it, so every refactor
of `_render_measure` since has been unprotected while the rule list said
otherwise.

This is a rebuild from the engine's ACTUAL behaviour — each expectation below was
observed by calling the real engine, not recalled from a spec. It is unit-level:
hand-built views, `db=None`, no Postgres and no BigQuery, so it runs anywhere and
belongs in the CI unit tier.

WHAT IT LOCKS
-------------
The composition rules of `_render_measure`, which is where a silently-wrong
number comes from:

  * aggregation wrapper and `count_distinct` spelling
  * `expression` taking precedence over `sql`
  * `filters` / `where_sql` becoming a CASE WHEN wrapper (Looker-style filtered
    measure) rather than a WHERE that would change the whole query's grain
  * AND-joining of the two filter sources
  * SQL-literal quote escaping
  * BUG-018: a numeric column compared against a numeric literal, UNQUOTED
  * circular dependency failing loud
  * an unknown field failing loud, and a numeric dimension falling back to an
    implicit measure (PowerBI's "drag a number, it sums")

Dialect-specific SQL shape is locked separately in `test_dialect_structural.py`.
"""
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_measure_render.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.semantic_query_engine import SemanticQueryEngine  # noqa: E402


DIMENSIONS = [
    {"name": "status", "type": "string"},
    {"name": "amount", "type": "number"},
    {"name": "qty", "type": "number"},
    {"name": "created_at", "type": "date"},
]


def _engine(measures, *, dialect="postgresql", dimensions=None):
    """A one-view engine with no database behind it."""
    engine = SemanticQueryEngine(db=None, database_type=dialect)  # type: ignore[arg-type]
    engine.views_cache = {
        "revenue": SimpleNamespace(
            measures=measures,
            dimensions=dimensions if dimensions is not None else DIMENSIONS,
            table_name="public.rev",
            name="revenue",
        )
    }
    return engine


def _render(measure, *, dialect="postgresql", dimensions=None, agg_override=None):
    engine = _engine([measure], dialect=dialect, dimensions=dimensions)
    return engine._render_measure(f"revenue.{measure['name']}", agg_override=agg_override)


# ── Aggregation basics ────────────────────────────────────────────────────
def test_plain_sum_qualifies_the_column_with_its_view():
    assert _render({"name": "a", "type": "sum", "sql": "amount"}) == "SUM(revenue.amount)"


def test_count_distinct_renders_as_count_distinct_not_count():
    # `COUNT(revenue.id)` instead of `COUNT(DISTINCT ...)` is a silently-wrong
    # number, not an error — exactly the class this suite exists for.
    sql = _render({"name": "c", "type": "count_distinct", "sql": "id"})
    assert sql == "COUNT(DISTINCT revenue.id)"


def test_agg_override_beats_the_declared_type():
    sql = _render({"name": "a", "type": "sum", "sql": "amount"}, agg_override="max")
    assert sql.startswith("MAX("), sql


# ── expression / sql precedence ───────────────────────────────────────────
def test_expression_takes_precedence_over_sql():
    # `expression` is the advanced power-user field. If `sql` won instead, a
    # measure defined as `amount * rate` would silently report raw `amount`.
    sql = _render({
        "name": "a", "type": "sum", "sql": "amount", "expression": "amount * rate",
    })
    assert "amount * rate" in sql
    assert sql == "SUM(amount * rate)"


# ── Filtered measures wrap in CASE WHEN, never in a WHERE ─────────────────
def test_where_sql_becomes_a_case_when_wrapper():
    # A WHERE would filter the whole query and change every other measure in the
    # chart; a CASE WHEN confines the condition to THIS measure.
    sql = _render({"name": "a", "type": "sum", "sql": "amount", "where_sql": "status = 'won'"})
    assert sql == "SUM(CASE WHEN (status = 'won') THEN revenue.amount END)"


def test_structured_filter_becomes_a_case_when_wrapper():
    sql = _render({
        "name": "a", "type": "sum", "sql": "amount",
        "filters": [{"field": "status", "operator": "eq", "value": "won"}],
    })
    assert sql == "SUM(CASE WHEN revenue.status = 'won' THEN revenue.amount END)"


def test_filters_and_where_sql_are_and_joined():
    sql = _render({
        "name": "a", "type": "sum", "sql": "amount",
        "where_sql": "x > 0",
        "filters": [{"field": "status", "operator": "eq", "value": "won"}],
    })
    assert sql == "SUM(CASE WHEN revenue.status = 'won' AND (x > 0) THEN revenue.amount END)"


def test_no_filters_means_no_case_wrapper():
    assert "CASE" not in _render({"name": "a", "type": "sum", "sql": "amount"})


# ── Literal rendering ─────────────────────────────────────────────────────
def test_single_quote_in_a_value_is_escaped_not_injected():
    sql = _render({
        "name": "a", "type": "sum", "sql": "amount",
        "filters": [{"field": "status", "operator": "eq", "value": "O'Brien"}],
    })
    assert "'O''Brien'" in sql
    # A lone unescaped quote would terminate the literal and break the statement.
    assert "'O'Brien'" not in sql


def test_numeric_column_compares_against_an_unquoted_number():
    """BUG-018: a numeric column filtered with a STRING literal.

    The FE sends filter values as text, so `qty >= '1'` used to be emitted.
    Postgres tolerates it; BigQuery rejects it outright with
    "No matching signature for operator >= (INT64, STRING)". The value must
    render unquoted.
    """
    sql = _render({
        "name": "a", "type": "sum", "sql": "amount",
        "filters": [{"field": "qty", "operator": "gte", "value": "1"}],
    })
    assert ">= 1" in sql
    assert ">= '1'" not in sql


def test_string_column_keeps_its_quotes():
    # The mirror of the test above: coercion must not strip quotes from a
    # genuine string comparison, which would be a SQL syntax error.
    sql = _render({
        "name": "a", "type": "sum", "sql": "amount",
        "filters": [{"field": "status", "operator": "eq", "value": "won"}],
    })
    assert "= 'won'" in sql


# ── Failing loud ──────────────────────────────────────────────────────────
def test_ratio_formula_inlines_its_dependencies():
    # `expression` + `depends_on` is the ratio-measure path: the expression is a
    # formula over ALREADY-AGGREGATED measures, so each ref renders as its own
    # aggregate rather than being summed a second time.
    engine = _engine([
        {"name": "won", "type": "sum", "sql": "amount"},
        {"name": "total", "type": "sum", "sql": "amount"},
        {"name": "rate", "type": "number",
         "expression": "${revenue.won} / NULLIF(${revenue.total}, 0)",
         "depends_on": ["revenue.won", "revenue.total"]},
    ])
    sql = engine._render_measure("revenue.rate")
    assert "SUM(revenue.amount)" in sql
    assert "NULLIF" in sql
    # Not re-aggregated: no SUM wrapped around the whole ratio.
    assert not sql.startswith("SUM(")


def test_formula_referencing_a_measure_absent_from_depends_on_fails_loud():
    # Silently allowing it would let a formula pull in an unjoined view.
    engine = _engine([
        {"name": "won", "type": "sum", "sql": "amount"},
        {"name": "total", "type": "sum", "sql": "amount"},
        {"name": "rate", "type": "number",
         "expression": "${revenue.won} / ${revenue.total}",
         "depends_on": ["revenue.won"]},
    ])
    with pytest.raises(ValueError, match="depends_on"):
        engine._render_measure("revenue.rate")


def test_aggregate_in_expression_without_depends_on_fails_loud():
    # Aggregating an expression that already aggregates gives SUM(SUM(x)) —
    # invalid SQL at best, a wrong number at worst. The engine must say so.
    engine = _engine([{"name": "a", "type": "sum", "expression": "SUM(amount)"}])
    with pytest.raises(ValueError, match="depends_on"):
        engine._render_measure("revenue.a")


def test_circular_measure_dependency_raises():
    engine = _engine([
        {"name": "a", "type": "number", "expression": "${revenue.b}", "depends_on": ["revenue.b"]},
        {"name": "b", "type": "number", "expression": "${revenue.a}", "depends_on": ["revenue.a"]},
    ])
    with pytest.raises(ValueError, match="[Cc]ircular"):
        engine._render_measure("revenue.a")


def test_unknown_field_that_is_not_a_dimension_either_raises_value_error():
    # ValueError (not KeyError/AttributeError) because the chart-data endpoints
    # map ValueError to HTTP 400 — a typo must be a 400, never a 500.
    engine = _engine([], dimensions=[{"name": "status", "type": "string"}])
    with pytest.raises(ValueError):
        engine._render_measure("revenue.nope")


def test_numeric_dimension_falls_back_to_an_implicit_sum():
    # PowerBI parity: dragging a raw numeric column into Values sums it, rather
    # than failing with "measure not found".
    engine = _engine([], dimensions=DIMENSIONS)
    assert engine._render_measure("revenue.amount") == "SUM(revenue.amount)"


def test_non_numeric_dimension_falls_back_to_count_distinct_not_sum():
    # SUM over a string would either error or silently produce nulls.
    engine = _engine([], dimensions=DIMENSIONS)
    assert engine._render_measure("revenue.status") == "COUNT(DISTINCT revenue.status)"


def test_sum_over_a_date_dimension_fails_loud():
    engine = _engine([], dimensions=DIMENSIONS)
    with pytest.raises(ValueError):
        engine._render_measure("revenue.created_at", agg_override="sum")
