"""
LiveQueryService — execute aggregated chart queries directly against source databases.

Used for tables with query_mode="live" (large data) to avoid syncing
hundreds of millions of rows to local DuckDB.

Dialect-aware SQL generation for BigQuery, PostgreSQL, MySQL.
Includes dry-run cost guard for BigQuery.
"""
from __future__ import annotations

import json
import time
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
    }.get(ds_type_val, "postgresql")


def _build_base_table_ref(
    ds_type: str,
    config: dict,
    source_table_name: str,
    dialect: str,
) -> str:
    """Build a fully-qualified table reference for the target database."""
    stn = source_table_name.strip().strip('"').strip("'")

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

    if "." in stn:
        schema, table = stn.split(".", 1)
        schema = schema.strip('"').strip("'")
        table = table.strip('"').strip("'")
        qi = _quote_identifier
        return f"{qi(schema, dialect)}.{qi(table, dialect)}"

    return _quote_identifier(stn, dialect)


def _build_source_select_query(
    datasource,
    db_table,
    ds_type: str,
    dialect: str,
) -> str:
    """Build the raw source SELECT used before dataset transformations."""
    table_identifier = db_table.source_table_name or db_table.display_name
    if db_table.source_kind == "sql_query" and db_table.source_query:
        validate_select_only(db_table.source_query)
        return f"SELECT * FROM ({db_table.source_query}) AS _source"
    base_ref = _build_base_table_ref(ds_type, datasource.config, table_identifier, dialect)
    return f"SELECT * FROM {base_ref}"


