"""
Data source connection service.
Handles connecting to and querying external data sources.
"""
import base64
import time
from typing import Generator, Iterator, List, Dict, Any, Tuple
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

logger = get_logger(__name__)


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
            credentials_info = json.loads(_resolve_gcp_credentials_json(config))
            credentials = service_account.Credentials.from_service_account_info(credentials_info)
            client = bigquery.Client(
                credentials=credentials,
                project=config.get("project_id")
            )
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
                            "Check that the service account has bigquery.datasets.list on the project, "
                            "or set a Default Dataset to target a specific dataset."
                        )
                except Exception as e:
                    return True, f"Connection successful, but could not list datasets: {e}. Set a Default Dataset if the service account only has per-dataset access."

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
                result = DataSourceConnectionService._execute_bigquery(config, sql_query, limit, timeout_seconds)
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
            query = sql_query
            if limit:
                query = f"{sql_query.rstrip(';')} LIMIT {limit}"
            
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
            query = sql_query
            if limit:
                query = f"{sql_query.rstrip(';')} LIMIT {limit}"
            
            cursor.execute(query, query_params)
            
            # Get column names
            columns = [desc[0] for desc in cursor.description]
            
            # Fetch data
            rows = cursor.fetchall()
            data = [dict(zip(columns, row)) for row in rows]
            
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
        timeout_seconds: int = 30
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute query against BigQuery."""
        client = None
        try:
            credentials_info = json.loads(_resolve_gcp_credentials_json(config))
            credentials = service_account.Credentials.from_service_account_info(credentials_info)
            project_id = config.get("project_id")
            
            client = bigquery.Client(
                credentials=credentials,
                project=project_id
            )
            
            # Apply limit if specified
            query = sql_query
            if limit:
                query = f"{sql_query.rstrip(';')} LIMIT {limit}"
            
            logger.info(f"Executing BigQuery query on project {project_id}")
            
            query_job = client.query(query)
            
            # Apply timeout when fetching results
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

    # ── Streaming methods (for sync / large-table ingestion) ──────────────────
    # These return (columns, generator_of_row_batches) so callers can write
    # data to Parquet incrementally without loading the entire result set into
    # RAM.  Each yielded batch is a list of dicts with at most `batch_size`
    # items.

    STREAM_BATCH_SIZE = 10_000

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
        credentials_info = json.loads(_resolve_gcp_credentials_json(config))
        credentials = service_account.Credentials.from_service_account_info(credentials_info)
        project_id = config.get("project_id")

        client = bigquery.Client(credentials=credentials, project=project_id)

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

        credentials_info = json.loads(_resolve_gcp_credentials_json(config))
        credentials = service_account.Credentials.from_service_account_info(credentials_info)
        project_id = config.get("project_id")

        client = bigquery.Client(credentials=credentials, project=project_id)

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
            List of column metadata dicts with 'name' and 'type'
        """
        try:
            if ds_type == DataSourceType.POSTGRESQL.value:
                return DataSourceConnectionService._infer_postgresql_types(config, sql_query)
            elif ds_type == DataSourceType.MYSQL.value:
                return DataSourceConnectionService._infer_mysql_types(config, sql_query)
            elif ds_type == DataSourceType.BIGQUERY.value:
                return DataSourceConnectionService._infer_bigquery_types(config, sql_query)
            elif ds_type == DataSourceType.MANUAL.value or ds_type == DataSourceType.GOOGLE_SHEETS.value:
                return DataSourceConnectionService._infer_manual_types(config, sql_query)
            else:
                raise ValueError(f"Unsupported data source type: {ds_type}")
        except Exception as e:
            logger.error(f"Type inference failed: {str(e)}")
            raise
    
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
            credentials_info = json.loads(_resolve_gcp_credentials_json(config))
            credentials = service_account.Credentials.from_service_account_info(credentials_info)
            project_id = config.get("project_id")
            
            client = bigquery.Client(
                credentials=credentials,
                project=project_id
            )
            
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
        """Infer column types for Manual Table / Google Sheets datasources."""
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
            credentials_info = json.loads(_resolve_gcp_credentials_json(config))
            credentials = service_account.Credentials.from_service_account_info(credentials_info)
            project_id = config.get("project_id")

            client = bigquery.Client(
                credentials=credentials,
                project=project_id
            )

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
        """List sheets from Google Sheets.

        Prefers the local snapshot in config['sheets'] so no live API call is
        made after the first connection.  Falls back to a live API call when
        the snapshot is absent (e.g. datasources created before this change).
        """
        try:
            spreadsheet_id = config.get('spreadsheet_id', '')

            # --- use cached snapshot if available ---
            cached_sheets = config.get('sheets')
            if cached_sheets:
                sheet_names = list(cached_sheets.keys())
                logger.info(f"Google Sheets list from cache: {len(sheet_names)} sheets")
            else:
                # fallback: live API call
                from app.services.google_sheets_connector import create_google_sheets_connector
                if not spreadsheet_id:
                    raise ValueError("spreadsheet_id is required")
                connector = create_google_sheets_connector(config)
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
        """Execute query against Google Sheets.

        Sheet resolution order:
          1. Parse the sheet name from the SQL (e.g. SELECT * FROM "Sheet1")
          2. Look it up in the local snapshot (config['sheets']) — no API call
          3. Fall back to a live API call when the snapshot is missing
        """
        try:
            from app.services.manual_table_connector import extract_sheet_name_from_sql

            # Determine which sheet the query is targeting
            parsed_name = extract_sheet_name_from_sql(sql_query)
            # extract_sheet_name_from_sql returns 'manual_data' as sentinel when not found
            sheet_name = parsed_name if (parsed_name and parsed_name != 'manual_data') \
                else config.get('sheet_name')

            cached_sheets = config.get('sheets')

            if cached_sheets:
                # Resolve sheet: exact match → first available
                if sheet_name and sheet_name in cached_sheets:
                    sheet_data = cached_sheets[sheet_name]
                elif cached_sheets:
                    first = next(iter(cached_sheets))
                    logger.warning(
                        f"Sheet '{sheet_name}' not in snapshot; using '{first}' instead"
                    )
                    sheet_data = cached_sheets[first]
                else:
                    return [], []

                columns = [col['name'] for col in sheet_data.get('columns', [])]
                rows = sheet_data.get('rows', [])
                logger.info(f"Google Sheets data from cache: {len(rows)} rows")
            else:
                # No snapshot — live API call
                from app.services.google_sheets_connector import create_google_sheets_connector
                connector = create_google_sheets_connector(config)
                spreadsheet_id = config.get('spreadsheet_id')
                data = connector.get_sheet_data(spreadsheet_id, sheet_name=sheet_name)
                columns = [col['name'] for col in data['columns']]
                rows = data['rows']
                logger.info(f"Google Sheets data via API: {len(rows)} rows")

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
                        # Build columnar arrays from row-oriented data
                        arrays = []
                        for c in col_names:
                            arrays.append(pa.array([r.get(c) for r in rows]))
                        table = pa.table(dict(zip(col_names, arrays)))
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
        Return columns for a specific table.
        Tries DuckDB synced view first (no live call), falls back to live source.
        Each item: {"name": str, "type": str}
        """
        from app.core.crypto import decrypt_config
        from app.services.sync_engine import get_synced_view
        from app.services.duckdb_engine import DuckDBEngine

        # --- Try DuckDB synced view first ---
        try:
            view_name = get_synced_view(ds_id, table_name)
            if view_name:
                with DuckDBEngine.read_conn() as conn:
                    rows = conn.execute(f"DESCRIBE {view_name}").fetchall()
                return [{"name": r[0], "type": r[1]} for r in rows]
        except Exception:
            pass

        # --- Fallback: live source (schema/metadata only, no data) ---
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
        elif ds_type in (DataSourceType.GOOGLE_SHEETS.value, DataSourceType.MANUAL.value):
            return DataSourceConnectionService._sheets_list_columns(config, tbl)
        return []

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
            credentials_info = json.loads(_resolve_gcp_credentials_json(config))
            credentials = service_account.Credentials.from_service_account_info(credentials_info)
            project_id = config.get("project_id", "")
            client = bigquery.Client(credentials=credentials, project=project_id)
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
        """Get column headers from Google Sheets / Manual (CSV/Excel) cached snapshot.
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
