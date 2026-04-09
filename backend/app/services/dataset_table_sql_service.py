"""Helpers for dataset-backed DuckDB SQL tables."""
from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from types import SimpleNamespace
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
_SQL_ALIAS_RESERVED_WORDS = {
    "as",
    "by",
    "cross",
    "from",
    "full",
    "group",
    "inner",
    "join",
    "left",
    "limit",
    "on",
    "order",
    "outer",
    "right",
    "select",
    "table",
    "where",
    "with",
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


def normalize_dataset_table_sql_alias(value: str | None, *, fallback: str = "table") -> str:
    text = str(value or "").strip()
    if "." in text and not re.search(r"\s", text):
        text = text.split(".")[-1]
    text = text.replace("\u0110", "D").replace("\u0111", "d")

    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    alias = re.sub(r"[^a-zA-Z0-9]+", "_", ascii_text).strip("_").lower()
    alias = re.sub(r"_+", "_", alias)
    if not alias:
        alias = fallback
    if alias[:1].isdigit():
        alias = f"table_{alias}"
    if alias in _SQL_ALIAS_RESERVED_WORDS:
        alias = f"{alias}_table"
    return alias


def build_dataset_table_sql_alias_base(table: DatasetTable | Any) -> str:
    table_id = getattr(table, "id", None)
    fallback = f"table_{table_id}" if table_id is not None else "table"
    raw_label = (
        getattr(table, "display_name", None)
        or getattr(table, "source_table_name", None)
        or fallback
    )
    return normalize_dataset_table_sql_alias(str(raw_label), fallback=fallback)


def build_dataset_table_reference_alias_map(
    tables: Iterable[DatasetTable | Any],
) -> Dict[int, str]:
    table_list = [
        table
        for table in (tables or [])
        if getattr(table, "id", None) is not None
    ]
    grouped: dict[str, list[DatasetTable | Any]] = defaultdict(list)
    for table in table_list:
        grouped[build_dataset_table_sql_alias_base(table)].append(table)

    alias_map: Dict[int, str] = {}
    for base_alias, grouped_tables in grouped.items():
        if len(grouped_tables) == 1:
            table_id = int(getattr(grouped_tables[0], "id"))
            alias_map[table_id] = base_alias
            continue

        for table in grouped_tables:
            table_id = int(getattr(table, "id"))
            alias_map[table_id] = f"{base_alias}_{table_id}"
    return alias_map


def get_dataset_table_reference_options(
    db: Session,
    dataset_id: int,
    *,
    exclude_table_id: int | None = None,
    include_disabled: bool = False,
) -> List[DatasetTableReferenceOption]:
    query = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .order_by(DatasetTable.created_at, DatasetTable.id)
    )
    tables = query.all()
    alias_map = build_dataset_table_reference_alias_map(tables)
    options: List[DatasetTableReferenceOption] = []
    for table in tables:
        if not include_disabled and not bool(getattr(table, "enabled", True)):
            continue
        if exclude_table_id is not None and int(table.id) == int(exclude_table_id):
            continue
        options.append(
            DatasetTableReferenceOption(
                table_id=int(table.id),
                alias=alias_map.get(int(table.id), build_dataset_table_sql_alias_base(table)),
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
    alias_to_table: Dict[str, int] = {}
    for option in get_dataset_table_reference_options(
        db,
        dataset_id,
        exclude_table_id=exclude_table_id,
        include_disabled=False,
    ):
        alias_to_table[option.alias.lower()] = option.table_id
        alias_to_table[build_dataset_table_sql_alias(option.table_id).lower()] = option.table_id

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


def rewrite_dataset_table_aliases_in_sql(
    sql: str,
    replacements: Dict[str, str],
) -> str:
    cleaned = validate_and_clean_derived_query(sql)
    normalized_replacements = {
        str(source or "").strip().lower(): str(target or "").strip()
        for source, target in (replacements or {}).items()
        if str(source or "").strip() and str(target or "").strip()
    }
    if not normalized_replacements:
        return cleaned

    statement = _parse_statement(cleaned)
    cte_names = {
        str(cte.alias_or_name or "").strip().lower()
        for cte in statement.find_all(exp.CTE)
        if str(cte.alias_or_name or "").strip()
    }

    changed = False
    for table in statement.find_all(exp.Table):
        table_name = str(table.name or "").strip()
        if not table_name:
            continue
        if table.args.get("db") is not None or table.args.get("catalog") is not None:
            continue
        lowered = table_name.lower()
        if lowered in cte_names:
            continue

        replacement = normalized_replacements.get(lowered)
        if not replacement or replacement.lower() == lowered:
            continue

        table.set("this", exp.Identifier(this=replacement, quoted=False))
        changed = True

    return statement.sql(dialect="duckdb") if changed else cleaned


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


def _apply_table_transformations(
    base_query: str,
    table: DatasetTable | Any,
    *,
    dialect: str = "duckdb",
) -> str:
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
        dialect=dialect,
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
        return _apply_table_transformations(f"SELECT * FROM {view_name}", table, dialect="duckdb")

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
        return _apply_table_transformations(
            f"SELECT * FROM ({rewritten}) AS _dataset_source",
            table,
            dialect="duckdb",
        )

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
    dataset_alias_map = build_dataset_table_reference_alias_map(
        db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_obj.id).all()
    )

    ctes: List[str] = []
    next_visited = [*(visited_table_ids or [])]
    if current_table_id is not None:
        next_visited.append(int(current_table_id))

    for dependency_id in dependency_ids:
        dependency_table = dependency_tables.get(int(dependency_id))
        if dependency_table is None:
            raise DatasetTableSqlError(
                f'Calculated table "{display_name}" references a missing table alias: {dataset_alias_map.get(int(dependency_id), build_dataset_table_sql_alias(int(dependency_id)))}',
                code="INVALID_DATASET_SQL",
            )
        dependency_sql = build_dataset_table_duckdb_query(
            db,
            dataset_obj,
            dependency_table,
            visited_table_ids=next_visited,
        )
        alias = dataset_alias_map.get(int(dependency_id), build_dataset_table_sql_alias(int(dependency_id))).replace('"', "")
        ctes.append(f'"{alias}" AS (\n{_indent_sql(dependency_sql)}\n)')

    base_query = f"SELECT * FROM (\n{_indent_sql(cleaned_query)}\n) AS _derived_table"
    if ctes:
        base_query = "WITH " + ",\n".join(ctes) + "\n" + base_query

    return _apply_table_transformations(base_query, table, dialect="duckdb")


def build_dataset_table_live_query(
    db: Session,
    dataset_obj: Dataset,
    table: DatasetTable | Any,
    *,
    visited_table_ids: Sequence[int] | None = None,
    required_datasource_id: int | None = None,
) -> tuple[DataSource, str]:
    from app.services.live_query_service import (
        _dialect_for_ds_type,
        _quote_identifier,
        build_live_base_query_plan,
    )

    if is_generated_calendar_table(table):
        raise DatasetTableSqlError(
            'Standard Date table cannot be used in a live calculated table. Sync the dataset tables first.',
            code="NOT_SYNCED",
        )

    if not is_derived_table(table):
        datasource_id = getattr(table, "datasource_id", None)
        datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first() if datasource_id else None
        if datasource is None:
            raise DatasetTableSqlError(
                f'Table "{getattr(table, "display_name", getattr(table, "source_table_name", "Unknown"))}" has no datasource.',
                code="DATASOURCE_NOT_FOUND",
            )
        if required_datasource_id is not None and int(datasource.id) != int(required_datasource_id):
            raise DatasetTableSqlError(
                "Live calculated tables can only reference tables from the same datasource.",
                code="NOT_SYNCED",
            )
        plan = build_live_base_query_plan(datasource, table, apply_type_overrides=True)
        return datasource, plan.sql

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
    dataset_alias_map = build_dataset_table_reference_alias_map(
        db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_obj.id).all()
    )

    resolved_datasource: DataSource | None = None
    ctes: List[str] = []
    next_visited = [*(visited_table_ids or [])]
    if current_table_id is not None:
        next_visited.append(int(current_table_id))

    for dependency_id in dependency_ids:
        dependency_table = dependency_tables.get(int(dependency_id))
        if dependency_table is None:
            raise DatasetTableSqlError(
                f'Calculated table "{display_name}" references a missing table alias: {dataset_alias_map.get(int(dependency_id), build_dataset_table_sql_alias(int(dependency_id)))}',
                code="INVALID_DATASET_SQL",
            )

        dependency_datasource, dependency_sql = build_dataset_table_live_query(
            db,
            dataset_obj,
            dependency_table,
            visited_table_ids=next_visited,
            required_datasource_id=(
                int(resolved_datasource.id)
                if resolved_datasource is not None
                else required_datasource_id
            ),
        )
        if resolved_datasource is None:
            resolved_datasource = dependency_datasource
        elif int(dependency_datasource.id) != int(resolved_datasource.id):
            raise DatasetTableSqlError(
                "Live calculated tables can only reference tables from the same datasource.",
                code="NOT_SYNCED",
            )

        ds_type = dependency_datasource.type if isinstance(dependency_datasource.type, str) else dependency_datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        alias = dataset_alias_map.get(int(dependency_id), build_dataset_table_sql_alias(int(dependency_id))).replace('"', "")
        quoted_alias = _quote_identifier(alias, dialect)
        ctes.append(f"{quoted_alias} AS (\n{_indent_sql(dependency_sql)}\n)")

    if resolved_datasource is None:
        raise DatasetTableSqlError(
            f'Calculated table "{display_name}" could not resolve a live datasource.',
            code="NOT_SYNCED",
        )

    ds_type = resolved_datasource.type if isinstance(resolved_datasource.type, str) else resolved_datasource.type.value
    dialect = _dialect_for_ds_type(ds_type)
    derived_alias = _quote_identifier("_derived_table", dialect)
    base_query = f"SELECT * FROM (\n{_indent_sql(cleaned_query)}\n) AS {derived_alias}"
    if ctes:
        base_query = "WITH " + ",\n".join(ctes) + "\n" + base_query

    return resolved_datasource, _apply_table_transformations(base_query, table, dialect=dialect)


def build_live_proxy_table_for_dataset_table(
    db: Session,
    dataset_obj: Dataset,
    table: DatasetTable | Any,
) -> tuple[DataSource, Any]:
    datasource, live_sql = build_dataset_table_live_query(db, dataset_obj, table)
    proxy_table = SimpleNamespace(
        id=getattr(table, "id", None),
        dataset_id=getattr(table, "dataset_id", getattr(dataset_obj, "id", None)),
        datasource_id=datasource.id,
        source_kind="sql_query",
        source_table_name=None,
        source_query=live_sql,
        display_name=getattr(table, "display_name", None),
        enabled=getattr(table, "enabled", True),
        transformations=[],
        type_overrides=getattr(table, "type_overrides", None),
        columns_cache=getattr(table, "columns_cache", None),
        sample_cache=getattr(table, "sample_cache", None),
    )
    return datasource, proxy_table


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
