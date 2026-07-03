"""SQL normalizer for golden-output comparison.

Whitespace, alias casing, paren depth, identifier quoting all vary on
innocuous emit changes. Normalize with sqlglot (used here ONLY as an
introspection tool — never on the chart engine emit path) so golden diff
isolates SEMANTIC changes from formatting noise.

If sqlglot fails to parse (rare for our engine output, can happen for
complex BQ-specific syntax in user source_query that bubbles up), fall
back to whitespace-collapsing normalization. Never raises.

Single-purpose module; safe to import from harness scripts only.
"""
from __future__ import annotations

import re

try:
    import sqlglot
    import sqlglot.errors
    _HAS_SQLGLOT = True
except ImportError:  # pragma: no cover
    sqlglot = None  # type: ignore
    _HAS_SQLGLOT = False


_WHITESPACE_RE = re.compile(r"\s+")


def normalize_sql(sql: str, dialect: str = "bigquery") -> str:
    """Return canonical form of `sql` for diff-friendly comparison.

    Args:
        sql: raw SQL string (may contain trailing semicolon, multi-line, etc.)
        dialect: sqlglot dialect; defaults to bigquery (most prod queries hit BQ).
                 Postgres-emitted SQL from fixture parses fine under "bigquery"
                 dialect for normalization purposes (we don't execute it).

    Returns:
        Normalized SQL string. Empty for empty input. Never raises.
    """
    if not sql:
        return ""
    text = sql.strip()
    if not text:
        return ""
    if _HAS_SQLGLOT:
        try:
            parsed = sqlglot.parse_one(text, read=dialect)
            return parsed.sql(dialect=dialect, normalize=True, pad=2)
        except (sqlglot.errors.ParseError, sqlglot.errors.TokenError):  # type: ignore[attr-defined]
            pass
        except Exception:
            # Defensive: sqlglot has had crashes on edge-case syntax.
            # Fall back rather than break the harness.
            pass
    return _whitespace_normalize(text)


def _whitespace_normalize(sql: str) -> str:
    """Collapse whitespace + strip trailing semicolons. Last-resort normalization."""
    return _WHITESPACE_RE.sub(" ", sql).strip().rstrip(";").strip()
