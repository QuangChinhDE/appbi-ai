"""
CRUD service for datasets.
"""
from typing import List, Optional, Dict, Any
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
import os

from app.models import Dataset
from app.schemas import DatasetCreate, DatasetUpdate
from app.services.datasource_service import DataSourceConnectionService
from app.services.datasource_crud_service import DataSourceCRUDService
from app.services.sql_validator import validate_select_only
from app.core.logging import get_logger

logger = get_logger(__name__)


def compile_transformed_sql(
    db: Session,
    dataset: Dataset,
    stop_at_step_id: Optional[str] = None
) -> str:
    """
    Compile dataset SQL with transformations applied.
    
    Args:
        db: Database session (required for join steps)
        dataset: Dataset model instance
        stop_at_step_id: Optional step ID to stop compilation at (for preview)
    
    Returns:
        Compiled SQL string
    """
    if not dataset.transformations:
        return dataset.sql_query
    
    version = dataset.transformation_version or 1
    
    if version == 2:
        # Use v2 compiler
        from app.services.transform_compiler_v2 import compile_pipeline_sql
        return compile_pipeline_sql(
            base_sql=dataset.sql_query,
            transformations=dataset.transformations,
            datasource_type=dataset.data_source.type.value,
            stop_at_step_id=stop_at_step_id,
            dataset_id=dataset.id,
            db=db
        )
    else:
        # Use v1 compiler (backward compatibility)
        from app.services.transform_compiler import TransformCompiler
        compiler = TransformCompiler(dataset.data_source.type.value)
        return compiler.compile_transformations(
            dataset.sql_query,
            dataset.transformations
        )


