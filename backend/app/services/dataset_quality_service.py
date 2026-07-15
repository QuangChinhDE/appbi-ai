"""
Dataset Quality Service
=======================
Manages CRUD for DatasetQualityRule and the execution of DatasetQualityRun.

Run execution strategy
----------------------
Each rule is compiled to a lightweight SQL fragment that returns two numbers:
  rows_checked  — total rows scanned
  rows_failed   — rows that violated the expectation

The check SQL is executed against the datasource that backs the table:
  • physical_table / sql_query  → DataSourceConnectionService.execute_query()
  • derived_table               → DataSourceConnectionService.execute_query() via proxy SQL
  • generated_calendar          → no execution (calendar is auto-generated; skip)

The overall quality score = (rules_passed / rules_enabled) * 100.

Rule-type catalogue
-------------------
Completeness:
  not_null          → COUNT(*) FILTER (WHERE col IS NULL)
  not_blank         → COUNT(*) FILTER (WHERE TRIM(CAST(col AS TEXT)) = '')
  completeness_pct  → null% must be ≤ threshold

Validity:
  accepted_values   → values not in allowed list
  pattern_match     → values not matching regex
  range_check       → values outside [min, max]
  format_check      → email / url / date / phone heuristic

Uniqueness:
  unique_column     → COUNT(*) - COUNT(DISTINCT col) > 0
  unique_combo      → duplicate combinations

Consistency:
  cross_column      → user-supplied SQL boolean expression
    cross_table       → join two dataset tables, then evaluate a SQL boolean expression

Timeliness:
  freshness_days    → MAX(date_col) older than N days

Accuracy:
  row_count_range   → total row count outside [min, max]
  statistical_range → values outside mean ± z*stddev (z-score)
"""
from __future__ import annotations

import json
import re
import time
from datetime import date, datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models.dataset import Dataset, DatasetQualityRule, DatasetQualityRun, DatasetTable
from app.schemas.dataset import (
    QualityRuleCreate,
    QualityRuleUpdate,
    QualitySummaryResponse,
    QualityDimensionSummary,
)

logger = get_logger(__name__)


class QualityRuleConflictError(ValueError):
    def __init__(self, message: str, *, existing_rule_id: Optional[int] = None):
        super().__init__(message)
        self.existing_rule_id = existing_rule_id


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VALID_DIMENSIONS = {
    "completeness", "validity", "uniqueness", "consistency", "timeliness", "accuracy"
}
VALID_SEVERITIES = {"info", "warning", "error"}
RULE_TYPE_LEVEL: Dict[str, str] = {
    "not_null": "column",
    "not_blank": "column",
    "completeness_pct": "column",
    "accepted_values": "column",
    "pattern_match": "column",
    "range_check": "column",
    "format_check": "column",
    "unique_column": "column",
    "unique_combo": "table",
    "cross_column": "table",
    "cross_table": "table",
    "freshness_days": "table",
    "row_count_range": "table",
    "statistical_range": "column",
    "schema_drift": "table",
    "custom_sql": "table",
}

# rule_type → natural dimension (suggestion only; users may pick any dimension)
RULE_TYPE_DIMENSION: Dict[str, str] = {
    "not_null": "completeness",
    "not_blank": "completeness",
    "completeness_pct": "completeness",
    "accepted_values": "validity",
    "pattern_match": "validity",
    "range_check": "validity",
    "format_check": "validity",
    "unique_column": "uniqueness",
    "unique_combo": "uniqueness",
    "cross_column": "consistency",
    "cross_table": "consistency",
    "freshness_days": "timeliness",
    "row_count_range": "accuracy",
    "statistical_range": "accuracy",
    "schema_drift": "consistency",
    "custom_sql": "accuracy",
}

# Pre-built format regex hints
_FORMAT_PATTERNS = {
    "email": r"^[^\s@]+@[^\s@]+\.[^\s@]+$",
    "url": r"^https?://",
    "phone": r"^\+?[0-9\s\-().]{7,20}$",
    "date": r"^\d{4}-\d{2}-\d{2}$",
    "datetime": r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}",
}

VIOLATION_PREVIEW_LIMIT = 20


# ---------------------------------------------------------------------------
# SQL builder helpers
# ---------------------------------------------------------------------------

def _q(col: str, dialect: str = "postgresql") -> str:
    """Quote an identifier using the correct delimiter for the dialect."""
    if dialect in ("bigquery", "mysql"):
        return '`' + col.replace('`', '``') + '`'
    return '"' + col.replace('"', '""') + '"'


def _text_cast(expr: str, dialect: str) -> str:
    """CAST to text using the dialect-appropriate type name."""
    if dialect == "bigquery":
        return f"CAST({expr} AS STRING)"
    if dialect == "mysql":
        return f"CAST({expr} AS CHAR)"
    if dialect == "duckdb":
        return f"CAST({expr} AS VARCHAR)"
    return f"CAST({expr} AS TEXT)"


def _numeric_cast_expr(expr: str, dialect: str) -> str:
    if dialect == "bigquery":
        return f"CAST({expr} AS FLOAT64)"
    if dialect == "mysql":
        return f"CAST({expr} AS DECIMAL(38,6))"
    if dialect == "duckdb":
        return f"CAST({expr} AS DOUBLE)"
    return f"CAST({expr} AS DOUBLE PRECISION)"


def _wrap_table_ref(table_ref: str, alias: str) -> str:
    """Give every table reference a predictable alias, even when it is already a subquery."""
    return f"(SELECT * FROM {table_ref}) AS {alias}"


def _qualified_col(alias: str, col: str, dialect: str = "postgresql") -> str:
    return f"{alias}.{_q(col, dialect)}"


def _serialize_preview_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {str(key): _serialize_preview_value(val) for key, val in value.items()}
    if isinstance(value, list):
        return [_serialize_preview_value(item) for item in value]
    return value


def _serialize_preview_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        {str(key): _serialize_preview_value(value) for key, value in row.items()}
        for row in rows
        if isinstance(row, dict)
    ]


