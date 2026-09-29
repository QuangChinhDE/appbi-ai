"""Text-pattern predicates (contains / not_contains / starts_with / ends_with / like),
per SQL dialect — one implementation for every SQL builder.

Postgres, DuckDB and MySQL-style engines express them with LIKE and an explicit
escape character, so a `%` or `_` the viewer typed is matched literally.

BigQuery (GoogleSQL) has no `ESCAPE` clause: `x LIKE '%a\\%%' ESCAPE '\\'` is a
syntax error, so every text filter on a BigQuery dataset failed — charts, the
dropdown's value search and the distinct-values cascade alike. BigQuery gets the
functions that take the value as a plain string instead of a pattern
(`STRPOS`, `STARTS_WITH`, `ENDS_WITH`): there is no wildcard to escape, so the
value's `%` and `_` are literal by construction. Case sensitivity is the same as
LIKE's on both engines, and a NULL column still matches nothing (both NOT LIKE
and `STRPOS(...) = 0` are NULL for a NULL input).

The value is quoted by the CALLER's own string-literal function, so each builder
keeps exactly the literal escaping it already had; this module changes only the
predicate's shape.
"""
from __future__ import annotations

from typing import Callable

PATTERN_OPERATORS = frozenset({"like", "contains", "not_contains", "starts_with", "ends_with"})


def pattern_predicate(
    expr: str,
    operator: str,
    value: object,
    dialect: str | None,
    quote: Callable[[str], str],
) -> str:
    """The SQL for `expr <operator> value`. `operator` is one of PATTERN_OPERATORS
    (`like` is the legacy name of `contains`)."""
    text = str(value)
    if (dialect or "").lower() == "bigquery":
        if text == "":
            # Postgres: LIKE '%%' (and 'x%' / '%x' with x empty) matches every
            # non-null row; NOT LIKE '%%' matches none. Stated, not left to
            # STRPOS(col, '')'s behaviour.
            if operator in ("like", "contains", "starts_with", "ends_with"):
                return f"({expr} IS NOT NULL)"
            if operator == "not_contains":
                return "FALSE"
        lit = quote(text)
        if operator in ("like", "contains"):
            return f"STRPOS({expr}, {lit}) > 0"
        if operator == "not_contains":
            return f"STRPOS({expr}, {lit}) = 0"
        if operator == "starts_with":
            return f"STARTS_WITH({expr}, {lit})"
        if operator == "ends_with":
            return f"ENDS_WITH({expr}, {lit})"
        raise ValueError(f"not a pattern operator: {operator!r}")
    # Unchanged for every other engine (byte-for-byte what the builders emitted).
    esc = text.replace("'", "''").replace("%", "\\%").replace("_", "\\_")
    if operator in ("like", "contains"):
        return f"{expr} LIKE '%{esc}%' ESCAPE '\\'"
    if operator == "not_contains":
        return f"{expr} NOT LIKE '%{esc}%' ESCAPE '\\'"
    if operator == "starts_with":
        return f"{expr} LIKE '{esc}%' ESCAPE '\\'"
    if operator == "ends_with":
        return f"{expr} LIKE '%{esc}' ESCAPE '\\'"
    raise ValueError(f"not a pattern operator: {operator!r}")
