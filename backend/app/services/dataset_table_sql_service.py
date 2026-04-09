"""Helpers for dataset-backed DuckDB SQL tables."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence

import sqlglot
import sqlglot.expressions as exp
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models import DataSource
from app.models.dataset import Dataset, DatasetTable
from app.services.dataset_calendar_service import (
    build_calendar_duckdb_sql,
    get_calendar_settings,
    is_generated_calendar_table,
)
from app.services.duckdb_query_validator import validate_duckdb_query
from app.services.query_validator import QueryValidationError, QueryValidator
from app.services.runtime_modes import resolve_dataset_query_mode
from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
from app.services.transformation_compiler import TransformationCompiler

logger = get_logger(__name__)


DERIVED_TABLE_SOURCE_KIND = "derived_table"
DATASET_TABLE_ALIAS_PREFIX = "dataset_table_"
_DUCKDB_EXTERNAL_TABLE_FUNCTIONS = {
    "csv_scan",
    "delta_scan",
    "glob",
    "iceberg_scan",
    "mysql_scan",
    "parquet_scan",
    "postgres_scan",
    "read_blob",
    "read_csv",
    "read_csv_auto",
    "read_json",
    "read_json_auto",
    "read_ndjson",
    "read_ndjson_auto",
    "read_parquet",
    "sqlite_scan",
}


class DatasetTableSqlError(ValueError):
    """Structured dataset SQL build error."""

    def __init__(self, message: str, *, code: str = "INVALID_DATASET_SQL"):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class DatasetTableReferenceOption:
    table_id: int
    alias: str
    display_name: str
    source_kind: str


def is_derived_table(table: DatasetTable | Any | None) -> bool:
    return str(getattr(table, "source_kind", "") or "").strip().lower() == DERIVED_TABLE_SOURCE_KIND


def build_dataset_table_sql_alias(table_id: int) -> str:
    return f"{DATASET_TABLE_ALIAS_PREFIX}{int(table_id)}"


def get_dataset_table_reference_options(
    db: Session,
    dataset_id: int,
    *,
    exclude_table_id: int | None = None,
    include_disabled: bool = False,
) -> List[DatasetTableReferenceOption]:
    query = db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id)
    if not include_disabled:
        query = query.filter(DatasetTable.enabled == True)  # noqa: E712

    options: List[DatasetTableReferenceOption] = []
    for table in query.order_by(DatasetTable.created_at).all():
        if exclude_table_id is not None and int(table.id) == int(exclude_table_id):
            continue
        options.append(
            DatasetTableReferenceOption(
                table_id=int(table.id),
                alias=build_dataset_table_sql_alias(int(table.id)),
                display_name=str(table.display_name or table.source_table_name or f"Table {table.id}"),
                source_kind=str(table.source_kind or "physical_table"),
            )
        )
    return options


def validate_and_clean_derived_query(query: str) -> str:
    try:
        cleaned = QueryValidator.validate_and_clean(query)
    except QueryValidationError as exc:
        raise DatasetTableSqlError(str(exc), code="INVALID_DATASET_SQL") from exc

    try:
        validate_duckdb_query(cleaned)
    except ValueError as exc:
        raise DatasetTableSqlError(str(exc), code="INVALID_DATASET_SQL") from exc

    return cleaned


def _indent_sql(sql: str, spaces: int = 2) -> str:
    prefix = " " * spaces
    return "\n".join(f"{prefix}{line}" if line else line for line in str(sql or "").splitlines())


def _parse_statement(sql: str) -> exp.Expression:
    try:
        return sqlglot.parse_one(sql, dialect="duckdb")
    except sqlglot.errors.ParseError as exc:
        raise DatasetTableSqlError(f"Invalid SQL syntax: {exc}", code="INVALID_DATASET_SQL") from exc


def extract_dataset_table_aliases_from_sql(sql: str) -> List[str]:
    cleaned = validate_and_clean_derived_query(sql)
    statement = _parse_statement(cleaned)

    cte_names = {
        str(cte.alias_or_name or "").strip().lower()
        for cte in statement.find_all(exp.CTE)
        if str(cte.alias_or_name or "").strip()
    }

    table_function_type = getattr(exp, "TableFunction", None)
    for node in statement.walk():
        if table_function_type is not None and isinstance(node, table_function_type):
            raise DatasetTableSqlError(
                "External table functions are not allowed in calculated tables.",
                code="INVALID_DATASET_SQL",
            )
        if isinstance(node, exp.Anonymous):
            fn_name = str(node.name or "").strip().lower()
            if fn_name in _DUCKDB_EXTERNAL_TABLE_FUNCTIONS:
                raise DatasetTableSqlError(
                    f"Function '{fn_name}' is not allowed in calculated tables.",
                    code="INVALID_DATASET_SQL",
                )

    aliases: List[str] = []
    seen: set[str] = set()
    for table in statement.find_all(exp.Table):
        table_name = str(table.name or "").strip()
        if not table_name:
            continue
        if table.args.get("db") is not None or table.args.get("catalog") is not None:
            raise DatasetTableSqlError(
                "Qualified table references are not allowed. Use dataset table aliases only.",
                code="INVALID_DATASET_SQL",
            )
        lowered = table_name.lower()
        if lowered in cte_names:
            continue
        if lowered not in seen:
            aliases.append(table_name)
            seen.add(lowered)
    return aliases


def collect_derived_dependency_table_ids(
    db: Session,
    dataset_id: int,
    query: str,
    *,
    exclude_table_id: int | None = None,
) -> List[int]:
    alias_to_table = {
        option.alias.lower(): option.table_id
        for option in get_dataset_table_reference_options(
            db,
            dataset_id,
            exclude_table_id=exclude_table_id,
            include_disabled=False,
        )
    }

    aliases = extract_dataset_table_aliases_from_sql(query)
    if not aliases:
        raise DatasetTableSqlError(
            "Calculated table SQL must reference at least one table from this dataset.",
            code="INVALID_DATASET_SQL",
        )

    dependency_ids: List[int] = []
    seen: set[int] = set()
    for alias in aliases:
        table_id = alias_to_table.get(alias.lower())
        if table_id is None:
            raise DatasetTableSqlError(
                f"Unknown table reference '{alias}'. Use the dataset table aliases shown in the editor.",
                code="INVALID_DATASET_SQL",
            )
        if table_id not in seen:
            dependency_ids.append(table_id)
            seen.add(table_id)
    return dependency_ids


def _source_columns_for_transformations(table: DatasetTable | Any) -> list[str] | None:
    columns_cache = getattr(table, "columns_cache", None)
    if isinstance(columns_cache, dict):
        source_columns = columns_cache.get("source_columns")
        if isinstance(source_columns, list):
            normalized = [str(item) for item in source_columns if str(item).strip()]
            if normalized:
                return normalized
        raw_columns = columns_cache.get("columns")
        if isinstance(raw_columns, list):
            normalized = [
                str(item.get("name") or "").strip()
                for item in raw_columns
                if isinstance(item, dict) and str(item.get("name") or "").strip()
            ]
            if normalized:
                return normalized
    if isinstance(columns_cache, list):
        normalized = [
            str(item.get("name") or "").strip()
            for item in columns_cache
            if isinstance(item, dict) and str(item.get("name") or "").strip()
        ]
        if normalized:
            return normalized
    return None


def _apply_table_transformations(base_query: str, table: DatasetTable | Any) -> str:
    transformations = [
        step
        for step in (getattr(table, "transformations", None) or [])
        if isinstance(step, dict) and step.get("enabled", True)
    ]
    if not transformations:
        return base_query

    compiled_sql, _ = TransformationCompiler.compile_transformations(
        base_query,
        transformations,
        dialect="duckdb",
        available_columns=_source_columns_for_transformations(table),
    )
    return compiled_sql


def _build_source_backed_duckdb_query(
    db: Session,
    dataset_obj: Dataset,
    table: DatasetTable | Any,
) -> str:
    if is_generated_calendar_table(table):
        settings = get_calendar_settings(dataset_obj, enabled_default=False)
        return build_calendar_duckdb_sql(settings)

    datasource_id = getattr(table, "datasource_id", None)
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first() if datasource_id else None
    if datasource is None:
        raise DatasetTableSqlError(
            f'Table "{getattr(table, "display_name", getattr(table, "source_table_name", "Unknown"))}" has no datasource.',
            code="DATASOURCE_NOT_FOUND",
        )

    source_kind = str(getattr(table, "source_kind", "") or "").strip().lower()
    display_name = str(getattr(table, "display_name", "") or getattr(table, "source_table_name", "") or "Table")

    if source_kind == "physical_table":
        source_table_name = str(getattr(table, "source_table_name", "") or "").strip()
        if not source_table_name:
            raise DatasetTableSqlError(
                f'Table "{display_name}" is missing its source table name.',
                code="INVALID_DATASET_SQL",
            )
        view_name = get_synced_view(datasource.id, source_table_name)
        if view_name is None:
            query_mode = resolve_dataset_query_mode(table)
            if query_mode == "live":
                raise DatasetTableSqlError(
                    f'Table "{display_name}" is in live mode and cannot be used in a calculated table until it is synced.',
                    code="NOT_SYNCED",
                )
            raise DatasetTableSqlError(
                f'Table "{display_name}" has not been synced yet.',
                code="NOT_SYNCED",
            )
        return _apply_table_transformations(f"SELECT * FROM {view_name}", table)

    if source_kind == "sql_query":
        source_query = str(getattr(table, "source_query", "") or "").strip()
        if not source_query:
            raise DatasetTableSqlError(
                f'Table "{display_name}" is missing its SQL query.',
                code="INVALID_DATASET_SQL",
            )
        rewritten = rewrite_sql_for_duckdb(datasource.id, source_query)
        if rewritten is None:
            raise DatasetTableSqlError(
                f'Table "{display_name}" cannot be compiled to DuckDB yet. Please sync its source tables first.',
                code="NOT_SYNCED",
            )
        return _apply_table_transformations(f"SELECT * FROM ({rewritten}) AS _dataset_source", table)

    raise DatasetTableSqlError(
        f"Unsupported source_kind for DuckDB compilation: {source_kind or 'unknown'}",
        code="INVALID_DATASET_SQL",
    )


def build_dataset_table_duckdb_query(
    db: Session,
    dataset_obj: Dataset,
    table: DatasetTable | Any,
    *,
    visited_table_ids: Sequence[int] | None = None,
) -> str:
    if not is_derived_table(table):
        return _build_source_backed_duckdb_query(db, dataset_obj, table)

    current_table_id = getattr(table, "id", None)
    display_name = str(getattr(table, "display_name", "") or f"Table {current_table_id or ''}").strip()
    if current_table_id is not None and current_table_id in set(visited_table_ids or []):
        cycle_chain = " -> ".join(str(item) for item in [*(visited_table_ids or []), current_table_id])
        raise DatasetTableSqlError(
            f"Calculated table dependency cycle detected: {cycle_chain}",
            code="CIRCULAR_DEPENDENCY",
        )

    source_query = str(getattr(table, "source_query", "") or "").strip()
    cleaned_query = validate_and_clean_derived_query(source_query)
    dependency_ids = collect_derived_dependency_table_ids(
        db,
        dataset_obj.id,
        cleaned_query,
        exclude_table_id=current_table_id,
    )

    dependency_tables = {
        int(dep.id): dep
        for dep in (
            db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_obj.id)
            .filter(DatasetTable.id.in_(dependency_ids))
            .all()
        )
    }

    ctes: List[str] = []
    next_visited = [*(visited_table_ids or [])]
    if current_table_id is not None:
        next_visited.append(int(current_table_id))

    for dependency_id in dependency_ids:
        dependency_table = dependency_tables.get(int(dependency_id))
        if dependency_table is None:
            raise DatasetTableSqlError(
                f'Calculated table "{display_name}" references a missing table alias: {build_dataset_table_sql_alias(int(dependency_id))}',
                code="INVALID_DATASET_SQL",
            )
        dependency_sql = build_dataset_table_duckdb_query(
            db,
            dataset_obj,
            dependency_table,
            visited_table_ids=next_visited,
        )
        alias = build_dataset_table_sql_alias(int(dependency_id)).replace('"', "")
        ctes.append(f'"{alias}" AS (\n{_indent_sql(dependency_sql)}\n)')

    base_query = f"SELECT * FROM (\n{_indent_sql(cleaned_query)}\n) AS _derived_table"
    if ctes:
        base_query = "WITH " + ",\n".join(ctes) + "\n" + base_query

    return _apply_table_transformations(base_query, table)


def preview_dataset_table_duckdb_query(
    db: Session,
    dataset_obj: Dataset,
    table: DatasetTable | Any,
    *,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[str], list[dict[str, Any]]]:
    from app.services.duckdb_engine import DuckDBEngine

    compiled_query = build_dataset_table_duckdb_query(db, dataset_obj, table)
    sql = f"SELECT * FROM ({compiled_query}) AS _dataset_preview LIMIT {max(1, int(limit))}"
    if offset:
        sql += f" OFFSET {max(0, int(offset))}"

    with DuckDBEngine.read_conn() as conn:
        result = conn.execute(sql)
        columns = [item[0] for item in (result.description or [])]
        raw_rows = result.fetchall()
    rows = [dict(zip(columns, row)) for row in raw_rows]
    return columns, rows
