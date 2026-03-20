"""CRUD service for Dataset Workspaces (Table-based Datasets)"""
from typing import List, Optional, Dict, Any
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import and_

from app.models.dataset_workspace import DatasetWorkspace, DatasetWorkspaceTable
from app.schemas.dataset_workspace import (
    WorkspaceCreate,
    WorkspaceUpdate,
    TableCreate,
    TableUpdate,
)


class DatasetWorkspaceCRUDService:
    """Service for Dataset Workspace CRUD operations"""
    
    # ===== Workspace Methods =====
    
    @staticmethod
    def get_all_workspaces(
        db: Session,
        skip: int = 0,
        limit: int = 100
    ) -> List[DatasetWorkspace]:
        """Get all workspaces with pagination"""
        return db.query(DatasetWorkspace)\
            .order_by(DatasetWorkspace.updated_at.desc())\
            .offset(skip)\
            .limit(limit)\
            .all()
    
    @staticmethod
    def get_workspace_by_id(
        db: Session,
        workspace_id: int,
        include_tables: bool = False
    ) -> Optional[DatasetWorkspace]:
        """Get workspace by ID, optionally with tables"""
        query = db.query(DatasetWorkspace)
        
        if include_tables:
            query = query.options(joinedload(DatasetWorkspace.tables))
        
        return query.filter(DatasetWorkspace.id == workspace_id).first()
    
    @staticmethod
    def create_workspace(
        db: Session,
        workspace: WorkspaceCreate,
        owner_id=None,
    ) -> DatasetWorkspace:
        """Create a new workspace"""
        db_workspace = DatasetWorkspace(
            name=workspace.name,
            description=workspace.description,
            owner_id=owner_id,
        )
        db.add(db_workspace)
        db.commit()
        db.refresh(db_workspace)
        return db_workspace
    
    @staticmethod
    def update_workspace(
        db: Session,
        workspace_id: int,
        workspace: WorkspaceUpdate
    ) -> Optional[DatasetWorkspace]:
        """Update a workspace"""
        db_workspace = db.query(DatasetWorkspace)\
            .filter(DatasetWorkspace.id == workspace_id)\
            .first()
        
        if not db_workspace:
            return None
        
        # Update only provided fields
        update_data = workspace.model_dump(exclude_unset=True)
        for key, value in update_data.items():
            setattr(db_workspace, key, value)
        
        db.commit()
        db.refresh(db_workspace)
        return db_workspace
    
    @staticmethod
    def delete_workspace(db: Session, workspace_id: int) -> bool:
        """Delete a workspace (cascade deletes tables)"""
        db_workspace = db.query(DatasetWorkspace)\
            .filter(DatasetWorkspace.id == workspace_id)\
            .first()
        
        if not db_workspace:
            return False
        
        db.delete(db_workspace)
        db.commit()
        return True
    
    # ===== Table Methods =====
    
    @staticmethod
    def get_workspace_tables(
        db: Session,
        workspace_id: int
    ) -> List[DatasetWorkspaceTable]:
        """Get all tables in a workspace"""
        return db.query(DatasetWorkspaceTable)\
            .filter(DatasetWorkspaceTable.workspace_id == workspace_id)\
            .order_by(DatasetWorkspaceTable.created_at)\
            .all()
    
    @staticmethod
    def get_table_by_id(
        db: Session,
        table_id: int
    ) -> Optional[DatasetWorkspaceTable]:
        """Get a table by ID"""
        return db.query(DatasetWorkspaceTable)\
            .filter(DatasetWorkspaceTable.id == table_id)\
            .first()
    
    @staticmethod
    def add_table_to_workspace(
        db: Session,
        workspace_id: int,
        table: TableCreate
    ) -> Optional[DatasetWorkspaceTable]:
        """Add a table to a workspace"""
        # Check if workspace exists
        workspace = db.query(DatasetWorkspace)\
            .filter(DatasetWorkspace.id == workspace_id)\
            .first()
        
        if not workspace:
            return None
        
        # Check if table already exists in this workspace.
        # Only deduplicate physical_table sources (by table name).
        # sql_query sources are always allowed to be created independently.
        if table.source_table_name is not None:
            existing = db.query(DatasetWorkspaceTable)\
                .filter(
                    and_(
                        DatasetWorkspaceTable.workspace_id == workspace_id,
                        DatasetWorkspaceTable.datasource_id == table.datasource_id,
                        DatasetWorkspaceTable.source_table_name == table.source_table_name
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
        
        db_table = DatasetWorkspaceTable(
            workspace_id=workspace_id,
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
    ) -> Optional[DatasetWorkspaceTable]:
        """Update a table"""
        db_table = db.query(DatasetWorkspaceTable)\
            .filter(DatasetWorkspaceTable.id == table_id)\
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
        """Remove a table from workspace"""
        db_table = db.query(DatasetWorkspaceTable)\
            .filter(DatasetWorkspaceTable.id == table_id)\
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
    ) -> Optional[DatasetWorkspaceTable]:
        """Update table cache after preview"""
        db_table = db.query(DatasetWorkspaceTable)\
            .filter(DatasetWorkspaceTable.id == table_id)\
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