class DatasetService:
    """Service for dataset operations."""
    
    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[Dataset]:
        """Get all datasets with pagination."""
        return db.query(Dataset).offset(skip).limit(limit).all()
    
    @staticmethod
    def get_by_id(db: Session, dataset_id: int) -> Optional[Dataset]:
        """Get a dataset by ID."""
        return db.query(Dataset).filter(Dataset.id == dataset_id).first()
    
    @staticmethod
    def get_by_name(db: Session, name: str) -> Optional[Dataset]:
        """Get a dataset by name."""
        return db.query(Dataset).filter(Dataset.name == name).first()
    
    @staticmethod
    def create(db: Session, dataset: DatasetCreate) -> Dataset:
        """Create a new dataset with inferred column metadata."""
        # Validate SQL query is SELECT-only
        validate_select_only(dataset.sql_query)
        
        # Verify data source exists
        data_source = DataSourceCRUDService.get_by_id(db, dataset.data_source_id)
        if not data_source:
            raise ValueError(f"Data source with ID {dataset.data_source_id} not found")
        
        # Infer column types
        try:
            columns = DataSourceConnectionService.infer_column_types(
                data_source.type.value,
                data_source.config,
                dataset.sql_query
            )
        except Exception as e:
            logger.error(f"Failed to infer column types: {str(e)}")
            raise ValueError(f"Failed to validate query: {str(e)}")
        
        transformations = dataset.transformations or []

        # If transformations exist, compile and execute to get actual output columns
        if transformations:
            try:
                from app.services.transform_compiler_v2 import compile_pipeline_sql
                compiled_sql = compile_pipeline_sql(
                    base_sql=dataset.sql_query,
                    transformations=transformations,
                    datasource_type=data_source.type.value,
                    db=None,
                    dataset_id=None,
                )
                col_names, rows, _ = DataSourceConnectionService.execute_query(
                    data_source.type.value,
                    data_source.config,
                    compiled_sql,
                    limit=1,
                )
                if col_names:
                    first = rows[0] if rows else {}
                    def _infer_type(val):
                        if isinstance(val, bool):
                            return "boolean"
                        if isinstance(val, int):
                            return "integer"
                        if isinstance(val, float):
                            return "number"
                        return "string"
                    columns = [
                        {"name": n, "type": _infer_type(first.get(n))}
                        for n in col_names
                    ]
            except Exception as e:
                logger.warning(f"Could not infer transformed columns, using raw: {e}")

        try:
            db_dataset = Dataset(
                name=dataset.name,
                description=dataset.description,
                data_source_id=dataset.data_source_id,
                sql_query=dataset.sql_query,
                columns=columns,
                transformations=transformations,
                transformation_version=dataset.transformation_version or 2,
            )
            db.add(db_dataset)
            db.commit()
            db.refresh(db_dataset)
            logger.info(f"Created dataset: {dataset.name}")
            return db_dataset
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Dataset with name '{dataset.name}' already exists")
    
    @staticmethod
    def update(
        db: Session,
        dataset_id: int,
        dataset_update: DatasetUpdate
    ) -> Optional[Dataset]:
        """Update a dataset."""
        db_dataset = DatasetService.get_by_id(db, dataset_id)
        if not db_dataset:
            return None
        
        # If SQL query is being updated, validate and re-infer column types
        if dataset_update.sql_query:
            # Validate SQL query is SELECT-only
            validate_select_only(dataset_update.sql_query)
            
            data_source = db_dataset.data_source
            try:
                columns = DataSourceConnectionService.infer_column_types(
                    data_source.type.value,
                    data_source.config,
                    dataset_update.sql_query
                )
                db_dataset.columns = columns
            except Exception as e:
                logger.error(f"Failed to infer column types: {str(e)}")
                raise ValueError(f"Failed to validate query: {str(e)}")
        
        try:
            update_data = dataset_update.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                if field != "columns":  # columns is handled above
                    setattr(db_dataset, field, value)
            
            db.commit()
            db.refresh(db_dataset)
            logger.info(f"Updated dataset: {db_dataset.name}")
            return db_dataset
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Dataset with name '{dataset_update.name}' already exists")
    
    @staticmethod
    def delete(db: Session, dataset_id: int) -> bool:
        """Delete a dataset."""
        db_dataset = DatasetService.get_by_id(db, dataset_id)
        if not db_dataset:
            return False
        
        db.delete(db_dataset)
        db.commit()
        logger.info(f"Deleted dataset: {db_dataset.name}")
        return True
    
    @staticmethod
    def execute(
        db: Session, 
        dataset_id: int, 
        limit: Optional[int] = None, 
        timeout_seconds: int = 30,
        apply_transformations: bool = True
    ):
        """Execute a dataset query and return results with optional transformations."""
        db_dataset = DatasetService.get_by_id(db, dataset_id)
        if not db_dataset:
            raise ValueError(f"Dataset with ID {dataset_id} not found")
        
        data_source = db_dataset.data_source
        
        # Determine final SQL query
        final_sql = db_dataset.sql_query
        
        # Check if materialized view/table exists and should be used
        if db_dataset.materialization:
            mat = db_dataset.materialization
            if mat.get('mode') in ('view', 'table') and mat.get('name'):
                # Use materialized object instead of compiling
                schema = mat.get('schema', '')
                mat_name = mat['name']
                
                if schema:
                    final_sql = f"SELECT * FROM {schema}.{mat_name}"
                else:
                    final_sql = f"SELECT * FROM {mat_name}"
                
                logger.info(f"Using materialized {mat['mode']}: {mat_name}")
            else:
                # No valid materialization, compile normally
                if apply_transformations and db_dataset.transformations:
                    try:
                        final_sql = compile_transformed_sql(db, db_dataset)
                        logger.info(f"Applied {len(db_dataset.transformations)} transformations to dataset {dataset_id}")
                    except Exception as e:
                        logger.error(f"Failed to compile transformations: {str(e)}")
                        final_sql = db_dataset.sql_query
        else:
            # No materialization, compile with transformations if enabled
            if apply_transformations and db_dataset.transformations:
                try:
                    final_sql = compile_transformed_sql(db, db_dataset)
                    logger.info(f"Applied {len(db_dataset.transformations)} transformations to dataset {dataset_id}")
                except Exception as e:
                    logger.error(f"Failed to compile transformations: {str(e)}")
                    final_sql = db_dataset.sql_query
        
        # Validate final SQL is SELECT-only
        validate_select_only(final_sql)
        
        columns, data, execution_time = DataSourceConnectionService.execute_query(
            data_source.type.value,
            data_source.config,
            final_sql,
            limit,
            timeout_seconds
        )
        
        return {
            "columns": columns,
            "data": data,
            "row_count": len(data)
        }
    
    @staticmethod
    def preview_adhoc(
        db: Session,
        data_source_id: int,
        sql_query: str,
        transformations: Optional[List[Dict[str, Any]]] = None,
        stop_at_step_id: Optional[str] = None,
        limit: int = 500,
        timeout_seconds: int = 30
    ):
        """
        Preview an ad-hoc dataset query without saving it.
        Used for live preview during dataset creation.
        
        Args:
            db: Database session
            data_source_id: ID of the data source
            sql_query: SQL query to execute
            transformations: Optional transformation steps
            stop_at_step_id: Optional step ID to stop compilation at
            limit: Maximum rows to return
            timeout_seconds: Query timeout
            
        Returns:
            Dict with columns, data, row_count, and compiled_sql
        """
        # Validate SQL query is SELECT-only
        validate_select_only(sql_query)
        
        # Get data source
        data_source = DataSourceCRUDService.get_by_id(db, data_source_id)
        if not data_source:
            raise ValueError(f"Data source with ID {data_source_id} not found")
        
        # Determine final SQL query
        final_sql = sql_query
        
        # Apply transformations if provided
        if transformations:
            version = 2  # Use v2 compiler for all new/adhoc datasets
            
            from app.services.transform_compiler_v2 import compile_pipeline_sql
            try:
                final_sql = compile_pipeline_sql(
                    base_sql=sql_query,
                    transformations=transformations,
                    datasource_type=data_source.type.value,
                    stop_at_step_id=stop_at_step_id,
                    dataset_id=None,  # No dataset ID for ad-hoc preview
                    db=db
                )
                logger.info(f"Compiled {len(transformations)} transformations for ad-hoc preview")
            except Exception as e:
                logger.error(f"Failed to compile transformations: {str(e)}")
                raise ValueError(f"Failed to compile transformations: {str(e)}")
        
        # Validate final SQL is SELECT-only
        validate_select_only(final_sql)
        
        # Execute query
        try:
            columns, data, execution_time = DataSourceConnectionService.execute_query(
                data_source.type.value,
                data_source.config,
                final_sql,
                limit,
                timeout_seconds
            )
        except Exception as e:
            logger.error(f"Failed to execute ad-hoc preview query: {str(e)}")
            raise ValueError(f"Failed to execute query: {str(e)}")
        
        # Build ColumnMetadata from column names + first-row type inference
        first = data[0] if data else {}
        def _guess_type(val):
            if isinstance(val, bool): return "boolean"
            if isinstance(val, int): return "integer"
            if isinstance(val, float): return "number"
            return "string"
        column_meta = [{"name": n, "type": _guess_type(first.get(n))} for n in columns]

        return {
            "columns": column_meta,
            "rows": data,
            "row_count": len(data),
            "compiled_sql": final_sql,
            "step_id": stop_at_step_id
        }
