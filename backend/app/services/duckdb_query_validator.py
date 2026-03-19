"""
DuckDB query validator using sqlglot AST parsing.

Defense in depth:
  - Layer 1 (engine-level): All queries run on read_only DuckDB connections
  - Layer 2 (this module): sqlglot AST parse rejects non-SELECT early with clear errors
"""
from __future__ import annotations

import sqlglot
import sqlglot.expressions as exp

# Statement types allowed at root level
_ALLOWED_ROOTS = (exp.Select,)


def validate_duckdb_query(sql: str) -> None:
    """
    Validate SQL for DuckDB execution.

    Raises ValueError if:
      - Empty or unparseable
      - Multiple statements
      - Root statement is not SELECT (includes WITH ... SELECT)
      - Any write node found anywhere in AST (INSERT, UPDATE, DELETE, DROP, etc.)
    """
    if not sql or not sql.strip():
        raise ValueError("Empty SQL query")

    try:
        statements = sqlglot.parse(sql, dialect="duckdb")
    except sqlglot.errors.ParseError as e:
        raise ValueError(f"Invalid SQL syntax: {e}")

    if not statements:
        raise ValueError("Empty SQL query")

    if len(statements) > 1:
        raise ValueError("Multiple statements not allowed. Send one query at a time.")

    stmt = statements[0]

    if not isinstance(stmt, _ALLOWED_ROOTS):
        stmt_type = type(stmt).__name__
        raise ValueError(
            f"Statement type '{stmt_type}' is not allowed. Only SELECT queries are permitted."
        )

    # Walk entire AST to catch write ops hidden in subqueries/CTEs
    for node in stmt.walk():
        if isinstance(node, (
            exp.Insert, exp.Update, exp.Delete,
            exp.Drop, exp.Create, exp.Alter,
            exp.Command,  # ATTACH, COPY, PRAGMA, etc.
        )):
            node_type = type(node).__name__
            raise ValueError(
                f"Write operation '{node_type}' found inside query. Not allowed."
            )