def _build_violation_preview_sql(
    table_ref: str,
    rule_type: str,
    col: Optional[str],
    config: Dict[str, Any],
    dialect: str = "postgresql",
    secondary_table_ref: Optional[str] = None,
    limit: int = VIOLATION_PREVIEW_LIMIT,
) -> Tuple[Optional[str], Optional[str]]:
    """Return a small preview query for offending values or aggregate failure context."""
    qcol = _q(col, dialect) if col else None
    src_ref = _wrap_table_ref(table_ref, "src")
    src_col = _qualified_col("src", col, dialect) if col else None

    if rule_type == "not_null":
        if not src_col:
            return None, None
        return f"SELECT src.* FROM {src_ref} WHERE {src_col} IS NULL LIMIT {limit}", None

    if rule_type == "not_blank":
        if not src_col:
            return None, None
        cond = f"TRIM({_text_cast(src_col, dialect)}) = ''"
        return f"SELECT src.* FROM {src_ref} WHERE {cond} LIMIT {limit}", None

    if rule_type == "completeness_pct":
        if not src_col:
            return None, None
        return (
            f"SELECT src.* FROM {src_ref} WHERE {src_col} IS NULL LIMIT {limit}",
            "Showing the rows contributing to the completeness failure.",
        )

    if rule_type == "accepted_values":
        if not src_col:
            return None, None
        values: List[str] = config.get("values") or []
        if not values:
            return None, None
        escaped = ", ".join("'" + value.replace("'", "''") + "'" for value in values)
        cond = f"{src_col} IS NOT NULL AND {_text_cast(src_col, dialect)} NOT IN ({escaped})"
        return f"SELECT src.* FROM {src_ref} WHERE {cond} LIMIT {limit}", None

    if rule_type == "pattern_match":
        if not src_col:
            return None, None
        pattern = str(config.get("pattern") or "").replace("'", "''")
        if not pattern:
            return None, None
        flags = str(config.get("flags") or "").lower()
        case_insensitive = "i" in flags
        if dialect == "bigquery":
            cond = f"NOT REGEXP_CONTAINS(CAST({src_col} AS STRING), r'(?{'i' if case_insensitive else ''}{pattern})')"
        elif dialect == "mysql":
            if case_insensitive:
                cond = f"{_text_cast(src_col, dialect)} NOT REGEXP '{pattern}'"
            else:
                cond = f"BINARY {_text_cast(src_col, dialect)} NOT REGEXP '{pattern}'"
        elif dialect == "duckdb":
            options = ", 'i'" if case_insensitive else ""
            cond = f"NOT regexp_matches({_text_cast(src_col, dialect)}, '{pattern}'{options})"
        else:
            op = "!~*" if case_insensitive else "!~"
            cond = f"{_text_cast(src_col, dialect)} {op} '{pattern}'"
        return (
            f"SELECT src.* FROM {src_ref} "
            f"WHERE {src_col} IS NOT NULL AND {cond} LIMIT {limit}",
            None,
        )

    if rule_type == "range_check":
        if not src_col:
            return None, None
        conditions = []
        mn = config.get("min")
        mx = config.get("max")
        if mn is not None:
            val = f"'{mn}'" if isinstance(mn, str) else str(mn)
            conditions.append(f"{_numeric_cast_expr(src_col, dialect)} < {val}")
        if mx is not None:
            val = f"'{mx}'" if isinstance(mx, str) else str(mx)
            conditions.append(f"{_numeric_cast_expr(src_col, dialect)} > {val}")
        if not conditions:
            return None, None
        cond = " OR ".join(conditions)
        return (
            f"SELECT src.* FROM {src_ref} "
            f"WHERE {src_col} IS NOT NULL AND ({cond}) LIMIT {limit}",
            None,
        )

    if rule_type == "format_check":
        if not src_col:
            return None, None
        fmt = str(config.get("format") or "").lower()
        pattern = _FORMAT_PATTERNS.get(fmt)
        if not pattern:
            return None, None
        escaped_pat = pattern.replace("'", "''")
        if dialect == "bigquery":
            cond = f"NOT REGEXP_CONTAINS({_text_cast(src_col, dialect)}, r'{escaped_pat}')"
        elif dialect == "mysql":
            cond = f"{_text_cast(src_col, dialect)} NOT REGEXP '{escaped_pat}'"
        elif dialect == "duckdb":
            cond = f"NOT regexp_matches({_text_cast(src_col, dialect)}, '{escaped_pat}')"
        else:
            cond = f"{_text_cast(src_col, dialect)} !~ '{escaped_pat}'"
        return (
            f"SELECT src.* FROM {src_ref} "
            f"WHERE {src_col} IS NOT NULL AND {cond} LIMIT {limit}",
            None,
        )

    if rule_type == "unique_column":
        if not qcol:
            return None, None
        return (
            f"SELECT {qcol} AS duplicate_value, COUNT(*) AS duplicate_count "
            f"FROM {table_ref} "
            f"GROUP BY {qcol} HAVING COUNT(*) > 1 "
            f"ORDER BY duplicate_count DESC LIMIT {limit}",
            "Showing duplicate values and how many times they appear.",
        )

    if rule_type == "unique_combo":
        cols: List[str] = config.get("columns") or ([] if not col else [col])
        if not cols:
            return None, None
        combo = ", ".join(_q(column, dialect) for column in cols)
        return (
            f"SELECT {combo}, COUNT(*) AS duplicate_count "
            f"FROM {table_ref} "
            f"GROUP BY {combo} HAVING COUNT(*) > 1 "
            f"ORDER BY duplicate_count DESC LIMIT {limit}",
            "Showing duplicate key combinations and their duplicate counts.",
        )

    if rule_type == "cross_column":
        expr = str(config.get("expression") or "").strip()
        if not expr:
            return None, None
        return f"SELECT src.* FROM {src_ref} WHERE NOT ({expr}) LIMIT {limit}", None

    if rule_type == "cross_table":
        expr = str(config.get("expression") or "").strip()
        join_condition = str(config.get("join_condition") or "").strip()
        if not expr or not join_condition or not secondary_table_ref:
            return None, None
        primary_ref = _wrap_table_ref(table_ref, "src")
        related_ref = _wrap_table_ref(secondary_table_ref, "ref")
        return (
            f"SELECT src.* FROM {primary_ref} "
            f"LEFT JOIN {related_ref} ON {join_condition} "
            f"WHERE NOT ({expr}) LIMIT {limit}",
            "Showing source-side rows that fail after evaluating the join rule.",
        )

    if rule_type == "freshness_days":
        date_col = config.get("column") or col
        if not date_col:
            return None, None
        qdate = _q(date_col, dialect)
        src_date = _qualified_col("src", date_col, dialect)
        max_days = int(config.get("max_days") or 1)
        if dialect == "bigquery":
            age_expr = f"DATE_DIFF(CURRENT_DATE(), CAST(MAX({src_date}) AS DATE), DAY)"
        elif dialect == "mysql":
            age_expr = f"DATEDIFF(CURDATE(), CAST(MAX({src_date}) AS DATE))"
        elif dialect == "duckdb":
            age_expr = f"date_diff('day', CAST(MAX({src_date}) AS DATE), CURRENT_DATE)"
        else:
            age_expr = f"EXTRACT(DAY FROM NOW() - CAST(MAX({src_date}) AS TIMESTAMPTZ))"
        return (
            f"SELECT MAX({qdate}) AS latest_value, {age_expr} AS current_age_days, {max_days} AS allowed_age_days "
            f"FROM {src_ref}",
            "Freshness is a table-level check, so the output shows the current age versus the allowed age.",
        )

    if rule_type == "row_count_range":
        min_rows = config.get("min")
        max_rows = config.get("max")
        min_expr = "NULL" if min_rows is None else str(int(min_rows))
        max_expr = "NULL" if max_rows is None else str(int(max_rows))
        return (
            f"SELECT COUNT(*) AS current_row_count, {min_expr} AS expected_min_rows, {max_expr} AS expected_max_rows "
            f"FROM {src_ref}",
            "Row-count range is a table-level check, so the output shows the measured count against the configured bounds.",
        )

    if rule_type == "statistical_range":
        if not src_col:
            return None, None
        min_z = config.get("min_z")
        max_z = config.get("max_z")
        numeric_expr = _numeric_cast_expr(src_col, dialect)
        stddev_fn = "STDDEV_SAMP" if dialect == "bigquery" else "STDDEV"
        conditions = []
        if min_z is not None:
            conditions.append(f"({numeric_expr} - avg_val) / NULLIF(std_val, 0) < {min_z}")
        if max_z is not None:
            conditions.append(f"({numeric_expr} - avg_val) / NULLIF(std_val, 0) > {max_z}")
        if not conditions:
            return None, None
        cond = " OR ".join(conditions)
        return (
            f"WITH stats AS ("
            f"  SELECT AVG({numeric_expr}) AS avg_val, {stddev_fn}({numeric_expr}) AS std_val "
            f"  FROM {src_ref}"
            f") "
            f"SELECT src.*, (({numeric_expr} - avg_val) / NULLIF(std_val, 0)) AS quality_z_score "
            f"FROM {src_ref} CROSS JOIN stats "
            f"WHERE {src_col} IS NOT NULL AND ({cond}) LIMIT {limit}",
            "Showing rows whose z-score is outside the configured bounds.",
        )

    if rule_type == "custom_sql":
        return None, "Preview output is unavailable for custom SQL rules. Add a separate detail query if needed."

    return None, None


def _build_check_sql(
    table_ref: str,
    rule_type: str,
    col: Optional[str],
    config: Dict[str, Any],
    dialect: str = "postgresql",
    secondary_table_ref: Optional[str] = None,
) -> Optional[str]:
    """
    Return a SQL snippet that produces (rows_checked, rows_failed).
    Returns None if the rule cannot be compiled (skip gracefully).

    table_ref  — e.g. 'public."orders"' or a subquery alias
    dialect    — 'postgresql' | 'mysql' | 'bigquery'  (affects NULL filter syntax)
    """
    # BigQuery / MySQL use slightly different filter syntax; default to ANSI FILTER
    def filter_expr(condition: str) -> str:
        if dialect == "bigquery":
            return f"COUNTIF({condition})"
        if dialect != "mysql":
            return f"COUNT(*) FILTER (WHERE {condition})"
        return f"SUM(CASE WHEN {condition} THEN 1 ELSE 0 END)"

    qcol = _q(col, dialect) if col else None

    # ── Completeness ───────────────────────────────────────────────────────
    if rule_type == "not_null":
        if not qcol:
            return None
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"{filter_expr(f'{qcol} IS NULL')} AS rows_failed "
            f"FROM {table_ref}"
        )

    if rule_type == "not_blank":
        if not qcol:
            return None
        blank_condition = f"TRIM({_text_cast(qcol, dialect)}) = ''"
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"{filter_expr(blank_condition)} AS rows_failed "
            f"FROM {table_ref}"
        )

    if rule_type == "completeness_pct":
        if not qcol:
            return None
        threshold = float(config.get("threshold") or 0)
        max_null_pct = 100.0 - threshold
        null_count_expr = filter_expr(f"{qcol} IS NULL")
        # rows_failed = null count if null% > max_null_pct else 0  (table-level flag)
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"CASE WHEN ({null_count_expr} * 100.0 / NULLIF(COUNT(*), 0)) > {max_null_pct} "
            f"THEN {null_count_expr} ELSE 0 END AS rows_failed "
            f"FROM {table_ref}"
        )

    # ── Validity ───────────────────────────────────────────────────────────
    if rule_type == "accepted_values":
        if not qcol:
            return None
        values: List[str] = config.get("values") or []
        if not values:
            return None
        escaped = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"{filter_expr(f'{qcol} IS NOT NULL AND {_text_cast(qcol, dialect)} NOT IN ({escaped})')} AS rows_failed "
            f"FROM {table_ref}"
        )

    if rule_type == "pattern_match":
        if not qcol:
            return None
        pattern = str(config.get("pattern") or "").replace("'", "''")
        if not pattern:
            return None
        flags = str(config.get("flags") or "").lower()
        case_insensitive = "i" in flags
        if dialect == "bigquery":
            cond = f"NOT REGEXP_CONTAINS(CAST({qcol} AS STRING), r'(?{'i' if case_insensitive else ''}{pattern})')"
        elif dialect == "mysql":
            # MySQL REGEXP is case-insensitive by default; use BINARY to force case-sensitive
            if case_insensitive:
                cond = f"{_text_cast(qcol, dialect)} NOT REGEXP '{pattern}'"
            else:
                cond = f"BINARY {_text_cast(qcol, dialect)} NOT REGEXP '{pattern}'"
        elif dialect == "duckdb":
            options = ", 'i'" if case_insensitive else ""
            cond = f"NOT regexp_matches({_text_cast(qcol, dialect)}, '{pattern}'{options})"
        else:
            # PostgreSQL: ~* for case-insensitive, !~ for case-sensitive
            op = "!~*" if case_insensitive else "!~"
            cond = f"{_text_cast(qcol, dialect)} {op} '{pattern}'"
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"{filter_expr(f'{qcol} IS NOT NULL AND {cond}')} AS rows_failed "
            f"FROM {table_ref}"
        )

    if rule_type == "range_check":
        if not qcol:
            return None
        conditions = []
        mn = config.get("min")
        mx = config.get("max")
        if mn is not None:
            val = f"'{mn}'" if isinstance(mn, str) else str(mn)
            conditions.append(f"{_numeric_cast_expr(qcol, dialect)} < {val}")
        if mx is not None:
            val = f"'{mx}'" if isinstance(mx, str) else str(mx)
            conditions.append(f"{_numeric_cast_expr(qcol, dialect)} > {val}")
        if not conditions:
            return None
        cond = " OR ".join(conditions)
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"{filter_expr(f'{qcol} IS NOT NULL AND ({cond})')} AS rows_failed "
            f"FROM {table_ref}"
        )

    if rule_type == "format_check":
        if not qcol:
            return None
        fmt = str(config.get("format") or "").lower()
        pattern = _FORMAT_PATTERNS.get(fmt)
        if not pattern:
            return None
        escaped_pat = pattern.replace("'", "''")
        if dialect == "bigquery":
            cond = f"NOT REGEXP_CONTAINS({_text_cast(qcol, dialect)}, r'{escaped_pat}')"
        elif dialect == "mysql":
            cond = f"{_text_cast(qcol, dialect)} NOT REGEXP '{escaped_pat}'"
        elif dialect == "duckdb":
            cond = f"NOT regexp_matches({_text_cast(qcol, dialect)}, '{escaped_pat}')"
        else:
            cond = f"{_text_cast(qcol, dialect)} !~ '{escaped_pat}'"
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"{filter_expr(f'{qcol} IS NOT NULL AND {cond}')} AS rows_failed "
            f"FROM {table_ref}"
        )

    # ── Uniqueness ─────────────────────────────────────────────────────────
    if rule_type == "unique_column":
        if not qcol:
            return None
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"(COUNT(*) - COUNT(DISTINCT {qcol})) AS rows_failed "
            f"FROM {table_ref}"
        )

    if rule_type == "unique_combo":
        cols: List[str] = config.get("columns") or ([] if not col else [col])
        if not cols:
            return None
        combo = ", ".join(_q(c, dialect) for c in cols)
        # COALESCE handles the case where no duplicates exist (subquery returns 0 rows → SUM = NULL)
        return (
            f"SELECT COALESCE(SUM(cnt), 0) AS rows_checked, COALESCE(SUM(cnt - 1), 0) AS rows_failed FROM ("
            f"  SELECT COUNT(*) AS cnt FROM {table_ref} GROUP BY {combo} HAVING COUNT(*) > 1"
            f") dups"
        )

    # ── Consistency ────────────────────────────────────────────────────────
    if rule_type == "cross_column":
        expr = str(config.get("expression") or "").strip()
        if not expr:
            return None
        # expression should be a boolean SQL expression (True = valid row)
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"{filter_expr(f'NOT ({expr})')} AS rows_failed "
            f"FROM {table_ref}"
        )

    if rule_type == "cross_table":
        expr = str(config.get("expression") or "").strip()
        join_condition = str(config.get("join_condition") or "").strip()
        if not expr or not join_condition or not secondary_table_ref:
            return None
        primary_ref = _wrap_table_ref(table_ref, "src")
        related_ref = _wrap_table_ref(secondary_table_ref, "ref")
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"{filter_expr(f'NOT ({expr})')} AS rows_failed "
            f"FROM {primary_ref} "
            f"LEFT JOIN {related_ref} ON {join_condition}"
        )

    # ── Timeliness ─────────────────────────────────────────────────────────
    if rule_type == "freshness_days":
        date_col = config.get("column") or col
        if not date_col:
            return None
        max_days = int(config.get("max_days") or 1)
        qdate = _q(date_col, dialect)
        if dialect == "bigquery":
            age_expr = f"DATE_DIFF(CURRENT_DATE(), CAST(MAX({qdate}) AS DATE), DAY)"
        elif dialect == "mysql":
            age_expr = f"DATEDIFF(CURDATE(), CAST(MAX({qdate}) AS DATE))"
        elif dialect == "duckdb":
            age_expr = f"date_diff('day', CAST(MAX({qdate}) AS DATE), CURRENT_DATE)"
        else:
            age_expr = f"EXTRACT(DAY FROM NOW() - CAST(MAX({qdate}) AS TIMESTAMPTZ))"
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"CASE WHEN {age_expr} > {max_days} THEN 1 ELSE 0 END AS rows_failed "
            f"FROM {table_ref}"
        )

    # ── Accuracy ───────────────────────────────────────────────────────────
    if rule_type == "row_count_range":
        mn = config.get("min")
        mx = config.get("max")
        conditions = []
        if mn is not None:
            conditions.append(f"COUNT(*) < {int(mn)}")
        if mx is not None:
            conditions.append(f"COUNT(*) > {int(mx)}")
        if not conditions:
            return None
        violated = " OR ".join(conditions)
        return (
            f"SELECT COUNT(*) AS rows_checked, "
            f"CASE WHEN {violated} THEN 1 ELSE 0 END AS rows_failed "
            f"FROM {table_ref}"
        )

    if rule_type == "statistical_range":
        if not qcol:
            return None
        min_z = config.get("min_z")
        max_z = config.get("max_z")
        numeric_expr = _numeric_cast_expr(qcol, dialect)
        stddev_fn = "STDDEV_SAMP" if dialect == "bigquery" else "STDDEV"
        conditions = []
        if min_z is not None:
            conditions.append(f"({numeric_expr} - avg_val) / NULLIF(std_val, 0) < {min_z}")
        if max_z is not None:
            conditions.append(f"({numeric_expr} - avg_val) / NULLIF(std_val, 0) > {max_z}")
        if not conditions:
            return None
        cond = " OR ".join(conditions)
        return (
            f"WITH stats AS ("
            f"  SELECT AVG({numeric_expr}) AS avg_val, {stddev_fn}({numeric_expr}) AS std_val "
            f"  FROM {table_ref}"
            f") "
            f"SELECT COUNT(*) AS rows_checked, "
            f"{filter_expr(f'{qcol} IS NOT NULL AND ({cond})')} AS rows_failed "
            f"FROM {table_ref} CROSS JOIN stats"
        )

    # ── Custom SQL escape hatch ────────────────────────────────────────────
    if rule_type == "custom_sql":
        sql = str(config.get("sql") or "").strip()
        if not sql:
            return None
        # Replace {{ table }} placeholder with the resolved table_ref so users
        # can write portable custom SQL without hard-coding table names.
        return sql.replace("{{ table }}", table_ref).replace("{{table}}", table_ref)

    return None


