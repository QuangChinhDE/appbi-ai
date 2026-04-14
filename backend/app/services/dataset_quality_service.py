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

Timeliness:
  freshness_days    → MAX(date_col) older than N days

Accuracy:
  row_count_range   → total row count outside [min, max]
  statistical_range → values outside mean ± z*stddev (z-score)
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
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


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VALID_DIMENSIONS = {
    "completeness", "validity", "uniqueness", "consistency", "timeliness", "accuracy"
}
VALID_SEVERITIES = {"info", "warning", "error"}

# rule_type → dimension mapping (for auto-validation)
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
    "freshness_days": "timeliness",
    "row_count_range": "accuracy",
    "statistical_range": "accuracy",
}

# Pre-built format regex hints
_FORMAT_PATTERNS = {
    "email": r"^[^\s@]+@[^\s@]+\.[^\s@]+$",
    "url": r"^https?://",
    "phone": r"^\+?[0-9\s\-().]{7,20}$",
    "date": r"^\d{4}-\d{2}-\d{2}$",
    "datetime": r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}",
}


# ---------------------------------------------------------------------------
# SQL builder helpers
# ---------------------------------------------------------------------------

def _q(col: str) -> str:
    """Double-quote an identifier (PostgreSQL-safe)."""
    return '"' + col.replace('"', '""') + '"'


def _numeric_cast_expr(expr: str, dialect: str) -> str:
    if dialect == "bigquery":
        return f"CAST({expr} AS FLOAT64)"
    if dialect == "mysql":
        return f"CAST({expr} AS DOUBLE)"
    return f"CAST({expr} AS DOUBLE PRECISION)"


def _build_check_sql(
    table_ref: str,
    rule_type: str,
    col: Optional[str],
    config: Dict[str, Any],
    dialect: str = "postgresql",
) -> Optional[str]:
    """
    Return a SQL snippet that produces (rows_checked, rows_failed).
    Returns None if the rule cannot be compiled (skip gracefully).

    table_ref  — e.g. 'public."orders"' or a subquery alias
    dialect    — 'postgresql' | 'mysql' | 'bigquery'  (affects NULL filter syntax)
    """
    # BigQuery / MySQL use slightly different filter syntax; default to ANSI FILTER
    use_filter_clause = dialect != "mysql"  # MySQL doesn't support FILTER (WHERE ...)

    def filter_expr(condition: str) -> str:
        if use_filter_clause:
            return f"COUNT(*) FILTER (WHERE {condition})"
        return f"SUM(CASE WHEN {condition} THEN 1 ELSE 0 END)"

    qcol = _q(col) if col else None

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
        blank_condition = f"TRIM(CAST({qcol} AS TEXT)) = ''"
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
            f"{filter_expr(f'{qcol} IS NOT NULL AND CAST({qcol} AS TEXT) NOT IN ({escaped})')} AS rows_failed "
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
                cond = f"CAST({qcol} AS CHAR) NOT REGEXP '{pattern}'"
            else:
                cond = f"BINARY CAST({qcol} AS CHAR) NOT REGEXP '{pattern}'"
        else:
            # PostgreSQL: ~* for case-insensitive, !~ for case-sensitive
            op = "!~*" if case_insensitive else "!~"
            cond = f"CAST({qcol} AS TEXT) {op} '{pattern}'"
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
            conditions.append(f"CAST({qcol} AS NUMERIC) < {val}")
        if mx is not None:
            val = f"'{mx}'" if isinstance(mx, str) else str(mx)
            conditions.append(f"CAST({qcol} AS NUMERIC) > {val}")
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
            cond = f"NOT REGEXP_CONTAINS(CAST({qcol} AS STRING), r'{escaped_pat}')"
        elif dialect == "mysql":
            cond = f"CAST({qcol} AS CHAR) NOT REGEXP '{escaped_pat}'"
        else:
            cond = f"CAST({qcol} AS TEXT) !~ '{escaped_pat}'"
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
        combo = ", ".join(_q(c) for c in cols)
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

    # ── Timeliness ─────────────────────────────────────────────────────────
    if rule_type == "freshness_days":
        date_col = config.get("column") or col
        if not date_col:
            return None
        max_days = int(config.get("max_days") or 1)
        qdate = _q(date_col)
        if dialect == "bigquery":
            age_expr = f"DATE_DIFF(CURRENT_DATE(), CAST(MAX({qdate}) AS DATE), DAY)"
        elif dialect == "mysql":
            age_expr = f"DATEDIFF(CURDATE(), CAST(MAX({qdate}) AS DATE))"
        else:
            age_expr = f"EXTRACT(DAY FROM NOW() - MAX({qdate}::timestamptz))"
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

    return None


