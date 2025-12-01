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
            
            # Fetch data
            data = []
            for row in results:
                data.append(dict(row.items()))
            
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