def _table_ref_for_source(
    db_table: DatasetTable,
    datasource: Any = None,
    dialect: str = "postgresql",
) -> Tuple[Optional[str], Optional[str]]:
    """
    Return (table_ref_sql, dialect) for use in quality check SQL.
    table_ref_sql is a FROM-able reference: a quoted table name or a sub-query.
    Returns (None, None) for unsupported kinds (generated_calendar).
    """
    if db_table.source_kind == "generated_calendar":
        return None, None

    if db_table.source_kind == "physical_table":
        tbl = db_table.source_table_name or ""
        if dialect == "bigquery":
            from app.core.crypto import decrypt_config

            config = decrypt_config(getattr(datasource, "config", {}) or {})
            project_id = str(config.get("project_id") or "").strip()
            default_dataset = str(config.get("dataset") or config.get("default_dataset") or "").strip()
            parts = [part.strip().strip("`").strip('"').strip("'") for part in tbl.split(".") if part and str(part).strip()]
            if len(parts) >= 3:
                return f"`{parts[-3]}.{parts[-2]}.{parts[-1]}`", None
            if len(parts) == 2:
                if project_id:
                    return f"`{project_id}.{parts[0]}.{parts[1]}`", None
                return f"`{parts[0]}.{parts[1]}`", None
            if len(parts) == 1:
                if project_id and default_dataset:
                    return f"`{project_id}.{default_dataset}.{parts[0]}`", None
                if default_dataset:
                    return f"`{default_dataset}.{parts[0]}`", None
                return f"`{parts[0]}`", None
            return None, None

        parts = [part for part in tbl.split(".") if part]
        if not parts:
            return None, None
        ref = ".".join(_q(part, dialect) for part in parts)
        return ref, None  # dialect resolved from datasource.type at call time

    if db_table.source_kind in ("sql_query", "derived_table"):
        q = (db_table.source_query or "").strip().rstrip(";")
        return f"({q}) _dq_src", None

    return None, None


def _dialect_for_ds(datasource) -> str:
    if datasource is None:
        return "postgresql"
    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    return {
        "bigquery": "bigquery",
        "google_sheets": "duckdb",
        "manual": "duckdb",
        "mysql": "mysql",
        "postgresql": "postgresql",
    }.get(ds_type, "postgresql")


def _resolve_execution_table_and_datasource(
    db: Session,
    dataset_obj: Dataset,
    db_table: DatasetTable,
    ds_map: Dict[int, Any],
) -> Tuple[DatasetTable, Any]:
    datasource = ds_map.get(db_table.datasource_id) if db_table.datasource_id else None

    if datasource is None and db_table.source_kind == "derived_table":
        from app.services.dataset_table_sql_service import build_live_proxy_table_for_dataset_table

        datasource, proxy_table = build_live_proxy_table_for_dataset_table(db, dataset_obj, db_table)
        if datasource is not None:
            ds_map[datasource.id] = datasource
        return proxy_table, datasource

    return db_table, datasource


def _clean_optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_string_list(values: Any) -> List[str]:
    if not isinstance(values, list):
        return []
    seen = set()
    normalized: List[str] = []
    for raw in values:
        text = _clean_optional_str(raw)
        if not text or text in seen:
            continue
        seen.add(text)
        normalized.append(text)
    return normalized


def _get_table_columns(table: DatasetTable) -> List[str]:
    cache = getattr(table, "columns_cache", None)
    if not isinstance(cache, dict):
        return []
    cols = cache.get("columns")
    if not isinstance(cols, list):
        return []

    normalized: List[str] = []
    for col in cols:
        if isinstance(col, dict):
            name = _clean_optional_str(col.get("name"))
        else:
            name = _clean_optional_str(getattr(col, "name", None))
        if name:
            normalized.append(name)
    return normalized


def _validate_known_columns(table: DatasetTable, columns: List[str]) -> None:
    available = set(_get_table_columns(table))
    if not available:
        return
    missing = [col for col in columns if col not in available]
    if not missing:
        return

    table_name = table.display_name or table.source_table_name or f"table {table.id}"
    missing_str = ", ".join(missing)
    raise ValueError(f"Column(s) {missing_str} not found in {table_name}")


def _normalize_numeric_value(value: Any, field_name: str) -> Optional[float | int]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be a number")
    if isinstance(value, (int, float)):
        return int(value) if isinstance(value, float) and value.is_integer() else value

    text = _clean_optional_str(value)
    if text is None:
        return None
    try:
        number = float(text)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be a number") from exc
    return int(number) if number.is_integer() else number


def _normalize_int_value(value: Any, field_name: str, *, minimum: Optional[int] = None) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be an integer")
    if isinstance(value, int):
        number = value
    else:
        text = _clean_optional_str(value)
        if text is None:
            return None
        try:
            number = int(text)
        except ValueError as exc:
            raise ValueError(f"{field_name} must be an integer") from exc

    if minimum is not None and number < minimum:
        raise ValueError(f"{field_name} must be at least {minimum}")
    return number


