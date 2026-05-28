"""
Data source connection service.
Handles connecting to and querying external data sources.
"""
import base64
import os
import re
import time
from typing import Generator, Iterator, List, Dict, Any, Tuple, Optional
import pymysql
import psycopg2
from google.cloud import bigquery
from google.oauth2 import service_account
import json

from app.core.logging import get_logger
from app.core.config import settings
from app.models import DataSourceType
from app.services.sql_validator import validate_select_only
from app.services.google_sheets_connector import create_google_sheets_connector
from app.services.manual_table_connector import create_manual_table_connector
from app.services.google_data_access_service import get_google_credentials_for_user_id

logger = get_logger(__name__)


def _bigquery_dedup_outer_select(client, original_query: str) -> Optional[str]:
    """Rewrite outer SELECT to dedupe columns when source SQL has
    duplicate-named outputs (vd JOIN trả về 2 cột `name`).

    Strategy:
      1. Probe the source's INNERMOST subquery via LIMIT 0 to learn
         every output column name (free — no bytes scanned).
      2. If no duplicates, return None (signals "real error, not a
         dedup case").
      3. Otherwise, rewrite outer `SELECT *` to an explicit list with
         unique aliases: `col_a, col_b, dup AS dup, dup AS dup_2, ...`.

    Pattern recognised: `SELECT * FROM ((<source>) AS _appbi_live)
    [WHERE ...] LIMIT N`. The dataset-level executor in
    `live_query_service.build_live_dataset_query` always emits this
    shape when no explicit dims/measures are picked.

    Returns the rewritten SQL, or None if we can't safely rewrite
    (caller should re-raise the original error).
    """
    # Find the source CTE/subquery between `FROM (` and `) AS _appbi_live`.
    # Use a balanced-paren parse from the rightmost `) AS _appbi_live`.
    marker = ") AS _appbi_live"
    idx = original_query.find(marker)
    if idx == -1:
        return None
    # Walk backwards to find the matching `(` for the source subquery.
    depth = 1
    pos = idx - 1
    while pos >= 0 and depth > 0:
        c = original_query[pos]
        if c == ")":
            depth += 1
        elif c == "(":
            depth -= 1
            if depth == 0:
                break
        pos -= 1
    if depth != 0 or pos < 0:
        return None
    source_sql = original_query[pos + 1 : idx]  # raw source SQL inside parens

    # Probe schema via dry-run (no bytes scanned, no execution). The
    # dry-run query job reports `schema` of the OUTPUT columns even
    # when actual execution would fail with ambiguous — because the
    # ambiguity is detected at query compilation BEFORE result framing.
    # If dry-run itself errors, we accept the original failure.
    try:
        from google.cloud import bigquery as _bq
        job_config = _bq.QueryJobConfig(dry_run=True, use_query_cache=False)
        probe_job = client.query(source_sql, job_config=job_config)
        # dry-run job has `.schema` directly without `.result()`.
        cols = [f.name for f in (probe_job.schema or [])]
        if not cols:
            return None
    except Exception:
        return None

    seen: dict[str, int] = {}
    has_dup = False
    expanded: list[str] = []
    for col in cols:
        seen[col] = seen.get(col, 0) + 1
        if seen[col] == 1:
            expanded.append(f"`{col}`")
        else:
            has_dup = True
            alias = f"{col}_{seen[col]}"
            expanded.append(f"`{col}` AS `{alias}`")
    if not has_dup:
        return None  # No duplicates — original error was something else.

    explicit_select = ", ".join(expanded)
    # Replace the leading "SELECT *" with the explicit list. Be precise:
    # only the OUTERMOST SELECT, not any nested ones.
    if not original_query.lstrip().upper().startswith("SELECT *"):
        return None
    return original_query.replace("SELECT *", f"SELECT {explicit_select}", 1)


def _coerce_sheet_value(value: Any, declared_type: str) -> Any:
    if value is None:
        return None

    if declared_type == "number":
        if isinstance(value, (int, float)):
            return value

        text = str(value).strip()
        if text in ("", "-", "—", "–"):
            return None

        negative = False
        if text.startswith("(") and text.endswith(")"):
            negative = True
            text = text[1:-1]

        is_percentage = text.endswith("%")
        if is_percentage:
            text = text[:-1]

        cleaned = text.replace(",", "").replace(" ", "").replace("\xa0", "")
        if not cleaned:
            return None

        try:
            number = float(cleaned)
        except ValueError:
            return None

        if negative:
            number = -number
        if is_percentage:
            number = number / 100
        return number

    if declared_type == "date":
        text = str(value).strip()
        return text or None

    text = str(value).strip()
    return text or None


def _build_arrow_table_from_sheet(pa_module, col_defs: List[Dict[str, Any]], rows: List[Dict[str, Any]]):
    col_names = [c["name"] for c in col_defs]
    col_types = {c["name"]: c.get("type", "string") for c in col_defs}

    arrays = []
    for col_name in col_names:
        declared_type = col_types.get(col_name, "string")
        values = [_coerce_sheet_value(row.get(col_name), declared_type) for row in rows]
        if declared_type == "number":
            arrays.append(pa_module.array(values, type=pa_module.float64()))
        else:
            arrays.append(pa_module.array(values, type=pa_module.string()))

    return pa_module.table(dict(zip(col_names, arrays)))


def _resolve_gcp_credentials_json(config: Dict[str, Any]) -> str:
    """
    Return the GCP credentials JSON string to use for a connection.

    Priority:
      1. credentials_json supplied in the datasource config (user-provided key).
      2. GCP_SERVICE_ACCOUNT_JSON from platform settings (.env).

    Raises ValueError when neither source is available.
    """
    from_config = config.get("credentials_json") or ""
    if isinstance(from_config, str) and from_config.strip():
        return from_config.strip()
    platform_json = (settings.GCP_SERVICE_ACCOUNT_JSON or "").strip()
    if platform_json:
        return platform_json
    raise ValueError(
        "No GCP credentials found. Either provide credentials_json in the "
        "datasource config or set GCP_SERVICE_ACCOUNT_JSON in the platform .env."
    )


def _build_gcp_credentials(config: Dict[str, Any]):
    auth_mode = str(config.get("auth_mode") or "service_account").strip().lower()
    if auth_mode == "google_oauth":
        google_oauth_user_id = str(config.get("google_oauth_user_id") or "").strip()
        if not google_oauth_user_id:
            raise ValueError(
                "Google OAuth datasource is missing its connected AppBI user. Reconnect Google access and save again."
            )
        return get_google_credentials_for_user_id(google_oauth_user_id)

    credentials_info = json.loads(_resolve_gcp_credentials_json(config))
    return service_account.Credentials.from_service_account_info(credentials_info)


_BQ_CLIENT_CACHE: Dict[str, Tuple[float, bigquery.Client]] = {}
_BQ_CLIENT_CACHE_TTL_SEC = 300  # 5 min — keeps client warm across dashboard requests


def _bigquery_client_cache_key(config: Dict[str, Any]) -> str | None:
    """Stable cache key over credential identity + project. None = uncacheable."""
    auth_mode = str(config.get("auth_mode") or "service_account").strip().lower()
    if auth_mode == "google_oauth":
        # OAuth credentials carry refresh state — don't cache the client.
        return None
    try:
        creds_json = _resolve_gcp_credentials_json(config)
    except ValueError:
        return None
    project_id = str(config.get("project_id") or "").strip()
    import hashlib
    creds_fp = hashlib.sha256(creds_json.encode("utf-8")).hexdigest()
    return f"{auth_mode}:{project_id}:{creds_fp}"


def _build_bigquery_client(config: Dict[str, Any]) -> bigquery.Client:
    project_id = str(config.get("project_id") or "").strip() or None
    cache_key = _bigquery_client_cache_key(config)
    if cache_key is not None:
        cached = _BQ_CLIENT_CACHE.get(cache_key)
        now = time.time()
        if cached and (now - cached[0]) < _BQ_CLIENT_CACHE_TTL_SEC:
            return cached[1]
    client = bigquery.Client(
        credentials=_build_gcp_credentials(config),
        project=project_id,
    )
    if cache_key is not None:
        _BQ_CLIENT_CACHE[cache_key] = (time.time(), client)
    return client


_TRAILING_ROW_LIMIT_RE = re.compile(
    r"(?:\bLIMIT\s+\d+\s*(?:OFFSET\s+\d+\s*)?|\bOFFSET\s+\d+\s+LIMIT\s+\d+\s*|\bFETCH\s+FIRST\s+\d+\s+ROWS?\s+ONLY)\s*$",
    re.IGNORECASE | re.DOTALL,
)


def _normalize_sql_query(sql_query: str) -> str:
    """Trim trailing semicolons/whitespace so LIMIT handling stays stable."""
    return sql_query.rstrip().rstrip(";").rstrip()


def _query_has_explicit_row_limit(sql_query: str) -> bool:
    """Return True when the SQL already ends with a row limiting clause."""
    return bool(_TRAILING_ROW_LIMIT_RE.search(_normalize_sql_query(sql_query)))


def _apply_optional_limit(sql_query: str, limit: int | None) -> str:
    """
    Append LIMIT only when the caller requested one and the SQL does not
    already end with LIMIT / FETCH FIRST.
    """
    normalized = _normalize_sql_query(sql_query)
    if not limit or _query_has_explicit_row_limit(normalized):
        return normalized
    return f"{normalized} LIMIT {int(limit)}"


