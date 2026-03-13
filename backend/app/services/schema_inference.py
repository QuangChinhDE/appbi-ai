"""
Schema inference utilities for datasets.

Provides methods to infer column names and types from SQL queries
by executing them with LIMIT 0 and inspecting cursor metadata.
"""

from typing import List, Dict, Any
from sqlalchemy.orm import Session

from app.models.models import DataSource
from app.services.datasource_service import DataSourceConnectionService


def infer_schema_from_sql(
    db: Session,
    datasource: DataSource,
    sql_query: str,
    timeout: int = 30
) -> List[Dict[str, str]]:
    """
    Infer column schema from a SQL query by executing it with LIMIT 0.
    
    Args:
        db: Database session
        datasource: DataSource model instance
        sql_query: SQL query to analyze
        timeout: Query timeout in seconds
    
    Returns:
        List of column metadata dictionaries with 'name' and 'type' keys
    """
    try:
        # Use existing DataSourceConnectionService.infer_column_types
        columns = DataSourceConnectionService.infer_column_types(
            datasource.type.value,
            datasource.config,
            sql_query
        )
        return columns
    
    except Exception as e:
        # If inference fails, return empty list
        print(f"Schema inference failed: {str(e)}")
        return []


def _map_python_type_to_string(python_type) -> str:
    """
    Map Python DB-API type code to string type name.
    
    Args:
        python_type: Type code from cursor description
    
    Returns:
        String type name (e.g., 'integer', 'string', 'date')
    """
    type_name = str(python_type).lower()
    
    # PostgreSQL types
    if 'int' in type_name or 'serial' in type_name or 'bigint' in type_name:
        return 'integer'
    elif 'numeric' in type_name or 'decimal' in type_name or 'money' in type_name:
        return 'number'
    elif 'float' in type_name or 'double' in type_name or 'real' in type_name:
        return 'float'
    elif 'bool' in type_name:
        return 'boolean'
    elif 'date' in type_name and 'time' not in type_name:
        return 'date'
    elif 'timestamp' in type_name or 'datetime' in type_name:
        return 'datetime'
    elif 'time' in type_name:
        return 'time'
    elif 'json' in type_name:
        return 'json'
    elif 'text' in type_name or 'char' in type_name or 'varchar' in type_name:
        return 'string'
    elif 'binary' in type_name or 'blob' in type_name or 'bytea' in type_name:
        return 'binary'
    else:
        return 'string'  # Default to string for unknown types


def update_dataset_schema(
    db: Session,
    dataset,
    compiled_sql: str
) -> List[Dict[str, str]]:
    """
    Update dataset.columns with inferred schema from compiled SQL.
    
    Args:
        db: Database session
        dataset: Dataset model instance
        compiled_sql: Final compiled SQL (with transformations)
    
    Returns:
        List of column metadata
    """
    try:
        columns = infer_schema_from_sql(
            db=db,
            datasource=dataset.data_source,
            sql_query=compiled_sql,
            timeout=30
        )
        
        if columns:
            dataset.columns = columns
            db.commit()
        
        return columns
    
    except Exception as e:
        print(f"Failed to update dataset schema: {str(e)}")
        return dataset.columns or []