def _normalize_quality_config(
    *,
    table: DatasetTable,
    rule_type: str,
    column_name: Optional[str],
    config: Any,
) -> Dict[str, Any]:
    raw = config or {}
    if hasattr(raw, "model_dump"):
        raw = raw.model_dump(exclude_none=True)
    if not isinstance(raw, dict):
        raw = {}

    if rule_type in {"not_null", "not_blank", "unique_column", "schema_drift"}:
        # schema_drift needs no user config — the baseline column fingerprint is
        # captured automatically on the rule's first run.
        return {}

    if rule_type == "completeness_pct":
        threshold = _normalize_numeric_value(raw.get("threshold"), "threshold")
        if threshold is None:
            raise ValueError("Completeness threshold is required")
        if threshold < 0 or threshold > 100:
            raise ValueError("Completeness threshold must be between 0 and 100")
        return {"threshold": threshold}

    if rule_type == "accepted_values":
        values = _normalize_string_list(raw.get("values"))
        if not values:
            raise ValueError("Accepted values must include at least one value")
        return {"values": values}

    if rule_type == "pattern_match":
        pattern = _clean_optional_str(raw.get("pattern"))
        if not pattern:
            raise ValueError("Regex pattern is required")
        flags = _clean_optional_str(raw.get("flags"))
        normalized = {"pattern": pattern}
        if flags:
            normalized["flags"] = flags
        return normalized

    if rule_type == "range_check":
        min_value = _normalize_numeric_value(raw.get("min"), "Min")
        max_value = _normalize_numeric_value(raw.get("max"), "Max")
        if min_value is None and max_value is None:
            raise ValueError("At least one numeric bound is required")
        if min_value is not None and max_value is not None and min_value > max_value:
            raise ValueError("Min cannot be greater than max")
        normalized: Dict[str, Any] = {}
        if min_value is not None:
            normalized["min"] = min_value
        if max_value is not None:
            normalized["max"] = max_value
        return normalized

    if rule_type == "format_check":
        fmt = (_clean_optional_str(raw.get("format")) or "").lower()
        if fmt not in _FORMAT_PATTERNS:
            raise ValueError("Format type is invalid")
        return {"format": fmt}

    if rule_type == "unique_combo":
        columns = _normalize_string_list(raw.get("columns"))
        if not columns:
            raise ValueError("Unique combination requires at least one column")
        _validate_known_columns(table, columns)
        return {"columns": columns}

    if rule_type == "cross_column":
        expression = _clean_optional_str(raw.get("expression"))
        if not expression:
            raise ValueError("SQL expression is required")
        return {"expression": expression}

    if rule_type == "cross_table":
        secondary_table_id = _normalize_int_value(raw.get("secondary_table_id"), "Secondary table ID", minimum=1)
        join_condition = _clean_optional_str(raw.get("join_condition"))
        expression = _clean_optional_str(raw.get("expression"))
        if secondary_table_id is None:
            raise ValueError("Cross-table checks require a secondary table")
        if not join_condition:
            raise ValueError("Join condition is required")
        if not expression:
            raise ValueError("SQL expression is required")
        return {
            "secondary_table_id": secondary_table_id,
            "join_condition": join_condition,
            "expression": expression,
        }

    if rule_type == "freshness_days":
        date_column = _clean_optional_str(raw.get("column"))
        if not date_column:
            raise ValueError("Freshness checks require a date column")
        _validate_known_columns(table, [date_column])
        max_days = _normalize_int_value(raw.get("max_days"), "Max age (days)", minimum=1)
        if max_days is None:
            raise ValueError("Max age (days) is required")
        return {"column": date_column, "max_days": max_days}

    if rule_type == "row_count_range":
        min_rows = _normalize_int_value(raw.get("min"), "Min rows", minimum=0)
        max_rows = _normalize_int_value(raw.get("max"), "Max rows", minimum=0)
        if min_rows is None and max_rows is None:
            raise ValueError("At least one row-count bound is required")
        if min_rows is not None and max_rows is not None and min_rows > max_rows:
            raise ValueError("Min rows cannot be greater than max rows")
        normalized: Dict[str, Any] = {}
        if min_rows is not None:
            normalized["min"] = min_rows
        if max_rows is not None:
            normalized["max"] = max_rows
        return normalized

    if rule_type == "statistical_range":
        min_z = _normalize_numeric_value(raw.get("min_z"), "Min Z-score")
        max_z = _normalize_numeric_value(raw.get("max_z"), "Max Z-score")
        if min_z is None and max_z is None:
            raise ValueError("At least one Z-score bound is required")
        if min_z is not None and max_z is not None and min_z > max_z:
            raise ValueError("Min Z-score cannot be greater than max Z-score")
        normalized: Dict[str, Any] = {}
        if min_z is not None:
            normalized["min_z"] = min_z
        if max_z is not None:
            normalized["max_z"] = max_z
        return normalized

    if rule_type == "custom_sql":
        sql = _clean_optional_str(raw.get("sql"))
        if not sql:
            raise ValueError("Custom SQL is required")
        if len(sql) > 5000:
            raise ValueError("Custom SQL must be at most 5000 characters")
        lowered = sql.lower()
        if "rows_checked" not in lowered or "rows_failed" not in lowered:
            raise ValueError("Custom SQL must select rows_checked and rows_failed columns")
        return {"sql": sql}

    raise ValueError(f"Unsupported rule type: {rule_type}")


def _normalize_quality_rule_fields(
    *,
    table: DatasetTable,
    dimension: str,
    rule_type: str,
    column_name: Optional[str],
    config: Any,
    severity: str,
) -> Dict[str, Any]:
    normalized_dimension = (_clean_optional_str(dimension) or "").lower()
    normalized_rule_type = (_clean_optional_str(rule_type) or "").lower()
    normalized_severity = (_clean_optional_str(severity) or "").lower()

    if normalized_dimension not in VALID_DIMENSIONS:
        raise ValueError("Quality dimension is invalid")
    if normalized_rule_type not in RULE_TYPE_DIMENSION:
        raise ValueError(f"Unsupported rule type: {rule_type}")
    if normalized_severity not in VALID_SEVERITIES:
        raise ValueError("Severity is invalid")

    normalized_column_name = _clean_optional_str(column_name)
    rule_level = RULE_TYPE_LEVEL[normalized_rule_type]
    if rule_level == "column":
        if not normalized_column_name:
            raise ValueError("This rule type requires a column")
        _validate_known_columns(table, [normalized_column_name])
    elif normalized_column_name:
        normalized_column_name = None

    normalized_config = _normalize_quality_config(
        table=table,
        rule_type=normalized_rule_type,
        column_name=normalized_column_name,
        config=config,
    )

    return {
        "dimension": normalized_dimension,
        "rule_type": normalized_rule_type,
        "column_name": normalized_column_name,
        "config": normalized_config,
        "severity": normalized_severity,
    }


def _canonicalize_rule_identity_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _canonicalize_rule_identity_value(val)
            for key, val in sorted(value.items(), key=lambda item: item[0])
        }
    if isinstance(value, list):
        normalized = [_canonicalize_rule_identity_value(item) for item in value]
        return sorted(normalized, key=lambda item: json.dumps(item, sort_keys=True, default=str))
    return value


def _find_duplicate_rule(
    db: Session,
    *,
    dataset_id: int,
    table_id: int,
    column_name: Optional[str],
    rule_type: str,
    config: Dict[str, Any],
    exclude_rule_id: Optional[int] = None,
) -> Optional[DatasetQualityRule]:
    candidates = (
        db.query(DatasetQualityRule)
        .filter(DatasetQualityRule.dataset_id == dataset_id)
        .order_by(DatasetQualityRule.id.asc())
        .all()
    )

    identity_config = _canonicalize_rule_identity_value(config or {})
    normalized_column_name = _clean_optional_str(column_name)

    for candidate in candidates:
        if exclude_rule_id is not None and candidate.id == exclude_rule_id:
            continue
        if candidate.dataset_id != dataset_id:
            continue
        if candidate.table_id != table_id:
            continue
        if _clean_optional_str(candidate.column_name) != normalized_column_name:
            continue
        if (_clean_optional_str(candidate.rule_type) or "").lower() != rule_type:
            continue
        if _canonicalize_rule_identity_value(candidate.config or {}) == identity_config:
            return candidate
    return None


def _raise_duplicate_rule_conflict(rule: DatasetQualityRule) -> None:
    raise QualityRuleConflictError(
        f"An equivalent quality rule already exists: #{rule.id} '{rule.name}'",
        existing_rule_id=rule.id,
    )


def _validate_cross_table_rule_config(
    db: Session,
    dataset_id: int,
    rule_type: str,
    config: Dict[str, Any],
) -> None:
    if rule_type != "cross_table":
        return

    secondary_table_id = _normalize_int_value(config.get("secondary_table_id"), "Secondary table ID", minimum=1)
    if secondary_table_id is None:
        raise ValueError("Cross-table checks require a secondary table")

    secondary_table = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.id == secondary_table_id,
            DatasetTable.dataset_id == dataset_id,
        )
        .first()
    )
    if not secondary_table:
        raise ValueError("Secondary table not found in this dataset")


# ---------------------------------------------------------------------------
# Rule preview (template-based description + SQL)
# ---------------------------------------------------------------------------

_RULE_DESCRIPTION_TEMPLATES: Dict[str, Dict[str, str]] = {
    "not_null": {
        "pass": '"{col}" always has a value (no NULLs)',
        "fail": '"{col}" contains NULL values',
        "scope": "Column-level — checks every row",
    },
    "not_blank": {
        "pass": '"{col}" is never an empty string',
        "fail": '"{col}" contains empty/blank strings',
        "scope": "Column-level — checks every row",
    },
    "completeness_pct": {
        "pass": '"{col}" is at least {threshold}% non-null',
        "fail": '"{col}" has more than {null_pct}% null values',
        "scope": "Column-level — checks null ratio",
    },
    "accepted_values": {
        "pass": '"{col}" only contains allowed values: {values}',
        "fail": '"{col}" contains values outside the allowed list',
        "scope": "Column-level — checks every non-null row",
    },
    "pattern_match": {
        "pass": '"{col}" matches regex: {pattern}',
        "fail": '"{col}" has values not matching the pattern',
        "scope": "Column-level — checks every non-null row",
    },
    "range_check": {
        "pass": '"{col}" is within [{min}, {max}]',
        "fail": '"{col}" has values outside the numeric range',
        "scope": "Column-level — checks every non-null row",
    },
    "format_check": {
        "pass": '"{col}" matches {format} format',
        "fail": '"{col}" has values that are not valid {format}',
        "scope": "Column-level — checks every non-null row",
    },
    "unique_column": {
        "pass": '"{col}" has no duplicate values',
        "fail": '"{col}" contains duplicate values',
        "scope": "Column-level — checks uniqueness",
    },
    "unique_combo": {
        "pass": "Combination ({columns}) is unique across all rows",
        "fail": "Duplicate rows found for combination ({columns})",
        "scope": "Table-level — checks grain/key uniqueness",
    },
    "cross_column": {
        "pass": "Expression evaluates to TRUE for all rows: {expression}",
        "fail": "Some rows violate the condition: {expression}",
        "scope": "Table-level — SQL boolean expression",
    },
    "cross_table": {
        "pass": "Cross-table validation passes for all joined rows",
        "fail": "Some joined rows violate: {expression}",
        "scope": "Table-level — joins two tables",
    },
    "freshness_days": {
        "pass": "Data in \"{date_col}\" is less than {max_days} day(s) old",
        "fail": "Data is stale — latest value in \"{date_col}\" is older than {max_days} day(s)",
        "scope": "Table-level — checks MAX(date) age",
    },
    "row_count_range": {
        "pass": "Row count is within [{min}, {max}]",
        "fail": "Row count is outside the expected range",
        "scope": "Table-level — checks total volume",
    },
    "statistical_range": {
        "pass": '"{col}" values are within z-score [{min_z}, {max_z}]',
        "fail": '"{col}" has outliers beyond z-score bounds',
        "scope": "Column-level — z-score outlier detection",
    },
    "schema_drift": {
        "pass": "Table schema matches the captured baseline",
        "fail": "Table schema changed — columns added / removed / retyped",
        "scope": "Table-level — compares column fingerprint to a baseline",
    },
    "custom_sql": {
        "pass": "Custom query returns rows_failed = 0",
        "fail": "Custom query found failing rows",
        "scope": "Table-level — user-defined SQL",
    },
}


