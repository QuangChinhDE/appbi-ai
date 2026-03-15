"""
Data source connection service.
Handles connecting to and querying external data sources.
"""
import time
from typing import List, Dict, Any, Tuple
import pymysql
import psycopg2
from google.cloud import bigquery
from google.oauth2 import service_account
import json

from app.core.logging import get_logger
from app.models import DataSourceType
from app.services.sql_validator import validate_select_only
from app.services.google_sheets_connector import create_google_sheets_connector
from app.services.manual_table_connector import create_manual_table_connector

logger = get_logger(__name__)


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
        try:
            credentials_info = json.loads(config.get("credentials_json", "{}"))
            credentials = service_account.Credentials.from_service_account_info(credentials_info)
            client = bigquery.Client(
                credentials=credentials,
                project=config.get("project_id")
            )
            # Test with a simple query
            query = "SELECT 1"
            client.query(query).result()
            return True, "Connection successful"
        except Exception as e:
            return False, str(e)
    
    @staticmethod
    def _test_google_sheets(config: Dict[str, Any]) -> Tuple[bool, str]:
        """Test Google Sheets connection."""
        try:
            connector = create_google_sheets_connector(config)
            if connector.test_connection():
                return True, "Connection successful"
            return False, "Failed to connect to Google Sheets"
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
        timeout_seconds: int = 30
    ) -> Tuple[List[str], List[Dict[str, Any]], float]:
        """
        Execute a SQL query against a data source.
        
        Args:
            ds_type: Type of data source
            config: Connection configuration
            sql_query: SQL query to execute
            limit: Optional row limit
            timeout_seconds: Query timeout in seconds (default: 30)
            
        Returns:
            Tuple of (columns, data, execution_time_ms)
            
        Raises:
            ValueError: If query is not a SELECT statement
        """
        # Validate SQL query for safety
        validate_select_only(sql_query)
        
        start_time = time.time()
        
        try:
            if ds_type == DataSourceType.POSTGRESQL.value:
                result = DataSourceConnectionService._execute_postgresql(config, sql_query, limit, timeout_seconds)
            elif ds_type == DataSourceType.MYSQL.value:
                result = DataSourceConnectionService._execute_mysql(config, sql_query, limit, timeout_seconds)
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
    def _execute_postgresql(
        config: Dict[str, Any],
        sql_query: str,
        limit: int = None,
        timeout_seconds: int = 30
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
            
            cursor.execute(query)
            
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
        timeout_seconds: int = 30
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
            
            cursor.execute(query)
            
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
        timeout_seconds: int = 30
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """Execute query against BigQuery."""
        client = None
        try:
            credentials_info = json.loads(config.get("credentials_json", "{}"))
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
            credentials_info = json.loads(config.get("credentials_json", "{}"))
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
                query += f" AND table_name ILIKE '%{search_query}%'"
            
            query += " ORDER BY table_schema, table_name"
            
            cursor.execute(query)
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
            query = f"""
                SELECT 
                    TABLE_NAME,
                    TABLE_TYPE
                FROM information_schema.tables
                WHERE TABLE_SCHEMA = '{database}'
            """
            
            if search_query:
                query += f" AND TABLE_NAME LIKE '%{search_query}%'"
            
            query += " ORDER BY TABLE_NAME"
            
            cursor.execute(query)
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
            credentials_info = json.loads(config.get("credentials_json", "{}"))
            credentials = service_account.Credentials.from_service_account_info(credentials_info)
            project_id = config.get("project_id")
            
            client = bigquery.Client(
                credentials=credentials,
                project=project_id
            )
            
            logger.info(f"Listing BigQuery tables for project {project_id}")
            
            # List all datasets
            datasets = list(client.list_datasets())
            
            tables = []
            for dataset in datasets:
                dataset_id = dataset.dataset_id
                
                # List tables in dataset
                dataset_tables = list(client.list_tables(dataset_id))
                
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
        """Execute query against an imported-file datasource (returns data for the named sheet)."""
        try:
            from app.services.manual_table_connector import create_manual_table_connector, extract_sheet_name_from_sql

            connector = create_manual_table_connector(config)
            sheet_name = extract_sheet_name_from_sql(sql_query)
            data = connector.get_sheet_data(sheet_name)

            columns = [col['name'] for col in data['columns']]
            rows = data['rows']

            if limit:
                rows = rows[:limit]

            logger.info(f"Manual table '{sheet_name}' data fetched: {len(rows)} rows")
            return columns, rows

        except Exception as e:
            logger.error(f"Manual table query failed: {str(e)}")
            raise