def _source_signature(db_table) -> Dict[str, Any]:
    return {
        "source_kind": getattr(db_table, "source_kind", None),
        "source_table_name": getattr(db_table, "source_table_name", None),
        "source_query": getattr(db_table, "source_query", None),
    }


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
) -> LiveBaseQueryPlan:
    """Build the live-mode SELECT, including transforms and runtime type casts."""
    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    dialect = _dialect_for_ds_type(ds_type)
    base_query = _build_source_select_query(datasource, db_table, ds_type, dialect)
    source_columns = _resolve_source_columns(datasource, db_table, ds_type, base_query)
    transformations = [
        t for t in (getattr(db_table, "transformations", None) or [])
        if t.get("enabled", True) and t.get("type") != "js_formula"
    ]
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
    for f in normalize_filter_conditions(filters):
        field = f.get("field", "")
        op = normalize_filter_operator(f.get("operator"))
        value = f.get("value")
        if not field:
            continue
        qf = qi(field, dialect)
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
            if lo and hi:
                parts.append(f"{qf} BETWEEN {_sql_literal(lo)} AND {_sql_literal(hi)}")
            elif lo:
                parts.append(f"{qf} >= {_sql_literal(lo)}")
            elif hi:
                parts.append(f"{qf} <= {_sql_literal(hi)}")
        elif op == "in" and isinstance(value, list):
            vals = ", ".join(_sql_literal(v) for v in value)
            parts.append(f"{qf} IN ({vals})")
        elif op == "in" and isinstance(value, str) and value:
            vals = ", ".join(
                _sql_literal(v.strip()) for v in value.split(",") if v.strip()
            )
            if vals:
                parts.append(f"{qf} IN ({vals})")
        elif op == "not_in" and isinstance(value, list):
            vals = ", ".join(_sql_literal(v) for v in value)
            parts.append(f"{qf} NOT IN ({vals})")
        elif op == "not_in" and isinstance(value, str) and value:
            vals = ", ".join(
                _sql_literal(v.strip()) for v in value.split(",") if v.strip()
            )
            if vals:
                parts.append(f"{qf} NOT IN ({vals})")
        elif op == "like" and value is not None:
            esc = str(value).replace("'", "''")
            parts.append(f"{qf} LIKE '%{esc}%'")
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
    Stricter limits than DuckDB path: chart ≤ 1000, TABLE ≤ 5000, SCATTER ≤ 5000.
    """
    qi = _quote_identifier
    ctype = str(getattr(chart_type, "value", chart_type) or "").upper()
    role_config = normalize_chart_role_config(chart_type, role_config)

    where_clause = _build_where_clause(filters, dialect)
    where_sql = f" WHERE {where_clause}" if where_clause else ""

    if not role_config:
        limit = limit_override or 500
        return f"SELECT * FROM {base_table}{where_sql} LIMIT {int(limit)}", False

    dimension = role_config.get("dimension")
    time_field = role_config.get("timeField")
    metrics = role_config.get("metrics") or []
    breakdown = role_config.get("breakdown")
    line_metric = role_config.get("lineMetric")
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

            limit = limit_override or 5000
            return (
                f"SELECT {qi(table_row_dimension, dialect)}, {qi(table_column_dimension, dialect)}, {metric_sql} "
                f"FROM {base_table}{where_sql} "
                f"GROUP BY {qi(table_row_dimension, dialect)}, {qi(table_column_dimension, dialect)} "
                f"ORDER BY {qi(table_row_dimension, dialect)} ASC, {qi(table_column_dimension, dialect)} ASC "
                f"LIMIT {int(limit)}",
                True,
            )

        cols = ", ".join(qi(c, dialect) for c in selected_cols) if selected_cols else "*"
        limit = limit_override or 5000
        return f"SELECT {cols} FROM {base_table}{where_sql} LIMIT {int(limit)}", True

    # SCATTER: raw points up to 5000
    if ctype == "SCATTER":
        sx, sy = role_config.get("scatterX"), role_config.get("scatterY")
        limit = limit_override or 5000
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

    select_parts = []
    group_by_parts = []

    if group_field:
        select_parts.append(qi(group_field, dialect))
        group_by_parts.append(qi(group_field, dialect))
    if breakdown and ctype != "BAR_LINE":
        select_parts.append(qi(breakdown, dialect))
        group_by_parts.append(qi(breakdown, dialect))

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
        if agg == "COUNT_DISTINCT":
            select_parts.append(f"COUNT(DISTINCT {qf}) AS {alias}")
        elif agg in ("COUNT", "AVG", "MIN", "MAX", "SUM"):
            select_parts.append(f"{agg}({qf}) AS {alias}")
        else:
            select_parts.append(f"SUM({qf}) AS {alias}")

    if not select_parts:
        raise ValueError("No valid metrics specified for aggregation.")

    sql = f"SELECT {', '.join(select_parts)} FROM {base_table}{where_sql}"
    if group_by_parts:
        sql += f" GROUP BY {', '.join(group_by_parts)}"

    # ORDER BY first metric DESC
    first_metric_alias = None
    for m in metrics:
        field = m.get("field", "")
        agg = (m.get("agg") or "sum").upper().replace(" ", "_")
        if not field:
            continue
        alias_name = f"{agg.lower()}__{field}"
        first_metric_alias = qi(alias_name, dialect)
        break

    if first_metric_alias and group_by_parts:
        sql += f" ORDER BY {first_metric_alias} DESC"

    # Stricter limit for live queries
    limit = limit_override or 1000
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

    select_parts: list[str] = []
    group_by_parts: list[str] = []
    measure_aliases: dict[str, str] = {}

    for dim in dims:
        quoted_dim = qi(dim, dialect)
        select_parts.append(quoted_dim)
        group_by_parts.append(quoted_dim)

    for metric in metrics:
        field = metric.get("field", "")
        agg = (metric.get("agg") or metric.get("function") or "sum").upper().replace(" ", "_")
        if not field:
            continue

        quoted_field = qi(field, dialect)
        alias_name = f"{field}_{agg.lower()}"
        alias = qi(alias_name, dialect)
        measure_aliases[alias_name] = alias

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

    sql = f"SELECT {', '.join(select_parts)} FROM {base_table}{where_sql}"

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

    sql += f" LIMIT {int(limit)}"
    return sql


# ── BigQuery cost guard ──────────────────────────────────────────────────────

def _estimate_bigquery_bytes(config: dict, sql: str) -> int:
    """Dry-run a BigQuery query to get estimated bytes processed. Returns 0 on error."""
    try:
        from google.cloud import bigquery
        from google.oauth2 import service_account
        from app.services.datasource_service import _resolve_gcp_credentials_json

        credentials_info = json.loads(_resolve_gcp_credentials_json(config))
        credentials = service_account.Credentials.from_service_account_info(credentials_info)
        client = bigquery.Client(
            credentials=credentials,
            project=config.get("project_id"),
        )
        try:
            job_config = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
            query_job = client.query(sql, job_config=job_config)
            return query_job.total_bytes_processed or 0
        finally:
            client.close()
    except Exception as e:
        logger.warning("BigQuery dry-run failed (proceeding anyway): %s", e)
        return 0


# ── Main execution entry point ───────────────────────────────────────────────

class LiveQueryService:
    """Execute aggregated chart queries directly against source databases."""

    @staticmethod
    def execute_preview_query(
        datasource,
        db_table,
        limit: int = 100,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """Preview dataset rows directly from the source with cache + cost guard."""
        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        dialect = _dialect_for_ds_type(ds_type)

        from app.core.crypto import decrypt_config
        config = decrypt_config(datasource.config)
        table_identifier = db_table.source_table_name or db_table.display_name
        limit = min(max(int(limit or 100), 1), 1000)
        offset = max(int(offset or 0), 0)

        cache_payload = {
            "limit": limit,
            "offset": offset,
            "transformations": getattr(db_table, "transformations", None) or [],
            "type_overrides": normalize_type_overrides(getattr(db_table, "type_overrides", None)),
        }
        cached = query_cache.get_cached(
            datasource.id,
            table_identifier,
            "dataset_preview",
            cache_payload,
            [],
        )
        if cached is not None:
            return cached

        plan = build_live_base_query_plan(datasource, db_table, apply_type_overrides=True)
        base_table = f"({plan.sql}) AS _appbi_live"
        sql = f"SELECT * FROM {base_table} LIMIT {limit}"
        if offset:
            sql += f" OFFSET {offset}"

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

        from app.services.datasource_service import DataSourceConnectionService

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

        from app.core.crypto import decrypt_config
        config = decrypt_config(datasource.config)

        # Merge stored filters + extra dashboard filters
        all_filters = list(filters or [])
        if extra_filters:
            all_filters.extend(extra_filters)
        all_filters = normalize_filter_conditions(all_filters)
        normalized_role_config = normalize_chart_role_config(chart_type, role_config)

        table_identifier = db_table.source_table_name or db_table.display_name
        plan = build_live_base_query_plan(datasource, db_table, apply_type_overrides=True)
        base_table = f"({plan.sql}) AS _appbi_live"
        cache_role_config = {
            **normalized_role_config,
            "_transformations": getattr(db_table, "transformations", None) or [],
            "_type_overrides": normalize_type_overrides(getattr(db_table, "type_overrides", None)),
        }

        # Check cache first
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

        from app.core.crypto import decrypt_config
        config = decrypt_config(datasource.config)

        table_identifier = db_table.source_table_name or db_table.display_name
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
    from google.cloud import bigquery
    from google.oauth2 import service_account

    credentials_info = json.loads(config.get("credentials_json", "{}"))
    if not credentials_info and settings.GCP_SERVICE_ACCOUNT_JSON:
        credentials_info = json.loads(settings.GCP_SERVICE_ACCOUNT_JSON)
    credentials = service_account.Credentials.from_service_account_info(credentials_info)
    project_id = config.get("project_id", "")

    client = bigquery.Client(credentials=credentials, project=project_id)
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