def _build_description(rule_type: str, col: Optional[str], config: Dict[str, Any]) -> Dict[str, str]:
    """Build human-readable pass/fail/scope descriptions from rule_type + config."""
    templates = _RULE_DESCRIPTION_TEMPLATES.get(rule_type, {
        "pass": "Rule passes",
        "fail": "Rule fails",
        "scope": "Unknown scope",
    })

    fmt_vars: Dict[str, str] = {
        "col": col or "(no column)",
        "threshold": str(config.get("threshold", 95)),
        "null_pct": str(round(100 - float(config.get("threshold", 95)), 1)),
        "values": ", ".join(str(v) for v in (config.get("values") or [])[:5]) or "(none)",
        "pattern": str(config.get("pattern", "")),
        "format": str(config.get("format", "")),
        "min": str(config.get("min", "-∞")),
        "max": str(config.get("max", "∞")),
        "columns": ", ".join(config.get("columns") or []) or "(none)",
        "expression": str(config.get("expression", ""))[:120],
        "date_col": str(config.get("column", col or "")),
        "max_days": str(config.get("max_days", 1)),
        "min_z": str(config.get("min_z", "-∞")),
        "max_z": str(config.get("max_z", "∞")),
    }

    try:
        return {
            "pass_description": templates["pass"].format(**fmt_vars),
            "fail_description": templates["fail"].format(**fmt_vars),
            "scope_description": templates["scope"].format(**fmt_vars),
        }
    except (KeyError, IndexError):
        return {
            "pass_description": templates.get("pass", "Rule passes"),
            "fail_description": templates.get("fail", "Rule fails"),
            "scope_description": templates.get("scope", ""),
        }


# ---------------------------------------------------------------------------
# CRUD operations
# ---------------------------------------------------------------------------

