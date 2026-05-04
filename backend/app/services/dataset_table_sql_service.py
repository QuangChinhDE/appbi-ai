"""Helpers for dataset-backed SQL tables."""
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
    build_calendar_live_sql,
    get_calendar_settings,
    is_generated_calendar_table,
)
from app.services.query_validator import QueryValidationError, QueryValidator
from app.services.transformation_compiler import TransformationCompiler

logger = get_logger(__name__)


DERIVED_TABLE_SOURCE_KIND = "derived_table"
DATASET_TABLE_ALIAS_PREFIX = "dataset_table_"
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
    """Normalize a dataset-level SQL alias. Delegates to identifier_utils for consistency."""
    from app.services.identifier_utils import normalize_table_alias
    return normalize_table_alias(value, fallback=fallback)


def normalize_physical_table_source_name(source_table_name: str | None) -> str:
    text = str(source_table_name or "").strip().strip('"').strip("'").strip("`")
    if not text:
        return ""

    parts: List[str] = []
    for segment in text.split("."):
        cleaned = segment.strip().strip('"').strip("'").strip("`")
        if cleaned:
            parts.append(cleaned)
    return ".".join(parts)


def build_physical_table_default_display_name(source_table_name: str | None) -> str:
    return normalize_physical_table_source_name(source_table_name)


def normalize_physical_table_sql_alias(source_table_name: str | None, *, fallback: str = "table") -> str:
    text = normalize_physical_table_source_name(source_table_name)
    if not text:
        return fallback

    text = text.replace(".", "_")
    text = text.replace("\u0110", "D").replace("\u0111", "d")

    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    alias = re.sub(r"[^a-zA-Z0-9_]+", "_", ascii_text).lower()
    alias = re.sub(r"_+", "_", alias)
    if not alias or not re.search(r"[a-zA-Z0-9]", alias):
        alias = fallback
    if alias[:1].isdigit():
        alias = f"table_{alias}"
    if alias in _SQL_ALIAS_RESERVED_WORDS:
        alias = f"{alias}_table"
    return alias


def build_dataset_table_alias_base_from_values(
    *,
    display_name: str | None = None,
    source_kind: str | None = None,
    source_table_name: str | None = None,
    table_id: int | None = None,
) -> str:
    fallback = f"table_{table_id}" if table_id is not None else "table"
    normalized_source_name = normalize_physical_table_source_name(source_table_name)
    kind = str(source_kind or "").strip().lower()

    if kind == "physical_table" and normalized_source_name:
        return normalize_physical_table_sql_alias(normalized_source_name, fallback=fallback)

    raw_label = display_name or normalized_source_name or fallback
    return normalize_dataset_table_sql_alias(str(raw_label), fallback=fallback)


def build_dataset_table_sql_alias_base(table: DatasetTable | Any) -> str:
    return build_dataset_table_alias_base_from_values(
        display_name=getattr(table, "display_name", None),
        source_kind=getattr(table, "source_kind", None),
        source_table_name=getattr(table, "source_table_name", None),
        table_id=getattr(table, "id", None),
    )


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


def _find_live_datasource_for_dataset(
    db: Session,
    dataset_obj: Dataset,
    *,
    required_datasource_id: int | None = None,
) -> DataSource | None:
    if required_datasource_id is not None:
        return db.query(DataSource).filter(DataSource.id == int(required_datasource_id)).first()

    candidate_tables = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == dataset_obj.id,
            DatasetTable.datasource_id.isnot(None),
        )
        .order_by(DatasetTable.id)
        .all()
    )

    for candidate in candidate_tables:
        if is_generated_calendar_table(candidate):
            continue
        datasource = db.query(DataSource).filter(DataSource.id == candidate.datasource_id).first()
        if datasource is not None:
            return datasource

    for candidate in candidate_tables:
        datasource = db.query(DataSource).filter(DataSource.id == candidate.datasource_id).first()
        if datasource is not None:
            return datasource

    return None


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
    )
    from app.services.dataset_relation_service import resolve_dataset_table_relation

    if is_generated_calendar_table(table):
        datasource = _find_live_datasource_for_dataset(
            db,
            dataset_obj,
            required_datasource_id=required_datasource_id,
        )
        if datasource is None:
            raise DatasetTableSqlError(
                'Standard Date table requires a datasource-backed table in the same dataset.',
                code="DATASOURCE_NOT_FOUND",
            )
        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        return datasource, build_calendar_live_sql(
            get_calendar_settings(dataset_obj, enabled_default=False),
            dialect,
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
        plan = resolve_dataset_table_relation(datasource, table)
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

    ordered_dependency_ids = [
        *[
            dependency_id
            for dependency_id in dependency_ids
            if not is_generated_calendar_table(dependency_tables.get(int(dependency_id)))
        ],
        *[
            dependency_id
            for dependency_id in dependency_ids
            if is_generated_calendar_table(dependency_tables.get(int(dependency_id)))
        ],
    ]

    for dependency_id in ordered_dependency_ids:
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
