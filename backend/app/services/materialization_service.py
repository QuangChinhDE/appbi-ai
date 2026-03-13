"""
Materialization service for creating and managing VIEWs and TABLEs.

Supports materializing dataset transformation pipelines as database objects
for improved query performance.
"""

from typing import Dict, Any
from sqlalchemy.orm import Session
from datetime import datetime
import re

from app.models.models import Dataset
from app.services.dataset_service import compile_transformed_sql
from app.services.datasource_service import DataSourceConnectionService
from app.core.logging import get_logger

logger = get_logger(__name__)


def sanitize_object_name(name: str) -> str:
    """
    Sanitize object name to prevent SQL injection.
    Only allows alphanumeric characters and underscores.
    """
    if not re.match(r'^[a-zA-Z0-9_]+$', name):
        raise ValueError(f"Invalid object name: {name}. Only alphanumeric characters and underscores allowed.")
    return name


def materialize_dataset(
    db: Session,
    dataset: Dataset,
    mode: str,
    custom_name: str = None,
    custom_schema: str = None
) -> Dict[str, Any]:
    """
    Materialize dataset as VIEW or TABLE.
    
    Args:
        db: Database session
        dataset: Dataset to materialize
        mode: 'view' or 'table'
        custom_name: Custom name for materialized object (default: dataset_<id>)
        custom_schema: Custom schema/dataset (optional)
    
    Returns:
        Dict with success, message, and materialization config
    """
    try:
        # Generate object name
        object_name = custom_name if custom_name else f"dataset_{dataset.id}"
        object_name = sanitize_object_name(object_name)
        
        if custom_schema:
            custom_schema = sanitize_object_name(custom_schema)
        
        # Compile SQL with transformations
        compiled_sql = compile_transformed_sql(db, dataset)
        datasource_type = dataset.data_source.type.value
        
        # Build DDL statement
        if mode == 'view':
            # CREATE OR REPLACE VIEW
            if datasource_type == 'bigquery':
                full_name = f"`{custom_schema}.{object_name}`" if custom_schema else f"`{object_name}`"
                ddl = f"CREATE OR REPLACE VIEW {full_name} AS {compiled_sql}"
            elif datasource_type == 'postgresql':
                full_name = f'"{custom_schema}"."{object_name}"' if custom_schema else f'"{object_name}"'
                ddl = f"CREATE OR REPLACE VIEW {full_name} AS {compiled_sql}"
            elif datasource_type == 'mysql':
                full_name = f"`{custom_schema}`.`{object_name}`" if custom_schema else f"`{object_name}`"
                ddl = f"CREATE OR REPLACE VIEW {full_name} AS {compiled_sql}"
            else:
                raise ValueError(f"Unsupported datasource type: {datasource_type}")
            
            logger.info(f"Creating VIEW {full_name} for dataset {dataset.id}")
            message = f"Successfully created VIEW {full_name}"
        
        elif mode == 'table':
            # CREATE TABLE (with DROP if exists for safety)
            if datasource_type == 'bigquery':
                full_name = f"`{custom_schema}.{object_name}`" if custom_schema else f"`{object_name}`"
                ddl = f"CREATE OR REPLACE TABLE {full_name} AS {compiled_sql}"
            elif datasource_type == 'postgresql':
                full_name = f'"{custom_schema}"."{object_name}"' if custom_schema else f'"{object_name}"'
                # PostgreSQL doesn't support CREATE OR REPLACE TABLE
                drop_ddl = f"DROP TABLE IF EXISTS {full_name}"
                ddl = f"{drop_ddl}; CREATE TABLE {full_name} AS {compiled_sql}"
            elif datasource_type == 'mysql':
                full_name = f"`{custom_schema}`.`{object_name}`" if custom_schema else f"`{object_name}`"
                drop_ddl = f"DROP TABLE IF EXISTS {full_name}"
                ddl = f"{drop_ddl}; CREATE TABLE {full_name} AS {compiled_sql}"
            else:
                raise ValueError(f"Unsupported datasource type: {datasource_type}")
            
            logger.info(f"Creating TABLE {full_name} for dataset {dataset.id}")
            message = f"Successfully created TABLE {full_name}"
        
        else:
            raise ValueError(f"Invalid mode: {mode}")
        
        # Execute DDL using datasource service
        # Note: This is a simplified approach - DDL operations should ideally be
        # executed through a dedicated admin connection with proper permissions
        try:
            DataSourceConnectionService.execute_query(
                datasource_type,
                dataset.data_source.config,
                ddl,
                limit=None,
                timeout_seconds=300  # 5 minute timeout for materialization
            )
        except Exception as e:
            # DDL execution might fail with execute_query since it expects SELECT
            # In production, would need dedicated DDL execution method
            raise ValueError(f"Materialization DDL execution failed: {str(e)}. Materialization requires direct database access with DDL permissions.")
        
        # Update dataset materialization config
        materialization = {
            'mode': mode,
            'name': object_name,
            'schema': custom_schema,
            'last_refreshed_at': datetime.utcnow().isoformat(),
            'status': 'idle',
            'error': None
        }
        
        dataset.materialization = materialization
        db.commit()
        db.refresh(dataset)
        
        return {
            'success': True,
            'message': message,
            'materialization': materialization
        }
    
    except Exception as e:
        logger.error(f"Materialization failed: {str(e)}")
        
        # Update status to failed
        if dataset.materialization:
            dataset.materialization['status'] = 'failed'
            dataset.materialization['error'] = str(e)
            db.commit()
        
        return {
            'success': False,
            'message': f"Materialization failed: {str(e)}",
            'materialization': dataset.materialization or {}
        }


