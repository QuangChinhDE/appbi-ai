"""Type override helpers for live dataset tables.

This service owns two related concerns:
- compiling safe runtime casts so a table-level type override affects real SQL,
- auditing candidate overrides before they are persisted.

The implementation is optimized for BigQuery because AppBI is currently running
in live-query-first mode against BigQuery. Other dialects keep a conservative
best-effort fallback.
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List

from app.core.logging import get_logger
from app.services import query_cache


def _canonical_column_key(name: Any) -> str:
    """Normalize column names for resilient matching.

    Why: Google Sheets headers often pick up trailing spaces, NBSP, zero-width
    characters, or casing drift between save and read. Without a canonical form,
    a `type_overrides` entry saved as "REV FINAL " never matches a query column
    "REV FINAL", and SUM falls back to the raw VARCHAR — the exact bug we hit.
    How to apply: use as a fallback lookup, never as the stored key. Stored keys
    must remain the user-facing original so SQL identifiers match.
    """
    text = unicodedata.normalize("NFKC", str(name or ""))
    text = text.replace("​", "").replace("﻿", "")
    return " ".join(text.split()).casefold()

logger = get_logger(__name__)

_TYPE_ALIASES = {
    "string": "string",
    "text": "string",
    "varchar": "string",
    "char": "string",
    "integer": "integer",
    "int": "integer",
    "bigint": "integer",
    "smallint": "integer",
    "float": "float",
    "double": "float",
    "decimal": "float",
    "numeric": "float",
    "number": "float",
    "real": "float",
    "boolean": "boolean",
    "bool": "boolean",
    "date": "date",
    "datetime": "datetime",
    "timestamp": "datetime",
}


@dataclass
class TypeAuditResult:
    column: str
    target_type: str
    invalid_count: int
    invalid_examples: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "column": self.column,
            "target_type": self.target_type,
            "invalid_count": self.invalid_count,
            "invalid_examples": self.invalid_examples,
        }


def _quote_identifier(name: str, dialect: str) -> str:
    if dialect in ("bigquery", "mysql"):
        return f"`{name}`"
    return f'"{name}"'


def normalize_target_type(target_type: Any) -> str | None:
    if target_type is None:
        return None
    normalized = _TYPE_ALIASES.get(str(target_type).strip().lower())
    if normalized is None:
        raise ValueError(f"Unsupported type override: {target_type}")
    return normalized


def _split_override_entry(entry: Any) -> tuple[str | None, str | None]:
    """Extract (type, format) from an override entry.

    Accepts both legacy string form ("date") and the richer object form
    ({"type": "date", "format": "DD/MM/YYYY"}). Format is only meaningful for
    date/datetime types and is ignored otherwise.
    """
    if entry is None:
        return None, None
    if isinstance(entry, dict):
        target = entry.get("type")
        fmt = entry.get("format")
        normalized = normalize_target_type(target)
        if normalized in ("date", "datetime") and isinstance(fmt, str) and fmt.strip():
            return normalized, fmt.strip()
        return normalized, None
    return normalize_target_type(entry), None


def normalize_type_overrides(raw_overrides: Dict[str, Any] | None) -> Dict[str, Any]:
    """Return overrides keyed by column.

    Values are either:
    - a plain type string ("float", "date", ...) when no extra options apply, or
    - a dict {"type": "date", "format": "DD/MM/YYYY"} when a parse format was
      explicitly provided by the user.

    Keeping the legacy string form for the common case avoids churning every
    consumer that only cares about the type.
    """
    normalized: Dict[str, Any] = {}
    for column, entry in (raw_overrides or {}).items():
        column_name = str(column).strip()
        if not column_name:
            continue
        target_type, fmt = _split_override_entry(entry)
        if target_type is None:
            continue
        if fmt:
            normalized[column_name] = {"type": target_type, "format": fmt}
        else:
            normalized[column_name] = target_type
    return normalized


def _override_type(entry: Any) -> str | None:
    target_type, _ = _split_override_entry(entry)
    return target_type


def _override_format(entry: Any) -> str | None:
    _, fmt = _split_override_entry(entry)
    return fmt


def _string_cast_type(dialect: str) -> str:
    if dialect == "bigquery":
        return "STRING"
    if dialect == "mysql":
        return "CHAR"
    return "TEXT"


def _trimmed_string_expr(value_sql: str, dialect: str) -> str:
    string_expr = f"CAST({value_sql} AS {_string_cast_type(dialect)})"
    return f"NULLIF(TRIM({string_expr}), '')"


# Map a user-facing date pattern (e.g. "DD/MM/YYYY") to the dialect-specific
# strptime-style pattern. Why: BigQuery SAFE_CAST(... AS DATE) only accepts ISO
# YYYY-MM-DD, so a value like "01/01/2026" silently becomes NULL — exactly the
# bug we hit. Letting the user pick the format on the UI and threading it down
# to PARSE_DATE / STR_TO_DATE / TO_DATE / strptime fixes that cleanly.
_PATTERN_TOKENS_BIGQUERY = [
    ("YYYY", "%Y"),
    ("YY", "%y"),
    ("MMM", "%b"),
    ("MM", "%m"),
    ("DD", "%d"),
    ("HH", "%H"),
    ("mm", "%M"),
    ("ss", "%S"),
]
_PATTERN_TOKENS_MYSQL = [
    ("YYYY", "%Y"),
    ("YY", "%y"),
    ("MMM", "%b"),
    ("MM", "%m"),
    ("DD", "%d"),
    ("HH", "%H"),
    ("mm", "%i"),
    ("ss", "%s"),
]
_PATTERN_TOKENS_POSTGRES = [
    ("YYYY", "YYYY"),
    ("YY", "YY"),
    ("MMM", "Mon"),
    ("MM", "MM"),
    ("DD", "DD"),
    ("HH", "HH24"),
    ("mm", "MI"),
    ("ss", "SS"),
]


def _translate_user_pattern(user_pattern: str, mapping: list[tuple[str, str]]) -> str:
    """Token-replace a user-facing pattern using a placeholder pass.

    Two-pass via placeholders avoids re-replacing tokens introduced by the
    target syntax (e.g. converting MM to %m and then %m's m back into something).
    """
    placeholders: dict[str, str] = {}
    work = user_pattern
    for i, (src, _) in enumerate(mapping):
        token = f"\x00{i}\x00"
        placeholders[token] = mapping[i][1]
        work = work.replace(src, token)
    for token, replacement in placeholders.items():
        work = work.replace(token, replacement)
    return work


def _sql_string_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _has_time_component(user_pattern: str) -> bool:
    return any(t in user_pattern for t in ("HH", "mm", "ss"))


def build_safe_cast_sql(
    value_sql: str,
    target_type: str,
    dialect: str,
    parse_format: str | None = None,
) -> str:
    normalized = normalize_target_type(target_type)
    if normalized is None:
        return value_sql

    if normalized == "string":
        return f"CAST({value_sql} AS {_string_cast_type(dialect)})"

    trimmed = _trimmed_string_expr(value_sql, dialect)
    lowered = f"LOWER({trimmed})"

    if dialect == "bigquery":
        if normalized == "integer":
            return f"SAFE_CAST({trimmed} AS INT64)"
        if normalized == "float":
            return f"SAFE_CAST({trimmed} AS FLOAT64)"
        if normalized == "boolean":
            return (
                "CASE "
                f"WHEN {trimmed} IS NULL THEN NULL "
                f"WHEN {lowered} IN ('true', 't', '1', 'yes', 'y') THEN TRUE "
                f"WHEN {lowered} IN ('false', 'f', '0', 'no', 'n') THEN FALSE "
                f"ELSE SAFE_CAST({trimmed} AS BOOL) END"
            )
        if normalized == "date":
            branches = [f"SAFE_CAST({trimmed} AS DATE)"]
            if parse_format:
                bq_pat = _sql_string_literal(_translate_user_pattern(parse_format, _PATTERN_TOKENS_BIGQUERY))
                if _has_time_component(parse_format):
                    branches.insert(0, f"DATE(SAFE.PARSE_TIMESTAMP({bq_pat}, {trimmed}))")
                else:
                    branches.insert(0, f"SAFE.PARSE_DATE({bq_pat}, {trimmed})")
            branches.extend([
                f"DATE(SAFE_CAST({trimmed} AS DATETIME))",
                f"DATE(SAFE_CAST({trimmed} AS TIMESTAMP))",
            ])
            return "COALESCE(" + ", ".join(branches) + ")"
        if normalized == "datetime":
            branches = [f"SAFE_CAST({trimmed} AS TIMESTAMP)"]
            if parse_format:
                bq_pat = _sql_string_literal(_translate_user_pattern(parse_format, _PATTERN_TOKENS_BIGQUERY))
                if _has_time_component(parse_format):
                    branches.insert(0, f"SAFE.PARSE_TIMESTAMP({bq_pat}, {trimmed})")
                else:
                    branches.insert(0, f"TIMESTAMP(SAFE.PARSE_DATE({bq_pat}, {trimmed}))")
            branches.extend([
                f"TIMESTAMP(SAFE_CAST({trimmed} AS DATETIME))",
                f"TIMESTAMP(SAFE_CAST({trimmed} AS DATE))",
            ])
            return "COALESCE(" + ", ".join(branches) + ")"

    if dialect == "mysql":
        if normalized == "integer":
            return (
                "CASE "
                f"WHEN {trimmed} REGEXP '^-?[0-9]+$' THEN CAST({trimmed} AS SIGNED) "
                "ELSE NULL END"
            )
        if normalized == "float":
            return (
                "CASE "
                f"WHEN {trimmed} REGEXP '^[-+]?(?:[0-9]+(?:\\\\.[0-9]*)?|\\\\.[0-9]+)$' "
                f"THEN CAST({trimmed} AS DECIMAL(38, 12)) ELSE NULL END"
            )
        if normalized == "boolean":
            return (
                "CASE "
                f"WHEN {trimmed} IS NULL THEN NULL "
                f"WHEN {lowered} IN ('true', 't', '1', 'yes', 'y') THEN TRUE "
                f"WHEN {lowered} IN ('false', 'f', '0', 'no', 'n') THEN FALSE "
                "ELSE NULL END"
            )
        if normalized == "date":
            iso_branch = (
                f"WHEN {trimmed} REGEXP '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$' THEN CAST({trimmed} AS DATE) "
            )
            if parse_format:
                my_pat = _sql_string_literal(_translate_user_pattern(parse_format, _PATTERN_TOKENS_MYSQL))
                user_branch = f"WHEN STR_TO_DATE({trimmed}, {my_pat}) IS NOT NULL THEN STR_TO_DATE({trimmed}, {my_pat}) "
                return f"CASE {user_branch}{iso_branch}ELSE NULL END"
            return f"CASE {iso_branch}ELSE NULL END"
        if normalized == "datetime":
            iso_branch = (
                f"WHEN {trimmed} REGEXP '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}([ T][0-9]{{2}}:[0-9]{{2}}(:[0-9]{{2}})?)?$' "
                f"THEN CAST({trimmed} AS DATETIME) "
            )
            if parse_format:
                my_pat = _sql_string_literal(_translate_user_pattern(parse_format, _PATTERN_TOKENS_MYSQL))
                user_branch = f"WHEN STR_TO_DATE({trimmed}, {my_pat}) IS NOT NULL THEN STR_TO_DATE({trimmed}, {my_pat}) "
                return f"CASE {user_branch}{iso_branch}ELSE NULL END"
            return f"CASE {iso_branch}ELSE NULL END"

    if normalized == "integer":
        cleaned = (
            f"REGEXP_REPLACE(REGEXP_REPLACE({trimmed}, '[\\s\\u00A0]', '', 'g'), ',', '', 'g')"
        )
        if dialect == "duckdb":
            return f"TRY_CAST({cleaned} AS BIGINT)"
        # Postgres (+ generic relational): NO `TRY_CAST` and the type is BIGINT;
        # a non-numeric string must yield NULL (not raise), so regex-guard the
        # CAST — mirrors the MySQL branch above and the date `~` branches below.
        return (
            f"CASE WHEN {cleaned} ~ '^-?[0-9]+$' "
            f"THEN CAST({cleaned} AS BIGINT) ELSE NULL END"
        )
    if normalized == "float":
        cleaned = (
            f"REGEXP_REPLACE(REGEXP_REPLACE({trimmed}, '[\\s\\u00A0]', '', 'g'), ',', '', 'g')"
        )
        if dialect == "duckdb":
            return f"TRY_CAST({cleaned} AS DOUBLE)"
        # Postgres (+ generic): `DOUBLE PRECISION` (Postgres has no `DOUBLE` type
        # nor `TRY_CAST`); regex-guard so non-numeric text → NULL, never a 42601.
        return (
            f"CASE WHEN {cleaned} ~ '^[-+]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)$' "
            f"THEN CAST({cleaned} AS DOUBLE PRECISION) ELSE NULL END"
        )
    if normalized == "boolean":
        return (
            "CASE "
            f"WHEN {trimmed} IS NULL THEN NULL "
            f"WHEN {lowered} IN ('true', 't', '1', 'yes', 'y') THEN TRUE "
            f"WHEN {lowered} IN ('false', 'f', '0', 'no', 'n') THEN FALSE "
            "ELSE NULL END"
        )
    if normalized == "date":
        iso_branch = (
            f"WHEN {trimmed} ~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}$' THEN CAST({trimmed} AS DATE) "
        )
        if parse_format:
            if dialect == "duckdb":
                # DuckDB has try_strptime(text, fmt) -> TIMESTAMP that returns
                # NULL on parse failure. Use the BigQuery-style %Y/%m/%d tokens.
                ddb_pat = _sql_string_literal(_translate_user_pattern(parse_format, _PATTERN_TOKENS_BIGQUERY))
                return (
                    f"COALESCE("
                    f"CAST(try_strptime({trimmed}, {ddb_pat}) AS DATE), "
                    f"TRY_CAST({trimmed} AS DATE)"
                    f")"
                )
            pg_pat = _sql_string_literal(_translate_user_pattern(parse_format, _PATTERN_TOKENS_POSTGRES))
            # Postgres TO_DATE raises on invalid input — wrap callers in their
            # own retry/validation if needed; here we simply offer the typed
            # parse alongside the ISO fallback.
            user_branch = (
                f"WHEN {trimmed} IS NOT NULL THEN TO_DATE({trimmed}, {pg_pat}) "
            )
            return f"CASE {user_branch}{iso_branch}ELSE NULL END"
        return f"CASE {iso_branch}ELSE NULL END"
    if normalized == "datetime":
        iso_branch = (
            f"WHEN {trimmed} ~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}([ T]\\d{{2}}:\\d{{2}}(:\\d{{2}})?)?$' "
            f"THEN CAST({trimmed} AS TIMESTAMP) "
        )
        if parse_format:
            if dialect == "duckdb":
                ddb_pat = _sql_string_literal(_translate_user_pattern(parse_format, _PATTERN_TOKENS_BIGQUERY))
                return (
                    f"COALESCE("
                    f"try_strptime({trimmed}, {ddb_pat}), "
                    f"TRY_CAST({trimmed} AS TIMESTAMP)"
                    f")"
                )
            pg_pat = _sql_string_literal(_translate_user_pattern(parse_format, _PATTERN_TOKENS_POSTGRES))
            user_branch = (
                f"WHEN {trimmed} IS NOT NULL THEN TO_TIMESTAMP({trimmed}, {pg_pat}) "
            )
            return f"CASE {user_branch}{iso_branch}ELSE NULL END"
        return f"CASE {iso_branch}ELSE NULL END"

    return value_sql


def build_runtime_projection_query(
    base_query: str,
    columns: Iterable[str],
    type_overrides: Dict[str, Any] | None,
    dialect: str,
) -> str:
    normalized_overrides = normalize_type_overrides(type_overrides)
    column_list = [str(column) for column in columns]
    if not normalized_overrides:
        return base_query
    if not column_list and dialect in ("duckdb", "bigquery"):
        return _build_replace_projection_query(base_query, normalized_overrides, dialect)
    if not column_list:
        return base_query

    canonical_index: Dict[str, str] = {}
    for override_key in normalized_overrides:
        canonical_index.setdefault(_canonical_column_key(override_key), override_key)

    projection: List[str] = []
    matched_keys: set[str] = set()
    for column in column_list:
        quoted = _quote_identifier(column, dialect)
        entry = normalized_overrides.get(column)
        if not entry:
            fallback_key = canonical_index.get(_canonical_column_key(column))
            if fallback_key is not None:
                entry = normalized_overrides.get(fallback_key)
                if entry:
                    matched_keys.add(fallback_key)
                    logger.warning(
                        "Type override key mismatch resolved via canonical lookup: "
                        "stored=%r query_column=%r target=%s",
                        fallback_key,
                        column,
                        entry,
                    )
        else:
            matched_keys.add(column)
        if not entry:
            projection.append(quoted)
            continue
        target_type = _override_type(entry)
        parse_format = _override_format(entry)
        if not target_type:
            projection.append(quoted)
            continue
        cast_expr = build_safe_cast_sql(quoted, target_type, dialect, parse_format=parse_format)
        projection.append(f"{cast_expr} AS {_quote_identifier(column, dialect)}")

    unmatched = set(normalized_overrides) - matched_keys
    if unmatched:
        logger.warning(
            "Type overrides defined for columns not present in projection: %s",
            sorted(unmatched),
        )

    return (
        "SELECT\n  "
        + ",\n  ".join(projection)
        + f"\nFROM (\n{_indent_sql(base_query)}\n) AS _appbi_typed"
    )


def _build_replace_projection_query(
    base_query: str,
    normalized_overrides: Dict[str, Any],
    dialect: str,
) -> str:
    """Fallback projection when the column list is unknown.

    Why: For Google Sheets the output_columns cache can be empty on a cold
    request, which previously skipped CAST entirely and let SUM(VARCHAR) reach
    the engine. DuckDB and BigQuery both support `SELECT * REPLACE (...)`, which
    rewrites only the overridden columns and passes the rest through unchanged.
    How to apply: only used when callers cannot supply a column list; quoted
    callers (chart/preview) still pass explicit columns and take the safer path.
    """
    replacements: List[str] = []
    for column, entry in normalized_overrides.items():
        target_type = _override_type(entry)
        if not target_type:
            continue
        parse_format = _override_format(entry)
        quoted = _quote_identifier(column, dialect)
        cast_expr = build_safe_cast_sql(quoted, target_type, dialect, parse_format=parse_format)
        replacements.append(f"{cast_expr} AS {quoted}")
    if not replacements:
        return base_query
    return (
        "SELECT * REPLACE (\n  "
        + ",\n  ".join(replacements)
        + f"\n)\nFROM (\n{_indent_sql(base_query)}\n) AS _appbi_typed"
    )


def _indent_sql(sql: str, spaces: int = 2) -> str:
    prefix = " " * spaces
    return "\n".join(f"{prefix}{line}" if line else line for line in sql.splitlines())


def _build_invalid_predicate(
    column_name: str,
    target_type: str,
    dialect: str,
    parse_format: str | None = None,
) -> str:
    quoted = _quote_identifier(column_name, dialect)
    trimmed = _trimmed_string_expr(quoted, dialect)
    cast_expr = build_safe_cast_sql(quoted, target_type, dialect, parse_format=parse_format)
    return f"{trimmed} IS NOT NULL AND {cast_expr} IS NULL"


def _build_bigquery_type_audit_query(
    base_query: str,
    column_name: str,
    target_type: str,
    parse_format: str | None = None,
) -> str:
    quoted = _quote_identifier(column_name, "bigquery")
    invalid_predicate = _build_invalid_predicate(column_name, target_type, "bigquery", parse_format=parse_format)
    return f"""
SELECT
  COUNTIF({invalid_predicate}) AS invalid_count,
  ARRAY_AGG(
    DISTINCT IF({invalid_predicate}, CAST({quoted} AS STRING), NULL)
    IGNORE NULLS
    LIMIT 3
  ) AS invalid_examples
FROM (
{_indent_sql(base_query)}
) AS _appbi_type_audit
""".strip()


def audit_type_overrides(
    datasource,
    table_identifier: str,
    base_query: str,
    candidate_overrides: Dict[str, Any] | None,
    available_columns: Iterable[str],
    dialect: str,
) -> List[TypeAuditResult]:
    from app.services.datasource_service import DataSourceConnectionService

    normalized_overrides = normalize_type_overrides(candidate_overrides)
    available_list = [str(column) for column in available_columns]
    available_set = set(available_list)
    canonical_lookup = {_canonical_column_key(c): c for c in available_list}
    audits: List[TypeAuditResult] = []

    for column_name, entry in normalized_overrides.items():
        target_type = _override_type(entry)
        parse_format = _override_format(entry)
        if not target_type or target_type == "string":
            continue
        if column_name not in available_set:
            resolved = canonical_lookup.get(_canonical_column_key(column_name))
            if resolved is None:
                raise ValueError(f"Unknown column for type override: {column_name}")
            column_name = resolved

        cache_payload = {
            "column": column_name,
            "target_type": target_type,
            "parse_format": parse_format,
            "base_query": base_query,
        }
        cached = query_cache.get_cached(
            datasource.id,
            table_identifier,
            "type_audit",
            cache_payload,
            [],
        )
        if cached is not None:
            audits.append(
                TypeAuditResult(
                    column=column_name,
                    target_type=target_type,
                    invalid_count=int(cached.get("invalid_count") or 0),
                    invalid_examples=[str(v) for v in (cached.get("invalid_examples") or [])],
                )
            )
            continue

        if dialect != "bigquery":
            logger.info(
                "Skipping exact type audit for non-BigQuery datasource id=%s column=%s",
                datasource.id,
                column_name,
            )
            audits.append(
                TypeAuditResult(
                    column=column_name,
                    target_type=target_type,
                    invalid_count=0,
                    invalid_examples=[],
                )
            )
            continue

        sql = _build_bigquery_type_audit_query(base_query, column_name, target_type, parse_format=parse_format)
        _, rows, _ = DataSourceConnectionService.execute_query(
            datasource.type.value if hasattr(datasource.type, "value") else datasource.type,
            datasource.config,
            sql,
            timeout_seconds=60,
        )
        first_row = rows[0] if rows else {}
        invalid_count = int(first_row.get("invalid_count") or 0)
        invalid_examples = [str(value) for value in (first_row.get("invalid_examples") or [])]
        cached_payload = {
            "invalid_count": invalid_count,
            "invalid_examples": invalid_examples,
        }
        query_cache.set_cached(
            datasource.id,
            table_identifier,
            "type_audit",
            cache_payload,
            [],
            cached_payload,
        )
        audits.append(
            TypeAuditResult(
                column=column_name,
                target_type=target_type,
                invalid_count=invalid_count,
                invalid_examples=invalid_examples,
            )
        )

    return audits
