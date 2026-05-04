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


def normalize_type_overrides(raw_overrides: Dict[str, Any] | None) -> Dict[str, str]:
    normalized: Dict[str, str] = {}
    for column, target_type in (raw_overrides or {}).items():
        column_name = str(column).strip()
        if not column_name:
            continue
        normalized_target = normalize_target_type(target_type)
        if normalized_target is not None:
            normalized[column_name] = normalized_target
    return normalized


def _string_cast_type(dialect: str) -> str:
    if dialect == "bigquery":
        return "STRING"
    if dialect == "mysql":
        return "CHAR"
    return "TEXT"


def _trimmed_string_expr(value_sql: str, dialect: str) -> str:
    string_expr = f"CAST({value_sql} AS {_string_cast_type(dialect)})"
    return f"NULLIF(TRIM({string_expr}), '')"


def build_safe_cast_sql(value_sql: str, target_type: str, dialect: str) -> str:
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
            return (
                "COALESCE("
                f"SAFE_CAST({trimmed} AS DATE), "
                f"DATE(SAFE_CAST({trimmed} AS DATETIME)), "
                f"DATE(SAFE_CAST({trimmed} AS TIMESTAMP))"
                ")"
            )
        if normalized == "datetime":
            return (
                "COALESCE("
                f"SAFE_CAST({trimmed} AS TIMESTAMP), "
                f"TIMESTAMP(SAFE_CAST({trimmed} AS DATETIME)), "
                f"TIMESTAMP(SAFE_CAST({trimmed} AS DATE))"
                ")"
            )

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
            return (
                "CASE "
                f"WHEN {trimmed} REGEXP '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$' THEN CAST({trimmed} AS DATE) "
                "ELSE NULL END"
            )
        if normalized == "datetime":
            return (
                "CASE "
                f"WHEN {trimmed} REGEXP '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}([ T][0-9]{{2}}:[0-9]{{2}}(:[0-9]{{2}})?)?$' "
                f"THEN CAST({trimmed} AS DATETIME) ELSE NULL END"
            )

    if normalized == "integer":
        cleaned = (
            f"REGEXP_REPLACE(REGEXP_REPLACE({trimmed}, '[\\s\\u00A0]', '', 'g'), ',', '', 'g')"
        )
        return f"TRY_CAST({cleaned} AS BIGINT)"
    if normalized == "float":
        cleaned = (
            f"REGEXP_REPLACE(REGEXP_REPLACE({trimmed}, '[\\s\\u00A0]', '', 'g'), ',', '', 'g')"
        )
        return f"TRY_CAST({cleaned} AS DOUBLE)"
    if normalized == "boolean":
        return (
            "CASE "
            f"WHEN {trimmed} IS NULL THEN NULL "
            f"WHEN {lowered} IN ('true', 't', '1', 'yes', 'y') THEN TRUE "
            f"WHEN {lowered} IN ('false', 'f', '0', 'no', 'n') THEN FALSE "
            "ELSE NULL END"
        )
    if normalized == "date":
        return (
            "CASE "
            f"WHEN {trimmed} ~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}$' THEN CAST({trimmed} AS DATE) "
            "ELSE NULL END"
        )
    if normalized == "datetime":
        return (
            "CASE "
            f"WHEN {trimmed} ~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}([ T]\\d{{2}}:\\d{{2}}(:\\d{{2}})?)?$' "
            f"THEN CAST({trimmed} AS TIMESTAMP) ELSE NULL END"
        )

    return value_sql


def build_runtime_projection_query(
    base_query: str,
    columns: Iterable[str],
    type_overrides: Dict[str, str] | None,
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
        target_type = normalized_overrides.get(column)
        if not target_type:
            fallback_key = canonical_index.get(_canonical_column_key(column))
            if fallback_key is not None:
                target_type = normalized_overrides.get(fallback_key)
                if target_type:
                    matched_keys.add(fallback_key)
                    logger.warning(
                        "Type override key mismatch resolved via canonical lookup: "
                        "stored=%r query_column=%r target=%s",
                        fallback_key,
                        column,
                        target_type,
                    )
        else:
            matched_keys.add(column)
        if not target_type:
            projection.append(quoted)
            continue
        cast_expr = build_safe_cast_sql(quoted, target_type, dialect)
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
    normalized_overrides: Dict[str, str],
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
    for column, target_type in normalized_overrides.items():
        quoted = _quote_identifier(column, dialect)
        cast_expr = build_safe_cast_sql(quoted, target_type, dialect)
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


def _build_invalid_predicate(column_name: str, target_type: str, dialect: str) -> str:
    quoted = _quote_identifier(column_name, dialect)
    trimmed = _trimmed_string_expr(quoted, dialect)
    cast_expr = build_safe_cast_sql(quoted, target_type, dialect)
    return f"{trimmed} IS NOT NULL AND {cast_expr} IS NULL"


def _build_bigquery_type_audit_query(base_query: str, column_name: str, target_type: str) -> str:
    quoted = _quote_identifier(column_name, "bigquery")
    invalid_predicate = _build_invalid_predicate(column_name, target_type, "bigquery")
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
    candidate_overrides: Dict[str, str] | None,
    available_columns: Iterable[str],
    dialect: str,
) -> List[TypeAuditResult]:
    from app.services.datasource_service import DataSourceConnectionService

    normalized_overrides = normalize_type_overrides(candidate_overrides)
    available_set = {str(column) for column in available_columns}
    audits: List[TypeAuditResult] = []

    for column_name, target_type in normalized_overrides.items():
        if target_type == "string":
            continue
        if column_name not in available_set:
            raise ValueError(f"Unknown column for type override: {column_name}")

        cache_payload = {
            "column": column_name,
            "target_type": target_type,
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

        sql = _build_bigquery_type_audit_query(base_query, column_name, target_type)
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