class DatasetQualityService:

    # ── Preview ────────────────────────────────────────────────────────────

    @staticmethod
    def preview_rule(
        db: Session,
        dataset_id: int,
        table_id: int,
        rule_type: str,
        column_name: Optional[str],
        config: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Return a preview of what this rule would do, without saving it.
        Returns SQL + human-readable descriptions.
        """
        table = (
            db.query(DatasetTable)
            .filter(DatasetTable.id == table_id, DatasetTable.dataset_id == dataset_id)
            .first()
        )
        if not table:
            return {"error": "Table not found", "sql": None, **_build_description(rule_type, column_name, config)}

        # Schema-drift is a metadata check (no SQL) — the baseline is captured on
        # the rule's first real run, so there is nothing to preview as SQL.
        if (_clean_optional_str(rule_type) or "").lower() == "schema_drift":
            return {"sql": None, **_build_description("schema_drift", None, config), "error": None}

        descs = _build_description(rule_type, column_name, config)

        try:
            normalized_rule_type = (_clean_optional_str(rule_type) or "").lower()
            if normalized_rule_type not in RULE_TYPE_DIMENSION:
                raise ValueError(f"Unsupported rule type: {rule_type}")
            normalized = _normalize_quality_rule_fields(
                table=table,
                dimension=RULE_TYPE_DIMENSION[normalized_rule_type],
                rule_type=normalized_rule_type,
                column_name=column_name,
                config=config,
                severity="warning",
            )
            _validate_cross_table_rule_config(
                db,
                dataset_id,
                normalized["rule_type"],
                normalized["config"],
            )
        except ValueError as exc:
            return {"sql": None, **descs, "error": str(exc)}

        # Build SQL preview
        table_name = table.display_name or table.source_table_name or "table"
        # Use a readable placeholder for preview
        table_ref = f'"{table_name}"'

        sql = _build_check_sql(
            table_ref=table_ref,
            rule_type=normalized["rule_type"],
            col=normalized["column_name"],
            config=normalized["config"],
            dialect="postgresql",
        )

        return {
            "sql": sql,
            **_build_description(
                normalized["rule_type"],
                normalized["column_name"],
                normalized["config"],
            ),
            "error": None,
        }

    @staticmethod
    def test_rule(
        db: Session,
        dataset_id: int,
        table_id: int,
        rule_type: str,
        column_name: Optional[str],
        config: Dict[str, Any],
    ) -> Dict[str, Any]:
        from app.models import DataSource

        table = (
            db.query(DatasetTable)
            .filter(DatasetTable.id == table_id, DatasetTable.dataset_id == dataset_id)
            .first()
        )
        if not table:
            return {
                "passed": False,
                "rows_checked": None,
                "rows_failed": None,
                "detail": "Table not found",
                "sql": None,
                "preview_sql": None,
                "preview_note": None,
                "preview_columns": [],
                "preview_rows": [],
                "log": ["[0ms] VALIDATION ERROR: Table not found"],
                "elapsed_ms": 0,
                "skipped": False,
                "error": True,
            }

        try:
            normalized_rule_type = (_clean_optional_str(rule_type) or "").lower()
            if normalized_rule_type not in RULE_TYPE_DIMENSION:
                raise ValueError(f"Unsupported rule type: {rule_type}")
            normalized = _normalize_quality_rule_fields(
                table=table,
                dimension=RULE_TYPE_DIMENSION[normalized_rule_type],
                rule_type=normalized_rule_type,
                column_name=column_name,
                config=config,
                severity="warning",
            )
            _validate_cross_table_rule_config(
                db,
                dataset_id,
                normalized["rule_type"],
                normalized["config"],
            )
        except ValueError as exc:
            return {
                "passed": False,
                "rows_checked": None,
                "rows_failed": None,
                "detail": str(exc),
                "sql": None,
                "preview_sql": None,
                "preview_note": None,
                "preview_columns": [],
                "preview_rows": [],
                "log": [f"[0ms] VALIDATION ERROR: {exc}"],
                "elapsed_ms": 0,
                "skipped": False,
                "error": True,
            }

        dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if dataset_obj is None:
            return {
                "passed": False,
                "rows_checked": None,
                "rows_failed": None,
                "detail": "Dataset not found",
                "sql": None,
                "preview_sql": None,
                "preview_note": None,
                "preview_columns": [],
                "preview_rows": [],
                "log": ["[0ms] VALIDATION ERROR: Dataset not found"],
                "elapsed_ms": 0,
                "skipped": False,
                "error": True,
            }

        table_map: Dict[int, DatasetTable] = {
            t.id: t
            for t in db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_id)
            .all()
        }
        ds_map: Dict[int, Any] = {}
        for db_table in table_map.values():
            if db_table.datasource_id and db_table.datasource_id not in ds_map:
                datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if datasource:
                    ds_map[db_table.datasource_id] = datasource

        preview_rule = SimpleNamespace(
            id=0,
            dataset_id=dataset_id,
            table_id=table_id,
            column_name=normalized["column_name"],
            dimension=RULE_TYPE_DIMENSION[normalized["rule_type"]],
            rule_type=normalized["rule_type"],
            name="Preview rule",
            config=normalized["config"],
            severity="warning",
            enabled=True,
        )

        result = DatasetQualityService._execute_single_rule(
            db,
            dataset_obj,
            preview_rule,
            table_map,
            ds_map,
        )
        result["preview_columns"] = list(result.get("preview_columns") or [])
        result["preview_rows"] = list(result.get("preview_rows") or [])
        return result

    # ── Rules ──────────────────────────────────────────────────────────────

    @staticmethod
    def list_rules(
        db: Session,
        dataset_id: int,
        table_id: Optional[int] = None,
    ) -> List[DatasetQualityRule]:
        q = (
            db.query(DatasetQualityRule)
            .filter(DatasetQualityRule.dataset_id == dataset_id)
            .order_by(DatasetQualityRule.dimension, DatasetQualityRule.table_id, DatasetQualityRule.column_name)
        )
        if table_id is not None:
            q = q.filter(DatasetQualityRule.table_id == table_id)
        return q.all()

    @staticmethod
    def get_rule(db: Session, rule_id: int) -> Optional[DatasetQualityRule]:
        return db.query(DatasetQualityRule).filter(DatasetQualityRule.id == rule_id).first()

    @staticmethod
    def create_rule(
        db: Session,
        dataset_id: int,
        data: QualityRuleCreate,
    ) -> DatasetQualityRule:
        table = (
            db.query(DatasetTable)
            .filter(
                DatasetTable.id == data.table_id,
                DatasetTable.dataset_id == dataset_id,
            )
            .first()
        )
        if not table:
            raise ValueError("Table not found in this dataset")

        normalized_name = _clean_optional_str(data.name)
        if not normalized_name:
            raise ValueError("Rule name is required")

        normalized = _normalize_quality_rule_fields(
            table=table,
            dimension=data.dimension,
            rule_type=data.rule_type,
            column_name=data.column_name,
            config=data.config,
            severity=data.severity,
        )
        _validate_cross_table_rule_config(db, dataset_id, normalized["rule_type"], normalized["config"])
        duplicate = _find_duplicate_rule(
            db,
            dataset_id=dataset_id,
            table_id=data.table_id,
            column_name=normalized["column_name"],
            rule_type=normalized["rule_type"],
            config=normalized["config"],
        )
        if duplicate:
            _raise_duplicate_rule_conflict(duplicate)
        rule = DatasetQualityRule(
            dataset_id=dataset_id,
            table_id=data.table_id,
            column_name=normalized["column_name"],
            dimension=normalized["dimension"],
            rule_type=normalized["rule_type"],
            name=normalized_name,
            config=normalized["config"],
            severity=normalized["severity"],
            enabled=data.enabled,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(rule)
        db.commit()
        db.refresh(rule)
        return rule

    @staticmethod
    def create_rules_bulk(
        db: Session,
        dataset_id: int,
        items: List[QualityRuleCreate],
    ) -> List[DatasetQualityRule]:
        """Create multiple rules atomically. Rolls back all on any failure."""
        if not items:
            return []
        created: List[DatasetQualityRule] = []
        try:
            for data in items:
                table = (
                    db.query(DatasetTable)
                    .filter(
                        DatasetTable.id == data.table_id,
                        DatasetTable.dataset_id == dataset_id,
                    )
                    .first()
                )
                if not table:
                    raise ValueError("Table not found in this dataset")

                normalized_name = _clean_optional_str(data.name)
                if not normalized_name:
                    raise ValueError("Rule name is required")

                normalized = _normalize_quality_rule_fields(
                    table=table,
                    dimension=data.dimension,
                    rule_type=data.rule_type,
                    column_name=data.column_name,
                    config=data.config,
                    severity=data.severity,
                )
                _validate_cross_table_rule_config(db, dataset_id, normalized["rule_type"], normalized["config"])
                duplicate = _find_duplicate_rule(
                    db,
                    dataset_id=dataset_id,
                    table_id=data.table_id,
                    column_name=normalized["column_name"],
                    rule_type=normalized["rule_type"],
                    config=normalized["config"],
                )
                if duplicate:
                    _raise_duplicate_rule_conflict(duplicate)
                rule = DatasetQualityRule(
                    dataset_id=dataset_id,
                    table_id=data.table_id,
                    column_name=normalized["column_name"],
                    dimension=normalized["dimension"],
                    rule_type=normalized["rule_type"],
                    name=normalized_name,
                    config=normalized["config"],
                    severity=normalized["severity"],
                    enabled=data.enabled,
                    created_at=datetime.utcnow(),
                    updated_at=datetime.utcnow(),
                )
                db.add(rule)
                db.flush()
                created.append(rule)
            db.commit()
        except Exception:
            db.rollback()
            raise
        for rule in created:
            db.refresh(rule)
        return created

    @staticmethod
    def update_rule(
        db: Session,
        rule: DatasetQualityRule,
        data: QualityRuleUpdate,
    ) -> DatasetQualityRule:
        payload = data.model_dump(exclude_unset=True)
        if not payload:
            return rule

        if "name" in payload:
            normalized_name = _clean_optional_str(payload["name"])
            if not normalized_name:
                raise ValueError("Rule name is required")
            payload["name"] = normalized_name

        if "severity" in payload:
            normalized_severity = (_clean_optional_str(payload["severity"]) or "").lower()
            if normalized_severity not in VALID_SEVERITIES:
                raise ValueError("Severity is invalid")
            payload["severity"] = normalized_severity

        if {"dimension", "rule_type", "column_name", "config"} & set(payload.keys()):
            table = (
                db.query(DatasetTable)
                .filter(
                    DatasetTable.id == rule.table_id,
                    DatasetTable.dataset_id == rule.dataset_id,
                )
                .first()
            )
            if not table:
                raise ValueError("Table not found in this dataset")

            normalized = _normalize_quality_rule_fields(
                table=table,
                dimension=payload.get("dimension", rule.dimension),
                rule_type=payload.get("rule_type", rule.rule_type),
                column_name=payload.get("column_name", rule.column_name),
                config=payload.get("config", rule.config or {}),
                severity=payload.get("severity", rule.severity),
            )
            _validate_cross_table_rule_config(db, rule.dataset_id, normalized["rule_type"], normalized["config"])
            payload["dimension"] = normalized["dimension"]
            payload["rule_type"] = normalized["rule_type"]
            payload["column_name"] = normalized["column_name"]
            payload["config"] = normalized["config"]
            payload["severity"] = normalized["severity"]

            duplicate = _find_duplicate_rule(
                db,
                dataset_id=rule.dataset_id,
                table_id=rule.table_id,
                column_name=payload["column_name"],
                rule_type=payload["rule_type"],
                config=payload["config"],
                exclude_rule_id=rule.id,
            )
            if duplicate:
                _raise_duplicate_rule_conflict(duplicate)

        for field, value in payload.items():
            setattr(rule, field, value)

        rule.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(rule)
        return rule

    @staticmethod
    def duplicate_rule(
        db: Session,
        rule: DatasetQualityRule,
        target_table_id: Optional[int] = None,
        name_suffix: str = " (copy)",
    ) -> DatasetQualityRule:
        """Duplicate an existing rule, optionally to a different table."""
        destination_table_id = target_table_id if target_table_id is not None else rule.table_id
        table = (
            db.query(DatasetTable)
            .filter(
                DatasetTable.id == destination_table_id,
                DatasetTable.dataset_id == rule.dataset_id,
            )
            .first()
        )
        if not table:
            raise ValueError("Target table not found in this dataset")

        normalized = _normalize_quality_rule_fields(
            table=table,
            dimension=rule.dimension,
            rule_type=rule.rule_type,
            column_name=rule.column_name,
            config=rule.config or {},
            severity=rule.severity,
        )
        _validate_cross_table_rule_config(db, rule.dataset_id, normalized["rule_type"], normalized["config"])
        duplicate = _find_duplicate_rule(
            db,
            dataset_id=rule.dataset_id,
            table_id=destination_table_id,
            column_name=normalized["column_name"],
            rule_type=normalized["rule_type"],
            config=normalized["config"],
        )
        if duplicate:
            _raise_duplicate_rule_conflict(duplicate)

        copied_name = _clean_optional_str(f"{rule.name}{name_suffix}")
        if not copied_name:
            raise ValueError("Rule name is required")

        new_rule = DatasetQualityRule(
            dataset_id=rule.dataset_id,
            table_id=destination_table_id,
            column_name=normalized["column_name"],
            dimension=normalized["dimension"],
            rule_type=normalized["rule_type"],
            name=copied_name,
            config=normalized["config"],
            severity=normalized["severity"],
            enabled=rule.enabled,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(new_rule)
        db.commit()
        db.refresh(new_rule)
        return new_rule

    @staticmethod
    def delete_rule(db: Session, rule: DatasetQualityRule) -> None:
        db.delete(rule)
        db.commit()

    # ── Runs ───────────────────────────────────────────────────────────────

    @staticmethod
    def list_runs(
        db: Session,
        dataset_id: int,
        limit: int = 20,
    ) -> List[DatasetQualityRun]:
        return (
            db.query(DatasetQualityRun)
            .filter(DatasetQualityRun.dataset_id == dataset_id)
            .order_by(DatasetQualityRun.created_at.desc())
            .limit(limit)
            .all()
        )

    @staticmethod
    def get_latest_run(db: Session, dataset_id: int) -> Optional[DatasetQualityRun]:
        return (
            db.query(DatasetQualityRun)
            .filter(DatasetQualityRun.dataset_id == dataset_id)
            .order_by(DatasetQualityRun.created_at.desc())
            .first()
        )

    @staticmethod
    def create_run(
        db: Session,
        dataset_id: int,
        triggered_by_id: Optional[str] = None,
        trigger_source: str = "manual",
        schedule_id: Optional[int] = None,
    ) -> DatasetQualityRun:
        run = DatasetQualityRun(
            dataset_id=dataset_id,
            status="queued",
            triggered_by_id=triggered_by_id,
            trigger_source=trigger_source,
            schedule_id=schedule_id,
            created_at=datetime.utcnow(),
        )
        db.add(run)
        db.commit()
        db.refresh(run)
        return run

    @staticmethod
    def has_active_run(db: Session, dataset_id: int) -> bool:
        """Return True if a run is currently queued or running for the dataset."""
        return (
            db.query(DatasetQualityRun.id)
            .filter(
                DatasetQualityRun.dataset_id == dataset_id,
                DatasetQualityRun.status.in_(("queued", "running")),
            )
            .first()
            is not None
        )

    @staticmethod
    def trigger_run(
        db: Session,
        dataset_id: int,
        triggered_by_id: Optional[str] = None,
        trigger_source: str = "manual",
        schedule_id: Optional[int] = None,
        allow_overlap: bool = False,
    ) -> Optional[DatasetQualityRun]:
        """
        Shared entry point that both the manual API and the scheduler use.

        Returns the newly-created run, or None if `allow_overlap=False` and
        another run is already active for this dataset.
        """
        if not allow_overlap and DatasetQualityService.has_active_run(db, dataset_id):
            logger.info(
                "[quality_run] Skipped trigger for dataset %s: another run is active",
                dataset_id,
            )
            return None

        return DatasetQualityService.create_run(
            db,
            dataset_id,
            triggered_by_id=triggered_by_id,
            trigger_source=trigger_source,
            schedule_id=schedule_id,
        )

    # ── Summary ────────────────────────────────────────────────────────────

    @staticmethod
    def get_summary(db: Session, dataset_id: int) -> QualitySummaryResponse:
        rules = DatasetQualityService.list_rules(db, dataset_id)
        enabled_rules = [r for r in rules if r.enabled]
        # Use the latest COMPLETED run for score/breakdown (not queued/running/failed)
        latest_run = (
            db.query(DatasetQualityRun)
            .filter(
                DatasetQualityRun.dataset_id == dataset_id,
                DatasetQualityRun.status == "completed",
            )
            .order_by(DatasetQualityRun.created_at.desc())
            .first()
        )

        covered_tables = len({r.table_id for r in rules})
        covered_columns = len({r.column_name for r in rules if r.column_name})

        # Breakdown by dimension
        dim_totals: Dict[str, int] = {}
        dim_enabled: Dict[str, int] = {}
        for r in rules:
            dim_totals[r.dimension] = dim_totals.get(r.dimension, 0) + 1
            if r.enabled:
                dim_enabled[r.dimension] = dim_enabled.get(r.dimension, 0) + 1

        # Merge run results into breakdown (exclude only intentional skips)
        dim_passed: Dict[str, int] = {}
        dim_failed: Dict[str, int] = {}
        if latest_run and latest_run.results:
            rule_id_to_dim = {r.id: r.dimension for r in rules}
            for rule_id_str, res in latest_run.results.items():
                if not isinstance(res, dict):
                    continue
                try:
                    rid = int(rule_id_str)
                except (ValueError, TypeError):
                    continue
                dim = rule_id_to_dim.get(rid)
                if not dim:
                    continue
                # Skipped rules stay out of pass/fail; execution errors count as failed.
                if res.get("skipped"):
                    continue
                if res.get("passed"):
                    dim_passed[dim] = dim_passed.get(dim, 0) + 1
                else:
                    dim_failed[dim] = dim_failed.get(dim, 0) + 1

        breakdown = [
            QualityDimensionSummary(
                dimension=dim,
                total=dim_totals.get(dim, 0),
                enabled=dim_enabled.get(dim, 0),
                passed=dim_passed.get(dim) if latest_run and latest_run.results else None,
                failed=dim_failed.get(dim) if latest_run and latest_run.results else None,
            )
            for dim in ["completeness", "validity", "uniqueness", "consistency", "timeliness", "accuracy"]
            if dim in dim_totals
        ]

        from app.schemas.dataset import QualityRunResponse
        latest_run_schema = None
        if latest_run:
            latest_run_schema = QualityRunResponse.model_validate(latest_run)

        return QualitySummaryResponse(
            total_rules=len(rules),
            enabled_rules=len(enabled_rules),
            covered_tables=covered_tables,
            covered_columns=covered_columns,
            last_run=latest_run_schema,
            score=latest_run.score if latest_run else None,
            dimension_breakdown=breakdown,
        )

    # ── Execution ──────────────────────────────────────────────────────────

    @staticmethod
    def execute_run(run_id: int) -> None:
        """
        Background task entry point.
        Opens its own DB session (separate from request session).
        """
        from app.core.database import SessionLocal

        db = SessionLocal()
        try:
            DatasetQualityService._run_quality_checks(db, run_id)
        except Exception as exc:
            logger.error(f"[quality_run:{run_id}] Unhandled error: {exc}", exc_info=True)
            try:
                run = db.query(DatasetQualityRun).filter(DatasetQualityRun.id == run_id).first()
                if run:
                    run.status = "failed"
                    run.error_message = str(exc)[:2000]
                    run.completed_at = datetime.utcnow()
                    db.commit()
            except Exception:
                pass
        finally:
            db.close()

    @staticmethod
    def _run_quality_checks(db: Session, run_id: int) -> None:
        from app.models import DataSource

        run = db.query(DatasetQualityRun).filter(DatasetQualityRun.id == run_id).first()
        if not run:
            logger.warning(f"[quality_run:{run_id}] Run not found, aborting.")
            return

        run.status = "running"
        run.started_at = datetime.utcnow()
        db.commit()

        dataset_obj = db.query(Dataset).filter(Dataset.id == run.dataset_id).first()
        if dataset_obj is None:
            raise ValueError(f"Dataset {run.dataset_id} not found")

        rules = DatasetQualityService.list_rules(db, run.dataset_id)
        enabled_rules = [r for r in rules if r.enabled]

        if not enabled_rules:
            run.status = "completed"
            # No enabled rules ⇒ nothing was checked. Do NOT report a green 100%
            # (that falsely reassures); leave score unset so the UI shows "no run".
            run.score = None
            run.results = {}
            run.completed_at = datetime.utcnow()
            db.commit()
            return

        # Pre-load tables & datasources once
        table_map: Dict[int, DatasetTable] = {
            t.id: t
            for t in db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == run.dataset_id)
            .all()
        }
        ds_map: Dict[int, Any] = {}
        for table in table_map.values():
            if table.datasource_id and table.datasource_id not in ds_map:
                ds = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
                if ds:
                    ds_map[table.datasource_id] = ds

        results: Dict[str, Any] = {}
        passed_count = 0
        scorable_count = 0  # only intentional skips stay out of the score

        # Ghi tổng số rules ngay từ đầu để FE biết denominator
        run.progress_done = 0
        run.progress_total = len(enabled_rules)
        db.commit()

        for idx, rule in enumerate(enabled_rules, start=1):
            result = DatasetQualityService._execute_single_rule(db, dataset_obj, rule, table_map, ds_map)
            results[str(rule.id)] = result
            # Execution errors should reduce confidence; only explicit skips stay out.
            if not result.get("skipped"):
                scorable_count += 1
                if result.get("passed"):
                    passed_count += 1
            # Commit progress sau mỗi rule để FE poll thấy tiến trình
            run.progress_done = idx
            db.commit()

        # When nothing was actually scored — every enabled rule skipped (e.g. all
        # targets are generated_calendar tables, or none could be compiled) — do
        # NOT report a falsely-reassuring 100%. Emit None so the UI shows "no run"
        # (and the e-mail/PDF show "—") instead of a green perfect score for a
        # dataset where zero checks executed. (DA9-2)
        score = round(passed_count / scorable_count * 100, 1) if scorable_count else None

        run.status = "completed"
        run.score = score
        run.results = results
        run.completed_at = datetime.utcnow()
        db.commit()
        logger.info(
            f"[quality_run:{run_id}] Completed. "
            f"{passed_count}/{scorable_count} scorable rules passed "
            f"({len(enabled_rules)} total enabled). Score={score}"
        )

    @staticmethod
    def _schema_fingerprint(table: DatasetTable) -> List[Dict[str, str]]:
        """Stable [{name,type}] list from the table's cached schema."""
        cache = table.columns_cache or {}
        cols = cache.get("columns") if isinstance(cache, dict) else None
        out: List[Dict[str, str]] = []
        for c in (cols or []):
            if isinstance(c, dict) and c.get("name"):
                out.append({"name": str(c["name"]), "type": str(c.get("type") or c.get("dtype") or "")})
        out.sort(key=lambda x: x["name"].lower())
        return out

    @staticmethod
    def _check_schema_drift(db, rule, db_table, log) -> Dict[str, Any]:
        """Compare the table's current column fingerprint to a stored baseline.
        On first run, capture the baseline (into rule.config) and pass; afterwards
        fail when columns are added / removed / retyped."""
        current = DatasetQualityService._schema_fingerprint(db_table)
        cfg = dict(rule.config or {})
        baseline = cfg.get("baseline_columns")
        if not baseline:
            cfg["baseline_columns"] = current
            rule.config = cfg
            if getattr(rule, "id", 0):  # real (persisted) rule — not the test SimpleNamespace
                try:
                    db.commit()
                except Exception:
                    db.rollback()
            log(f"Baseline captured ({len(current)} columns)")
            return {"passed": True, "rows_checked": len(current), "rows_failed": 0,
                    "detail": f"Baseline captured ({len(current)} columns)"}
        prev_map = {c["name"]: c.get("type", "") for c in baseline}
        cur_map = {c["name"]: c.get("type", "") for c in current}
        added = [n for n in cur_map if n not in prev_map]
        removed = [n for n in prev_map if n not in cur_map]
        retyped = [{"column": n, "from": prev_map[n], "to": cur_map[n]}
                   for n in cur_map if n in prev_map and prev_map[n] != cur_map[n]]
        changes = len(added) + len(removed) + len(retyped)
        log(f"Schema drift: +{len(added)} / -{len(removed)} / ~{len(retyped)}")
        detail = (f"+{len(added)} added / -{len(removed)} removed / ~{len(retyped)} retyped"
                  if changes else "Schema unchanged")
        return {"passed": changes == 0, "rows_checked": len(current), "rows_failed": changes,
                "detail": detail, "added": added, "removed": removed, "retyped": retyped}

    @staticmethod
    def _execute_single_rule(
        db: Session,
        dataset_obj: Dataset,
        rule: DatasetQualityRule,
        table_map: Dict[int, DatasetTable],
        ds_map: Dict[int, Any],
    ) -> Dict[str, Any]:
        """Execute one rule and return a result dict with execution log."""
        import traceback as _tb

        log_entries: List[str] = []
        started = time.time()

        def _log(msg: str) -> None:
            elapsed = round((time.time() - started) * 1000)
            log_entries.append(f"[{elapsed}ms] {msg}")

        def _result(base: Dict[str, Any]) -> Dict[str, Any]:
            elapsed_ms = round((time.time() - started) * 1000)
            base["log"] = log_entries
            base["elapsed_ms"] = elapsed_ms
            return base

        _log(f"Start rule '{rule.name}' (type={rule.rule_type}, dim={rule.dimension})")
        _log(f"Target: table_id={rule.table_id}, column={rule.column_name or '(table-level)'}")

        db_table = table_map.get(rule.table_id)
        if not db_table:
            _log("ERROR: Table not found in dataset")
            return _result({
                "passed": False, "rows_checked": None, "rows_failed": None,
                "detail": "Table not found", "skipped": True,
            })

        _log(f"Table: '{db_table.display_name or db_table.source_table_name}' (kind={db_table.source_kind})")

        # Schema-drift: pure metadata comparison (no warehouse query). Handle it
        # before source resolution so it works on any table kind.
        if rule.rule_type == "schema_drift":
            return _result(DatasetQualityService._check_schema_drift(db, rule, db_table, _log))

        if db_table.source_kind == "generated_calendar":
            _log("SKIP: Calendar table — no data to check")
            return _result({
                "passed": False, "rows_checked": None, "rows_failed": None,
                "detail": "Calendar table — skipped", "skipped": True,
            })

        try:
            _log("Resolving execution table and datasource…")
            execution_table, datasource = _resolve_execution_table_and_datasource(db, dataset_obj, db_table, ds_map)
            _log(f"Resolved: source={execution_table.source_table_name or '(query)'}, ds={'found' if datasource else 'None'}")
        except Exception as exc:
            _log(f"ERROR resolving execution target: {exc}")
            _log(_tb.format_exc()[:800])
            return _result({
                "passed": False, "rows_checked": None, "rows_failed": None,
                "detail": f"Execution target error: {str(exc)[:500]}", "error": True,
            })

        dialect = _dialect_for_ds(datasource)
        table_ref, _ = _table_ref_for_source(execution_table, datasource, dialect)
        if not table_ref:
            _log("ERROR: Cannot build table reference for this source kind")
            return _result({
                "passed": False, "rows_checked": None, "rows_failed": None,
                "detail": "Cannot build table reference for this source kind", "skipped": True,
            })
        _log(f"Table ref: {table_ref[:200]}")

        if datasource is None:
            _log("ERROR: Data source not found for this table")
            return _result({
                "passed": False, "rows_checked": None, "rows_failed": None,
                "detail": "Data source not found for this table", "skipped": True,
            })

        dialect = _dialect_for_ds(datasource)
        _log(f"Dialect: {dialect}")

        config = rule.config or {}
        _log(f"Rule config: {str(config)[:300]}")

        secondary_table_ref: Optional[str] = None
        if rule.rule_type == "cross_table":
            secondary_table_id = _normalize_int_value(config.get("secondary_table_id"), "Secondary table ID", minimum=1)
            if secondary_table_id is None:
                _log("ERROR: secondary_table_id is missing or invalid")
                return _result({
                    "passed": False, "rows_checked": None, "rows_failed": None,
                    "detail": "Cross-table rule requires a valid secondary_table_id",
                    "error": True,
                })

            secondary_db_table = table_map.get(secondary_table_id)
            if not secondary_db_table:
                _log(f"ERROR: Secondary table {secondary_table_id} not found in dataset")
                return _result({
                    "passed": False, "rows_checked": None, "rows_failed": None,
                    "detail": "Secondary table not found in dataset",
                    "error": True,
                })

            try:
                _log("Resolving secondary table and datasource…")
                secondary_exec_table, secondary_datasource = _resolve_execution_table_and_datasource(
                    db,
                    dataset_obj,
                    secondary_db_table,
                    ds_map,
                )
                _log(
                    "Resolved secondary: "
                    f"source={secondary_exec_table.source_table_name or '(query)'}, "
                    f"ds={'found' if secondary_datasource else 'None'}"
                )
            except Exception as exc:
                _log(f"ERROR resolving secondary execution target: {exc}")
                _log(_tb.format_exc()[:800])
                return _result({
                    "passed": False, "rows_checked": None, "rows_failed": None,
                    "detail": f"Secondary execution target error: {str(exc)[:500]}", "error": True,
                })

            if secondary_datasource is None:
                _log("ERROR: Data source not found for secondary table")
                return _result({
                    "passed": False, "rows_checked": None, "rows_failed": None,
                    "detail": "Data source not found for secondary table",
                    "error": True,
                })

            primary_ds_id = getattr(datasource, "id", None)
            secondary_ds_id = getattr(secondary_datasource, "id", None)
            if primary_ds_id != secondary_ds_id:
                _log(
                    "ERROR: Cross-table rule spans different datasources "
                    f"(primary={primary_ds_id}, secondary={secondary_ds_id})"
                )
                return _result({
                    "passed": False, "rows_checked": None, "rows_failed": None,
                    "detail": "Cross-table checks currently require both tables to resolve to the same datasource",
                    "error": True,
                })

            secondary_table_ref, _ = _table_ref_for_source(secondary_exec_table, secondary_datasource, dialect)
            if not secondary_table_ref:
                _log("ERROR: Cannot build secondary table reference for this source kind")
                return _result({
                    "passed": False, "rows_checked": None, "rows_failed": None,
                    "detail": "Cannot build secondary table reference for this source kind",
                    "error": True,
                })

            _log(
                "Cross-table aliases: src = primary table, ref = secondary table. "
                f"Secondary ref: {secondary_table_ref[:200]}"
            )

        check_sql = _build_check_sql(
            table_ref=table_ref,
            rule_type=rule.rule_type,
            col=rule.column_name,
            config=config,
            dialect=dialect,
            secondary_table_ref=secondary_table_ref,
        )

        if not check_sql:
            _log(f"ERROR: Cannot compile rule_type '{rule.rule_type}' — missing or invalid config")
            return _result({
                "passed": False, "rows_checked": None, "rows_failed": None,
                "detail": f"Cannot compile rule_type '{rule.rule_type}' — missing config", "skipped": True,
            })

        _log(f"Generated SQL: {check_sql}")

        try:
            from app.services.datasource_service import DataSourceConnectionService

            ds_type = (
                (datasource.type if isinstance(datasource.type, str) else datasource.type.value)
                if datasource
                else "postgresql"
            )
            _log(f"Executing query against {ds_type}…")
            columns, rows, exec_ms = DataSourceConnectionService.execute_query(
                ds_type=ds_type,
                config=datasource.config if datasource else {},
                sql_query=check_sql,
                limit=None,
                timeout_seconds=60,
            )
            _log(f"Query executed in {round(exec_ms)}ms — returned {len(rows)} row(s)")

            if not rows:
                _log("PASS: No rows returned (empty table)")
                return _result({
                    "passed": True, "rows_checked": 0, "rows_failed": 0,
                    "detail": "No rows returned", "sql": check_sql,
                })

            row = rows[0]
            _log(f"Raw result: {row}")
            rows_checked = _coerce_int(row.get("rows_checked"))
            rows_failed = _coerce_int(row.get("rows_failed"))

            if rows_failed is None:
                _log(f"ERROR: rows_failed is not a valid integer: {row.get('rows_failed')!r}")
                return _result({
                    "passed": False, "rows_checked": rows_checked, "rows_failed": None,
                    "detail": "Quality query returned an invalid rows_failed value",
                    "error": True, "sql": check_sql,
                })

            passed = rows_failed == 0
            detail = None if passed else f"{rows_failed} row(s) failed out of {rows_checked}"
            _log(f"{'PASS' if passed else 'FAIL'}: checked={rows_checked}, failed={rows_failed}")

            preview_sql = None
            preview_note = None
            preview_columns: Optional[List[str]] = None
            preview_rows: Optional[List[Dict[str, Any]]] = None
            if not passed:
                preview_sql, preview_note = _build_violation_preview_sql(
                    table_ref=table_ref,
                    rule_type=rule.rule_type,
                    col=rule.column_name,
                    config=config,
                    dialect=dialect,
                    secondary_table_ref=secondary_table_ref,
                )
                if preview_sql:
                    _log("Loading preview output for failed rows…")
                    try:
                        preview_columns, preview_result_rows, preview_exec_ms = DataSourceConnectionService.execute_query(
                            ds_type=ds_type,
                            config=datasource.config if datasource else {},
                            sql_query=preview_sql,
                            limit=None,
                            timeout_seconds=30,
                        )
                        preview_rows = _serialize_preview_rows(preview_result_rows)
                        _log(
                            "Preview loaded "
                            f"in {round(preview_exec_ms)}ms — returned {len(preview_rows)} row(s)"
                        )
                    except Exception as preview_exc:
                        preview_rows = None
                        preview_columns = None
                        preview_note = (
                            f"{preview_note} " if preview_note else ""
                        ) + f"Preview output unavailable: {str(preview_exc)[:200]}"
                        _log(f"PREVIEW ERROR: {preview_exc}")
                elif preview_note:
                    _log(f"Preview note: {preview_note}")

            return _result({
                "passed": passed, "rows_checked": rows_checked, "rows_failed": rows_failed,
                "detail": detail, "sql": check_sql,
                "preview_sql": preview_sql,
                "preview_note": preview_note,
                "preview_columns": preview_columns,
                "preview_rows": preview_rows,
            })

        except Exception as exc:
            _log(f"EXECUTION ERROR: {exc}")
            _log(_tb.format_exc()[:1200])
            logger.warning(f"[quality] Rule {rule.id} ({rule.rule_type}) failed: {exc}")
            return _result({
                "passed": False, "rows_checked": None, "rows_failed": None,
                "detail": f"Execution error: {str(exc)[:500]}",
                "error": True, "sql": check_sql,
            })


def _coerce_int(value) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# ===========================================================================
# Row-level evaluation (used by the Workboard module for in-form validation).
# Pure-Python: no SQL, no DB. Cross-row rules (unique_*, freshness, etc.) are
# intentionally skipped here -- the database constraints + the batch quality
# run remain authoritative for those.
# ===========================================================================

# Rule types that can be evaluated against a single row in pure Python.
_ROW_EVALUABLE_RULE_TYPES = {
    "not_null",
    "not_blank",
    "accepted_values",
    "pattern_match",
    "range_check",
    "format_check",
}


def _coerce_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text.replace(",", ""))
    except ValueError:
        return None


