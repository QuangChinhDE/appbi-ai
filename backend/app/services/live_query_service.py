"""
LiveQueryService — execute aggregated chart queries directly against source databases.

Used for tables with query_mode="live" (large data) to avoid syncing
hundreds of millions of rows to local DuckDB.

Dialect-aware SQL generation for BigQuery, PostgreSQL, MySQL.
Includes dry-run cost guard for BigQuery.
"""
from __future__ import annotations

import hashlib
import time
from datetime import date as dt_date, datetime
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import settings
from app.core.logging import get_logger
from app.services.chart_contracts import (
    normalize_chart_role_config,
    normalize_filter_conditions,
    normalize_filter_operator,
)
from app.services import query_cache
from app.services.dataset_calendar_service import build_calendar_filter_expression
from app.services.transformation_compiler import TransformationCompiler
from app.services.sql_validator import validate_select_only
from app.services.type_override_service import (
    build_runtime_projection_query,
    normalize_type_overrides,
)

logger = get_logger(__name__)


@dataclass
class LiveBaseQueryPlan:
    sql: str
    source_columns: List[str]
    output_columns: List[str]


# ── SQL dialect helpers ──────────────────────────────────────────────────────

def _quote_identifier(name: str, dialect: str) -> str:
    """Quote a column/table identifier for the target dialect."""
    if dialect == "bigquery":
        return f"`{name}`"
    elif dialect == "mysql":
        return f"`{name}`"
    else:  # postgresql, default
        return f'"{name}"'


