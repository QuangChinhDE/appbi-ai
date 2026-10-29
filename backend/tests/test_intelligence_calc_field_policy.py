"""Calculated fields: an AST allow-list, on every dialect (SEC-01 / SEC-01b, PR-0C).

Each refused case is something that READS beyond the query's own fields (a
relation, a bare column, an unknown function), or that the engine has its own
contract for (windows). Each allowed case is a shape a real calculated field
takes. The matrix runs on the default parser and on the three warehouse dialects,
because sqlglot models some functions differently per dialect: BigQuery's
DATE_TRUNC takes its arguments in the other order, and SAFE_DIVIDE is its own
class.
"""
from __future__ import annotations

import pytest

from app.services.calculated_field_policy import CalculatedFieldRefused, validate_calculated_field

DIALECTS = [None, "postgresql", "bigquery", "mysql"]

ALLOWED = [
    "${o.revenue} / NULLIF(${o.orders}, 0)",
    "DATE_DIFF(${o.updated_at}, ${o.created_at}, DAY)",
    "CASE WHEN ${o.amount} > 0 THEN 'dương' ELSE 'âm' END",
    "COUNT(*)",
    "COUNT(DISTINCT ${o.customer_id})",
    "ROUND(${o.margin} * 100.0, 2)",
    "EXTRACT(YEAR FROM ${o.order_date})",
    "SAFE_DIVIDE(${o.revenue}, ${o.orders})",
    "${o.status} IN ('delivered', 'shipped')",
    "COALESCE(${o.region}, 'Chưa gán')",
    "CAST(${o.amount} AS DOUBLE) - ${o.cost}",
    "SUM(${o.amount}) - SUM(${o.refund})",
    "${o.name} || ' - ' || ${o.region}",
    "CURRENT_DATE - ${o.order_date}",
    "DATE_TRUNC('month', ${o.order_date})",
]

#: Allowed on the dialect that has the function (sqlglot models it per dialect).
DIALECT_ALLOWED = [
    ("postgresql", "TO_CHAR(${o.order_date}, 'YYYY')"),
    ("bigquery", "FORMAT_DATE('%Y', ${o.order_date})"),
]


#: Second review: a raw column named like a unit, inside a date function but NOT in
#: its unit slot, read data without `${view.field}`.
UNIT_SLOT_REFUSED = [
    ("postgresql", "DATE_PART('year', date)"),
    ("postgresql", "EXTRACT(YEAR FROM date)"),
    ("bigquery", "DATE_DIFF(date, ${o.d}, DAY)"),
    ("bigquery", "DATE_ADD(date, INTERVAL 1 DAY)"),
    ("mysql", '"x" + 1'),  # a COLUMN under ANSI_QUOTES
]


@pytest.mark.parametrize("dialect,sql", UNIT_SLOT_REFUSED)
def test_a_unit_word_outside_the_unit_slot_is_refused(dialect, sql):
    with pytest.raises(CalculatedFieldRefused):
        validate_calculated_field(sql, dialect=dialect)


@pytest.mark.parametrize("dialect,sql", [
    ("bigquery", "DATE_ADD(${o.d}, INTERVAL 1 DAY)"),
    ("postgresql", "EXTRACT(YEAR FROM ${o.d})"),
    ("mysql", "CAST(${o.n} AS UNSIGNED)"),
    ("duckdb", "CAST(${o.n} AS HUGEINT)"),
])
def test_unit_slots_and_unsigned_casts_still_pass(dialect, sql):
    validate_calculated_field(sql, dialect=dialect)


#: Refused where the construct IS a column read. On BigQuery and MySQL a
#: double-quoted token is a string literal (no data is read), so it is not listed there.
DIALECT_REFUSED = [
    ("postgresql", 'SUM("date")'),
    (None, 'SUM("date")'),
]


@pytest.mark.parametrize("dialect,sql", DIALECT_REFUSED)
def test_a_quoted_raw_column_is_refused_where_it_is_a_column(dialect, sql):
    with pytest.raises(CalculatedFieldRefused):
        validate_calculated_field(sql, dialect=dialect)


@pytest.mark.parametrize("dialect,sql", DIALECT_ALLOWED)
def test_a_dialect_specific_function_is_allowed_on_its_dialect(dialect, sql):
    validate_calculated_field(sql, dialect=dialect)

REFUSED = {
    "scalar subquery over another table": "(SELECT MAX(salary) FROM hr.payroll)",
    "subquery inside arithmetic": "${o.amount} + (SELECT 1)",
    "EXISTS over a table": "EXISTS (SELECT 1 FROM hr.payroll)",
    "IN over a subquery": "${o.id} IN (SELECT id FROM hr.payroll)",
    "bare column outside the field refs": "salary * 2",
    "qualified column": "hr.payroll.salary",
    "unknown function": "pg_read_file('/etc/passwd')",
    "second statement": "1; DROP TABLE x",
    "window (own spec contract)": "SUM(${o.amount}) OVER ()",
    "foreign placeholder syntax": "${TABLE}.salary",
    "empty": "   ",
    # ── found by the semantic-guard review: lexer disagreement ──
    # sqlglot nests block comments for BigQuery/MySQL; those engines do not, so
    # the subquery was invisible to the AST and ran in the warehouse.
    "nested-comment smuggling (BigQuery)": "/* /* */ (SELECT MAX(salary) FROM hr.payroll) + # */\n 1",
    "nested-comment smuggling (MySQL)": "/* /* */ (SELECT MAX(salary) FROM hr.payroll) + -- */\n 1",
    "MySQL executable comment": "/*! (SELECT MAX(salary) FROM hr.payroll) + */ 1",
    "line comment": "${o.amount} -- harmless?",
    "triple-quoted string (BigQuery lexer class)": "''' + (SELECT MAX(salary) FROM hr.payroll) + '''",
    "dollar-quoted string (Postgres lexer class)": "$$ x $$ || ${o.name}",
    "backslash escape": "'a\\' + (SELECT 1) + '",
    # ── unit words are units only as a unit argument ──
    "raw column named like a unit": "SUM(year)",
    # ── internal placeholder names cannot be typed ──
    "hand-written placeholder": "__cfref7 + 1",
    # ── casts reach scalar types only ──
    "catalog cast (table existence)": "CAST('hr.payroll' AS regclass)",
}


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize("sql", ALLOWED)
def test_a_real_calculated_field_is_allowed(sql, dialect):
    validate_calculated_field(sql, dialect=dialect)


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize("why,sql", list(REFUSED.items()), ids=list(REFUSED))
def test_a_construct_that_reads_beyond_the_query_is_refused(why, sql, dialect):
    with pytest.raises(CalculatedFieldRefused):
        validate_calculated_field(sql, dialect=dialect)


def test_the_refusal_is_a_value_error_so_the_api_answers_400():
    with pytest.raises(ValueError):
        validate_calculated_field("(SELECT 1)")


def test_the_engine_uses_the_policy_before_rendering():
    """The protected engine delegates to the policy: no second, weaker check."""
    from app.services.semantic_query_engine import SemanticQueryEngine

    eng = SemanticQueryEngine.__new__(SemanticQueryEngine)
    eng.database_type = "bigquery"
    with pytest.raises(CalculatedFieldRefused):
        eng._validate_calculated_field_safety("(SELECT MAX(salary) FROM hr.payroll)")
    eng._validate_calculated_field_safety("SAFE_DIVIDE(${o.revenue}, ${o.orders})")