def _row_violation(rule: DatasetQualityRule, message: str) -> Dict[str, Any]:
    return {
        "rule_id": rule.id,
        "rule_type": rule.rule_type,
        "dimension": rule.dimension,
        "severity": (rule.severity or "warning"),
        "column": rule.column_name,
        "message": message,
    }


def _evaluate_single_rule(
    rule: DatasetQualityRule, row: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    rule_type = rule.rule_type
    if rule_type not in _ROW_EVALUABLE_RULE_TYPES:
        return None

    column = rule.column_name
    if not column:
        return None
    if column not in row:
        # The form did not touch this column on this submission; skip.
        return None

    value = row.get(column)
    config: Dict[str, Any] = dict(rule.config or {})

    if rule_type == "not_null":
        if value is None:
            return _row_violation(rule, f"'{column}' is required")
        return None

    if rule_type == "not_blank":
        if value is None or str(value).strip() == "":
            return _row_violation(rule, f"'{column}' must not be blank")
        return None

    if rule_type == "accepted_values":
        if value is None:
            return None
        accepted = [str(item) for item in (config.get("values") or [])]
        if accepted and str(value) not in accepted:
            return _row_violation(
                rule,
                f"'{column}' = {value!r} is not one of the accepted values",
            )
        return None

    if rule_type == "pattern_match":
        if value is None:
            return None
        pattern = str(config.get("pattern") or "")
        if not pattern:
            return None
        flags_text = str(config.get("flags") or "").lower()
        flags = re.IGNORECASE if "i" in flags_text else 0
        try:
            if not re.search(pattern, str(value), flags=flags):
                return _row_violation(
                    rule,
                    f"'{column}' does not match pattern {pattern!r}",
                )
        except re.error:
            return None
        return None

    if rule_type == "range_check":
        if value is None:
            return None
        number = _coerce_float(value)
        if number is None:
            return _row_violation(
                rule, f"'{column}' must be a number for range_check"
            )
        mn = config.get("min")
        mx = config.get("max")
        mn_num = _coerce_float(mn) if mn is not None else None
        mx_num = _coerce_float(mx) if mx is not None else None
        if mn_num is not None and number < mn_num:
            return _row_violation(rule, f"'{column}' must be >= {mn_num}")
        if mx_num is not None and number > mx_num:
            return _row_violation(rule, f"'{column}' must be <= {mx_num}")
        return None

    if rule_type == "format_check":
        if value is None:
            return None
        fmt = str(config.get("format") or "").lower()
        pattern = _FORMAT_PATTERNS.get(fmt)
        if not pattern:
            return None
        if not re.search(pattern, str(value)):
            return _row_violation(
                rule, f"'{column}' does not match format '{fmt}'"
            )
        return None

    return None


def evaluate_row(
    rules: List[DatasetQualityRule],
    row: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Evaluate the column-level subset of *rules* against a single *row* dict.

    Returns a list of violation dicts (possibly empty). Each violation has
    ``severity`` of ``info``/``warning``/``error``. Callers decide whether
    to block (severity=error) or merely warn the user.
    """
    if not rules or not row:
        return []
    violations: List[Dict[str, Any]] = []
    for rule in rules:
        if not getattr(rule, "enabled", True):
            continue
        try:
            violation = _evaluate_single_rule(rule, row)
        except Exception:  # pragma: no cover - defensive
            logger.exception("Failed to evaluate quality rule id=%s", getattr(rule, "id", None))
            continue
        if violation is not None:
            violations.append(violation)
    return violations
