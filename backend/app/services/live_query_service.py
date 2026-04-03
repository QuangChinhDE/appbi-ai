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
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import settings
from app.core.logging import get_logger
from app.services import query_cache

logger = get_logger(__name__)


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


# ── WHERE clause builder (dialect-aware) ─────────────────────────────────────

def _build_where_clause(filters: list, dialect: str) -> str:
    """Build a SQL WHERE clause from a list of {field, operator, value} dicts."""
    if not filters:
        return ""
    parts = []
    qi = _quote_identifier
    for f in filters or []:
        field = f.get("field", "")
        op = (f.get("operator") or "eq").lower()
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
        elif op == "contains" and value is not None:
            esc = str(value).replace("'", "''").replace("%", "\\%").replace("_", "\\_")
            parts.append(f"{qf} LIKE '%{esc}%' ESCAPE '\\'")
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
) -> Tuple[str, bool]:
    """
    Build an aggregation query for direct source execution.

    Returns (sql, pre_aggregated).
    Stricter limits than DuckDB path: chart ≤ 1000, TABLE ≤ 5000, SCATTER ≤ 5000.
    """
    qi = _quote_identifier
    ctype = str(getattr(chart_type, "value", chart_type) or "").upper()

    where_clause = _build_where_clause(filters, dialect)
    where_sql = f" WHERE {where_clause}" if where_clause else ""

    if not role_config:
        return f"SELECT * FROM {base_table}{where_sql} LIMIT 500", False

    dimension = role_config.get("dimension")
    time_field = role_config.get("timeField")
    metrics = role_config.get("metrics") or []
    breakdown = role_config.get("breakdown")
    selected_cols = role_config.get("selectedColumns")

    # TABLE: capped at 5000 rows
    if ctype == "TABLE":
        cols = ", ".join(qi(c, dialect) for c in selected_cols) if selected_cols else "*"
        return f"SELECT {cols} FROM {base_table}{where_sql} LIMIT 5000", True

    # SCATTER: raw points up to 5000
    if ctype == "SCATTER":
        sx, sy = role_config.get("scatterX"), role_config.get("scatterY")
        if sx and sy:
            return (
                f"SELECT {qi(sx, dialect)}, {qi(sy, dialect)} FROM {base_table}{where_sql} LIMIT 5000",
                True,
            )
        return f"SELECT * FROM {base_table}{where_sql} LIMIT 5000", True

    # All other types: GROUP BY aggregation (required for live mode)
    group_field = dimension or time_field
    if not metrics:
        # For live mode, reject charts without aggregation (except TABLE/SCATTER)
        raise ValueError(
            "Charts on large tables require at least one metric (aggregation). "
            "Please add a SUM, COUNT, AVG, MIN or MAX measure."
        )

    select_parts = []
    group_by_parts = []

    if group_field:
        select_parts.append(qi(group_field, dialect))
        group_by_parts.append(qi(group_field, dialect))
    if breakdown:
        select_parts.append(qi(breakdown, dialect))
        group_by_parts.append(qi(breakdown, dialect))

    for m in metrics:
        field = m.get("field", "")
        agg = (m.get("agg") or "sum").upper().replace(" ", "_")
        if not field:
            continue
        qf = qi(field, dialect)
        alias_name = f"{agg.lower()}__{field}"
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
    sql += " LIMIT 1000"
    return sql, True


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
    def execute_chart_query(
        datasource,
        db_table,
        chart_type: str,
        role_config: dict,
        filters: list,
        extra_filters: list | None = None,
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

        # Build table reference
        table_identifier = db_table.source_table_name or db_table.display_name
        if db_table.source_kind == "sql_query" and db_table.source_query:
            base_table = f"({db_table.source_query}) AS _q"
        else:
            base_table = _build_base_table_ref(ds_type, datasource.config, table_identifier, dialect)

        # Check cache first
        cached = query_cache.get_cached(
            datasource.id, table_identifier, chart_type, role_config, all_filters
        )
        if cached is not None:
            return cached

        # Build aggregation SQL
        sql, pre_aggregated = build_live_agg_query(
            base_table, chart_type, role_config, all_filters, dialect
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
        )

        execution_time_ms = (time.time() - start_time) * 1000

        result = {
            "data": rows,
            "pre_aggregated": pre_aggregated,
            "execution_time_ms": round(execution_time_ms, 1),
        }

        # Store in cache
        query_cache.set_cached(
            datasource.id, table_identifier, chart_type, role_config, all_filters, result
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
