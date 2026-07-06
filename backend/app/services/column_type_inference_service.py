"""Full-scan column type inference.

Why: schema inference at import time only sees a sample, so a column that is
99% integer + 1% "N/A" lands as VARCHAR. Charts then fail with SUM(VARCHAR)
even after the user "fixes" the type — until they fix every column manually.

This service runs ONE batched query against the full source data (capped for
cost), counts how many values fail to cast for each candidate type, and picks
the most specific type that meets a tolerance threshold. Results write back
into `DatasetTable.type_overrides`, never overwriting user-set values.

Trigger points:
- After Google Sheets sync (background, batched).
- Manual via POST /datasets/{id}/tables/{tid}/auto-detect-types.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

from app.core.logging import get_logger
from app.services.type_override_service import (
    _build_invalid_predicate,
    _quote_identifier,
    _trimmed_string_expr,
    build_safe_cast_sql,
    normalize_type_overrides,
)

logger = get_logger(__name__)


# Order matters: more specific types first. We pick the earliest type that
# meets the tolerance, so "all values are integer-shaped" picks integer over
# float even though both would technically satisfy.
CANDIDATE_TYPES: Tuple[str, ...] = ("boolean", "integer", "float", "date", "datetime")


# Default scan caps per dialect. DuckDB/Sheets is local and free; BigQuery
# costs bytes; SQL DBs may lock. Override via service kwargs.
DIALECT_ROW_CAPS: Dict[str, int] = {
    "duckdb": 1_000_000,
    "bigquery": 5_000_000,
    "postgresql": 5_000_000,
    "mysql": 5_000_000,
}

# Per-batch column count to keep SELECT lists from blowing up.
DEFAULT_COLUMN_BATCH_SIZE = 25


@dataclass
class ColumnTypeSuggestion:
    column: str
    suggested_type: Optional[str]
    total_non_null: int
    invalid_count: int
    invalid_examples: List[str] = field(default_factory=list)
    skipped_reason: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "column": self.column,
            "suggested_type": self.suggested_type,
            "total_non_null": self.total_non_null,
            "invalid_count": self.invalid_count,
            "invalid_examples": self.invalid_examples,
            "skipped_reason": self.skipped_reason,
        }


def _alias(prefix: str, idx: int, suffix: str) -> str:
    return f"_appbi_{prefix}_{idx}_{suffix}"


def _build_count_expr(predicate: str, dialect: str) -> str:
    if dialect == "bigquery":
        return f"COUNTIF({predicate})"
    return f"SUM(CASE WHEN {predicate} THEN 1 ELSE 0 END)"


def _build_examples_expr(
    quoted_col: str,
    invalid_predicate: str,
    dialect: str,
    string_cast_target: str,
) -> str:
    """Up to 3 distinct invalid sample values, comma-joined as a string."""
    if dialect == "bigquery":
        return (
            f"ARRAY_TO_STRING("
            f"ARRAY_AGG(DISTINCT IF({invalid_predicate}, "
            f"CAST({quoted_col} AS {string_cast_target}), NULL) "
            f"IGNORE NULLS LIMIT 3), '|')"
        )
    if dialect == "duckdb":
        return (
            f"STRING_AGG(DISTINCT CASE WHEN {invalid_predicate} "
            f"THEN CAST({quoted_col} AS {string_cast_target}) END, '|')"
        )
    if dialect == "postgresql":
        return (
            f"STRING_AGG(DISTINCT CASE WHEN {invalid_predicate} "
            f"THEN CAST({quoted_col} AS {string_cast_target}) END, '|')"
        )
    if dialect == "mysql":
        return (
            f"GROUP_CONCAT(DISTINCT CASE WHEN {invalid_predicate} "
            f"THEN CAST({quoted_col} AS {string_cast_target}) END SEPARATOR '|')"
        )
    return "NULL"


def _string_cast_target(dialect: str) -> str:
    if dialect == "bigquery":
        return "STRING"
    if dialect == "mysql":
        return "CHAR"
    return "TEXT"


def _wrap_with_row_cap(base_query: str, row_cap: Optional[int], dialect: str) -> str:
    """Limit the rows scanned for inference."""
    if not row_cap or row_cap <= 0:
        return base_query
    return f"SELECT * FROM (\n{base_query}\n) AS _appbi_full LIMIT {int(row_cap)}"


def build_inference_query(
    base_query: str,
    columns: Iterable[str],
    dialect: str,
) -> Tuple[str, List[Tuple[str, str, str]]]:
    """Build one SELECT that, for each (column, candidate_type), reports
    invalid_count and a few invalid_examples — plus total_non_null per column.

    Returns: (sql, [(column, candidate_type, alias_prefix), ...]).
    """
    column_list = [str(c) for c in columns if str(c).strip()]
    if not column_list:
        return "", []

    string_target = _string_cast_target(dialect)
    select_parts: List[str] = []
    plan: List[Tuple[str, str, str]] = []

    for idx, col in enumerate(column_list):
        quoted_col = _quote_identifier(col, dialect)
        trimmed = _trimmed_string_expr(quoted_col, dialect)
        non_null_predicate = f"{trimmed} IS NOT NULL"
        non_null_alias = _alias("nn", idx, "cnt")
        select_parts.append(
            f"{_build_count_expr(non_null_predicate, dialect)} AS {non_null_alias}"
        )
        plan.append((col, "_total_non_null", non_null_alias))

        for cand in CANDIDATE_TYPES:
            invalid_predicate = _build_invalid_predicate(col, cand, dialect)
            inv_alias = _alias("inv", idx, f"{cand}_cnt")
            ex_alias = _alias("inv", idx, f"{cand}_ex")
            select_parts.append(
                f"{_build_count_expr(invalid_predicate, dialect)} AS {inv_alias}"
            )
            select_parts.append(
                f"{_build_examples_expr(quoted_col, invalid_predicate, dialect, string_target)} AS {ex_alias}"
            )
            plan.append((col, cand, inv_alias))
            plan.append((col, f"{cand}__examples", ex_alias))

    sql = (
        "SELECT\n  "
        + ",\n  ".join(select_parts)
        + f"\nFROM (\n{base_query}\n) AS _appbi_infer"
    )
    return sql, plan


def _parse_row(
    row: Dict[str, Any],
    plan: List[Tuple[str, str, str]],
) -> Dict[str, Dict[str, Any]]:
    """Pivot the single-row result into {column: {total_non_null, candidate: {invalid, examples}}}."""
    result: Dict[str, Dict[str, Any]] = {}
    for column, label, alias in plan:
        col_bucket = result.setdefault(column, {"_total_non_null": 0})
        value = row.get(alias)
        if label == "_total_non_null":
            col_bucket["_total_non_null"] = int(value or 0)
            continue
        if label.endswith("__examples"):
            cand = label[: -len("__examples")]
            cand_bucket = col_bucket.setdefault(cand, {"invalid": 0, "examples": []})
            if value:
                samples = [s for s in str(value).split("|") if s][:3]
                cand_bucket["examples"] = samples
            continue
        cand_bucket = col_bucket.setdefault(label, {"invalid": 0, "examples": []})
        cand_bucket["invalid"] = int(value or 0)
    return result


def _pick_best_type(
    column_stats: Dict[str, Any],
    tolerance: float,
    min_non_null: int,
) -> Tuple[Optional[str], int, List[str], Optional[str]]:
    """Pick the most specific candidate that meets the tolerance.

    Returns (suggested_type, invalid_count, examples, skipped_reason).
    """
    total = int(column_stats.get("_total_non_null") or 0)
    if total < min_non_null:
        return None, 0, [], "too_few_non_null_values"

    best: Optional[Tuple[str, int, List[str]]] = None
    for cand in CANDIDATE_TYPES:
        bucket = column_stats.get(cand)
        if not bucket:
            continue
        invalid = int(bucket.get("invalid") or 0)
        ratio = invalid / total if total else 1.0
        if ratio <= tolerance:
            best = (cand, invalid, list(bucket.get("examples") or []))
            break

    if best is None:
        return None, 0, [], "no_candidate_within_tolerance"
    return best[0], best[1], best[2], None


def infer_full_column_types(
    datasource,
    db_table,
    *,
    columns: Optional[Iterable[str]] = None,
    tolerance: float = 0.001,
    row_cap: Optional[int] = None,
    min_non_null: int = 3,
    column_batch_size: int = DEFAULT_COLUMN_BATCH_SIZE,
) -> List[ColumnTypeSuggestion]:
    """Run a full-scan inference and return per-column suggestions.

    Tolerance is the maximum fraction of non-null values allowed to fail the
    cast; default 0.1%. Columns that already have a user-set override are
    returned as suggestions but the caller decides whether to overwrite.

    `min_non_null` (default 3) is the floor of non-null values a column needs
    before we'll type it. It used to be 10, which silently left SMALL tables
    untyped — very common for Google-Sheets reference/dimension tabs (a 5-row
    `Lo` table stayed all-`string`, so its numeric/date columns never worked).
    Because `tolerance` already requires ~ALL non-null values to cast cleanly, a
    3+ row all-clean column is strong enough evidence; a 1-2 value column is not.

    The query batches columns to keep SELECT-list size sane on engines with
    column-count limits.
    """
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.live_query_service import (
        _dialect_for_ds_type,
        build_live_base_query_plan,
    )

    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    dialect = _dialect_for_ds_type(ds_type)

    plan = build_live_base_query_plan(
        datasource,
        db_table,
        apply_type_overrides=False,
    )
    base_query = plan.sql
    available_columns = list(columns) if columns else list(plan.output_columns or plan.source_columns or [])
    available_columns = [str(c) for c in available_columns if str(c).strip()]
    if not available_columns:
        logger.info("Type inference skipped: no columns resolved for table id=%s", getattr(db_table, "id", "?"))
        return []

    effective_cap = row_cap if row_cap is not None else DIALECT_ROW_CAPS.get(dialect)
    capped_query = _wrap_with_row_cap(base_query, effective_cap, dialect)

    suggestions: List[ColumnTypeSuggestion] = []
    for start in range(0, len(available_columns), column_batch_size):
        batch = available_columns[start : start + column_batch_size]
        sql, batch_plan = build_inference_query(capped_query, batch, dialect)
        if not sql:
            continue
        try:
            _, rows, _ = DataSourceConnectionService.execute_query(
                ds_type,
                datasource.config,
                sql,
                timeout_seconds=120,
            )
        except Exception as exc:
            logger.warning(
                "Type inference batch failed for table id=%s batch=%d-%d: %s",
                getattr(db_table, "id", "?"),
                start,
                start + len(batch),
                exc,
            )
            for col in batch:
                suggestions.append(
                    ColumnTypeSuggestion(
                        column=col,
                        suggested_type=None,
                        total_non_null=0,
                        invalid_count=0,
                        invalid_examples=[],
                        skipped_reason="inference_query_failed",
                    )
                )
            continue
        if not rows:
            continue
        parsed = _parse_row(rows[0], batch_plan)
        for col in batch:
            stats = parsed.get(col, {"_total_non_null": 0})
            suggested, invalid, examples, reason = _pick_best_type(stats, tolerance, min_non_null)
            suggestions.append(
                ColumnTypeSuggestion(
                    column=col,
                    suggested_type=suggested,
                    total_non_null=int(stats.get("_total_non_null") or 0),
                    invalid_count=invalid,
                    invalid_examples=examples,
                    skipped_reason=reason,
                )
            )

    return suggestions


def apply_suggestions_to_table(
    db,
    db_table,
    suggestions: Iterable[ColumnTypeSuggestion],
    *,
    overwrite_user_overrides: bool = False,
) -> Dict[str, str]:
    """Merge suggestions into DatasetTable.type_overrides.

    Returns a dict of {column: applied_type} for columns that were changed.
    By default never overwrites a column that already has an override.
    """
    from app.services.type_override_service import _override_type as _ovr_type
    existing = normalize_type_overrides(getattr(db_table, "type_overrides", None) or {})
    applied: Dict[str, str] = {}
    merged = dict(existing)

    for sug in suggestions:
        if not sug.suggested_type:
            continue
        if sug.column in existing and not overwrite_user_overrides:
            continue
        if _ovr_type(existing.get(sug.column)) == sug.suggested_type:
            continue
        merged[sug.column] = sug.suggested_type
        applied[sug.column] = sug.suggested_type

    if applied:
        db_table.type_overrides = merged
        db.add(db_table)
        db.commit()
        db.refresh(db_table)
        logger.info(
            "Applied %d auto-detected type overrides to table id=%s: %s",
            len(applied),
            getattr(db_table, "id", "?"),
            applied,
        )
    return applied