class DataSourceConnectionService:
    """Service for managing connections to external data sources."""
    
    @staticmethod
    def test_connection(ds_type: str, config: Dict[str, Any]) -> Tuple[bool, str]:
        """
        Test a data source connection.
        
        Args:
            ds_type: Type of data source
            config: Connection configuration
            
        Returns:
            Tuple of (success: bool, message: str)
        """
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)
        try:
            if ds_type == DataSourceType.POSTGRESQL.value:
                return DataSourceConnectionService._test_postgresql(config)
            elif ds_type == DataSourceType.MYSQL.value:
                return DataSourceConnectionService._test_mysql(config)
            elif ds_type == DataSourceType.BIGQUERY.value:
                return DataSourceConnectionService._test_bigquery(config)
            elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
                return DataSourceConnectionService._test_google_sheets(config)
            elif ds_type == DataSourceType.MANUAL.value:
                return DataSourceConnectionService._test_manual(config)
            else:
                return False, f"Unsupported data source type: {ds_type}"
        except Exception as e:
            logger.error(f"Connection test failed: {str(e)}")
            return False, f"Connection failed: {str(e)}"
    
    @staticmethod
    def _test_postgresql(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test PostgreSQL connection."""
        conn = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=5
            )
            # Apply schema search_path if specified
            schema = config.get("schema_name") or config.get("schema")
            if schema:
                with conn.cursor() as cur:
                    cur.execute(f"SET search_path TO {schema}")
            return True, "Connection successful"
        except Exception as e:
            return False, str(e)
        finally:
            if conn:
                conn.close()
    
    @staticmethod
    def _test_mysql(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test MySQL connection."""
        conn = None
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=config.get("port", 3306),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=5
            )
            return True, "Connection successful"
        except Exception as e:
            return False, str(e)
        finally:
            if conn:
                conn.close()
    
    @staticmethod
    def _test_bigquery(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test BigQuery connection."""
        client = None
        try:
            client = _build_bigquery_client(config)
            # Test basic API access
            query = "SELECT 1"
            client.query(query).result()

            # Also verify dataset/table listing permission — this is what the datasource
            # actually needs after connecting.  If default_dataset is set, probe that
            # dataset directly (covers per-dataset IAM roles).  Otherwise attempt a
            # project-level dataset listing so the user gets an early warning.
            default_dataset = config.get("default_dataset", "").strip()
            if default_dataset:
                try:
                    list(client.list_tables(default_dataset, max_results=1))
                except Exception as e:
                    return True, f"Connection successful, but could not list tables in dataset '{default_dataset}': {e}"
            else:
                try:
                    datasets = list(client.list_datasets(max_results=1))
                    if not datasets:
                        return True, (
                            "Connection successful, but no datasets found in the project. "
                            "Check that the connected credential has bigquery.datasets.list on the project, "
                            "or set a Default Dataset to target a specific dataset."
                        )
                except Exception as e:
                    return True, f"Connection successful, but could not list datasets: {e}. Set a Default Dataset if the credential only has per-dataset access."

            return True, "Connection successful"
        except Exception as e:
            return False, str(e)
        finally:
            if client:
                client.close()
    
    @staticmethod
    def _test_google_sheets(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test Google Sheets connection by verifying API access to the spreadsheet."""
        try:
            spreadsheet_id = (config.get("spreadsheet_id") or "").strip()
            if not spreadsheet_id:
                return False, "Spreadsheet ID is required"
            connector = create_google_sheets_connector(config)
            if connector.test_connection(spreadsheet_id):
                # Also verify we can list sheets (confirms read access)
                sheets = connector.list_sheets(spreadsheet_id)
                return True, f"Connection successful — {len(sheets)} sheet(s) found"
            return False, "Failed to connect to Google Sheets. Check that the spreadsheet is shared with the service account."
        except Exception as e:
            return False, str(e)
    
    @staticmethod
    def _test_manual(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test manual table (always succeeds)."""
        return True, "Manual table ready"
    
    @staticmethod
    def execute_query(
        ds_type: str,
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None,
        timeout_seconds: int = 30,
        query_params: list = None,
        skip_bigquery_cost_check: bool = False,
    ) -> Tuple[List[str], List[Dict[str, Any]], float]:
        """
        Execute a SQL query against a data source.
        
        Args:
            ds_type: Type of data source
            config: Connection configuration
            sql_query: SQL query to execute
            limit: Optional row limit
            timeout_seconds: Query timeout in seconds (default: 30)
            query_params: Optional list of parameter values for %s placeholders
            skip_bigquery_cost_check: Skip dry-run scan guard for BigQuery callers
            
        Returns:
            Tuple of (columns, data, execution_time_ms)
            
        Raises:
            ValueError: If query is not a SELECT statement
        """
        # Validate SQL query for safety
        validate_select_only(sql_query)

        from app.core.crypto import decrypt_config
        config = decrypt_config(config)

        start_time = time.time()
        
        try:
            if ds_type == DataSourceType.POSTGRESQL.value:
                result = DataSourceConnectionService._execute_postgresql(config, sql_query, limit, timeout_seconds, query_params)
            elif ds_type == DataSourceType.MYSQL.value:
                result = DataSourceConnectionService._execute_mysql(config, sql_query, limit, timeout_seconds, query_params)
            elif ds_type == DataSourceType.BIGQUERY.value:
                result = DataSourceConnectionService._execute_bigquery(
                    config,
                    sql_query,
                    limit,
                    timeout_seconds,
                    skip_cost_check=skip_bigquery_cost_check,
                )
            elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
                result = DataSourceConnectionService._execute_google_sheets(config, sql_query, limit)
            elif ds_type == DataSourceType.MANUAL.value:
                result = DataSourceConnectionService._execute_manual(config, sql_query, limit)
            else:
                raise ValueError(f"Unsupported data source type: {ds_type}")
            
            execution_time_ms = (time.time() - start_time) * 1000
            return result[0], result[1], execution_time_ms
            
        except Exception as e:
            logger.error(f"Query execution failed: {str(e)}")
            raise

    @staticmethod
    def execute_write(
        ds_type: str,
        config: Dict[str, Any],
        sql_query: str,
        query_params: list = None,
        timeout_seconds: int = 30,
    ) -> Tuple[List[str], List[Dict[str, Any]], int, float]:
        """
        Execute a write statement (INSERT/UPDATE/DELETE) against a data source.

        Unlike :meth:`execute_query`, this path does NOT pass through
        ``validate_select_only`` — write SQL is built by trusted internal
        callers (see ``workboard_write_service``) using parameterised queries.
        Callers MUST use parameter placeholders (``%s``) for every value;
        never interpolate user input into the SQL string.

        Currently supported on PostgreSQL and MySQL only. Other datasource
        types (Google Sheets, BigQuery) need to use :meth:`execute_write_op`
        instead — see workboard write service for the row-level abstraction.

        Returns:
            (columns, rows, rowcount, execution_time_ms)

            ``columns`` and ``rows`` are populated when the SQL ends with a
            ``RETURNING`` clause (PostgreSQL) — empty lists otherwise.
        """
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)

        start_time = time.time()
        if ds_type == DataSourceType.POSTGRESQL.value:
            columns, rows, rowcount = DataSourceConnectionService._execute_postgresql_write(
                config, sql_query, query_params, timeout_seconds
            )
        elif ds_type == DataSourceType.MYSQL.value:
            columns, rows, rowcount = DataSourceConnectionService._execute_mysql_write(
                config, sql_query, query_params, timeout_seconds
            )
        else:
            raise ValueError(
                f"Write operations are not supported on datasource type '{ds_type}'."
            )

        execution_time_ms = (time.time() - start_time) * 1000
        return columns, rows, rowcount, execution_time_ms

    @staticmethod
    def execute_write_op(
        ds_type: str,
        config: Dict[str, Any],
        op: str,                      # "insert" | "update" | "delete"
        table_name: str,
        values: Dict[str, Any] | None = None,
        pk: Dict[str, Any] | None = None,
        lock_column: Optional[str] = None,
        lock_token: Any = None,
        auto_pk_columns: Optional[List[str]] = None,
    ) -> Tuple[Dict[str, Any], int, float]:
        """Row-level write that doesn't require SQL strings.

        Designed for datasources that don't speak SQL (Google Sheets) or
        where the workboard layer prefers a high-level operation over
        building SQL. Returns ``(row_values, rowcount, ms)``:

          * ``row_values`` echoes the inserted/updated row as a dict;
          * ``rowcount`` is 1 when the op succeeds, else 0.

        SQL-speaking datasources can still go through this helper —
        internally it builds the equivalent INSERT/UPDATE/DELETE and routes
        to :meth:`execute_write`.

        Extra GSheets-only params:
          * ``lock_column``/``lock_token`` — optimistic-lock column name and
            the token value the client read. If set, update/delete will raise
            ValueError("OPTIMISTIC_LOCK: ...") when the stored value differs.
          * ``auto_pk_columns`` — for insert only. UUID is auto-generated for
            each listed column that is absent/empty in ``values``.
        """
        from app.core.crypto import decrypt_config
        cfg = decrypt_config(config)

        start = time.time()

        if ds_type == DataSourceType.GOOGLE_SHEETS.value:
            from app.services.google_sheets_connector import (
                create_google_sheets_connector,
            )
            connector = create_google_sheets_connector(cfg)
            spreadsheet_id = cfg.get("spreadsheet_id")
            if not spreadsheet_id:
                raise ValueError("Google Sheets datasource missing spreadsheet_id.")
            # ``table_name`` is the sheet name for Sheets datasources.
            sheet_name = table_name
            if op == "insert":
                row = connector.append_row(
                    spreadsheet_id, sheet_name, values or {},
                    auto_pk_columns=auto_pk_columns,
                )
                ms = (time.time() - start) * 1000
                return row, 1, ms
            if op == "update":
                if not pk:
                    raise ValueError("update requires a primary-key dict.")
                row = connector.update_row_by_pk(
                    spreadsheet_id, sheet_name, pk, values or {},
                    lock_column=lock_column, lock_token=lock_token,
                )
                ms = (time.time() - start) * 1000
                return row, 1, ms
            if op == "delete":
                if not pk:
                    raise ValueError("delete requires a primary-key dict.")
                connector.delete_row_by_pk(
                    spreadsheet_id, sheet_name, pk,
                    lock_column=lock_column, lock_token=lock_token,
                )
                ms = (time.time() - start) * 1000
                return {}, 1, ms
            raise ValueError(f"Unsupported op '{op}'.")

        # Fall through: build SQL and re-use execute_write for SQL backends.
        if ds_type not in (
            DataSourceType.POSTGRESQL.value,
            DataSourceType.MYSQL.value,
        ):
            raise ValueError(
                f"Write operations are not supported on datasource type '{ds_type}'."
            )

        # The legacy WorkboardWriteService still builds SQL itself; this
        # branch exists so future callers can hand off ops directly.
        raise NotImplementedError(
            "SQL-backed write_op routing is intentionally not implemented yet — "
            "callers should keep using execute_write for Postgres/MySQL."
        )

    @staticmethod
    def _execute_postgresql_write(
        config: Dict[str, Any],
        sql_query: str,
        query_params: list,
        timeout_seconds: int,
    ) -> Tuple[List[str], List[Dict[str, Any]], int]:
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=min(timeout_seconds, 10),
            )
            cursor = conn.cursor()
            cursor.execute(f"SET statement_timeout = {timeout_seconds * 1000}")
            schema = config.get("schema_name") or config.get("schema")
            if schema:
                cursor.execute(f"SET search_path TO {schema}")
            cursor.execute(sql_query, query_params)
            rowcount = cursor.rowcount or 0
            columns: List[str] = []
            rows: List[Dict[str, Any]] = []
            if cursor.description:
                columns = [desc[0] for desc in cursor.description]
                fetched = cursor.fetchall()
                rows = [dict(zip(columns, row)) for row in fetched]
            conn.commit()
            return columns, rows, rowcount
        except Exception:
            if conn is not None:
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

    @staticmethod
    def _execute_mysql_write(
        config: Dict[str, Any],
        sql_query: str,
        query_params: list,
        timeout_seconds: int,
    ) -> Tuple[List[str], List[Dict[str, Any]], int]:
        conn = None
        cursor = None
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=config.get("port", 3306),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=min(timeout_seconds, 10),
                read_timeout=timeout_seconds,
                write_timeout=timeout_seconds,
                autocommit=False,
            )
            cursor = conn.cursor()
            cursor.execute(sql_query, query_params)
            rowcount = cursor.rowcount or 0
            conn.commit()
            # MySQL does not support RETURNING; callers must SELECT separately.
            return [], [], rowcount
        except Exception:
            if conn is not None:
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

    @staticmethod
    def fetch_table_data(
        ds_type: str,
        config: Dict[str, Any],
        schema: str,
        table: str,
        limit: int = None,
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """
        Fetch rows from a single table / sheet directly — no fake SQL.

        Used by the sync engine and live fallback paths so each connector uses
        its native fetch API instead of building fake SQL that connectors then
        have to re-parse (fragile for GSheets / Manual).

        The sentinel schema value ``"default"`` is resolved to the connector's
        actual default schema (``public`` for PostgreSQL, the configured
        database for MySQL) so callers don't have to know the real default.

        Args:
            ds_type: DataSourceType value
            config:  Connection config (decrypted internally)
            schema:  Schema name, or ``"default"`` for the connector default,
                     or spreadsheet_id for GSheets
            table:   Table / sheet name
            limit:   Optional row limit (None = all rows)

        Returns:
            (column_names, rows)
        """
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)

        if ds_type == DataSourceType.POSTGRESQL.value:
            # Resolve "default" sentinel to the configured schema or "public"
            real_schema = schema if schema != "default" else (
                config.get("schema_name") or config.get("schema") or "public"
            )
            sql = f'SELECT * FROM "{real_schema}"."{table}"'
            if limit:
                sql += f" LIMIT {int(limit)}"
            cols, rows = DataSourceConnectionService._execute_postgresql(
                config, sql, limit=None
            )
            return cols, rows

        elif ds_type == DataSourceType.MYSQL.value:
            # Resolve "default" sentinel to the configured database
            real_schema = schema if schema != "default" else (
                config.get("database") or schema
            )
            sql = f'SELECT * FROM `{real_schema}`.`{table}`'
            if limit:
                sql += f" LIMIT {int(limit)}"
            cols, rows = DataSourceConnectionService._execute_mysql(
                config, sql, limit=None
            )
            return cols, rows

        elif ds_type == DataSourceType.BIGQUERY.value:
            project_id = config.get("project_id", "")
            sql = f"SELECT * FROM `{project_id}.{schema}.{table}`"
            if limit:
                sql += f" LIMIT {int(limit)}"
            cols, rows = DataSourceConnectionService._execute_bigquery(
                config, sql, limit=None,
            )
            return cols, rows

        elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
            from app.services.google_sheets_connector import create_google_sheets_connector
            spreadsheet_id = config.get("spreadsheet_id") or schema
            connector = create_google_sheets_connector(config)
            data = connector.get_sheet_data(spreadsheet_id, sheet_name=table)
            columns = [col["name"] for col in data.get("columns", [])]
            rows = data.get("rows", [])
            if limit:
                rows = rows[:limit]
            return columns, rows

        elif ds_type == DataSourceType.MANUAL.value:
            from app.services.manual_table_connector import create_manual_table_connector
            connector = create_manual_table_connector(config)
            data = connector.get_sheet_data(table)
            columns = [col["name"] for col in data.get("columns", [])]
            rows = data.get("rows", [])
            if limit:
                rows = rows[:limit]
            return columns, rows

        else:
            raise ValueError(f"fetch_table_data: unsupported datasource type {ds_type!r}")

    @staticmethod
    def _execute_postgresql(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None,
        timeout_seconds: int = 30,
        query_params: list = None,
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute query against PostgreSQL."""
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=min(timeout_seconds, 10)
            )
            cursor = conn.cursor()
            
            # Set statement timeout
            cursor.execute(f"SET statement_timeout = {timeout_seconds * 1000}")
            
            # Apply schema search_path if specified
            schema = config.get("schema_name") or config.get("schema")
            if schema:
                cursor.execute(f"SET search_path TO {schema}")
            
            # Apply limit if specified
            query = _apply_optional_limit(sql_query, limit)
            
            cursor.execute(query, query_params)
            
            # Get column names
            columns = [desc[0] for desc in cursor.description]
            
            # Fetch data
            rows = cursor.fetchall()
            data = [dict(zip(columns, row)) for row in rows]
            
            return columns, data
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _execute_mysql(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None,
        timeout_seconds: int = 30,
        query_params: list = None,
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute query against MySQL."""
        conn = None
        cursor = None
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=config.get("port", 3306),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=min(timeout_seconds, 10),
                read_timeout=timeout_seconds,
                write_timeout=timeout_seconds
            )
            cursor = conn.cursor()
            
            # Apply limit if specified
            query = _apply_optional_limit(sql_query, limit)
            
            cursor.execute(query, query_params)
            
            # Get column names
            columns = [desc[0] for desc in cursor.description]
            
            # Fetch data
            rows = cursor.fetchall()
            data = [dict(zip(columns, row)) for row in rows]

            return columns, data
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _execute_bigquery(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None,
        timeout_seconds: int = 30,
        skip_cost_check: bool = False,
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute query against BigQuery."""
        client = None
        try:
            project_id = config.get("project_id")
            
            client = _build_bigquery_client(config)
            
            # Apply limit if specified
            query = _apply_optional_limit(sql_query, limit)

            if not skip_cost_check:
                # Phase-15.59b — cost-check dry-run hits the SAME
                # ambiguous-column failure as the real query (BigQuery
                # validates syntax during dry-run). If the dry-run
                # fails specifically with "ambiguous", swallow it here
                # and skip the cost check — the dedup retry path below
                # will catch + retry the real query and may succeed.
                try:
                    estimated_bytes = DataSourceConnectionService._estimate_bigquery_bytes(config, query)
                    max_bytes = settings.BQ_MAX_BYTES_SCANNED
                    if estimated_bytes > max_bytes:
                        gb_est = estimated_bytes / (1024**3)
                        gb_max = max_bytes / (1024**3)
                        raise ValueError(
                            f"Query would scan {gb_est:.1f} GB (limit: {gb_max:.0f} GB). "
                            "Add filters or reduce selected columns before running it."
                        )
                except Exception as cost_err:
                    if "ambiguous" in str(cost_err).lower():
                        logger.info(
                            "[bq_dedup] cost-check dry-run hit ambiguous; "
                            "skipping cost check so retry-with-dedup can run."
                        )
                    else:
                        raise

            logger.info(f"Executing BigQuery query on project {project_id}")
            # Phase-15.58 — log the actual SQL string so DA can grep
            # backend logs when BigQuery rejects with cryptic errors
            # like "Column name is ambiguous". A 2-second snippet of
            # the SQL (first 1500 chars) is enough to spot a missing
            # table alias without dumping multi-KB queries.
            sql_preview = (query or "").strip().replace("\n", " ")
            if len(sql_preview) > 1500:
                sql_preview = sql_preview[:1500] + " ... [truncated]"
            logger.info(f"[bq_sql] {sql_preview}")

            try:
                query_job = client.query(query)
                results = query_job.result(timeout=timeout_seconds)
            except Exception as first_err:
                # Phase-15.58/59 — retry-with-dedup for ambiguous-column
                # failure. Try 2 strategies in order:
                #   1. LiveQueryService path: wrapper `(source) AS _appbi_live`
                #      → probe source schema + rewrite outer SELECT *.
                #   2. Semantic engine path: full SELECT with explicit
                #      column list. Dump SQL for human review — engine
                #      bug, can't auto-fix without breaking semantics.
                err_msg = str(first_err)
                if "ambiguous" not in err_msg.lower():
                    # The INFO preview above is truncated at 1500 chars,
                    # which hides the real failure site when the engine
                    # emits a multi-KB nested-CTE / EXISTS chain that BQ
                    # rejects (e.g. "Unexpected keyword SELECT at [419:76]").
                    # Dump the FULL SQL on ERROR so DA can match the line/col
                    # in the BQ error to the exact emitted text.
                    logger.error(
                        "[bq_sql_failed] BigQuery rejected query (full SQL follows). "
                        "err=%s\n----- FULL SQL -----\n%s\n----- END SQL -----",
                        err_msg, query,
                    )
                    raise
                logger.warning(
                    "[bq_dedup] ambiguous-column error received. SQL=%s",
                    (query or "").replace("\n", " ")[:2000],
                )
                rewritten = _bigquery_dedup_outer_select(client, query)
                if rewritten is None:
                    logger.error(
                        "[bq_dedup] dedup rewrite skipped — pattern not matched. "
                        "Likely semantic-engine emit bug. Re-raising original error."
                    )
                    raise
                logger.info(f"[bq_sql_retry] {rewritten[:1500]}")
                query_job = client.query(rewritten)
                results = query_job.result(timeout=timeout_seconds)
            
            # Get column names
            columns = [field.name for field in results.schema]
            
            # Fetch data and handle encoding issues
            data = []
            for row in results:
                row_dict = {}
                for key, value in row.items():
                    # Handle bytes/binary data
                    if isinstance(value, bytes):
                        try:
                            row_dict[key] = value.decode('utf-8')
                        except UnicodeDecodeError:
                            # If UTF-8 decode fails, use base64 encoding
                            import base64
                            row_dict[key] = base64.b64encode(value).decode('ascii')
                    else:
                        row_dict[key] = value
                data.append(row_dict)
            
            logger.info(f"BigQuery query completed. Rows returned: {len(data)}")
            return columns, data
            
        except Exception as e:
            logger.error(f"BigQuery execution failed on project {config.get('project_id')}: {str(e)}")
            raise
        finally:
            # Cleanup client if needed
            if client:
                client.close()

    @staticmethod
    def _estimate_bigquery_bytes(config: Dict[str, Any], sql_query: str) -> int:
        """Dry-run a BigQuery query and return estimated bytes processed."""
        client = None
        try:
            project_id = config.get("project_id")
            client = _build_bigquery_client(config)
            job_config = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
            job = client.query(sql_query, job_config=job_config)
            return int(job.total_bytes_processed or 0)
        finally:
            if client:
                client.close()

    # ── Streaming methods (for sync / large-table ingestion) ──────────────────
    # These return (columns, generator_of_row_batches) so callers can write
    # data to Parquet incrementally without loading the entire result set into
    # RAM.  Each yielded batch is a list of dicts with at most `batch_size`
    # items.
    # Larger batches = fewer DB round-trips AND larger Parquet row groups,
    # which dramatically speeds DuckDB zone-map pushdown on 100M+ row tables.
    STREAM_BATCH_SIZE = int(os.environ.get("SYNC_STREAM_BATCH_SIZE", "50000"))

    @staticmethod
    def _stream_postgresql(
        config: Dict[str, Any],
        sql_query: str,
        timeout_seconds: int = 3600,
    ) -> Tuple[List[str], Generator[List[Dict[str, Any]], None, None]]:
        """Stream rows from PostgreSQL using a server-side cursor."""
        conn = psycopg2.connect(
            host=config.get("host"),
            port=config.get("port", 5432),
            database=config.get("database"),
            user=config.get("username"),
            password=config.get("password"),
            connect_timeout=min(timeout_seconds, 10),
        )
        try:
            conn.autocommit = False  # Required for server-side cursors

            # SET commands must run on a regular cursor, not the named
            # (server-side) one — psycopg2 wraps named-cursor queries in
            # DECLARE ... CURSOR FOR ..., which causes a syntax error.
            setup_cur = conn.cursor()
            setup_cur.execute(f"SET statement_timeout = {timeout_seconds * 1000}")
            schema = config.get("schema_name") or config.get("schema")
            if schema:
                setup_cur.execute(f"SET search_path TO {schema}")
            setup_cur.close()

            cursor = conn.cursor(name="sync_stream_cursor")
            cursor.itersize = DataSourceConnectionService.STREAM_BATCH_SIZE
            cursor.execute(sql_query)

            # Server-side (named) cursors don't populate .description
            # until the first fetch, so we must fetch before reading it.
            first_batch = cursor.fetchmany(
                DataSourceConnectionService.STREAM_BATCH_SIZE
            )

            if cursor.description:
                columns = [desc[0] for desc in cursor.description]
            else:
                # Empty result — get column names via a regular cursor.
                cursor.close()
                meta_cur = conn.cursor()
                meta_cur.execute(sql_query + " LIMIT 0")
                columns = [desc[0] for desc in meta_cur.description]
                meta_cur.close()
                # No data to stream — return empty generator
                def _empty():
                    conn.close()
                    return
                    yield  # noqa: make this a generator
                return columns, _empty()

            def _gen():
                try:
                    yield [dict(zip(columns, r)) for r in first_batch]
                    while True:
                        rows = cursor.fetchmany(
                            DataSourceConnectionService.STREAM_BATCH_SIZE
                        )
                        if not rows:
                            break
                        yield [dict(zip(columns, r)) for r in rows]
                finally:
                    cursor.close()
                    conn.close()

            return columns, _gen()
        except Exception:
            conn.close()
            raise

    @staticmethod
    def _stream_mysql(
        config: Dict[str, Any],
        sql_query: str,
        timeout_seconds: int = 3600,
    ) -> Tuple[List[str], Generator[List[Dict[str, Any]], None, None]]:
        """Stream rows from MySQL using SSDictCursor (server-side streaming)."""
        conn = pymysql.connect(
            host=config.get("host"),
            port=config.get("port", 3306),
            database=config.get("database"),
            user=config.get("username"),
            password=config.get("password"),
            connect_timeout=min(timeout_seconds, 10),
            read_timeout=timeout_seconds,
            write_timeout=timeout_seconds,
        )
        try:
            cursor = conn.cursor(pymysql.cursors.SSCursor)
            cursor.execute(sql_query)

            columns = [desc[0] for desc in cursor.description]

            def _gen():
                try:
                    while True:
                        rows = cursor.fetchmany(DataSourceConnectionService.STREAM_BATCH_SIZE)
                        if not rows:
                            break
                        yield [dict(zip(columns, r)) for r in rows]
                finally:
                    cursor.close()
                    conn.close()

            return columns, _gen()
        except Exception:
            conn.close()
            raise

    @staticmethod
    def _stream_bigquery(
        config: Dict[str, Any],
        sql_query: str,
        timeout_seconds: int = 3600,
    ) -> Tuple[List[str], Generator[List[Dict[str, Any]], None, None]]:
        """Stream rows from BigQuery using page iteration (constant memory)."""
        project_id = config.get("project_id")

        client = _build_bigquery_client(config)

        try:
            logger.info("Streaming BigQuery query on project %s", project_id)
            query_job = client.query(sql_query)
            result_iter = query_job.result(
                timeout=timeout_seconds,
                page_size=DataSourceConnectionService.STREAM_BATCH_SIZE,
            )

            columns = [field.name for field in result_iter.schema]

            def _gen():
                try:
                    batch: List[Dict[str, Any]] = []
                    for row in result_iter:
                        row_dict = {}
                        for key, value in row.items():
                            if isinstance(value, bytes):
                                try:
                                    row_dict[key] = value.decode("utf-8")
                                except UnicodeDecodeError:
                                    row_dict[key] = base64.b64encode(value).decode("ascii")
                            else:
                                row_dict[key] = value
                        batch.append(row_dict)
                        if len(batch) >= DataSourceConnectionService.STREAM_BATCH_SIZE:
                            yield batch
                            batch = []
                    if batch:
                        yield batch
                finally:
                    client.close()

            return columns, _gen()
        except Exception:
            client.close()
            raise

    @staticmethod
    def stream_bigquery_arrow(
        config: Dict[str, Any],
        sql_query: str,
        timeout_seconds: int = 3600,
    ) -> Generator["pa.RecordBatch", None, None]:
        """
        Stream BigQuery results as Arrow RecordBatches **directly**.

        This is 3-5x faster than `_stream_bigquery()` because:
        - BigQuery returns data in Arrow wire format natively
        - No row-by-row Python dict conversion
        - RecordBatches are written to Parquet with zero-copy

        Yields pa.RecordBatch objects (not list-of-dicts).
        Caller must handle pyarrow import.
        """
        import pyarrow as pa

        project_id = config.get("project_id")

        client = _build_bigquery_client(config)

        try:
            logger.info("Streaming BigQuery (Arrow) query on project %s", project_id)
            query_job = client.query(sql_query)
            result_iter = query_job.result(timeout=timeout_seconds)

            for record_batch in result_iter.to_arrow_iterable():
                yield record_batch
        finally:
            client.close()

    @staticmethod
    def stream_table_data(
        ds_type: str,
        config: Dict[str, Any],
        schema: str,
        table: str,
    ) -> Tuple[List[str], Generator[List[Dict[str, Any]], None, None]]:
        """
        Stream rows from a table in constant-memory batches.

        Returns (column_names, generator_of_batches) where each batch is a
        list of dicts with at most STREAM_BATCH_SIZE items.

        For datasource types that don't support streaming (Google Sheets,
        Manual), falls back to a single-batch wrapper around fetch_table_data.
        """
        from app.core.crypto import decrypt_config
        raw_config = config  # keep original for fallback (fetch_table_data decrypts internally)
        config = decrypt_config(config)

        ds_type_val = ds_type if isinstance(ds_type, str) else ds_type.value

        if ds_type_val == DataSourceType.POSTGRESQL.value:
            real_schema = schema if schema != "default" else (
                config.get("schema_name") or config.get("schema") or "public"
            )
            sql = f'SELECT * FROM "{real_schema}"."{table}"'
            return DataSourceConnectionService._stream_postgresql(config, sql)

        elif ds_type_val == DataSourceType.MYSQL.value:
            real_schema = schema if schema != "default" else (
                config.get("database") or schema
            )
            sql = f'SELECT * FROM `{real_schema}`.`{table}`'
            return DataSourceConnectionService._stream_mysql(config, sql)

        elif ds_type_val == DataSourceType.BIGQUERY.value:
            project_id = config.get("project_id", "")
            sql = f"SELECT * FROM `{project_id}.{schema}.{table}`"
            return DataSourceConnectionService._stream_bigquery(config, sql)

        else:
            # Google Sheets / Manual — data is small, wrap in single batch
            cols, rows = DataSourceConnectionService.fetch_table_data(
                ds_type, raw_config, schema, table,
            )

            def _single_batch():
                if rows:
                    yield rows

            return cols, _single_batch()

    @staticmethod
    def stream_query(
        ds_type: str,
        config: Dict[str, Any],
        sql_query: str,
        timeout_seconds: int = 3600,
    ) -> Tuple[List[str], Generator[List[Dict[str, Any]], None, None]]:
        """
        Stream an arbitrary SQL query in constant-memory batches.

        Used by sync engine for incremental queries (WHERE watermark > ...).
        For datasource types without streaming support, falls back to
        execute_query wrapped in a single batch.
        """
        from app.core.crypto import decrypt_config
        from app.services.sql_validator import validate_select_only

        validate_select_only(sql_query)
        raw_config = config  # keep for fallback (execute_query decrypts internally)
        config = decrypt_config(config)

        ds_type_val = ds_type if isinstance(ds_type, str) else ds_type.value

        if ds_type_val == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._stream_postgresql(
                config, sql_query, timeout_seconds,
            )
        elif ds_type_val == DataSourceType.MYSQL.value:
            return DataSourceConnectionService._stream_mysql(
                config, sql_query, timeout_seconds,
            )
        elif ds_type_val == DataSourceType.BIGQUERY.value:
            return DataSourceConnectionService._stream_bigquery(
                config, sql_query, timeout_seconds,
            )
        else:
            # Fallback: load-all and wrap
            col_names, rows, _ = DataSourceConnectionService.execute_query(
                ds_type, raw_config, sql_query, limit=None,
                timeout_seconds=timeout_seconds,
            )

            def _single():
                if rows:
                    yield rows

            return col_names, _single()

    @staticmethod
    def infer_column_types(
        ds_type: str,
        config: Dict[str, Any],
        sql_query: str
    ) -> List[Dict[str, str]]:
        """
        Infer column types from a query result.

        Args:
            ds_type: Type of data source
            config: Connection configuration
            sql_query: SQL query

        Returns:
            List of column metadata dicts. Each entry has:
            - `name`: original column name as returned by the engine (kept for back-compat
              with consumers that still query by raw label, e.g. older datasets stored
              with Vietnamese identifiers).
            - `display_name`: user-facing label, identical to `name` here.
            - `safe_name`: deterministic ASCII snake_case identifier suitable for
              calculated-field references (`[safe_name]`) and any new SQL composition.
              Always unique within the result set.
            - `type`: inferred SQL type token.
        """
        try:
            if ds_type == DataSourceType.POSTGRESQL.value:
                raw = DataSourceConnectionService._infer_postgresql_types(config, sql_query)
            elif ds_type == DataSourceType.MYSQL.value:
                raw = DataSourceConnectionService._infer_mysql_types(config, sql_query)
            elif ds_type == DataSourceType.BIGQUERY.value:
                raw = DataSourceConnectionService._infer_bigquery_types(config, sql_query)
            elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
                raw = DataSourceConnectionService._infer_google_sheets_types(config, sql_query)
            elif ds_type == DataSourceType.MANUAL.value:
                raw = DataSourceConnectionService._infer_manual_types(config, sql_query)
            else:
                raise ValueError(f"Unsupported data source type: {ds_type}")
            return DataSourceConnectionService._enrich_columns_with_safe_names(raw)
        except Exception as e:
            logger.error(f"Type inference failed: {str(e)}")
            raise

    @staticmethod
    def _enrich_columns_with_safe_names(columns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Attach `display_name` and `safe_name` to each column entry without mutating `name`.

        Existing dataset rows still address columns via the original `name`; the new
        `safe_name` is purely additive and is the canonical reference for new code paths
        such as calculated-field formulas.
        """
        from app.services.identifier_utils import normalize_column_identifier

        enriched: List[Dict[str, Any]] = []
        used_safe_names: List[str] = []
        for entry in columns or []:
            if not isinstance(entry, dict):
                continue
            original_name = str(entry.get("name") or "")
            existing_display = entry.get("display_name")
            existing_safe = entry.get("safe_name")
            display_name = str(existing_display) if existing_display else original_name
            if existing_safe:
                safe_name = str(existing_safe)
            else:
                safe_name = normalize_column_identifier(
                    original_name or display_name,
                    existing=used_safe_names,
                    fallback="col",
                )
            used_safe_names.append(safe_name)
            merged = dict(entry)
            merged["name"] = original_name
            merged["display_name"] = display_name
            merged["safe_name"] = safe_name
            enriched.append(merged)
        return enriched
    
    @staticmethod
    def _infer_postgresql_types(config: Dict[str, Any], sql_query: str) -> List[Dict[str, str]]:
        """Infer column types from PostgreSQL query."""
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password")
            )
            cursor = conn.cursor()
            
            # Execute with LIMIT 0 to get column info without data
            cursor.execute(f"{sql_query.rstrip(';')} LIMIT 0")
            
            columns = []
            for desc in cursor.description:
                columns.append({
                    "name": desc[0],
                    "type": DataSourceConnectionService._pg_type_to_string(desc[1])
                })
            
            return columns
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _infer_mysql_types(config: Dict[str, Any], sql_query: str) -> List[Dict[str, str]]:
        """Infer column types from MySQL query."""
        conn = None
        cursor = None
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=config.get("port", 3306),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password")
            )
            cursor = conn.cursor()
            
            # Execute with LIMIT 0 to get column info without data
            cursor.execute(f"{sql_query.rstrip(';')} LIMIT 0")
            
            columns = []
            for desc in cursor.description:
                columns.append({
                    "name": desc[0],
                    "type": DataSourceConnectionService._mysql_type_to_string(desc[1])
                })
            
            return columns
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _infer_bigquery_types(config: Dict[str, Any], sql_query: str) -> List[Dict[str, str]]:
        """Infer column types from BigQuery query."""
        client = None
        try:
            project_id = config.get("project_id")
            
            client = _build_bigquery_client(config)
            
            logger.info(f"Inferring BigQuery schema for project {project_id}")
            
            # Use dry run to get schema without executing
            job_config = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
            query_job = client.query(sql_query, job_config=job_config)
            
            columns = []
            for field in query_job.schema:
                columns.append({
                    "name": field.name,
                    "type": field.field_type.lower()
                })
            
            logger.info(f"BigQuery schema inference completed. Columns: {len(columns)}")
            return columns
            
        except Exception as e:
            logger.error(f"BigQuery schema inference failed on project {config.get('project_id')}: {str(e)}")
            raise
        finally:
            if client:
                client.close()
    
    @staticmethod
    def _infer_manual_types(config: Dict[str, Any], sql_query: str) -> List[Dict[str, str]]:
        """Infer column types for Manual Table datasources."""
        try:
            from app.services.manual_table_connector import create_manual_table_connector, extract_sheet_name_from_sql
            connector = create_manual_table_connector(config)
            sheet_name = extract_sheet_name_from_sql(sql_query)
            data = connector.get_sheet_data(sheet_name)
            return [{"name": col["name"], "type": col.get("type", "string")} for col in data["columns"]]
        except Exception as e:
            logger.error(f"Manual type inference failed: {str(e)}")
            raise

    @staticmethod
    def _infer_google_sheets_types(config: Dict[str, Any], sql_query: str) -> List[Dict[str, str]]:
        """Infer column names from the live Google Sheets workbook."""
        try:
            from app.core.crypto import decrypt_config

            live_config = decrypt_config(config)
            columns, _ = DataSourceConnectionService._execute_google_sheets(
                live_config,
                sql_query,
                limit=1,
            )
            return [{"name": str(column), "type": "string"} for column in columns]
        except Exception as e:
            logger.error(f"Google Sheets type inference failed: {str(e)}")
            raise

    @staticmethod
    def _pg_type_to_string(type_code: int) -> str:
        """Convert PostgreSQL type code to string."""
        # Common PostgreSQL type codes
        type_map = {
            16: "boolean",
            20: "bigint",
            21: "smallint",
            23: "integer",
            25: "text",
            700: "real",
            701: "double",
            1043: "varchar",
            1082: "date",
            1114: "timestamp",
            1184: "timestamptz",
        }
        return type_map.get(type_code, "unknown")
    
    @staticmethod
    def _mysql_type_to_string(type_code: int) -> str:
        """Convert MySQL type code to string."""
        # Common MySQL type codes from pymysql
        type_map = {
            1: "tinyint",
            2: "smallint",
            3: "integer",
            4: "float",
            5: "double",
            7: "timestamp",
            8: "bigint",
            10: "date",
            12: "datetime",
            246: "decimal",
            252: "text",
            253: "varchar",
            254: "char",
        }
        return type_map.get(type_code, "unknown")
    
    @staticmethod
    def list_tables(
        ds_type: str,
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """
        List all tables from a datasource.
        
        Args:
            ds_type: Type of data source
            config: Connection configuration
            search_query: Optional search query to filter tables
            
        Returns:
            List of table dicts with 'name', 'schema', and 'type' keys
        """
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)
        try:
            if ds_type == DataSourceType.POSTGRESQL.value:
                return DataSourceConnectionService._list_postgresql_tables(config, search_query)
            elif ds_type == DataSourceType.MYSQL.value:
                return DataSourceConnectionService._list_mysql_tables(config, search_query)
            elif ds_type == DataSourceType.BIGQUERY.value:
                return DataSourceConnectionService._list_bigquery_tables(config, search_query)
            elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
                return DataSourceConnectionService._list_google_sheets(config, search_query)
            elif ds_type == DataSourceType.MANUAL.value:
                return DataSourceConnectionService._list_manual_tables(config, search_query)
            else:
                raise ValueError(f"Unsupported data source type: {ds_type}")
        except Exception as e:
            logger.error(f"Failed to list tables: {str(e)}")
            raise
    
    @staticmethod
    def _list_postgresql_tables(
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """List tables from PostgreSQL."""
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password")
            )
            cursor = conn.cursor()
            
            # Query information_schema for tables and views
            query = """
                SELECT 
                    table_schema,
                    table_name,
                    table_type
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            """
            
            if search_query:
                query += " AND table_name ILIKE %s"
                params = (f"%{search_query}%",)
            else:
                params = ()

            query += " ORDER BY table_schema, table_name"

            cursor.execute(query, params)
            rows = cursor.fetchall()
            
            tables = []
            for schema, name, table_type in rows:
                tables.append({
                    "name": f"{schema}.{name}",
                    "schema": schema,
                    "type": "view" if table_type == "VIEW" else "table"
                })
            
            return tables
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _list_mysql_tables(
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """List tables from MySQL."""
        conn = None
        cursor = None
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=config.get("port", 3306),
                user=config.get("username"),
                password=config.get("password")
            )
            cursor = conn.cursor()
            
            database = config.get("database")
            
            # Query information_schema for tables
            query = """
                SELECT 
                    TABLE_NAME,
                    TABLE_TYPE
                FROM information_schema.tables
                WHERE TABLE_SCHEMA = %s
            """
            params: tuple = (database,)

            if search_query:
                query += " AND TABLE_NAME LIKE %s"
                params = (database, f"%{search_query}%")

            query += " ORDER BY TABLE_NAME"

            cursor.execute(query, params)
            rows = cursor.fetchall()
            
            tables = []
            for name, table_type in rows:
                tables.append({
                    "name": name,
                    "schema": database,
                    "type": "view" if table_type == "VIEW" else "table"
                })
            
            return tables
            
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()
    
    @staticmethod
    def _list_bigquery_tables(
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """List tables from BigQuery."""
        client = None
        try:
            project_id = config.get("project_id")

            client = _build_bigquery_client(config)

            logger.info(f"Listing BigQuery tables for project {project_id}")

            class _DS:
                def __init__(self, ds_id):
                    self.dataset_id = ds_id

            default_dataset = config.get("default_dataset", "").strip()

            if default_dataset:
                # User explicitly set a dataset — scope listing to that dataset only.
                logger.info(f"default_dataset configured: listing only '{default_dataset}'")
                datasets = [_DS(default_dataset)]
            else:
                # No dataset filter — list all datasets in the project.
                datasets = list(client.list_datasets())
                if not datasets:
                    logger.warning(
                        f"list_datasets() returned empty for project {project_id}. "
                        "Grant bigquery.datasets.list on the project or set a Default Dataset."
                    )

            tables = []
            for dataset in datasets:
                dataset_id = dataset.dataset_id

                try:
                    dataset_tables = list(client.list_tables(dataset_id))
                except Exception as e:
                    logger.warning(f"Could not list tables in dataset '{dataset_id}': {e}")
                    continue

                for table in dataset_tables:
                    table_name = f"{dataset_id}.{table.table_id}"

                    # Apply search filter
                    if search_query and search_query.lower() not in table_name.lower():
                        continue

                    tables.append({
                        "name": table_name,
                        "schema": dataset_id,
                        "type": "view" if table.table_type == "VIEW" else "table"
                    })

            logger.info(f"BigQuery tables listed: {len(tables)}")
            return tables

        except Exception as e:
            logger.error(f"BigQuery list tables failed on project {config.get('project_id')}: {str(e)}")
            raise
        finally:
            if client:
                client.close()
    
    @staticmethod
    def _list_google_sheets(
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """List sheets from the live Google Sheets workbook."""
        try:
            spreadsheet_id, connector = DataSourceConnectionService._get_google_sheets_connector(config)
            sheet_names = connector.list_sheets(spreadsheet_id)
            logger.info(f"Google Sheets list via API: {len(sheet_names)} sheets")

            tables = []
            for sheet_name in sheet_names:
                if search_query and search_query.lower() not in sheet_name.lower():
                    continue
                tables.append({
                    "name": sheet_name,
                    "schema": spreadsheet_id,
                    "type": "sheet"
                })

            return tables

        except Exception as e:
            logger.error(f"Google Sheets list failed: {str(e)}")
            raise

    @staticmethod
    def _get_google_sheets_connector(config: Dict[str, Any]):
        from app.services.google_sheets_connector import create_google_sheets_connector

        spreadsheet_id = str(config.get("spreadsheet_id") or "").strip()
        if not spreadsheet_id:
            raise ValueError("spreadsheet_id is required")
        return spreadsheet_id, create_google_sheets_connector(config)
    
    @staticmethod
    def _list_manual_tables(
        config: Dict[str, Any],
        search_query: str = None
    ) -> List[Dict[str, str]]:
        """List all sheets / tables from an imported file datasource."""
        try:
            from app.services.manual_table_connector import create_manual_table_connector
            connector = create_manual_table_connector(config)
            tables = [
                {"name": name, "schema": "manual", "type": "table"}
                for name in connector.list_sheets()
            ]
            if search_query:
                q = search_query.lower()
                tables = [t for t in tables if q in t["name"].lower()]
            logger.info(f"Manual datasource sheets listed: {len(tables)}")
            return tables
        except Exception as e:
            logger.error(f"Manual table list failed: {str(e)}")
            raise
    
    @staticmethod
    def _execute_google_sheets(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute SQL query against Google Sheets using DuckDB.

        All sheets are registered as DuckDB in-memory tables so any SQL
        (WHERE, GROUP BY, ORDER BY, JOINs, CTEs) is fully supported.
        """
        try:
            # ── Collect all sheet data from the live workbook ─────────────────
            spreadsheet_id, connector = DataSourceConnectionService._get_google_sheets_connector(config)

            sheet_names = connector.list_sheets(spreadsheet_id)
            all_sheets = {}
            for sn in sheet_names:
                data = connector.get_sheet_data(spreadsheet_id, sheet_name=sn)
                all_sheets[sn] = data
            logger.info(f"Google Sheets data via API: {len(all_sheets)} sheets")

            # ── Try DuckDB first (full SQL support) ───────────────────────────
            try:
                import duckdb
                import pyarrow as pa

                con = duckdb.connect(database=":memory:")

                for sheet_name, sheet_data in all_sheets.items():
                    rows = sheet_data.get('rows', [])
                    col_defs = sheet_data.get('columns', [])
                    col_names = [c['name'] for c in col_defs]
                    if not col_names:
                        logger.info(
                            "Skipping empty Google Sheet tab '%s' during DuckDB registration",
                            sheet_name,
                        )
                        continue

                    if rows:
                        table = _build_arrow_table_from_sheet(pa, col_defs, rows)
                    else:
                        table = pa.table({c: pa.array([], type=pa.string()) for c in col_names})

                    safe_name = sheet_name.replace(" ", "_")
                    con.register(safe_name, table)
                    if safe_name != sheet_name:
                        con.register(sheet_name, table)

                final_sql = sql_query
                if limit:
                    final_sql = f"SELECT * FROM ({sql_query}) _lim LIMIT {limit}"

                result = con.execute(final_sql)
                columns = [desc[0] for desc in result.description]
                raw_rows = result.fetchall()
                con.close()

                rows = [dict(zip(columns, row)) for row in raw_rows]
                logger.info(f"DuckDB executed Google Sheets query: {len(rows)} rows")
                return columns, rows

            except ImportError:
                logger.warning("DuckDB not available; falling back to raw sheet scan")

            # ── Fallback: raw sheet scan (simple SELECT * only) ───────────────
            from app.services.manual_table_connector import extract_sheet_name_from_sql

            parsed_name = extract_sheet_name_from_sql(sql_query)
            sheet_name = parsed_name if (parsed_name and parsed_name != 'manual_data') \
                else config.get('sheet_name')

            if sheet_name and sheet_name in all_sheets:
                sheet_data = all_sheets[sheet_name]
            elif sheet_name:
                raise ValueError(f"Sheet '{sheet_name}' not found in spreadsheet.")
            elif all_sheets:
                first = next(iter(all_sheets))
                logger.warning(f"Sheet '{sheet_name}' not found; using '{first}' instead")
                sheet_data = all_sheets[first]
            else:
                return [], []

            columns = [col['name'] for col in sheet_data.get('columns', [])]
            rows = sheet_data.get('rows', [])
            if limit:
                rows = rows[:limit]
            return columns, rows

        except Exception as e:
            logger.error(f"Google Sheets query failed: {str(e)}")
            raise
    
    @staticmethod
    def _execute_manual(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute SQL query against an imported-file datasource using DuckDB.

        All sheets are registered as in-memory tables so any SQL statement
        (WHERE, GROUP BY, ORDER BY, CTEs, JOINs across sheets) is fully supported.
        Falls back to raw sheet scan if DuckDB is not available.
        """
        try:
            from app.services.manual_table_connector import create_manual_table_connector

            connector = create_manual_table_connector(config)

            # ── Try DuckDB first (full SQL support) ──────────────────────────
            try:
                import duckdb
                import pyarrow as pa

                con = duckdb.connect(database=":memory:")

                # Create a "manual" schema so queries like "manual"."table" work
                con.execute("CREATE SCHEMA IF NOT EXISTS manual")

                # Register every sheet as a DuckDB table via PyArrow
                for sheet_name in connector.list_sheets():
                    sheet_data = connector.get_sheet_data(sheet_name)
                    rows = sheet_data.get("rows", [])
                    col_defs = sheet_data.get("columns", [])
                    col_names = [c["name"] for c in col_defs]

                    if rows:
                        table = _build_arrow_table_from_sheet(pa, col_defs, rows)
                    else:
                        table = pa.table({c: pa.array([], type=pa.string()) for c in col_names})

                    safe_name = sheet_name.replace(" ", "_")
                    # Register in main schema (default)
                    con.register(safe_name, table)
                    if safe_name != sheet_name:
                        con.register(sheet_name, table)
                    # Also register in manual schema for "manual"."table" queries
                    con.execute(f'CREATE OR REPLACE VIEW manual."{safe_name}" AS SELECT * FROM "{safe_name}"')
                    if safe_name != sheet_name:
                        con.execute(f'CREATE OR REPLACE VIEW manual."{sheet_name}" AS SELECT * FROM "{safe_name}"')

                final_sql = sql_query
                if limit:
                    final_sql = f"SELECT * FROM ({sql_query}) _lim LIMIT {limit}"

                result = con.execute(final_sql)
                columns = [desc[0] for desc in result.description]
                raw_rows = result.fetchall()
                con.close()

                rows = [dict(zip(columns, row)) for row in raw_rows]
                logger.info(f"DuckDB executed manual query: {len(rows)} rows")
                return columns, rows

            except ImportError:
                # DuckDB / pandas not installed – fall back to raw sheet scan
                logger.warning("DuckDB not available; falling back to raw sheet scan")

            # ── Fallback: raw sheet scan (simple SELECT * only) ───────────────
            from app.services.manual_table_connector import extract_sheet_name_from_sql
            sheet_name = extract_sheet_name_from_sql(sql_query)
            data = connector.get_sheet_data(sheet_name)
            columns = [col["name"] for col in data["columns"]]
            rows = data["rows"]
            if limit:
                rows = rows[:limit]
            logger.info(f"Manual table '{sheet_name}' fallback fetch: {len(rows)} rows")
            return columns, rows

        except Exception as e:
            logger.error(f"Manual table query failed: {str(e)}")
            raise

    # ── Schema Browser ────────────────────────────────────────────────────────

    @staticmethod
    def get_schema_browser(ds_type: str, config: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Return a schema-browser tree: list of schemas, each with tables/views + row counts.
        Currently implemented for PostgreSQL; other types delegate to list_tables().
        """
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)
        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_schema_browser(config)
        # Fallback: wrap list_tables() result into generic schema tree
        tables = DataSourceConnectionService.list_tables(ds_type, config)
        schema_map: Dict[str, List] = {}
        for t in tables:
            s = t.get("schema", "default")
            schema_map.setdefault(s, []).append({
                "name": t["name"].split(".")[-1],
                "type": t.get("type", "table"),
                "row_count": None,
            })
        return [{"schema": s, "tables": tbls} for s, tbls in schema_map.items()]

    @staticmethod
    def _pg_schema_browser(config: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Rich schema browser for PostgreSQL: uses pg_class for row estimates + size."""
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
            )
            cursor = conn.cursor()
            cursor.execute("""
                SELECT
                    n.nspname                        AS schema,
                    c.relname                        AS table_name,
                    CASE c.relkind
                        WHEN 'r' THEN 'table'
                        WHEN 'v' THEN 'view'
                        WHEN 'm' THEN 'materialized_view'
                        ELSE 'other'
                    END                              AS table_type,
                    GREATEST(c.reltuples::bigint, 0) AS row_count_estimate,
                    pg_total_relation_size(c.oid)    AS size_bytes
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'v', 'm')
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                ORDER BY n.nspname, c.relname
            """)
            rows = cursor.fetchall()
            schema_map: Dict[str, Dict] = {}
            for schema, name, ttype, row_count, size_bytes in rows:
                if schema not in schema_map:
                    schema_map[schema] = {"schema": schema, "tables": []}
                schema_map[schema]["tables"].append({
                    "name": name,
                    "type": ttype,
                    "row_count": row_count,
                    "size_bytes": size_bytes,
                })
            return list(schema_map.values())
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

    @staticmethod
    def get_table_detail(
        ds_type: str,
        config: Dict[str, Any],
        schema_name: str,
        table_name: str,
        preview_rows: int = 5,
    ) -> Dict[str, Any]:
        """
        Return detailed metadata for a single table: columns with PK/FK/IDX flags
        and a small preview dataset.
        """
        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_table_detail(
                config, schema_name, table_name, preview_rows
            )
        # Generic fallback using execute_query
        full_name = f'"{schema_name}"."{table_name}"'
        try:
            cols, data, _ = DataSourceConnectionService.execute_query(
                ds_type, config, f"SELECT * FROM {full_name}", limit=preview_rows
            )
            columns = [{"name": c, "type": "unknown", "nullable": True,
                        "is_primary_key": False, "is_foreign_key": False,
                        "has_index": False} for c in cols]
            return {"schema": schema_name, "name": table_name, "type": "table",
                    "row_count": None, "columns": columns, "preview": data}
        except Exception as e:
            raise ValueError(f"Cannot fetch table detail: {e}")

    @staticmethod
    def _pg_table_detail(
        config: Dict[str, Any],
        schema_name: str,
        table_name: str,
        preview_rows: int = 5,
    ) -> Dict[str, Any]:
        conn = None
        cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
            )
            cursor = conn.cursor()

            # 1. Column metadata with PK / FK / index flags
            cursor.execute("""
                SELECT
                    a.attname                                                    AS column_name,
                    pg_catalog.format_type(a.atttypid, a.atttypmod)             AS data_type,
                    NOT a.attnotnull                                             AS is_nullable,
                    COALESCE((
                        SELECT TRUE FROM pg_constraint c
                        WHERE c.conrelid = a.attrelid AND c.contype = 'p'
                          AND a.attnum = ANY(c.conkey)
                    ), FALSE)                                                    AS is_pk,
                    COALESCE((
                        SELECT TRUE FROM pg_constraint c
                        WHERE c.conrelid = a.attrelid AND c.contype = 'f'
                          AND a.attnum = ANY(c.conkey)
                    ), FALSE)                                                    AS is_fk,
                    COALESCE((
                        SELECT TRUE FROM pg_index i
                        WHERE i.indrelid = a.attrelid AND a.attnum = ANY(i.indkey)
                          AND NOT i.indisprimary
                    ), FALSE)                                                    AS has_idx
                FROM pg_attribute a
                JOIN pg_class     cl ON cl.oid = a.attrelid
                JOIN pg_namespace n  ON n.oid  = cl.relnamespace
                WHERE n.nspname = %s
                  AND cl.relname = %s
                  AND a.attnum > 0
                  AND NOT a.attisdropped
                ORDER BY a.attnum
            """, (schema_name, table_name))
            col_rows = cursor.fetchall()
            columns = [
                {
                    "name": cname,
                    "type": dtype,
                    "nullable": bool(nullable),
                    "is_primary_key": bool(is_pk),
                    "is_foreign_key": bool(is_fk),
                    "has_index": bool(has_idx),
                }
                for cname, dtype, nullable, is_pk, is_fk, has_idx in col_rows
            ]

            # 2. Row count estimate from pg_class
            cursor.execute("""
                SELECT GREATEST(c.reltuples::bigint, 0),
                       pg_total_relation_size(c.oid)
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s
            """, (schema_name, table_name))
            meta_row = cursor.fetchone()
            row_count = meta_row[0] if meta_row else None
            size_bytes = meta_row[1] if meta_row else None

            # 3. Determine table type
            cursor.execute("""
                SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view'
                                      WHEN 'm' THEN 'materialized_view' ELSE 'other' END
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = %s AND c.relname = %s
            """, (schema_name, table_name))
            type_row = cursor.fetchone()
            table_type = type_row[0] if type_row else "table"

            # 4. Preview rows — safe identifier quoting
            import psycopg2.extensions as _ext
            safe_schema = _ext.quote_ident(schema_name, conn)
            safe_table = _ext.quote_ident(table_name, conn)
            cursor.execute(f"SELECT * FROM {safe_schema}.{safe_table} LIMIT %s", (preview_rows,))
            preview_cols = [desc[0] for desc in cursor.description]
            preview_data = []
            for row in cursor.fetchall():
                preview_data.append({
                    preview_cols[i]: (str(v) if not isinstance(v, (int, float, bool, type(None))) else v)
                    for i, v in enumerate(row)
                })

            return {
                "schema": schema_name,
                "name": table_name,
                "type": table_type,
                "row_count": row_count,
                "size_bytes": size_bytes,
                "columns": columns,
                "preview": preview_data,
            }
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

    @staticmethod
    def get_watermark_candidates(
        ds_type: str,
        config: Dict[str, Any],
        schema_name: str,
        table_name: str,
    ) -> List[Dict[str, str]]:
        """Return columns suitable as watermark (timestamp/date/integer types)."""
        from app.core.crypto import decrypt_config
        config = decrypt_config(config)

        # Google Sheets and Manual datasources have no typed columns — no watermark support
        if ds_type in (DataSourceType.GOOGLE_SHEETS.value, DataSourceType.MANUAL.value):
            return []

        watermark_types = {
            "timestamp", "timestamptz", "timestamp with time zone",
            "timestamp without time zone", "date", "datetime",
            "integer", "bigint", "int4", "int8", "int64",
        }

        if ds_type == DataSourceType.POSTGRESQL.value:
            detail = DataSourceConnectionService._pg_table_detail(config, schema_name, table_name, preview_rows=0)
            return [
                {"name": c["name"], "type": c["type"]}
                for c in detail["columns"]
                if any(wt in c["type"].lower() for wt in watermark_types)
            ]

        if ds_type == DataSourceType.BIGQUERY.value:
            full_table = f"{schema_name}.{table_name}"
            columns = DataSourceConnectionService._bq_list_columns(config, full_table)
            bq_watermark_types = {
                "timestamp", "datetime", "date", "integer", "int64", "numeric",
            }
            return [
                {"name": c["name"], "type": c["type"]}
                for c in columns
                if c["type"].lower() in bq_watermark_types
            ]

        if ds_type == DataSourceType.MYSQL.value:
            database = config.get("database", schema_name)
            columns = DataSourceConnectionService._mysql_list_columns(config, database, table_name)
            return [
                {"name": c["name"], "type": c["type"]}
                for c in columns
                if any(wt in c["type"].lower() for wt in watermark_types)
            ]

        return []

    @staticmethod
    def list_columns(
        ds_id: int,
        ds_type: str,
        config: Dict[str, Any],
        table_name: str,
    ) -> List[Dict[str, str]]:
        """
        Return columns for a specific table via live source query.
        Each item: {"name": str, "type": str}
        """
        from app.core.crypto import decrypt_config

        config = decrypt_config(config)

        # Parse schema.table
        if "." in table_name:
            parts = table_name.split(".", 1)
            schema = parts[0].strip('"').strip("'")
            tbl = parts[1].strip('"').strip("'")
        else:
            schema = None
            tbl = table_name.strip('"').strip("'")

        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_list_columns(config, schema or "public", tbl)
        elif ds_type == DataSourceType.MYSQL.value:
            return DataSourceConnectionService._mysql_list_columns(config, schema or config.get("database", ""), tbl)
        elif ds_type == DataSourceType.BIGQUERY.value:
            return DataSourceConnectionService._bq_list_columns(config, table_name)
        elif ds_type == DataSourceType.GOOGLE_SHEETS.value:
            return DataSourceConnectionService._google_sheets_list_columns(config, tbl)
        elif ds_type == DataSourceType.MANUAL.value:
            return DataSourceConnectionService._sheets_list_columns(config, tbl)
        return []

    @staticmethod
    def list_foreign_keys(
        ds_type: str,
        config: Dict[str, Any],
        table_names: List[str],
    ) -> List[Dict[str, Any]]:
        """Phase-15.69 — pull FK constraints from the source DB's
        INFORMATION_SCHEMA (or equivalent) for a given set of tables.

        Returns a flat list:
          [
            {
              "from_schema": "public", "from_table": "orders",
              "from_column": "user_id",
              "to_schema": "public", "to_table": "users",
              "to_column": "id",
            },
            ...
          ]

        Only includes FKs where BOTH endpoints are in `table_names`
        (qualified `schema.table` strings) so we don't pollute the
        model with joins to tables the dataset doesn't import.

        Google Sheets / Manual / BigQuery (no real FK metadata)
        return []. BigQuery does have INFORMATION_SCHEMA but FKs are
        decorative only (not enforced) — still useful as hints when DA
        author keys them, so we read them too.
        """
        from app.core.crypto import decrypt_config

        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_list_foreign_keys(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.MYSQL.value:
            return DataSourceConnectionService._mysql_list_foreign_keys(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.BIGQUERY.value:
            return DataSourceConnectionService._bq_list_foreign_keys(
                decrypt_config(config), table_names
            )
        return []

    @staticmethod
    def _pg_list_foreign_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> List[Dict[str, Any]]:
        """Postgres: read pg_constraint + pg_attribute for type='f' (FK)."""
        if not table_names:
            return []
        # Build the (schema, table) tuple list for IN clause.
        pairs: List[tuple[str, str]] = []
        for raw in table_names:
            if "." in raw:
                s, t = raw.split(".", 1)
            else:
                s, t = "public", raw
            pairs.append((s.strip('"').strip("'"), t.strip('"').strip("'")))
        if not pairs:
            return []
        sql = """
            SELECT
                src_ns.nspname  AS from_schema,
                src_tbl.relname AS from_table,
                src_col.attname AS from_column,
                dst_ns.nspname  AS to_schema,
                dst_tbl.relname AS to_table,
                dst_col.attname AS to_column
            FROM pg_constraint c
            JOIN pg_class    src_tbl ON src_tbl.oid = c.conrelid
            JOIN pg_namespace src_ns ON src_ns.oid = src_tbl.relnamespace
            JOIN pg_class    dst_tbl ON dst_tbl.oid = c.confrelid
            JOIN pg_namespace dst_ns ON dst_ns.oid = dst_tbl.relnamespace
            JOIN unnest(c.conkey)  WITH ORDINALITY AS src_attr(attnum, ord) ON TRUE
            JOIN unnest(c.confkey) WITH ORDINALITY AS dst_attr(attnum, ord)
                 ON src_attr.ord = dst_attr.ord
            JOIN pg_attribute src_col
                 ON src_col.attrelid = c.conrelid AND src_col.attnum = src_attr.attnum
            JOIN pg_attribute dst_col
                 ON dst_col.attrelid = c.confrelid AND dst_col.attnum = dst_attr.attnum
            WHERE c.contype = 'f'
        """
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql)
            allowed = {(s, t) for s, t in pairs}
            out: List[Dict[str, Any]] = []
            for row in cur.fetchall():
                fs, ft, fc, ts, tt, tc = row
                if (fs, ft) not in allowed or (ts, tt) not in allowed:
                    continue
                out.append({
                    "from_schema": fs, "from_table": ft, "from_column": fc,
                    "to_schema": ts, "to_table": tt, "to_column": tc,
                })
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[fk_extract] Postgres FK query failed: {exc}")
            return []

    @staticmethod
    def _mysql_list_foreign_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> List[Dict[str, Any]]:
        """MySQL: KEY_COLUMN_USAGE filtered to FK rows."""
        if not table_names:
            return []
        # MySQL doesn't really use schema; use db name as the schema.
        db_name = config.get("database") or ""
        bare_tables = []
        for raw in table_names:
            if "." in raw:
                _, t = raw.split(".", 1)
            else:
                t = raw
            bare_tables.append(t.strip('"').strip("'").strip("`"))
        if not bare_tables:
            return []
        placeholders = ",".join(["%s"] * len(bare_tables))
        sql = f"""
            SELECT
                TABLE_SCHEMA            AS from_schema,
                TABLE_NAME              AS from_table,
                COLUMN_NAME             AS from_column,
                REFERENCED_TABLE_SCHEMA AS to_schema,
                REFERENCED_TABLE_NAME   AS to_table,
                REFERENCED_COLUMN_NAME  AS to_column
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE REFERENCED_TABLE_NAME IS NOT NULL
              AND TABLE_SCHEMA = %s
              AND TABLE_NAME IN ({placeholders})
        """
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=int(config.get("port", 3306)),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
                read_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql, [db_name, *bare_tables])
            allowed = set(bare_tables)
            out: List[Dict[str, Any]] = []
            for row in cur.fetchall():
                fs, ft, fc, ts, tt, tc = row
                if ft not in allowed or tt not in allowed:
                    continue
                out.append({
                    "from_schema": fs, "from_table": ft, "from_column": fc,
                    "to_schema": ts, "to_table": tt, "to_column": tc,
                })
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[fk_extract] MySQL FK query failed: {exc}")
            return []

    @staticmethod
    def _bq_list_foreign_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> List[Dict[str, Any]]:
        """BigQuery: INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE +
        TABLE_CONSTRAINTS. FKs decorative only (not enforced) but DAs
        who model them get free join suggestions.

        BigQuery requires querying per-dataset INFORMATION_SCHEMA; we
        group `table_names` by their dataset (the `schema` part).
        """
        if not table_names:
            return []
        by_dataset: Dict[str, List[str]] = {}
        for raw in table_names:
            if "." in raw:
                parts = raw.split(".")
                if len(parts) == 2:
                    ds, t = parts
                elif len(parts) >= 3:
                    # project.dataset.table
                    ds = parts[-2]
                    t = parts[-1]
                else:
                    continue
            else:
                continue
            by_dataset.setdefault(ds.strip("`"), []).append(t.strip("`"))
        if not by_dataset:
            return []
        try:
            client = _build_bigquery_client(config)
            project_id = config.get("project_id")
            out: List[Dict[str, Any]] = []
            for ds_name, tables in by_dataset.items():
                # BigQuery FKs: TABLE_CONSTRAINTS where CONSTRAINT_TYPE='FOREIGN KEY'
                # then join CONSTRAINT_COLUMN_USAGE for both sides.
                allowed = set(tables)
                sql = f"""
                    SELECT
                      kcu.table_schema      AS from_schema,
                      kcu.table_name        AS from_table,
                      kcu.column_name       AS from_column,
                      ccu.table_schema      AS to_schema,
                      ccu.table_name        AS to_table,
                      ccu.column_name       AS to_column
                    FROM `{project_id}.{ds_name}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS` tc
                    JOIN `{project_id}.{ds_name}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE` kcu
                      ON tc.constraint_name = kcu.constraint_name
                      AND tc.table_schema = kcu.table_schema
                    JOIN `{project_id}.{ds_name}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE` ccu
                      ON tc.constraint_name = ccu.constraint_name
                      AND tc.table_schema = ccu.table_schema
                    WHERE tc.constraint_type = 'FOREIGN KEY'
                """
                job = client.query(sql)
                for row in job.result(timeout=30):
                    fs, ft, fc, ts, tt, tc = (
                        row["from_schema"], row["from_table"], row["from_column"],
                        row["to_schema"], row["to_table"], row["to_column"],
                    )
                    if ft not in allowed:
                        continue
                    out.append({
                        "from_schema": fs, "from_table": ft, "from_column": fc,
                        "to_schema": ts, "to_table": tt, "to_column": tc,
                    })
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[fk_extract] BigQuery FK query failed: {exc}")
            return []

    @staticmethod
    def list_primary_keys(
        ds_type: str,
        config: Dict[str, Any],
        table_names: List[str],
    ) -> Dict[str, List[str]]:
        """Phase-16 — fetch primary-key columns per table.

        Returns ``{"schema.table": ["pk_col1", ...], ...}``. Tables with
        composite PKs return the ordered list of columns. Tables with no
        declared PK are absent. The relationship review modal uses this
        to anchor pass 2 ("name match") on the real PK instead of
        assuming `.id`, and to set cardinality correctly in pass 3 (a
        column joining onto a PK is necessarily many_to_one).
        """
        from app.core.crypto import decrypt_config

        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_list_primary_keys(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.MYSQL.value:
            return DataSourceConnectionService._mysql_list_primary_keys(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.BIGQUERY.value:
            return DataSourceConnectionService._bq_list_primary_keys(
                decrypt_config(config), table_names
            )
        return {}

    @staticmethod
    def list_source_column_types(
        ds_type: str,
        config: Dict[str, Any],
        table_names: List[str],
    ) -> Dict[str, Dict[str, str]]:
        """Phase-16 — fetch the source DB's declared column type per table.

        Returns ``{"schema.table": {"col_name": "raw_db_type", ...}, ...}``.
        The raw type is the value the DB returns in INFORMATION_SCHEMA
        (e.g. "uuid", "bigint", "character varying", "varchar(36)") —
        more discriminating than AppBI's normalised cache labels, which
        collapse every numeric into "number" and every text into "string".
        """
        from app.core.crypto import decrypt_config

        if ds_type == DataSourceType.POSTGRESQL.value:
            return DataSourceConnectionService._pg_list_source_column_types(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.MYSQL.value:
            return DataSourceConnectionService._mysql_list_source_column_types(
                decrypt_config(config), table_names
            )
        if ds_type == DataSourceType.BIGQUERY.value:
            return DataSourceConnectionService._bq_list_source_column_types(
                decrypt_config(config), table_names
            )
        return {}

    @staticmethod
    def _pg_list_primary_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, List[str]]:
        if not table_names:
            return {}
        pairs: List[tuple[str, str]] = []
        for raw in table_names:
            if "." in raw:
                s, t = raw.split(".", 1)
            else:
                s, t = "public", raw
            pairs.append((s.strip('"').strip("'"), t.strip('"').strip("'")))
        if not pairs:
            return {}
        sql = """
            SELECT
                ns.nspname  AS schema_name,
                tbl.relname AS table_name,
                att.attname AS column_name,
                src_attr.ord AS ord
            FROM pg_constraint c
            JOIN pg_class     tbl ON tbl.oid = c.conrelid
            JOIN pg_namespace ns  ON ns.oid = tbl.relnamespace
            JOIN unnest(c.conkey) WITH ORDINALITY AS src_attr(attnum, ord) ON TRUE
            JOIN pg_attribute att
                 ON att.attrelid = c.conrelid AND att.attnum = src_attr.attnum
            WHERE c.contype = 'p'
            ORDER BY ns.nspname, tbl.relname, src_attr.ord
        """
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql)
            allowed = {(s, t) for s, t in pairs}
            out: Dict[str, List[str]] = {}
            for schema_name, table_name, column_name, _ord in cur.fetchall():
                if (schema_name, table_name) not in allowed:
                    continue
                key = f"{schema_name}.{table_name}"
                out.setdefault(key, []).append(column_name)
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[pk_extract] Postgres PK query failed: {exc}")
            return {}

    @staticmethod
    def _mysql_list_primary_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, List[str]]:
        if not table_names:
            return {}
        db_name = config.get("database") or ""
        bare_tables = []
        for raw in table_names:
            if "." in raw:
                _, t = raw.split(".", 1)
            else:
                t = raw
            bare_tables.append(t.strip('"').strip("'").strip("`"))
        if not bare_tables:
            return {}
        placeholders = ",".join(["%s"] * len(bare_tables))
        sql = f"""
            SELECT
                TABLE_SCHEMA,
                TABLE_NAME,
                COLUMN_NAME,
                ORDINAL_POSITION
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE CONSTRAINT_NAME = 'PRIMARY'
              AND TABLE_SCHEMA = %s
              AND TABLE_NAME IN ({placeholders})
            ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
        """
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=int(config.get("port", 3306)),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
                read_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql, [db_name, *bare_tables])
            out: Dict[str, List[str]] = {}
            for schema_name, table_name, column_name, _ord in cur.fetchall():
                key = f"{schema_name}.{table_name}"
                out.setdefault(key, []).append(column_name)
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[pk_extract] MySQL PK query failed: {exc}")
            return {}

    @staticmethod
    def _bq_list_primary_keys(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, List[str]]:
        if not table_names:
            return {}
        by_dataset: Dict[str, List[str]] = {}
        for raw in table_names:
            if "." in raw:
                parts = raw.split(".")
                if len(parts) == 2:
                    ds, t = parts
                elif len(parts) >= 3:
                    ds = parts[-2]
                    t = parts[-1]
                else:
                    continue
            else:
                continue
            by_dataset.setdefault(ds.strip("`"), []).append(t.strip("`"))
        if not by_dataset:
            return {}
        out: Dict[str, List[str]] = {}
        try:
            client = _build_bigquery_client(config)
            project_id = config.get("project_id")
            for ds_name, tables in by_dataset.items():
                allowed = set(tables)
                sql = f"""
                    SELECT
                      kcu.table_schema, kcu.table_name, kcu.column_name, kcu.ordinal_position
                    FROM `{project_id}.{ds_name}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS` tc
                    JOIN `{project_id}.{ds_name}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE` kcu
                      ON tc.constraint_name = kcu.constraint_name
                     AND tc.table_schema = kcu.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                    ORDER BY kcu.table_schema, kcu.table_name, kcu.ordinal_position
                """
                job = client.query(sql)
                for row in job.result(timeout=30):
                    schema_name = row["table_schema"]
                    table_name = row["table_name"]
                    if table_name not in allowed:
                        continue
                    key = f"{schema_name}.{table_name}"
                    out.setdefault(key, []).append(row["column_name"])
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[pk_extract] BigQuery PK query failed: {exc}")
            return {}

    @staticmethod
    def _pg_list_source_column_types(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, Dict[str, str]]:
        if not table_names:
            return {}
        pairs: List[tuple[str, str]] = []
        for raw in table_names:
            if "." in raw:
                s, t = raw.split(".", 1)
            else:
                s, t = "public", raw
            pairs.append((s.strip('"').strip("'"), t.strip('"').strip("'")))
        if not pairs:
            return {}
        sql = """
            SELECT
                table_schema,
                table_name,
                column_name,
                data_type,
                udt_name,
                character_maximum_length
            FROM information_schema.columns
        """
        try:
            conn = psycopg2.connect(
                host=config.get("host"),
                port=config.get("port", 5432),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql)
            allowed = {(s, t) for s, t in pairs}
            out: Dict[str, Dict[str, str]] = {}
            for schema_name, table_name, column_name, data_type, udt_name, char_max in cur.fetchall():
                if (schema_name, table_name) not in allowed:
                    continue
                # Prefer udt_name for postgres-specific types (uuid, jsonb) —
                # data_type collapses uuid into "uuid" already but for arrays
                # it gives "ARRAY" which loses the element type.
                resolved_type = str(udt_name or data_type or "").lower()
                if char_max is not None and resolved_type in {"varchar", "character varying", "char", "character"}:
                    resolved_type = f"{resolved_type}({int(char_max)})"
                key = f"{schema_name}.{table_name}"
                out.setdefault(key, {})[column_name] = resolved_type
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[type_extract] Postgres column types query failed: {exc}")
            return {}

    @staticmethod
    def _mysql_list_source_column_types(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, Dict[str, str]]:
        if not table_names:
            return {}
        db_name = config.get("database") or ""
        bare_tables = []
        for raw in table_names:
            if "." in raw:
                _, t = raw.split(".", 1)
            else:
                t = raw
            bare_tables.append(t.strip('"').strip("'").strip("`"))
        if not bare_tables:
            return {}
        placeholders = ",".join(["%s"] * len(bare_tables))
        sql = f"""
            SELECT
                TABLE_SCHEMA,
                TABLE_NAME,
                COLUMN_NAME,
                COLUMN_TYPE
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s
              AND TABLE_NAME IN ({placeholders})
        """
        try:
            conn = pymysql.connect(
                host=config.get("host"),
                port=int(config.get("port", 3306)),
                database=config.get("database"),
                user=config.get("username"),
                password=config.get("password"),
                connect_timeout=10,
                read_timeout=10,
            )
            cur = conn.cursor()
            cur.execute(sql, [db_name, *bare_tables])
            out: Dict[str, Dict[str, str]] = {}
            for schema_name, table_name, column_name, column_type in cur.fetchall():
                key = f"{schema_name}.{table_name}"
                out.setdefault(key, {})[column_name] = str(column_type or "").lower()
            cur.close()
            conn.close()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[type_extract] MySQL column types query failed: {exc}")
            return {}

    @staticmethod
    def _bq_list_source_column_types(
        config: Dict[str, Any], table_names: List[str]
    ) -> Dict[str, Dict[str, str]]:
        if not table_names:
            return {}
        by_dataset: Dict[str, List[str]] = {}
        for raw in table_names:
            if "." in raw:
                parts = raw.split(".")
                if len(parts) == 2:
                    ds, t = parts
                elif len(parts) >= 3:
                    ds = parts[-2]
                    t = parts[-1]
                else:
                    continue
            else:
                continue
            by_dataset.setdefault(ds.strip("`"), []).append(t.strip("`"))
        if not by_dataset:
            return {}
        out: Dict[str, Dict[str, str]] = {}
        try:
            client = _build_bigquery_client(config)
            project_id = config.get("project_id")
            for ds_name, tables in by_dataset.items():
                allowed = set(tables)
                sql = f"""
                    SELECT table_schema, table_name, column_name, data_type
                    FROM `{project_id}.{ds_name}.INFORMATION_SCHEMA.COLUMNS`
                """
                job = client.query(sql)
                for row in job.result(timeout=30):
                    schema_name = row["table_schema"]
                    table_name = row["table_name"]
                    if table_name not in allowed:
                        continue
                    key = f"{schema_name}.{table_name}"
                    out.setdefault(key, {})[row["column_name"]] = str(row["data_type"] or "").lower()
            return out
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[type_extract] BigQuery column types query failed: {exc}")
            return {}

    @staticmethod
    def _pg_list_columns(config: Dict[str, Any], schema: str, table: str) -> List[Dict[str, str]]:
        conn = cursor = None
        try:
            conn = psycopg2.connect(
                host=config.get("host"), port=config.get("port", 5432),
                database=config.get("database"), user=config.get("username"),
                password=config.get("password"),
            )
            cursor = conn.cursor()
            cursor.execute(
                """SELECT column_name, data_type
                   FROM information_schema.columns
                   WHERE table_schema = %s AND table_name = %s
                   ORDER BY ordinal_position""",
                (schema, table),
            )
            return [{"name": r[0], "type": r[1]} for r in cursor.fetchall()]
        finally:
            if cursor: cursor.close()
            if conn: conn.close()

    @staticmethod
    def _mysql_list_columns(config: Dict[str, Any], database: str, table: str) -> List[Dict[str, str]]:
        conn = cursor = None
        try:
            conn = pymysql.connect(
                host=config.get("host"), port=config.get("port", 3306),
                user=config.get("username"), password=config.get("password"),
            )
            cursor = conn.cursor()
            cursor.execute(
                """SELECT COLUMN_NAME, DATA_TYPE
                   FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
                   ORDER BY ORDINAL_POSITION""",
                (database, table),
            )
            return [{"name": r[0], "type": r[1]} for r in cursor.fetchall()]
        finally:
            if cursor: cursor.close()
            if conn: conn.close()

    @staticmethod
    def _bq_list_columns(config: Dict[str, Any], full_table: str) -> List[Dict[str, str]]:
        client = None
        try:
            project_id = config.get("project_id", "")
            client = _build_bigquery_client(config)
            parts = full_table.split(".")
            if len(parts) >= 3:
                # Already fully-qualified: project.dataset.table
                table_ref_str = full_table
            elif len(parts) == 2:
                # dataset.table — prefix with project so cross-project refs work
                table_ref_str = f"{project_id}.{parts[0]}.{parts[1]}"
            else:
                table_ref_str = full_table
            table_ref = client.get_table(table_ref_str)
            return [{"name": f.name, "type": f.field_type} for f in table_ref.schema]
        except Exception as e:
            logger.warning(f"_bq_list_columns failed for table '{full_table}': {e}")
            return []
        finally:
            if client:
                client.close()

    @staticmethod
    def _sheets_list_columns(config: Dict[str, Any], sheet_name: str) -> List[Dict[str, str]]:
        """Get column headers from a Manual (CSV/Excel) cached snapshot.
        Config format: {"sheets": {sheet_name: {"columns": [{name, type}], "rows": [...]}}}
        """
        try:
            cached_sheets = config.get("sheets", {})
            sheet_data = cached_sheets.get(sheet_name) or (list(cached_sheets.values())[0] if cached_sheets else None)
            if not sheet_data:
                return []
            # Format A: {"columns": [{name, type}, ...], "rows": [...]}
            if isinstance(sheet_data, dict) and "columns" in sheet_data:
                cols = sheet_data["columns"]
                return [
                    {"name": c["name"] if isinstance(c, dict) else str(c),
                     "type": c.get("type", "string") if isinstance(c, dict) else "string"}
                    for c in cols if c
                ]
            # Format B: [[header1, header2, ...], [row1...], ...]
            if isinstance(sheet_data, list) and len(sheet_data) > 0:
                headers = sheet_data[0]
                if isinstance(headers, list):
                    return [{"name": str(h), "type": "string"} for h in headers if h]
                if isinstance(headers, dict):
                    return [{"name": k, "type": "string"} for k in headers.keys()]
            return []
        except Exception:
            return []

    @staticmethod
    def _google_sheets_list_columns(config: Dict[str, Any], sheet_name: str) -> List[Dict[str, str]]:
        """Get column headers from the live Google Sheets workbook."""
        try:
            spreadsheet_id, connector = DataSourceConnectionService._get_google_sheets_connector(config)
            target_sheet = str(sheet_name or config.get("sheet_name") or "").strip()
            if not target_sheet:
                sheet_names = connector.list_sheets(spreadsheet_id)
                target_sheet = sheet_names[0] if sheet_names else ""
            if not target_sheet:
                return []
            data = connector.get_sheet_data(spreadsheet_id, sheet_name=target_sheet)
            return [
                {
                    "name": col["name"] if isinstance(col, dict) else str(col),
                    "type": col.get("type", "string") if isinstance(col, dict) else "string",
                }
                for col in data.get("columns", [])
                if col
            ]
        except Exception:
            return []
