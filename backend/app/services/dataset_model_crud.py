"""
CRUD service for Dataset Models
"""
from typing import List, Optional
from sqlalchemy.orm import Session, joinedload

from app.models import (
    DatasetModel,
    DatasetModelTable,
    DatasetRelationship,
    DatasetCalculatedColumn
)
# Alias for clarity
DatasetTable = DatasetModelTable
from app.schemas import (
    DatasetModelCreate,
    DatasetModelUpdate,
    DatasetModelTableCreate,
    DatasetModelTableUpdate,
    DatasetRelationshipCreate,
    DatasetRelationshipUpdate,
    DatasetCalculatedColumnCreate,
    DatasetCalculatedColumnUpdate
)
# Aliases for backward compatibility
DatasetTableCreate = DatasetModelTableCreate
DatasetTableUpdate = DatasetModelTableUpdate


class DatasetModelCRUDService:
    """CRUD operations for Dataset Models"""
    
    def __init__(self, db: Session):
        self.db = db
    
    # ============================================================================
    # DatasetModel CRUD
    # ============================================================================
    
    def get_dataset_models(self, skip: int = 0, limit: int = 100) -> List[DatasetModel]:
        """Get all dataset models"""
        return self.db.query(DatasetModel).offset(skip).limit(limit).all()
    
    def get_dataset_model(self, model_id: int) -> Optional[DatasetModel]:
        """Get dataset model by ID with all relationships loaded"""
        return (
            self.db.query(DatasetModel)
            .options(
                joinedload(DatasetModel.tables).joinedload(DatasetTable.data_source),
                joinedload(DatasetModel.relationships),
                joinedload(DatasetModel.calculated_columns)
            )
            .filter(DatasetModel.id == model_id)
            .first()
        )
    
    def create_dataset_model(self, data: DatasetModelCreate) -> DatasetModel:
        """Create new dataset model"""
        model = DatasetModel(**data.model_dump())
        self.db.add(model)
        self.db.commit()
        self.db.refresh(model)
        return model
    
    def update_dataset_model(self, model_id: int, data: DatasetModelUpdate) -> Optional[DatasetModel]:
        """Update dataset model"""
        model = self.db.query(DatasetModel).filter(DatasetModel.id == model_id).first()
        if not model:
            return None
        
        update_data = data.model_dump(exclude_unset=True)
        for key, value in update_data.items():
            setattr(model, key, value)
        
        self.db.commit()
        self.db.refresh(model)
        return model
    
    def delete_dataset_model(self, model_id: int) -> bool:
        """Delete dataset model"""
        model = self.db.query(DatasetModel).filter(DatasetModel.id == model_id).first()
        if not model:
            return False
        
        self.db.delete(model)
        self.db.commit()
        return True
    
    # ============================================================================
    # DatasetTable CRUD
    # ============================================================================
    
    def get_table(self, table_id: int) -> Optional[DatasetTable]:
        """Get table by ID"""
        return (
            self.db.query(DatasetTable)
            .options(joinedload(DatasetTable.data_source))
            .filter(DatasetTable.id == table_id)
            .first()
        )
    
    def create_table(self, model_id: int, data: DatasetTableCreate) -> DatasetTable:
        """Create new table in dataset model"""
        table = DatasetTable(
            dataset_model_id=model_id,
            **data.model_dump()
        )
        self.db.add(table)
        self.db.commit()
        self.db.refresh(table)
        return table
    
    def update_table(self, table_id: int, data: DatasetTableUpdate) -> Optional[DatasetTable]:
        """Update table"""
        table = self.db.query(DatasetTable).filter(DatasetTable.id == table_id).first()
        if not table:
            return None
        
        update_data = data.model_dump(exclude_unset=True)
        for key, value in update_data.items():
            setattr(table, key, value)
        
        self.db.commit()
        self.db.refresh(table)
        return table
    
    def delete_table(self, table_id: int) -> bool:
        """Delete table"""
        table = self.db.query(DatasetTable).filter(DatasetTable.id == table_id).first()
        if not table:
            return False
        
        self.db.delete(table)
        self.db.commit()
        return True
    
    def update_table_columns_cache(self, table_id: int, columns: List[dict]) -> Optional[DatasetTable]:
        """Update table's cached column schema"""
        table = self.db.query(DatasetTable).filter(DatasetTable.id == table_id).first()
        if not table:
            return None
        
        table.columns = columns
        self.db.commit()
        self.db.refresh(table)
        return table
    
    # ============================================================================
    # DatasetRelationship CRUD
    # ============================================================================
    
    def create_relationship(self, model_id: int, data: DatasetRelationshipCreate) -> DatasetRelationship:
        """Create new relationship"""
        # Convert JoinCondition objects to dicts
        on_conditions = [cond.model_dump() for cond in data.on]
        
        relationship = DatasetRelationship(
            dataset_model_id=model_id,
            left_table_id=data.left_table_id,
            right_table_id=data.right_table_id,
            join_type=data.join_type,
            on=on_conditions
        )
        self.db.add(relationship)
        self.db.commit()
        self.db.refresh(relationship)
        return relationship
    
    def update_relationship(self, rel_id: int, data: DatasetRelationshipUpdate) -> Optional[DatasetRelationship]:
        """Update relationship"""
        relationship = self.db.query(DatasetRelationship).filter(DatasetRelationship.id == rel_id).first()
        if not relationship:
            return None
        
        update_data = data.model_dump(exclude_unset=True)
        
        # Convert JoinCondition objects to dicts if present
        if 'on' in update_data and update_data['on'] is not None:
            update_data['on'] = [cond.model_dump() for cond in update_data['on']]
        
        for key, value in update_data.items():
            setattr(relationship, key, value)
        
        self.db.commit()
        self.db.refresh(relationship)
        return relationship
    
    def delete_relationship(self, rel_id: int) -> bool:
        """Delete relationship"""
        relationship = self.db.query(DatasetRelationship).filter(DatasetRelationship.id == rel_id).first()
        if not relationship:
            return False
        
        self.db.delete(relationship)
        self.db.commit()
        return True
    
    # ============================================================================
    # DatasetCalculatedColumn CRUD
    # ============================================================================
    
    def create_calculated_column(self, model_id: int, data: DatasetCalculatedColumnCreate) -> DatasetCalculatedColumn:
        """Create new calculated column"""
        column = DatasetCalculatedColumn(
            dataset_model_id=model_id,
            **data.model_dump()
        )
        self.db.add(column)
        self.db.commit()
        self.db.refresh(column)
        return column
    
    def update_calculated_column(self, col_id: int, data: DatasetCalculatedColumnUpdate) -> Optional[DatasetCalculatedColumn]:
        """Update calculated column"""
        column = self.db.query(DatasetCalculatedColumn).filter(DatasetCalculatedColumn.id == col_id).first()
        if not column:
            return None
        
        update_data = data.model_dump(exclude_unset=True)
        for key, value in update_data.items():
            setattr(column, key, value)
        
        self.db.commit()
        self.db.refresh(column)
        return column
    
    def delete_calculated_column(self, col_id: int) -> bool:
        """Delete calculated column"""
        column = self.db.query(DatasetCalculatedColumn).filter(DatasetCalculatedColumn.id == col_id).first()
        if not column:
            return False
        
        self.db.delete(column)
        self.db.commit()
        return True
