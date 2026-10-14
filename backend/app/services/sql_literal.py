"""The ONE way a Python value becomes a SQL literal, per dialect.

Every query builder used to carry its own `"'" + v.replace("'", "''") + "'"`.
That is correct for Postgres and DuckDB (standard strings: a backslash is an
ordinary character) and WRONG for the two engines where a backslash escapes
inside a string literal:

  * BigQuery (GoogleSQL) — `'a\\'` is an unterminated string: the backslash
    escapes the closing quote. `'' ` doubling does not neutralise it.
  * MySQL (default sql_mode) — same.

So a viewer filter value ending in `\\` swallowed the closing quote, and the
next value in the same IN list ran as SQL: `col IN ('\\', ') OR 1=1 #')`.
User-controlled values reach these builders from public links, embeds,
slicers, viewer filters and the distinct-values search.

Contract (locked by tests/test_sql_literal_security.py):

  * the literal parses back, on its dialect, to exactly the input value — no
    input can end the string early or change the statement's structure;
  * NULL / booleans / finite numbers are rendered unquoted; NaN/Infinity are
    refused (``str(float('nan'))`` is the bare word ``nan``);
  * BigQuery also escapes newlines/CR (a raw newline is illegal inside a
    single-quoted GoogleSQL string);
  * MySQL output is safe under BOTH backslash modes: quotes are doubled (never
    backslash-escaped), so with NO_BACKSLASH_ESCAPES the worst case is a
    wrong value, never an open string.
"""
from __future__ import annotations

import math
from typing import Any

_BACKSLASH_DIALECTS = frozenset({"bigquery", "mysql"})


def _norm(dialect: str | None) -> str:
    d = (dialect or "").strip().lower()
    return "postgresql" if d in ("postgres", "") else d


def quote_string(value: Any, dialect: str | None) -> str:
    """A single-quoted SQL string literal for ``str(value)`` on ``dialect``."""
    text = str(value)
    d = _norm(dialect)
    if d == "bigquery":
        out = (
            text.replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        )
        return "'" + out + "'"
    if d == "mysql":
        return "'" + text.replace("\\", "\\\\").replace("'", "''") + "'"
    # Postgres (standard_conforming_strings, the default since 9.1), DuckDB,
    # SQLite: backslash is literal; doubling the quote is the whole escape.
    return "'" + text.replace("'", "''") + "'"


def sql_literal(value: Any, dialect: str | None) -> str:
    """NULL / TRUE / FALSE / a finite number unquoted; anything else a string."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("A filter value must be a finite number.")
        return str(value)
    return quote_string(value, dialect)


def uses_backslash_escapes(dialect: str | None) -> bool:
    return _norm(dialect) in _BACKSLASH_DIALECTS
