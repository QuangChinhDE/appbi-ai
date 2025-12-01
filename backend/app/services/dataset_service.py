"""
CRUD service for datasets.
"""
from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.models import Dataset
from app.schemas import DatasetCreate, DatasetUpdate
from app.services.datasource_service import DataSourceConnectionService
from app.services.datasource_crud_service import DataSourceCRUDService
from app.services.sql_validator import validate_select_only
from app.core.logging import get_logger

logger = get_logger(__name__)


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
        
        try:
            db_dataset = Dataset(
                name=dataset.name,
                description=dataset.description,
                data_source_id=dataset.data_source_id,
                sql_query=dataset.sql_query,
                columns=columns
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
    def execute(db: Session, dataset_id: int, limit: Optional[int] = None, timeout_seconds: int = 30):
        """Execute a dataset query and return results."""
        db_dataset = DatasetService.get_by_id(db, dataset_id)
        if not db_dataset:
            raise ValueError(f"Dataset with ID {dataset_id} not found")
        
        data_source = db_dataset.data_source
        
        columns, data, execution_time = DataSourceConnectionService.execute_query(
            data_source.type.value,
            data_source.config,
            db_dataset.sql_query,
            limit,
            timeout_seconds
        )
        
        return {
            "columns": columns,
            "data": data,
            "row_count": len(data)
        }
