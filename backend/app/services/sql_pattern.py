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

Quoting is NOT delegated: every literal here goes through the canonical,
dialect-aware `app.services.sql_literal.quote_string` (a backslash escapes inside
BigQuery and MySQL strings, so the old per-builder quote-doubling let a value
ending in a backslash end the string early). The `quote` argument is kept for
call-site compatibility and ignored.

For LIKE engines the pattern escapes its own escape character (backslash)
first, so a backslash the viewer typed is matched literally too, and the ESCAPE
clause is itself a dialect-quoted literal: one backslash on Postgres/DuckDB, two
on MySQL, where a lone backslash inside quotes would be an unterminated string.
"""
from __future__ import annotations

from typing import Callable

from app.services.sql_literal import quote_string

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
        lit = quote_string(text, dialect)
        if operator in ("like", "contains"):
            return f"STRPOS({expr}, {lit}) > 0"
        if operator == "not_contains":
            return f"STRPOS({expr}, {lit}) = 0"
        if operator == "starts_with":
            return f"STARTS_WITH({expr}, {lit})"
        if operator == "ends_with":
            return f"ENDS_WITH({expr}, {lit})"
        raise ValueError(f"not a pattern operator: {operator!r}")
    # LIKE engines. For a value without backslash or quote this is byte-for-byte
    # what the builders always emitted on Postgres/DuckDB.
    esc = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    escape = quote_string("\\", dialect)

    def pat(p: str) -> str:
        return quote_string(p, dialect)

    if operator in ("like", "contains"):
        return f"{expr} LIKE {pat('%' + esc + '%')} ESCAPE {escape}"
    if operator == "not_contains":
        return f"{expr} NOT LIKE {pat('%' + esc + '%')} ESCAPE {escape}"
    if operator == "starts_with":
        return f"{expr} LIKE {pat(esc + '%')} ESCAPE {escape}"
    if operator == "ends_with":
        return f"{expr} LIKE {pat('%' + esc)} ESCAPE {escape}"
    raise ValueError(f"not a pattern operator: {operator!r}")


def regex_predicate(
    expr: str,
    value: object,
    dialect: str | None,
    quote: Callable[[str], str],
) -> str:
    """`expr` contains a match of the regular expression `value` (unanchored).

    Each engine has its own spelling; `SIMILAR TO` is NOT one of them — it is
    an anchored SQL pattern where `.` is literal, so on Postgres it returned a
    plausible, wrong row set for an ordinary regex. An engine without a known
    spelling is refused rather than guessed."""
    d = (dialect or "").lower()
    lit = quote_string(str(value), dialect)
    if d == "bigquery":
        return f"REGEXP_CONTAINS({expr}, {lit})"
    if d in ("postgresql", "postgres", ""):
        return f"{expr} ~ {lit}"
    if d == "duckdb":
        return f"regexp_matches({expr}, {lit})"
    if d == "mysql":
        return f"{expr} REGEXP {lit}"
    raise ValueError(f"Toán tử 'matches_regex' chưa được hỗ trợ trên {dialect}.")
