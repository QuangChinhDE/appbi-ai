"""
CRUD service for data sources.
"""
from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.models import DataSource, DataSourceType
from app.schemas import DataSourceCreate, DataSourceUpdate
from app.core.logging import get_logger

logger = get_logger(__name__)


class DataSourceCRUDService:
    """Service for data source CRUD operations."""
    
    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[DataSource]:
        """Get all data sources with pagination."""
        return db.query(DataSource).offset(skip).limit(limit).all()
    
    @staticmethod
    def get_by_id(db: Session, data_source_id: int) -> Optional[DataSource]:
        """Get a data source by ID."""
        return db.query(DataSource).filter(DataSource.id == data_source_id).first()
    
    @staticmethod
    def get_by_name(db: Session, name: str) -> Optional[DataSource]:
        """Get a data source by name."""
        return db.query(DataSource).filter(DataSource.name == name).first()
    
    @staticmethod
    def create(db: Session, data_source: DataSourceCreate) -> DataSource:
        """Create a new data source."""
        try:
            db_data_source = DataSource(
                name=data_source.name,
                type=DataSourceType(data_source.type.value),
                description=data_source.description,
                config=data_source.config
            )
            db.add(db_data_source)
            db.commit()
            db.refresh(db_data_source)
            logger.info(f"Created data source: {data_source.name}")
            return db_data_source
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Data source with name '{data_source.name}' already exists")
    
    @staticmethod
    def update(
        db: Session,
        data_source_id: int,
        data_source_update: DataSourceUpdate
    ) -> Optional[DataSource]:
        """Update a data source."""
        db_data_source = DataSourceCRUDService.get_by_id(db, data_source_id)
        if not db_data_source:
            return None
        
        try:
            update_data = data_source_update.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                setattr(db_data_source, field, value)
            
            db.commit()
            db.refresh(db_data_source)
            logger.info(f"Updated data source: {db_data_source.name}")
            return db_data_source
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Data source with name '{data_source_update.name}' already exists")
    
    @staticmethod
    def delete(db: Session, data_source_id: int) -> bool:
        """Delete a data source."""
        db_data_source = DataSourceCRUDService.get_by_id(db, data_source_id)
        if not db_data_source:
            return False
        
        db.delete(db_data_source)
        db.commit()
        logger.info(f"Deleted data source: {db_data_source.name}")
        return True
