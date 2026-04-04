"""CRUD service for Datasets (Table-based Datasets)"""
from typing import List, Optional, Dict, Any
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import and_

from app.models.dataset import Dataset, DatasetTable
from app.schemas.dataset import (
    DatasetCreate,
    DatasetUpdate,
    TableCreate,
    TableUpdate,
)


class DatasetCRUDService:
    """Service for Dataset CRUD operations"""
    
    # ===== Dataset Methods =====
    
    @staticmethod
    def get_all_datasets(
        db: Session,
        skip: int = 0,
        limit: int = 100
    ) -> List[Dataset]:
        """Get all datasets with pagination"""
        return db.query(Dataset)\
            .order_by(Dataset.updated_at.desc())\
            .offset(skip)\
            .limit(limit)\
            .all()
    
    @staticmethod
    def get_dataset_by_id(
        db: Session,
        dataset_id: int,
        include_tables: bool = False
    ) -> Optional[Dataset]:
        """Get dataset by ID, optionally with tables"""
        query = db.query(Dataset)
        
        if include_tables:
            query = query.options(joinedload(Dataset.tables))
        
        return query.filter(Dataset.id == dataset_id).first()
    
    @staticmethod
    def create_dataset(
        db: Session,
        dataset_in: DatasetCreate,
        owner_id=None,
    ) -> Dataset:
        """Create a new dataset"""
        db_dataset = Dataset(
            name=dataset_in.name,
            description=dataset_in.description,
            owner_id=owner_id,
        )
        db.add(db_dataset)
        db.commit()
        db.refresh(db_dataset)
        return db_dataset
    
    @staticmethod
    def update_dataset(
        db: Session,
        dataset_id: int,
        dataset_in: DatasetUpdate
    ) -> Optional[Dataset]:
        """Update a dataset"""
        db_dataset_obj = db.query(Dataset)\
            .filter(Dataset.id == dataset_id)\
            .first()
        
        if not db_dataset:
            return None
        
        # Update only provided fields
        update_data = dataset_in.model_dump(exclude_unset=True)
        for key, value in update_data.items():
            setattr(db_dataset, key, value)
        
        db.commit()
        db.refresh(db_dataset)
        return db_dataset
    
    @staticmethod
    def delete_dataset(db: Session, dataset_id: int) -> bool:
        """Delete a dataset (cascade deletes tables)"""
        db_dataset_obj = db.query(Dataset)\
            .filter(Dataset.id == dataset_id)\
            .first()
        
        if not db_dataset_obj:
            return False
        
        db.delete(db_dataset_obj)
        db.commit()
        return True
    
    # ===== Table Methods =====
    
    @staticmethod
    def get_dataset_tables(
        db: Session,
        dataset_id: int
    ) -> List[DatasetTable]:
        """Get all tables in a dataset"""
        return db.query(DatasetTable)\
            .filter(DatasetTable.dataset_id == dataset_id)\
            .order_by(DatasetTable.created_at)\
            .all()
    
    @staticmethod
    def get_table_by_id(
        db: Session,
        table_id: int
    ) -> Optional[DatasetTable]:
        """Get a table by ID"""
        return db.query(DatasetTable)\
            .filter(DatasetTable.id == table_id)\
            .first()
    
    @staticmethod
    def add_table_to_dataset(
        db: Session,
        dataset_id: int,
        table: TableCreate
    ) -> Optional[DatasetTable]:
        """Add a table to a dataset"""
        # Check if dataset exists
        dataset_obj = db.query(Dataset)\
            .filter(Dataset.id == dataset_id)\
            .first()
        
        if not dataset_obj:
            return None
        
        # Check if table already exists in this dataset.
        # Only deduplicate physical_table sources (by table name).
        # sql_query sources are always allowed to be created independently.
        if table.source_table_name is not None:
            existing = db.query(DatasetTable)\
                .filter(
                    and_(
                        DatasetTable.dataset_id == dataset_id,
                        DatasetTable.datasource_id == table.datasource_id,
                        DatasetTable.source_table_name == table.source_table_name
                    )
                )\
                .first()
            if existing:
                return existing
        
        # Create display name if not provided
        display_name = table.display_name
        if not display_name:
            # Extract table name from source (e.g., "public.orders" -> "Orders")
            if table.source_table_name:
                table_name = table.source_table_name.split('.')[-1]
                display_name = table_name.replace('_', ' ').title()
            else:
                display_name = "Untitled Table"
        
        db_table = DatasetTable(
            dataset_id=dataset_id,
            datasource_id=table.datasource_id,
            source_kind=table.source_kind,
            source_table_name=table.source_table_name,
            source_query=table.source_query,
            display_name=display_name,
            enabled=table.enabled,
            transformations=table.transformations or [],
        )
        
        db.add(db_table)
        db.commit()
        db.refresh(db_table)
        return db_table
    
    @staticmethod
    def update_table(
        db: Session,
        table_id: int,
        table_update: TableUpdate
    ) -> Optional[DatasetTable]:
        """Update a table"""
        db_table = db.query(DatasetTable)\
            .filter(DatasetTable.id == table_id)\
            .first()
        
        if not db_table:
            return None
        
        # Update only provided fields
        update_data = table_update.model_dump(exclude_unset=True)
        for key, value in update_data.items():
            setattr(db_table, key, value)
        
        db.commit()
        db.refresh(db_table)
        return db_table
    
    @staticmethod
    def delete_table(db: Session, table_id: int) -> bool:
        """Remove a table from dataset"""
        db_table = db.query(DatasetTable)\
            .filter(DatasetTable.id == table_id)\
            .first()
        
        if not db_table:
            return False
        
        db.delete(db_table)
        db.commit()
        return True
    
    @staticmethod
    def update_table_cache(
        db: Session,
        table_id: int,
        columns_cache: Optional[Dict[str, Any]] = None,
        sample_cache: Optional[List[Dict[str, Any]]] = None
    ) -> Optional[DatasetTable]:
        """Update table cache after preview"""
        db_table = db.query(DatasetTable)\
            .filter(DatasetTable.id == table_id)\
            .first()
        
        if not db_table:
            return None
        
        if columns_cache is not None:
            db_table.columns_cache = columns_cache
        
        if sample_cache is not None:
            db_table.sample_cache = sample_cache
        
        db.commit()
        db.refresh(db_table)
        return db_table