def _table_ref_for_source(db_table: DatasetTable) -> Tuple[Optional[str], Optional[str]]:
    """
    Return (table_ref_sql, dialect) for use in quality check SQL.
    table_ref_sql is a FROM-able reference: a quoted table name or a sub-query.
    Returns (None, None) for unsupported kinds (generated_calendar).
    """
    if db_table.source_kind == "generated_calendar":
        return None, None

    if db_table.source_kind == "physical_table":
        tbl = db_table.source_table_name or ""
        # Already includes schema, e.g. "public.orders" — wrap safely
        parts = tbl.split(".", 1)
        if len(parts) == 2:
            ref = f'"{parts[0]}"."{parts[1]}"'
        else:
            ref = f'"{tbl}"'
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


# ---------------------------------------------------------------------------
# CRUD operations
# ---------------------------------------------------------------------------

class DatasetQualityService:

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
        rule = DatasetQualityRule(
            dataset_id=dataset_id,
            table_id=data.table_id,
            column_name=data.column_name or None,
            dimension=data.dimension,
            rule_type=data.rule_type,
            name=data.name,
            config=data.config.model_dump(exclude_none=True) if data.config else {},
            severity=data.severity,
            enabled=data.enabled,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(rule)
        db.commit()
        db.refresh(rule)
        return rule

    @staticmethod
    def update_rule(
        db: Session,
        rule: DatasetQualityRule,
        data: QualityRuleUpdate,
    ) -> DatasetQualityRule:
        for field, value in data.model_dump(exclude_unset=True).items():
            if field == "config" and value is not None:
                # QualityRuleConfig → dict
                if hasattr(value, "model_dump"):
                    value = value.model_dump(exclude_none=True)
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
        new_rule = DatasetQualityRule(
            dataset_id=rule.dataset_id,
            table_id=target_table_id if target_table_id is not None else rule.table_id,
            column_name=rule.column_name,
            dimension=rule.dimension,
            rule_type=rule.rule_type,
            name=rule.name + name_suffix,
            config=dict(rule.config) if rule.config else {},
            severity=rule.severity,
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
    ) -> DatasetQualityRun:
        run = DatasetQualityRun(
            dataset_id=dataset_id,
            status="queued",
            triggered_by_id=triggered_by_id,
            created_at=datetime.utcnow(),
        )
        db.add(run)
        db.commit()
        db.refresh(run)
        return run

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

        # Merge run results into breakdown (exclude skipped/error rules)
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
                # Skip errored/skipped rules — they don't count toward pass/fail
                if res.get("skipped") or res.get("error"):
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
            run.score = 100.0
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
        scorable_count = 0  # rules thực sự chạy được (không bị error/skip)

        # Ghi tổng số rules ngay từ đầu để FE biết denominator
        run.progress_done = 0
        run.progress_total = len(enabled_rules)
        db.commit()

        for idx, rule in enumerate(enabled_rules, start=1):
            result = DatasetQualityService._execute_single_rule(db, dataset_obj, rule, table_map, ds_map)
            results[str(rule.id)] = result
            # Chỉ tính score cho rules thực sự chạy được (không bị error/skip)
            if not result.get("skipped") and not result.get("error"):
                scorable_count += 1
                if result.get("passed"):
                    passed_count += 1
            # Commit progress sau mỗi rule để FE poll thấy tiến trình
            run.progress_done = idx
            db.commit()

        score = round(passed_count / scorable_count * 100, 1) if scorable_count else 100.0

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

        table_ref, _ = _table_ref_for_source(execution_table)
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

        check_sql = _build_check_sql(
            table_ref=table_ref,
            rule_type=rule.rule_type,
            col=rule.column_name,
            config=config,
            dialect=dialect,
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
                limit=2,
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

            return _result({
                "passed": passed, "rows_checked": rows_checked, "rows_failed": rows_failed,
                "detail": detail, "sql": check_sql,
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