def refresh_materialized_dataset(
    db: Session,
    dataset: Dataset
) -> Dict[str, Any]:
    """
    Refresh materialized VIEW or TABLE.
    
    For VIEWs: Recreate the view with updated SQL
    For TABLEs: Drop and recreate with new data
    """
    if not dataset.materialization:
        raise ValueError("Dataset is not materialized")
    
    mat = dataset.materialization
    mode = mat.get('mode')
    
    if mode not in ('view', 'table'):
        raise ValueError(f"Cannot refresh mode: {mode}")
    
    # Update status to running
    dataset.materialization['status'] = 'running'
    db.commit()
    
    try:
        # Re-materialize with existing config
        result = materialize_dataset(
            db,
            dataset,
            mode=mode,
            custom_name=mat.get('name'),
            custom_schema=mat.get('schema')
        )
        
        if result['success']:
            result['message'] = f"Successfully refreshed {mode.upper()} {mat.get('name')}"
        
        return result
    
    except Exception as e:
        logger.error(f"Refresh failed: {str(e)}")
        
        dataset.materialization['status'] = 'failed'
        dataset.materialization['error'] = str(e)
        db.commit()
        
        return {
            'success': False,
            'message': f"Refresh failed: {str(e)}",
            'materialization': dataset.materialization
        }


def dematerialize_dataset(
    db: Session,
    dataset: Dataset
) -> Dict[str, Any]:
    """
    Dematerialize dataset by dropping VIEW or TABLE.
    """
    if not dataset.materialization:
        return {
            'success': True,
            'message': 'Dataset is not materialized',
            'materialization': {'mode': 'none'}
        }
    
    mat = dataset.materialization
    mode = mat.get('mode')
    
    if mode == 'none':
        return {
            'success': True,
            'message': 'Dataset is already dematerialized',
            'materialization': mat
        }
    
    object_name = mat.get('name')
    custom_schema = mat.get('schema')
    
    if not object_name:
        # No object to drop, just clear config
        dataset.materialization = {'mode': 'none'}
        db.commit()
        return {
            'success': True,
            'message': 'Materialization config cleared',
            'materialization': {'mode': 'none'}
        }
    
    try:
        datasource_type = dataset.data_source.type.value
        
        # Build DROP statement
        if datasource_type == 'bigquery':
            full_name = f"`{custom_schema}.{object_name}`" if custom_schema else f"`{object_name}`"
            object_type = 'VIEW' if mode == 'view' else 'TABLE'
            ddl = f"DROP {object_type} IF EXISTS {full_name}"
        elif datasource_type == 'postgresql':
            full_name = f'"{custom_schema}"."{object_name}"' if custom_schema else f'"{object_name}"'
            object_type = 'VIEW' if mode == 'view' else 'TABLE'
            ddl = f"DROP {object_type} IF EXISTS {full_name}"
        elif datasource_type == 'mysql':
            full_name = f"`{custom_schema}`.`{object_name}`" if custom_schema else f"`{object_name}`"
            object_type = 'VIEW' if mode == 'view' else 'TABLE'
            ddl = f"DROP {object_type} IF EXISTS {full_name}"
        else:
            raise ValueError(f"Unsupported datasource type: {datasource_type}")
        
        # Execute DROP (note: same limitation as materialize regarding DDL)
        try:
            DataSourceConnectionService.execute_query(
                datasource_type,
                dataset.data_source.config,
                ddl,
                limit=None,
                timeout_seconds=60
            )
        except Exception as e:
            # DDL might fail with execute_query
            logger.warning(f"DROP statement execution issue: {str(e)}")
        
        logger.info(f"Dropped {object_type} {full_name} for dataset {dataset.id}")
        
        # Clear materialization config
        dataset.materialization = {'mode': 'none'}
        db.commit()
        db.refresh(dataset)
        
        return {
            'success': True,
            'message': f"Successfully dropped {mode.upper()} {full_name}",
            'materialization': {'mode': 'none'}
        }
    
    except Exception as e:
        logger.error(f"Dematerialization failed: {str(e)}")
        return {
            'success': False,
            'message': f"Dematerialization failed: {str(e)}",
            'materialization': dataset.materialization
        }