def _sql_literal(value) -> str:
    """Safely escape a Python value as a SQL literal."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _dialect_for_ds_type(ds_type: str) -> str:
    """Map datasource type string to SQL dialect."""
    ds_type_val = ds_type if isinstance(ds_type, str) else ds_type.value
    return {
        "bigquery": "bigquery",
        "postgresql": "postgresql",
        "mysql": "mysql",
        "google_sheets": "duckdb",
        "manual": "duckdb",
    }.get(ds_type_val, "postgresql")


def _should_cache_live_query(ds_type: str) -> bool:
    """Google Sheets is externally mutable, so source freshness beats TTL cache."""
    ds_type_val = ds_type if isinstance(ds_type, str) else ds_type.value
    return ds_type_val != "google_sheets"


def _build_base_table_ref(
    ds_type: str,
    config: dict,
    source_table_name: str,
    dialect: str,
) -> str:
    """Build a fully-qualified table reference for the target database."""
    stn = source_table_name.strip().strip('"').strip("'")
    qi = _quote_identifier

    if dialect == "bigquery":
        from app.core.crypto import decrypt_config
        decrypted = decrypt_config(config)
        project_id = decrypted.get("project_id", "")
        if "." in stn:
            # Already qualified: schema.table → project.schema.table
            parts = stn.split(".", 1)
            return f"`{project_id}.{parts[0]}.{parts[1]}`"
        else:
            # Bare table name — need dataset
            dataset = decrypted.get("dataset", "")
            return f"`{project_id}.{dataset}.{stn}`"

    # DuckDB-backed snapshot connectors treat the full source table name as a
    # logical table identifier. Filenames commonly contain dots (for example
    # ``country_summary.csv - country_summary``), which are not schema
    # qualifiers and must not be split into ``schema.table`` here.
    if ds_type == "manual":
        if "." in stn:
            schema, table = stn.split(".", 1)
            if schema.strip('"').strip("'").lower() == "manual":
                table = table.strip().strip('"').strip("'")
                return f"{qi('manual', dialect)}.{qi(table, dialect)}"
        return f"{qi('manual', dialect)}.{qi(stn, dialect)}"

    if ds_type == "google_sheets":
        return qi(stn, dialect)

    if "." in stn:
        schema, table = stn.split(".", 1)
        schema = schema.strip('"').strip("'")
        table = table.strip('"').strip("'")
        return f"{qi(schema, dialect)}.{qi(table, dialect)}"

    return qi(stn, dialect)


def _parse_bigquery_dataset_and_table(
    config: dict,
    source_table_name: str,
) -> Tuple[Optional[str], Optional[str]]:
    stn = (source_table_name or "").strip().strip('"').strip("'").strip("`")
    if not stn:
        return None, None

    parts = [
        part.strip().strip("`").strip('"').strip("'")
        for part in stn.split(".")
        if part and str(part).strip()
    ]
    if len(parts) >= 3:
        return parts[-2], parts[-1]
    if len(parts) == 2:
        return parts[0], parts[1]

    default_dataset = (
        config.get("dataset")
        or config.get("default_dataset")
        or ""
    )
    default_dataset = str(default_dataset).strip().strip("`").strip('"').strip("'")
    return (default_dataset or None), parts[0]


def _parse_bigquery_partition_id_to_date(partition_id: str | None) -> Optional[dt_date]:
    raw = str(partition_id or "").strip()
    if not raw or raw in {"__NULL__", "__UNPARTITIONED__"}:
        return None

    formats = {
        4: "%Y",
        6: "%Y%m",
        8: "%Y%m%d",
        10: "%Y%m%d%H",
    }
    fmt = formats.get(len(raw))
    if not fmt:
        return None
    try:
        return datetime.strptime(raw, fmt).date()
    except ValueError:
        return None


def _build_bigquery_partition_window_clause(
    partition_days_ago: int,
    partition_metadata: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    days_ago = max(int(partition_days_ago or 0), 0)
    partition_metadata = partition_metadata or {}
    start_date_sql = f"DATE_SUB(CURRENT_DATE(), INTERVAL {days_ago} DAY)"
    end_date_sql = "DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY)"

    partition_field = str(partition_metadata.get("partition_field") or "").strip()
    partition_field_type = str(partition_metadata.get("partition_field_type") or "").upper()

    if partition_field:
        quoted_field = _quote_identifier(partition_field, "bigquery")
        if partition_field_type == "DATE":
            return f"{quoted_field} >= {start_date_sql} AND {quoted_field} < {end_date_sql}"
        if partition_field_type == "DATETIME":
            return (
                f"{quoted_field} >= DATETIME({start_date_sql}) "
                f"AND {quoted_field} < DATETIME({end_date_sql})"
            )
        return (
            f"{quoted_field} >= TIMESTAMP({start_date_sql}) "
            f"AND {quoted_field} < TIMESTAMP({end_date_sql})"
        )

    if partition_metadata.get("uses_ingestion_time_partitioning"):
        return (
            f"_PARTITIONTIME >= TIMESTAMP({start_date_sql}) "
            f"AND _PARTITIONTIME < TIMESTAMP({end_date_sql})"
        )

    return None


def _get_bigquery_partition_metadata(
    config: dict,
    source_table_name: str,
) -> Dict[str, Any]:
    metadata: Dict[str, Any] = {
        "project_id": None,
        "dataset_name": None,
        "table_name": None,
        "partition_field": None,
        "partition_field_type": None,
        "uses_ingestion_time_partitioning": False,
        "earliest_partition_date": None,
        "has_supported_partitioning": False,
    }
    try:
        from google.cloud import bigquery
        from app.services.datasource_service import _build_bigquery_client

        dataset_name, table_name = _parse_bigquery_dataset_and_table(config, source_table_name)
        project_id = str(config.get("project_id") or "").strip()
        metadata.update({
            "project_id": project_id or None,
            "dataset_name": dataset_name,
            "table_name": table_name,
        })
        if not project_id or not dataset_name or not table_name:
            return metadata

        client = _build_bigquery_client(config)
        try:
            table_ref = f"{project_id}.{dataset_name}.{table_name}"
            table = client.get_table(table_ref)
            time_partitioning = getattr(table, "time_partitioning", None)
            partition_field = str(getattr(time_partitioning, "field", "") or "").strip() or None
            schema_by_name = {
                str(field.name): str(field.field_type).upper()
                for field in getattr(table, "schema", []) or []
            }
            metadata["partition_field"] = partition_field
            metadata["partition_field_type"] = schema_by_name.get(partition_field) if partition_field else None
            metadata["uses_ingestion_time_partitioning"] = bool(time_partitioning and not partition_field)
            metadata["has_supported_partitioning"] = bool(
                metadata["uses_ingestion_time_partitioning"]
                or (partition_field and metadata["partition_field_type"] in {"DATE", "DATETIME", "TIMESTAMP"})
            )

            if metadata["has_supported_partitioning"]:
                sql = (
                    f"SELECT partition_id "
                    f"FROM `{project_id}.{dataset_name}.INFORMATION_SCHEMA.PARTITIONS` "
                    "WHERE table_name = @table_name "
                    "AND partition_id NOT IN ('__NULL__', '__UNPARTITIONED__') "
                    "ORDER BY partition_id ASC "
                    "LIMIT 1"
                )
                job_config = bigquery.QueryJobConfig(
                    query_parameters=[
                        bigquery.ScalarQueryParameter("table_name", "STRING", table_name),
                    ],
                    use_query_cache=True,
                )
                rows = client.query(sql, job_config=job_config).result()
                first_row = next(iter(rows), None)
                if first_row is not None:
                    try:
                        metadata["earliest_partition_date"] = _parse_bigquery_partition_id_to_date(
                            first_row["partition_id"]
                        )
                    except Exception:
                        metadata["earliest_partition_date"] = None
            return metadata
        finally:
            client.close()
    except Exception as e:
        logger.warning(
            "Failed to read BigQuery partition metadata for %s: %s",
            source_table_name,
            e,
        )
        return metadata


def _describe_bigquery_partition_target(partition_metadata: Optional[Dict[str, Any]]) -> str:
    partition_metadata = partition_metadata or {}
    partition_field = str(partition_metadata.get("partition_field") or "").strip()
    if partition_field:
        return partition_field
    if partition_metadata.get("uses_ingestion_time_partitioning"):
        return "_PARTITIONTIME"
    return "unpartitioned"


def _convert_dq_identifiers_to_backticks(sql: str) -> str:
    """Convert double-quoted SQL identifiers to backtick-quoted identifiers.

    BigQuery uses backticks for identifiers; double-quotes denote string
    literals.  The visual SQL builder (and some manual queries) may produce
    ``SELECT "col" FROM "schema.table"`` which is valid PostgreSQL but invalid
    BigQuery.  This function rewrites those double-quoted segments to backticks
    while leaving single-quoted string literals untouched.
    """
    import re

    # Match double-quoted segments that look like identifiers (not inside
    # single-quoted strings).  We walk through the SQL character by character
    # to respect single-quoted string boundaries.
    result: list[str] = []
    i = 0
    length = len(sql)
    while i < length:
        ch = sql[i]
        if ch == "'":
            # Skip single-quoted string literal entirely
            j = i + 1
            while j < length:
                if sql[j] == "'" and j + 1 < length and sql[j + 1] == "'":
                    j += 2  # escaped quote
                elif sql[j] == "'":
                    j += 1
                    break
                else:
                    j += 1
            result.append(sql[i:j])
            i = j
        elif ch == '"':
            # Double-quoted identifier → convert to backtick
            j = i + 1
            ident_chars: list[str] = []
            while j < length:
                if sql[j] == '"' and j + 1 < length and sql[j + 1] == '"':
                    ident_chars.append('"')
                    j += 2  # escaped double-quote
                elif sql[j] == '"':
                    j += 1
                    break
                else:
                    ident_chars.append(sql[j])
                    j += 1
            result.append("`")
            result.append("".join(ident_chars))
            result.append("`")
            i = j
        else:
            result.append(ch)
            i += 1
    return "".join(result)


def _build_source_select_query(
    datasource,
    db_table,
    ds_type: str,
    dialect: str,
    partition_days_ago: Optional[int] = None,
    bigquery_partition_meta: Optional[Dict[str, Any]] = None,
) -> str:
    """Build the raw source SELECT used before dataset transformations."""
    table_identifier = db_table.source_table_name or db_table.display_name
    if db_table.source_kind == "sql_query" and db_table.source_query:
        validate_select_only(db_table.source_query)
        source_sql = db_table.source_query
        # BigQuery uses backticks for identifiers; double-quotes denote string
        # literals.  Convert any double-quoted identifiers coming from the
        # visual SQL builder (or old data) to backtick-quoted identifiers so
        # BigQuery can execute them correctly.
        if dialect == "bigquery":
            source_sql = _convert_dq_identifiers_to_backticks(source_sql)
        return f"SELECT * FROM ({source_sql}) AS _source"
    base_ref = _build_base_table_ref(ds_type, datasource.config, table_identifier, dialect)
    sql = f"SELECT * FROM {base_ref}"
    if (
        dialect == "bigquery"
        and partition_days_ago is not None
        and getattr(db_table, "source_kind", None) == "physical_table"
        and getattr(db_table, "source_table_name", None)
    ):
        partition_clause = _build_bigquery_partition_window_clause(
            partition_days_ago,
            bigquery_partition_meta,
        )
        if partition_clause:
            sql += f" WHERE {partition_clause}"
    return sql


def _source_signature(db_table) -> Dict[str, Any]:
    return {
        "source_kind": getattr(db_table, "source_kind", None),
        "source_table_name": getattr(db_table, "source_table_name", None),
        "source_query": getattr(db_table, "source_query", None),
    }


def build_dataset_table_cache_identifier(db_table) -> str:
    table_id = getattr(db_table, "id", None)
    source_kind = str(getattr(db_table, "source_kind", "") or "unknown").strip().lower()
    source_table_name = str(getattr(db_table, "source_table_name", "") or "").strip()
    source_query = str(getattr(db_table, "source_query", "") or "").strip()
    display_name = str(getattr(db_table, "display_name", "") or "").strip()

    if source_kind == "physical_table" and source_table_name:
        source_ref = f"physical:{source_table_name.lower()}"
    elif source_kind == "sql_query" and source_query:
        source_hash = hashlib.sha1(source_query.encode("utf-8")).hexdigest()[:16]
        source_ref = f"sql:{source_hash}"
    elif source_kind == "derived_table" and source_query:
        source_hash = hashlib.sha1(source_query.encode("utf-8")).hexdigest()[:16]
        source_ref = f"derived:{source_hash}"
    elif source_table_name:
        source_ref = f"table:{source_table_name.lower()}"
    elif source_query:
        source_hash = hashlib.sha1(source_query.encode("utf-8")).hexdigest()[:16]
        source_ref = f"sql:{source_hash}"
    elif display_name:
        source_ref = f"display:{display_name.lower()}"
    else:
        source_ref = "anonymous"

    if table_id is not None:
        return f"dataset_table:{table_id}:{source_ref}"
    return f"dataset_table:{source_ref}"


def _extract_cached_output_columns(db_table) -> list[str]:
    raw_cols = getattr(db_table, "columns_cache", None)
    if isinstance(raw_cols, dict) and "columns" in raw_cols:
        raw_cols = raw_cols["columns"]
    if not isinstance(raw_cols, list):
        return []
    result: list[str] = []
    for col in raw_cols:
        if isinstance(col, dict) and col.get("name"):
            result.append(str(col["name"]))
        elif isinstance(col, str):
            result.append(str(col))
    return result


def _extract_cached_source_columns(db_table) -> list[str]:
    raw_cache = getattr(db_table, "columns_cache", None)
    if not isinstance(raw_cache, dict):
        return []
    if raw_cache.get("source_signature") != _source_signature(db_table):
        return []
    source_columns = raw_cache.get("source_columns")
    if not isinstance(source_columns, list):
        return []
    return [str(column) for column in source_columns if str(column).strip()]


def _infer_source_columns(datasource, ds_type: str, sql_query: str) -> list[str]:
    """Infer raw source columns using connector metadata APIs where possible."""
    from app.services.datasource_service import DataSourceConnectionService

    try:
        inferred = DataSourceConnectionService.infer_column_types(
            ds_type,
            datasource.config,
            sql_query,
        )
    except Exception as exc:
        logger.warning("Source column inference failed for live transformations: %s", exc)
        return []

    return [
        str(col.get("name"))
        for col in inferred
        if isinstance(col, dict) and col.get("name")
    ]


def _resolve_source_columns(
    datasource,
    db_table,
    ds_type: str,
    base_query: str,
) -> list[str]:
    cached = _extract_cached_source_columns(db_table)
    if cached:
        logger.debug(
            "Live schema cache HIT: ds=%s table=%s cols=%d",
            getattr(datasource, "id", "?"),
            getattr(db_table, "id", "?"),
            len(cached),
        )
        return cached
    inferred = _infer_source_columns(datasource, ds_type, base_query)
    if inferred:
        logger.debug(
            "Live schema cache MISS: inferred source columns for ds=%s table=%s cols=%d",
            getattr(datasource, "id", "?"),
            getattr(db_table, "id", "?"),
            len(inferred),
        )
        return inferred
    return _extract_cached_output_columns(db_table)


def build_live_base_query_plan(
    datasource,
    db_table,
    *,
    apply_type_overrides: bool = True,
    partition_days_ago: Optional[int] = None,
    bigquery_partition_meta: Optional[Dict[str, Any]] = None,
) -> LiveBaseQueryPlan:
    """Build the live-mode SELECT, including transforms and runtime type casts."""
    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    dialect = _dialect_for_ds_type(ds_type)
    base_query = _build_source_select_query(
        datasource,
        db_table,
        ds_type,
        dialect,
        partition_days_ago=partition_days_ago,
        bigquery_partition_meta=bigquery_partition_meta,
    )
    source_columns = _resolve_source_columns(datasource, db_table, ds_type, base_query)
    transformations = TransformationCompiler.normalize_server_transformations(
        getattr(db_table, "transformations", None) or []
    )
    compiled_sql = base_query
    output_columns = list(source_columns)
    if transformations:
        compiled_sql, output_columns = TransformationCompiler.compile_transformations(
            base_query,
            transformations,
            dialect=dialect,
            available_columns=source_columns or None,
        )

    normalized_overrides = normalize_type_overrides(
        getattr(db_table, "type_overrides", None) if apply_type_overrides else None
    )
    if normalized_overrides:
        projection_columns = list(output_columns or _extract_cached_output_columns(db_table))
        if projection_columns:
            compiled_sql = build_runtime_projection_query(
                compiled_sql,
                projection_columns,
                normalized_overrides,
                dialect,
            )
            output_columns = projection_columns
        elif dialect in ("duckdb", "bigquery"):
            compiled_sql = build_runtime_projection_query(
                compiled_sql,
                [],
                normalized_overrides,
                dialect,
            )

    return LiveBaseQueryPlan(
        sql=compiled_sql,
        source_columns=list(source_columns),
        output_columns=list(output_columns),
    )


# ── WHERE clause builder (dialect-aware) ─────────────────────────────────────

def _build_where_clause(filters: list, dialect: str) -> str:
    """Build a SQL WHERE clause from a list of {field, operator, value} dicts."""
    if not filters:
        return ""
    parts = []
    qi = _quote_identifier

    def value_present(value) -> bool:
        return value is not None and not (isinstance(value, str) and not value.strip())

    for f in normalize_filter_conditions(filters):
        field = f.get("field", "")
        op = normalize_filter_operator(f.get("operator"))
        value = f.get("value")
        if not field:
            continue
        calendar_field = str(f.get("calendarField") or f.get("calendar_field") or "").strip()
        calendar_source_field = str(
            f.get("calendarSourceField")
            or f.get("calendar_source_field")
            or field
        ).strip()
        qf = (
            build_calendar_filter_expression(calendar_field, calendar_source_field, dialect)
            if calendar_field
            else None
        ) or qi(field, dialect)
        if op == "eq":
            parts.append(f"{qf} = {_sql_literal(value)}")
        elif op == "neq":
            parts.append(f"{qf} != {_sql_literal(value)}")
        elif op == "gt":
            parts.append(f"{qf} > {_sql_literal(value)}")
        elif op == "gte":
            parts.append(f"{qf} >= {_sql_literal(value)}")
        elif op == "lt":
            parts.append(f"{qf} < {_sql_literal(value)}")
        elif op == "lte":
            parts.append(f"{qf} <= {_sql_literal(value)}")
        elif op == "between" and isinstance(value, list) and len(value) >= 2:
            lo, hi = value[0], value[1]
            if value_present(lo) and value_present(hi):
                parts.append(f"{qf} BETWEEN {_sql_literal(lo)} AND {_sql_literal(hi)}")
            elif value_present(lo):
                parts.append(f"{qf} >= {_sql_literal(lo)}")
            elif value_present(hi):
                parts.append(f"{qf} <= {_sql_literal(hi)}")
        elif op == "in" and isinstance(value, list):
            vals = ", ".join(_sql_literal(v) for v in value if value_present(v))
            if vals:
                parts.append(f"{qf} IN ({vals})")
        elif op == "in" and isinstance(value, str) and value:
            vals = ", ".join(
                _sql_literal(v.strip()) for v in value.split(",") if v.strip()
            )
            if vals:
                parts.append(f"{qf} IN ({vals})")
        elif op == "not_in" and isinstance(value, list):
            vals = ", ".join(_sql_literal(v) for v in value if value_present(v))
            if vals:
                parts.append(f"{qf} NOT IN ({vals})")
        elif op == "not_in" and isinstance(value, str) and value:
            vals = ", ".join(
                _sql_literal(v.strip()) for v in value.split(",") if v.strip()
            )
            if vals:
                parts.append(f"{qf} NOT IN ({vals})")
        elif op == "like" and value is not None:
            esc = str(value).replace("'", "''").replace("%", "\\%").replace("_", "\\_")
            parts.append(f"{qf} LIKE '%{esc}%' ESCAPE '\\'")
        elif op == "contains" and value is not None:
            esc = str(value).replace("'", "''").replace("%", "\\%").replace("_", "\\_")
            parts.append(f"{qf} LIKE '%{esc}%' ESCAPE '\\'")
        elif op == "not_contains" and value is not None:
            esc = str(value).replace("'", "''").replace("%", "\\%").replace("_", "\\_")
            parts.append(f"{qf} NOT LIKE '%{esc}%' ESCAPE '\\'")
        elif op == "starts_with" and value is not None:
            esc = str(value).replace("'", "''").replace("%", "\\%").replace("_", "\\_")
            parts.append(f"{qf} LIKE '{esc}%' ESCAPE '\\'")
        elif op == "is_null":
            parts.append(f"{qf} IS NULL")
        elif op == "is_not_null":
            parts.append(f"{qf} IS NOT NULL")
    return " AND ".join(parts)


# ── Aggregation query builder (dialect-aware) ────────────────────────────────

def build_live_agg_query(
    base_table: str,
    chart_type: str,
    role_config: dict,
    filters: list,
    dialect: str,
    limit_override: Optional[int] = None,
) -> Tuple[str, bool]:
    """
    Build an aggregation query for direct source execution.

    Returns (sql, pre_aggregated).
    Defaults stay conservative (chart 1000, TABLE/SCATTER 5000), while
    preview callers may request a higher limit up to a 5000-row server cap.
    """
    qi = _quote_identifier
    ctype = str(getattr(chart_type, "value", chart_type) or "").upper()
    role_config = normalize_chart_role_config(chart_type, role_config)
    row_order_alias = "__appbi_row_order"
    group_order_alias = "__appbi_group_order"
    quoted_row_order_alias = qi(row_order_alias, dialect)
    quoted_group_order_alias = qi(group_order_alias, dialect)

    def resolve_limit(default_limit: int) -> int:
        if limit_override is None:
            return default_limit
        return max(1, min(int(limit_override), 5000))

    where_clause = _build_where_clause(filters, dialect)
    where_sql = f" WHERE {where_clause}" if where_clause else ""

    if not role_config:
        limit = resolve_limit(500)
        return f"SELECT * FROM {base_table}{where_sql} LIMIT {int(limit)}", False

    dimension = role_config.get("dimension")
    time_field = role_config.get("timeField")
    metrics = role_config.get("metrics") or []
    breakdown = role_config.get("breakdown")
    line_metric = role_config.get("lineMetric")
    benchmark_metric = role_config.get("benchmarkMetric")
    table_mode = role_config.get("tableMode")
    table_row_dimension = role_config.get("tableRowDimension")
    table_column_dimension = role_config.get("tableColumnDimension")
    table_pivot_metric = role_config.get("tablePivotMetric")
    selected_cols = role_config.get("selectedColumns")

    # TABLE: capped at 5000 rows
    if ctype == "TABLE":
        if (
            table_mode == "pivot"
            and table_row_dimension
            and table_column_dimension
            and table_row_dimension != table_column_dimension
            and isinstance(table_pivot_metric, dict)
            and table_pivot_metric.get("field")
        ):
            metric_field = str(table_pivot_metric.get("field"))
            metric_agg = str(table_pivot_metric.get("agg") or "sum").upper().replace(" ", "_")
            quoted_metric_field = qi(metric_field, dialect)
            quoted_alias = qi(f"{metric_agg.lower()}__{metric_field}", dialect)

            if metric_agg == "COUNT_DISTINCT":
                metric_sql = f"COUNT(DISTINCT {quoted_metric_field}) AS {quoted_alias}"
            elif metric_agg in ("COUNT", "AVG", "MIN", "MAX", "SUM"):
                metric_sql = f"{metric_agg}({quoted_metric_field}) AS {quoted_alias}"
            else:
                metric_sql = f"SUM({quoted_metric_field}) AS {quoted_alias}"

            limit = resolve_limit(5000)
            ordered_base_table = (
                f"(SELECT *, ROW_NUMBER() OVER () AS {quoted_row_order_alias} "
                f"FROM {base_table}) AS _appbi_ordered"
            )
            inner_sql = (
                f"SELECT {qi(table_row_dimension, dialect)}, {qi(table_column_dimension, dialect)}, {metric_sql}, "
                f"MIN({quoted_row_order_alias}) AS {quoted_group_order_alias} "
                f"FROM {ordered_base_table}{where_sql} "
                f"GROUP BY {qi(table_row_dimension, dialect)}, {qi(table_column_dimension, dialect)}"
            )
            return (
                f"SELECT {qi(table_row_dimension, dialect)}, {qi(table_column_dimension, dialect)}, {quoted_alias} "
                f"FROM ({inner_sql}) AS _appbi_pivot "
                f"ORDER BY {quoted_group_order_alias} ASC "
                f"LIMIT {int(limit)}",
                True,
            )

        cols = ", ".join(qi(c, dialect) for c in selected_cols) if selected_cols else "*"
        limit = resolve_limit(5000)
        return f"SELECT {cols} FROM {base_table}{where_sql} LIMIT {int(limit)}", True

    # SCATTER: raw points up to 5000
    if ctype == "SCATTER":
        sx, sy = role_config.get("scatterX"), role_config.get("scatterY")
        limit = resolve_limit(5000)
        if sx and sy:
            return (
                f"SELECT {qi(sx, dialect)}, {qi(sy, dialect)} FROM {base_table}{where_sql} LIMIT {int(limit)}",
                True,
            )
        return f"SELECT * FROM {base_table}{where_sql} LIMIT {int(limit)}", True

    # All other types: GROUP BY aggregation (required for live mode)
    group_field = dimension or time_field
    if not metrics:
        # For live mode, reject charts without aggregation (except TABLE/SCATTER)
        raise ValueError(
            "Charts on large tables require at least one metric (aggregation). "
            "Please add a SUM, COUNT, AVG, MIN or MAX measure."
        )
    metric_defs = list(metrics)
    if ctype == "BAR_LINE" and line_metric:
        metric_defs.append(line_metric)
    if ctype == "KPI" and benchmark_metric:
        metric_defs.append(benchmark_metric)

    select_parts = []
    group_by_parts = []
    output_columns = []

    if group_field:
        quoted_group_field = qi(group_field, dialect)
        select_parts.append(quoted_group_field)
        group_by_parts.append(quoted_group_field)
        output_columns.append(quoted_group_field)
    if breakdown and ctype != "BAR_LINE":
        quoted_breakdown = qi(breakdown, dialect)
        select_parts.append(quoted_breakdown)
        group_by_parts.append(quoted_breakdown)
        output_columns.append(quoted_breakdown)

    seen_metric_aliases: set[str] = set()
    for m in metric_defs:
        field = m.get("field", "")
        agg = (m.get("agg") or "sum").upper().replace(" ", "_")
        if not field:
            continue
        qf = qi(field, dialect)
        alias_name = f"{agg.lower()}__{field}"
        if alias_name in seen_metric_aliases:
            continue
        seen_metric_aliases.add(alias_name)
        alias = qi(alias_name, dialect)
        output_columns.append(alias)
        if agg == "COUNT_DISTINCT":
            select_parts.append(f"COUNT(DISTINCT {qf}) AS {alias}")
        elif agg in ("COUNT", "AVG", "MIN", "MAX", "SUM"):
            select_parts.append(f"{agg}({qf}) AS {alias}")
        else:
            select_parts.append(f"SUM({qf}) AS {alias}")

    if not select_parts:
        raise ValueError("No valid metrics specified for aggregation.")

    source_table = (
        f"(SELECT *, ROW_NUMBER() OVER () AS {quoted_row_order_alias} FROM {base_table}) AS _appbi_ordered"
        if group_by_parts
        else base_table
    )
    sql = f"SELECT {', '.join(select_parts)}"
    if group_by_parts:
        sql += f", MIN({quoted_row_order_alias}) AS {quoted_group_order_alias}"
    sql += f" FROM {source_table}{where_sql}"
    if group_by_parts:
        sql += f" GROUP BY {', '.join(group_by_parts)}"
    if group_by_parts:
        sql = (
            f"SELECT {', '.join(output_columns)} "
            f"FROM ({sql}) AS _appbi_grouped "
            f"ORDER BY {quoted_group_order_alias} ASC"
        )

    # Stricter limit for live queries
    limit = resolve_limit(1000)
    sql += f" LIMIT {int(limit)}"
    return sql, True


def build_live_dataset_query(
    base_table: str,
    dimensions: list[str],
    measures: list[dict],
    filters: list,
    order_by: list[dict],
    limit: int,
    dialect: str,
) -> str:
    """Build a dataset execute query that mirrors the synced DuckDB path."""
    qi = _quote_identifier
    dims = [d for d in (dimensions or []) if d]
    metrics = [m for m in (measures or []) if m.get("field")]
    orders = [o for o in (order_by or []) if o.get("field")]
    row_order_alias = "__appbi_row_order"
    group_order_alias = "__appbi_group_order"
    quoted_row_order_alias = qi(row_order_alias, dialect)
    quoted_group_order_alias = qi(group_order_alias, dialect)

    select_parts: list[str] = []
    group_by_parts: list[str] = []
    measure_aliases: dict[str, str] = {}
    output_columns: list[str] = []

    for dim in dims:
        quoted_dim = qi(dim, dialect)
        select_parts.append(quoted_dim)
        group_by_parts.append(quoted_dim)
        output_columns.append(quoted_dim)

    for metric in metrics:
        field = metric.get("field", "")
        agg = (metric.get("agg") or metric.get("function") or "sum").upper().replace(" ", "_")
        if not field:
            continue

        quoted_field = qi(field, dialect)
        alias_name = f"{field}_{agg.lower()}"
        alias = qi(alias_name, dialect)
        measure_aliases[alias_name] = alias
        output_columns.append(alias)

        if agg == "COUNT_DISTINCT":
            select_parts.append(f"COUNT(DISTINCT {quoted_field}) AS {alias}")
        elif agg in ("COUNT", "AVG", "MIN", "MAX", "SUM"):
            select_parts.append(f"{agg}({quoted_field}) AS {alias}")
        else:
            select_parts.append(f"SUM({quoted_field}) AS {alias}")

    if not select_parts:
        select_parts.append("*")

    where_clause = _build_where_clause(filters, dialect)
    where_sql = f" WHERE {where_clause}" if where_clause else ""

    preserve_group_order = bool(dims and metrics and not orders)
    source_table = (
        f"(SELECT *, ROW_NUMBER() OVER () AS {quoted_row_order_alias} FROM {base_table}) AS _appbi_ordered"
        if preserve_group_order
        else base_table
    )
    sql = f"SELECT {', '.join(select_parts)}"
    if preserve_group_order:
        sql += f", MIN({quoted_row_order_alias}) AS {quoted_group_order_alias}"
    sql += f" FROM {source_table}{where_sql}"

    if dims and metrics:
        sql += f" GROUP BY {', '.join(group_by_parts)}"

    if orders:
        order_parts: list[str] = []
        for order in orders:
            field = order.get("field", "")
            direction = str(order.get("direction") or "DESC").upper()
            direction = direction if direction in ("ASC", "DESC") else "DESC"

            if field in measure_aliases:
                quoted_order = measure_aliases[field]
            else:
                quoted_order = qi(field, dialect)

            order_parts.append(f"{quoted_order} {direction}")

        if order_parts:
            sql += f" ORDER BY {', '.join(order_parts)}"
    elif preserve_group_order:
        sql = (
            f"SELECT {', '.join(output_columns)} "
            f"FROM ({sql}) AS _appbi_grouped "
            f"ORDER BY {quoted_group_order_alias} ASC"
        )

    sql += f" LIMIT {int(limit)}"
    return sql


# ── BigQuery cost guard ──────────────────────────────────────────────────────

def _estimate_bigquery_bytes(config: dict, sql: str) -> int:
    """Dry-run a BigQuery query to get estimated bytes processed. Returns 0 on error."""
    try:
        from google.cloud import bigquery
        from app.services.datasource_service import _build_bigquery_client

        client = _build_bigquery_client(config)
        try:
            job_config = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
            query_job = client.query(sql, job_config=job_config)
            return query_job.total_bytes_processed or 0
        finally:
            client.close()
    except Exception as e:
        logger.warning("BigQuery dry-run failed (proceeding anyway): %s", e)
        return 0


def _get_bigquery_earliest_partition_date(
    config: dict,
    source_table_name: str,
) -> Optional[dt_date]:
    """Backward-compatible wrapper for callers needing only the earliest partition date."""
    return _get_bigquery_partition_metadata(config, source_table_name).get("earliest_partition_date")


def _build_preview_sql(base_sql: str, limit: int, offset: int,
                       filters: list | None = None, dialect: str = "postgresql") -> str:
    where = _build_where_clause(filters or [], dialect)
    inner = f"SELECT * FROM ({base_sql}) AS _appbi_live"
    if where:
        inner += f" WHERE {where}"
    sql = f"{inner} LIMIT {int(limit)}"
    if offset:
        sql += f" OFFSET {int(offset)}"
    return sql


# ── Main execution entry point ───────────────────────────────────────────────

class LiveQueryService:
    """Execute aggregated chart queries directly against source databases."""

    @staticmethod
    def execute_preview_query(
        datasource,
        db_table,
        limit: int = 100,
        offset: int = 0,
        filters: list | None = None,
    ) -> Dict[str, Any]:
        """Preview dataset rows directly from the source with cache + cost guard."""
        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        dialect = "bigquery" if ds_type == "bigquery" else "postgresql"
        cache_enabled = _should_cache_live_query(ds_type)

        from app.core.crypto import decrypt_config
        config = decrypt_config(datasource.config)
        table_identifier = build_dataset_table_cache_identifier(db_table)
        limit = min(max(int(limit or 100), 1), 1000)
        offset = max(int(offset or 0), 0)

        cache_payload = {
            "limit": limit,
            "offset": offset,
            "filters": [f if isinstance(f, dict) else f.dict() for f in (filters or [])],
            "transformations": getattr(db_table, "transformations", None) or [],
            "type_overrides": normalize_type_overrides(getattr(db_table, "type_overrides", None)),
        }
        if cache_enabled:
            cached = query_cache.get_cached(
                datasource.id,
                table_identifier,
                "dataset_preview",
                cache_payload,
                [],
            )
            if cached is not None:
                return cached

        from app.services.datasource_service import DataSourceConnectionService

        if (
            ds_type == "bigquery"
            and getattr(db_table, "source_kind", None) == "physical_table"
            and getattr(db_table, "source_table_name", None)
        ):
            partition_metadata = _get_bigquery_partition_metadata(
                config,
                db_table.source_table_name,
            )
            earliest_partition_date = partition_metadata.get("earliest_partition_date")
            if partition_metadata.get("has_supported_partitioning") and earliest_partition_date is not None:
                max_lookback_days = max(
                    0,
                    (datetime.utcnow().date() - earliest_partition_date).days,
                )
            elif partition_metadata.get("has_supported_partitioning"):
                max_lookback_days = max(
                    int(settings.BQ_PREVIEW_PARTITION_MAX_LOOKBACK_DAYS or 0),
                    0,
                )
            else:
                max_lookback_days = None

            result: Dict[str, Any] | None = None
            if max_lookback_days is not None:
                partition_target = _describe_bigquery_partition_target(partition_metadata)
                for partition_days_ago in range(max_lookback_days + 1):
                    plan = build_live_base_query_plan(
                        datasource,
                        db_table,
                        apply_type_overrides=True,
                        partition_days_ago=partition_days_ago,
                        bigquery_partition_meta=partition_metadata,
                    )
                    filter_dicts = [f if isinstance(f, dict) else f.dict() for f in (filters or [])]
                    sql = _build_preview_sql(plan.sql, limit, offset, filter_dicts, dialect)
                    estimated_bytes = _estimate_bigquery_bytes(config, sql)
                    max_bytes = settings.BQ_MAX_BYTES_SCANNED
                    if estimated_bytes > max_bytes:
                        gb_est = estimated_bytes / (1024**3)
                        gb_max = max_bytes / (1024**3)
                        raise ValueError(
                            f"Preview would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                            "Reduce selected columns or narrow the recent partition window."
                        )

                    columns, rows, execution_time_ms = DataSourceConnectionService.execute_query(
                        ds_type,
                        datasource.config,
                        sql,
                        timeout_seconds=60,
                        skip_bigquery_cost_check=True,
                    )
                    result = {
                        "columns": columns,
                        "rows": rows,
                        "execution_time_ms": round(execution_time_ms, 1),
                        "source_columns": plan.source_columns,
                        "output_columns": plan.output_columns,
                        "partition_days_ago": partition_days_ago,
                        "partition_target": partition_target,
                    }
                    if len(rows) >= limit or partition_days_ago >= max_lookback_days:
                        break

                    logger.info(
                        "BigQuery preview widened to %d day(s) on %s for ds=%d table=%s offset=%d rows=%d/%d",
                        partition_days_ago + 2,
                        partition_target,
                        datasource.id,
                        table_identifier,
                        offset,
                        len(rows),
                        limit,
                    )

            if result is None:
                plan = build_live_base_query_plan(
                    datasource,
                    db_table,
                    apply_type_overrides=True,
                )
                filter_dicts = [f if isinstance(f, dict) else f.dict() for f in (filters or [])]
                sql = _build_preview_sql(plan.sql, limit, offset, filter_dicts, dialect)
                estimated_bytes = _estimate_bigquery_bytes(config, sql)
                max_bytes = settings.BQ_MAX_BYTES_SCANNED
                if estimated_bytes > max_bytes:
                    gb_est = estimated_bytes / (1024**3)
                    gb_max = max_bytes / (1024**3)
                    raise ValueError(
                        f"Preview would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                        "Reduce selected columns or narrow the source query."
                    )

                columns, rows, execution_time_ms = DataSourceConnectionService.execute_query(
                    ds_type,
                    datasource.config,
                    sql,
                    timeout_seconds=60,
                    skip_bigquery_cost_check=True,
                )
                result = {
                    "columns": columns,
                    "rows": rows,
                    "execution_time_ms": round(execution_time_ms, 1),
                    "source_columns": plan.source_columns,
                    "output_columns": plan.output_columns,
                    "partition_days_ago": None,
                    "partition_target": "unpartitioned",
                }
        else:
            plan = build_live_base_query_plan(datasource, db_table, apply_type_overrides=True)
            filter_dicts = [f if isinstance(f, dict) else f.dict() for f in (filters or [])]
            sql = _build_preview_sql(plan.sql, limit, offset, filter_dicts, dialect)

            if ds_type == "bigquery":
                estimated_bytes = _estimate_bigquery_bytes(config, sql)
                max_bytes = settings.BQ_MAX_BYTES_SCANNED
                if estimated_bytes > max_bytes:
                    gb_est = estimated_bytes / (1024**3)
                    gb_max = max_bytes / (1024**3)
                    raise ValueError(
                        f"Preview would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                        "Reduce selected columns or switch to a narrower SQL source."
                    )

            columns, rows, execution_time_ms = DataSourceConnectionService.execute_query(
                ds_type,
                datasource.config,
                sql,
                timeout_seconds=60 if ds_type == "bigquery" else 30,
                skip_bigquery_cost_check=True,
            )
            result = {
                "columns": columns,
                "rows": rows,
                "execution_time_ms": round(execution_time_ms, 1),
                "source_columns": plan.source_columns,
                "output_columns": plan.output_columns,
            }
        if cache_enabled:
            query_cache.set_cached(
                datasource.id,
                table_identifier,
                "dataset_preview",
                cache_payload,
                [],
                result,
            )
        return result

    @staticmethod
    def execute_chart_query(
        datasource,
        db_table,
        chart_type: str,
        role_config: dict,
        filters: list,
        extra_filters: list | None = None,
        limit_override: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Execute a chart query against the live source database.

        Returns: {data: List[Dict], pre_aggregated: bool, execution_time_ms: float}

        Raises:
            ValueError: if chart lacks required aggregation or cost guard triggers.
        """
        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        cache_enabled = _should_cache_live_query(ds_type)

        from app.core.crypto import decrypt_config
        config = decrypt_config(datasource.config)

        # Merge stored filters + extra dashboard filters
        all_filters = list(filters or [])
        if extra_filters:
            all_filters.extend(extra_filters)
        all_filters = normalize_filter_conditions(all_filters)
        normalized_role_config = normalize_chart_role_config(chart_type, role_config)

        table_identifier = build_dataset_table_cache_identifier(db_table)
        plan = build_live_base_query_plan(datasource, db_table, apply_type_overrides=True)
        base_table = f"({plan.sql}) AS _appbi_live"
        cache_role_config = {
            **normalized_role_config,
            "_transformations": getattr(db_table, "transformations", None) or [],
            "_type_overrides": normalize_type_overrides(getattr(db_table, "type_overrides", None)),
        }

        # Check cache first
        if cache_enabled:
            cached = query_cache.get_cached(
                datasource.id, table_identifier, chart_type, cache_role_config, all_filters
            )
            if cached is not None:
                return cached

        # Build aggregation SQL
        sql, pre_aggregated = build_live_agg_query(
            base_table, chart_type, normalized_role_config, all_filters, dialect, limit_override=limit_override
        )

        # BigQuery cost guard
        if ds_type == "bigquery":
            estimated_bytes = _estimate_bigquery_bytes(config, sql)
            max_bytes = settings.BQ_MAX_BYTES_SCANNED
            if estimated_bytes > max_bytes:
                gb_est = estimated_bytes / (1024**3)
                gb_max = max_bytes / (1024**3)
                raise ValueError(
                    f"Query would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                    f"Add filters (e.g. date range) to reduce the data scanned."
                )
            if estimated_bytes > 0:
                logger.info(
                    "BigQuery dry-run: %.2f GB for ds=%d table=%s",
                    estimated_bytes / (1024**3),
                    datasource.id,
                    table_identifier,
                )

        # Execute query against the source
        from app.services.datasource_service import DataSourceConnectionService

        start_time = time.time()

        if ds_type == "bigquery":
            timeout = 60
        else:
            timeout = 30

        _, rows, execution_time_ms = DataSourceConnectionService.execute_query(
            ds_type,
            datasource.config,
            sql,
            timeout_seconds=timeout,
            skip_bigquery_cost_check=True,
        )

        execution_time_ms = (time.time() - start_time) * 1000

        result = {
            "data": rows,
            "pre_aggregated": pre_aggregated,
            "execution_time_ms": round(execution_time_ms, 1),
        }

        # Store in cache
        if cache_enabled:
            query_cache.set_cached(
                datasource.id, table_identifier, chart_type, cache_role_config, all_filters, result
            )

        logger.info(
            "Live query executed: ds=%d, table=%s, chart_type=%s, rows=%d, time=%.0fms",
            datasource.id,
            table_identifier,
            chart_type,
            len(rows),
            execution_time_ms,
        )

        return result

    @staticmethod
    def execute_chart_query_from_sql(
        datasource,
        chart_type: str,
        role_config: dict,
        filters: list,
        sql_query: str,
        extra_filters: list | None = None,
        limit_override: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Execute a chart query where the chart source is a custom SQL statement.

        The chart role config still applies on top of the SQL output columns.
        """
        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        cache_enabled = _should_cache_live_query(ds_type)

        from app.core.crypto import decrypt_config
        from app.services.datasource_service import DataSourceConnectionService

        config = decrypt_config(datasource.config)
        validate_select_only(sql_query)
        normalized_sql_query = sql_query.strip().rstrip(";").rstrip()

        all_filters = list(filters or [])
        if extra_filters:
            all_filters.extend(extra_filters)
        all_filters = normalize_filter_conditions(all_filters)
        normalized_role_config = normalize_chart_role_config(chart_type, role_config)
        normalized_chart_type = str(getattr(chart_type, "value", chart_type) or "").upper()

        if normalized_chart_type not in {"TABLE", "SCATTER"} and not (normalized_role_config.get("metrics") or []):
            raise ValueError(
                "Choose at least one value column from your SQL output before previewing this chart."
            )

        source_hash = hashlib.sha1(normalized_sql_query.encode("utf-8")).hexdigest()[:16]
        table_identifier = f"custom_sql::{source_hash}"
        cache_role_config = {
            **normalized_role_config,
            "_source_sql": normalized_sql_query,
        }

        if cache_enabled:
            cached = query_cache.get_cached(
                datasource.id,
                table_identifier,
                chart_type,
                cache_role_config,
                all_filters,
            )
            if cached is not None:
                return cached

        base_table = f"({normalized_sql_query}) AS _appbi_live"
        sql, pre_aggregated = build_live_agg_query(
            base_table,
            chart_type,
            normalized_role_config,
            all_filters,
            dialect,
            limit_override=limit_override,
        )

        if ds_type == "bigquery":
            estimated_bytes = _estimate_bigquery_bytes(config, sql)
            max_bytes = settings.BQ_MAX_BYTES_SCANNED
            if estimated_bytes > max_bytes:
                gb_est = estimated_bytes / (1024**3)
                gb_max = max_bytes / (1024**3)
                raise ValueError(
                    f"Query would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                    "Add filters or narrow the custom SQL."
                )
            if estimated_bytes > 0:
                logger.info(
                    "BigQuery dry-run for custom chart SQL: %.2f GB for ds=%d",
                    estimated_bytes / (1024**3),
                    datasource.id,
                )

        start_time = time.time()
        timeout = 60 if ds_type == "bigquery" else 30

        _, rows, execution_time_ms = DataSourceConnectionService.execute_query(
            ds_type,
            datasource.config,
            sql,
            timeout_seconds=timeout,
            skip_bigquery_cost_check=True,
        )

        execution_time_ms = (time.time() - start_time) * 1000

        result = {
            "data": rows,
            "pre_aggregated": pre_aggregated,
            "execution_time_ms": round(execution_time_ms, 1),
        }

        if cache_enabled:
            query_cache.set_cached(
                datasource.id,
                table_identifier,
                chart_type,
                cache_role_config,
                all_filters,
                result,
            )

        logger.info(
            "Live custom chart query executed: ds=%d, chart_type=%s, rows=%d, time=%.0fms",
            datasource.id,
            chart_type,
            len(rows),
            execution_time_ms,
        )

        return result

    @staticmethod
    def execute_dataset_query(
        datasource,
        db_table,
        dimensions: list[str] | None,
        measures: list[dict] | None,
        filters: list | None,
        order_by: list[dict] | None = None,
        limit: int = 1000,
    ) -> list[dict]:
        """Execute dataset table query directly against the live source."""
        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)
        cache_enabled = _should_cache_live_query(ds_type)

        from app.core.crypto import decrypt_config
        config = decrypt_config(datasource.config)

        table_identifier = build_dataset_table_cache_identifier(db_table)
        plan = build_live_base_query_plan(datasource, db_table, apply_type_overrides=True)
        base_table = f"({plan.sql}) AS _appbi_live"
        normalized_filters = normalize_filter_conditions(list(filters or []))
        cache_payload = {
            "dimensions": list(dimensions or []),
            "measures": list(measures or []),
            "order_by": list(order_by or []),
            "limit": int(limit),
            "transformations": getattr(db_table, "transformations", None) or [],
            "type_overrides": normalize_type_overrides(getattr(db_table, "type_overrides", None)),
        }
        if cache_enabled:
            cached = query_cache.get_cached(
                datasource.id,
                table_identifier,
                "dataset_execute",
                cache_payload,
                normalized_filters,
            )
            if cached is not None:
                return list(cached.get("rows") or [])

        sql = build_live_dataset_query(
            base_table=base_table,
            dimensions=list(dimensions or []),
            measures=list(measures or []),
            filters=normalized_filters,
            order_by=list(order_by or []),
            limit=limit,
            dialect=dialect,
        )

        if ds_type == "bigquery":
            estimated_bytes = _estimate_bigquery_bytes(config, sql)
            max_bytes = settings.BQ_MAX_BYTES_SCANNED
            if estimated_bytes > max_bytes:
                gb_est = estimated_bytes / (1024**3)
                gb_max = max_bytes / (1024**3)
                raise ValueError(
                    f"Query would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                    f"Add filters (e.g. date range) to reduce the data scanned."
                )

        from app.services.datasource_service import DataSourceConnectionService

        timeout = 60 if ds_type == "bigquery" else 30
        _, rows, _ = DataSourceConnectionService.execute_query(
            ds_type,
            datasource.config,
            sql,
            timeout_seconds=timeout,
            skip_bigquery_cost_check=True,
        )
        if cache_enabled:
            query_cache.set_cached(
                datasource.id,
                table_identifier,
                "dataset_execute",
                cache_payload,
                normalized_filters,
                {"rows": rows},
            )
        return rows

    @staticmethod
    def get_table_size_metadata(
        ds_type: str,
        config: dict,
        schema_name: str,
        table_name: str,
    ) -> Dict[str, Any]:
        """
        Query source metadata for table size (row count & bytes).
        Uses INFORMATION_SCHEMA or pg_class — no data scan cost.

        Returns: {estimated_row_count: int|None, estimated_size_bytes: int|None}
        """
        from app.core.crypto import decrypt_config
        decrypted = decrypt_config(config)

        ds_type_val = ds_type if isinstance(ds_type, str) else ds_type.value

        try:
            if ds_type_val == "bigquery":
                return _get_bigquery_table_size(decrypted, schema_name, table_name)
            elif ds_type_val == "postgresql":
                return _get_postgresql_table_size(decrypted, schema_name, table_name)
            elif ds_type_val == "mysql":
                return _get_mysql_table_size(decrypted, schema_name, table_name)
            else:
                # Google Sheets, Manual — always small
                return {"estimated_row_count": None, "estimated_size_bytes": None}
        except Exception as e:
            logger.warning("Failed to get table size for %s.%s: %s", schema_name, table_name, e)
            return {"estimated_row_count": None, "estimated_size_bytes": None}

    @staticmethod
    def should_use_live_mode(
        estimated_row_count: Optional[int],
        estimated_size_bytes: Optional[int],
    ) -> bool:
        """Check if a table exceeds the threshold for live query mode."""
        if estimated_row_count and estimated_row_count > settings.LARGE_TABLE_ROW_THRESHOLD:
            return True
        if estimated_size_bytes:
            threshold_bytes = int(settings.LARGE_TABLE_SIZE_THRESHOLD_GB * 1024**3)
            if estimated_size_bytes > threshold_bytes:
                return True
        return False


# ── Size metadata helpers per database ────────────────────────────────────────

def _get_bigquery_table_size(config: dict, schema_name: str, table_name: str) -> Dict[str, Any]:
    """Use BigQuery client API (get_table) for safe metadata lookup — no SQL injection risk."""
    from app.services.datasource_service import _build_bigquery_client

    project_id = config.get("project_id", "")

    client = _build_bigquery_client(config)
    try:
        # Use the safe client API instead of SQL string interpolation
        table_ref = f"{project_id}.{schema_name}.{table_name}"
        table = client.get_table(table_ref)
        return {
            "estimated_row_count": int(table.num_rows) if table.num_rows is not None else None,
            "estimated_size_bytes": int(table.num_bytes) if table.num_bytes is not None else None,
        }
    except Exception:
        return {"estimated_row_count": None, "estimated_size_bytes": None}
    finally:
        client.close()


def _get_postgresql_table_size(config: dict, schema_name: str, table_name: str) -> Dict[str, Any]:
    """Use pg_class.reltuples for fast row estimates."""
    import psycopg2

    conn = psycopg2.connect(
        host=config.get("host", "localhost"),
        port=config.get("port", 5432),
        user=config.get("username") or config.get("user", ""),
        password=config.get("password", ""),
        dbname=config.get("database", ""),
        connect_timeout=10,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT c.reltuples::bigint AS row_estimate,
                       pg_total_relation_size(c.oid) AS size_bytes
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s
                LIMIT 1
                """,
                (schema_name or "public", table_name),
            )
            row = cur.fetchone()
            if row:
                return {
                    "estimated_row_count": max(0, int(row[0])) if row[0] else None,
                    "estimated_size_bytes": int(row[1]) if row[1] else None,
                }
        return {"estimated_row_count": None, "estimated_size_bytes": None}
    finally:
        conn.close()


def _get_mysql_table_size(config: dict, schema_name: str, table_name: str) -> Dict[str, Any]:
    """Use INFORMATION_SCHEMA.TABLES for row/size estimates."""
    import pymysql

    conn = pymysql.connect(
        host=config.get("host", "localhost"),
        port=int(config.get("port", 3306)),
        user=config.get("username") or config.get("user", ""),
        password=config.get("password", ""),
        database=config.get("database", schema_name),
        connect_timeout=10,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT TABLE_ROWS, DATA_LENGTH
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
                LIMIT 1
                """,
                (schema_name or config.get("database", ""), table_name),
            )
            row = cur.fetchone()
            if row:
                return {
                    "estimated_row_count": int(row[0]) if row[0] else None,
                    "estimated_size_bytes": int(row[1]) if row[1] else None,
                }
        return {"estimated_row_count": None, "estimated_size_bytes": None}
    finally:
        conn.close()
