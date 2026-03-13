"""API endpoints for Dataset Workspaces (Table-based Datasets)"""
from typing import List, Optional
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import DataSource
from app.schemas import (
    WorkspaceCreate,
    WorkspaceUpdate,
    WorkspaceResponse,
    WorkspaceWithTables,
    TableCreate,
    TableUpdate,
    TableResponse,
    TablePreviewRequest,
    TablePreviewResponse,
    ExecuteQueryRequest,
    ExecuteQueryResponse,
    DatasourceTable,
    WorkspaceColumnMetadata,
)
from app.services import (
    DatasetWorkspaceCRUDService,
    DataSourceConnectionService,
)

router = APIRouter()


# ===== Workspace Endpoints =====

@router.get("/", response_model=List[WorkspaceResponse])
def list_workspaces(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db)
):
    """List all dataset workspaces"""
    workspaces = DatasetWorkspaceCRUDService.get_all_workspaces(db, skip, limit)
    return workspaces


@router.post("/", response_model=WorkspaceResponse, status_code=201)
def create_workspace(
    workspace: WorkspaceCreate,
    db: Session = Depends(get_db)
):
    """Create a new dataset workspace"""
    db_workspace = DatasetWorkspaceCRUDService.create_workspace(db, workspace)
    return db_workspace


@router.get("/{workspace_id}", response_model=WorkspaceWithTables)
def get_workspace(
    workspace_id: int,
    db: Session = Depends(get_db)
):
    """Get a dataset workspace by ID with its tables"""
    workspace = DatasetWorkspaceCRUDService.get_workspace_by_id(
        db, workspace_id, include_tables=True
    )
    
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    
    return workspace


@router.put("/{workspace_id}", response_model=WorkspaceResponse)
def update_workspace(
    workspace_id: int,
    workspace: WorkspaceUpdate,
    db: Session = Depends(get_db)
):
    """Update a dataset workspace"""
    db_workspace = DatasetWorkspaceCRUDService.update_workspace(
        db, workspace_id, workspace
    )
    
    if not db_workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    
    return db_workspace


@router.delete("/{workspace_id}", status_code=204)
def delete_workspace(
    workspace_id: int,
    db: Session = Depends(get_db)
):
    """Delete a dataset workspace"""
    success = DatasetWorkspaceCRUDService.delete_workspace(db, workspace_id)
    
    if not success:
        raise HTTPException(status_code=404, detail="Workspace not found")


# ===== Table Endpoints =====

@router.get("/{workspace_id}/tables", response_model=List[TableResponse])
def list_workspace_tables(
    workspace_id: int,
    db: Session = Depends(get_db)
):
    """List all tables in a workspace"""
    # Check if workspace exists
    workspace = DatasetWorkspaceCRUDService.get_workspace_by_id(db, workspace_id)
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    
    tables = DatasetWorkspaceCRUDService.get_workspace_tables(db, workspace_id)
    return tables


@router.post("/{workspace_id}/tables", status_code=201)
def add_table_to_workspace(
    workspace_id: int,
    table: TableCreate,
    db: Session = Depends(get_db)
):
    """Add a table to a workspace"""
    try:
        # Validate datasource exists
        datasource = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
        if not datasource:
            raise HTTPException(status_code=404, detail="Datasource not found")
        
        # Validate SQL query if source_kind is 'sql_query'
        if table.source_kind == "sql_query":
            from app.services.query_validator import QueryValidator, QueryValidationError
            try:
                # Validate and clean the query
                table.source_query = QueryValidator.validate_and_clean(table.source_query)
            except QueryValidationError as e:
                raise HTTPException(status_code=400, detail=f"Invalid SQL query: {str(e)}")
        
        db_table = DatasetWorkspaceCRUDService.add_table_to_workspace(
            db, workspace_id, table
        )
        
        if not db_table:
            raise HTTPException(status_code=404, detail="Workspace not found")
        
        # Return plain dict instead of model to avoid serialization issues
        return {
            "id": db_table.id,
            "workspace_id": db_table.workspace_id,
            "datasource_id": db_table.datasource_id,
            "source_kind": db_table.source_kind,
            "source_table_name": db_table.source_table_name,
            "source_query": db_table.source_query,
            "display_name": db_table.display_name,
            "enabled": db_table.enabled,
            "transformations": db_table.transformations,
            "columns_cache": db_table.columns_cache,
            "sample_cache": db_table.sample_cache,
            "created_at": db_table.created_at.isoformat() if db_table.created_at else None,
            "updated_at": db_table.updated_at.isoformat() if db_table.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{workspace_id}/tables/{table_id}", response_model=TableResponse)
def update_workspace_table(
    workspace_id: int,
    table_id: int,
    table_update: TableUpdate,
    db: Session = Depends(get_db)
):
    """Update a table in a workspace"""
    # Verify table belongs to workspace
    db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Table not found in this workspace")
    
    updated_table = DatasetWorkspaceCRUDService.update_table(
        db, table_id, table_update
    )
    
    return updated_table


@router.delete("/{workspace_id}/tables/{table_id}", status_code=204)
def remove_table_from_workspace(
    workspace_id: int,
    table_id: int,
    db: Session = Depends(get_db)
):
    """Remove a table from a workspace"""
    # Verify table belongs to workspace
    db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Table not found in this workspace")
    
    success = DatasetWorkspaceCRUDService.delete_table(db, table_id)
    
    if not success:
        raise HTTPException(status_code=404, detail="Table not found")


@router.post(
    "/{workspace_id}/tables/{table_id}/preview",
    response_model=TablePreviewResponse
)
def preview_workspace_table(
    workspace_id: int,
    table_id: int,
    preview_request: TablePreviewRequest,
    db: Session = Depends(get_db)
):
    """Preview data from a workspace table with transformations"""
    # Get table
    db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Table not found in this workspace")
    
    # Get datasource
    datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    
    # Build base query based on source_kind
    if db_table.source_kind == "sql_query":
        # Use custom SQL query as subquery
        if not db_table.source_query:
            raise HTTPException(status_code=400, detail="Table has source_kind='sql_query' but source_query is NULL")
        base_query = f"SELECT * FROM ({db_table.source_query}) AS custom_query"
    else:
        # Use physical table
        if not db_table.source_table_name:
            raise HTTPException(status_code=400, detail="Table has source_kind='physical_table' but source_table_name is NULL")
        base_query = f"SELECT * FROM {db_table.source_table_name}"
    
    # Apply transformations if any
    from app.services.transformation_compiler import TransformationCompiler
    
    if db_table.transformations:
        # transformations is stored as JSON array
        transformations = db_table.transformations if isinstance(db_table.transformations, list) else []
        query, _ = TransformationCompiler.compile_transformations(
            base_query,
            transformations,
            dialect=datasource.type
        )
    else:
        query = base_query
    
    # Add limit and offset
    if preview_request.limit:
        query += f" LIMIT {preview_request.limit}"
    
    if preview_request.offset:
        query += f" OFFSET {preview_request.offset}"
    
    try:
        # Execute query
        columns, rows, _ = DataSourceConnectionService.execute_query(
            datasource.type,
            datasource.config,
            query,
            limit=None  # Already in query
        )
        
        # Infer column types
        column_metadata = []
        for i, col in enumerate(columns):
            # Simple type inference from first row
            col_type = "string"
            if rows and len(rows) > 0:
                # Handle both dict and list/tuple rows
                if isinstance(rows[0], dict):
                    val = rows[0].get(col)
                else:
                    val = rows[0][i] if i < len(rows[0]) else None
                
                if isinstance(val, bool):
                    col_type = "boolean"
                elif isinstance(val, (int, float, Decimal)):
                    col_type = "number"
            
            column_metadata.append(
                WorkspaceColumnMetadata(
                    name=col,
                    type=col_type,
                    nullable=True
                )
            )
        
        # Get total count (approximate for now)
        # In production, run a COUNT query
        total = len(rows)
        has_more = len(rows) >= preview_request.limit
        
        # Serialize rows for JSON storage (convert datetime, date, etc.)
        def serialize_value(val):
            """Convert non-JSON-serializable values to strings"""
            from datetime import datetime, date
            if isinstance(val, (datetime, date)):
                return val.isoformat()
            return val
        
        # Convert rows to serializable format
        serializable_rows = []
        for row in rows[:10]:  # Keep only first 10 for cache
            if isinstance(row, dict):
                serializable_rows.append({k: serialize_value(v) for k, v in row.items()})
            else:
                serializable_rows.append([serialize_value(v) for v in row])
        
        # Cache results
        DatasetWorkspaceCRUDService.update_table_cache(
            db,
            table_id,
            columns_cache={"columns": [col.model_dump() for col in column_metadata]},
            sample_cache=serializable_rows
        )
        
        return TablePreviewResponse(
            columns=column_metadata,
            rows=rows,
            total=total,
            has_more=has_more
        )
    
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to preview table: {str(e)}"
        )


@router.post(
    "/{workspace_id}/tables/{table_id}/execute",
    response_model=ExecuteQueryResponse
)
def execute_workspace_table_query(
    workspace_id: int,
    table_id: int,
    execute_request: ExecuteQueryRequest,
    db: Session = Depends(get_db)
):
    """Execute query on workspace table with dimensions, measures, and filters"""
    # Get table
    db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Table not found in this workspace")
    
    # Get datasource
    datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    
    # Build base query
    if db_table.source_kind == "sql_query":
        if not db_table.source_query:
            raise HTTPException(status_code=400, detail="Table has source_kind='sql_query' but source_query is NULL")
        base_table = f"({db_table.source_query}) AS base_table"
    else:
        if not db_table.source_table_name:
            raise HTTPException(status_code=400, detail="Table has source_kind='physical_table' but source_table_name is NULL")
        base_table = db_table.source_table_name
    
    # Build SELECT clause with dimensions and measures
    select_parts = []
    
    # Add dimensions
    if execute_request.dimensions:
        for dim in execute_request.dimensions:
            select_parts.append(dim)
    
    # Add measures (aggregations)
    if execute_request.measures:
        for measure in execute_request.measures:
            agg_func = measure.function.upper()
            if agg_func == 'COUNT_DISTINCT':
                agg_func = 'COUNT(DISTINCT'
                select_parts.append(f"{agg_func} {measure.field}) AS {measure.field}_{measure.function}")
            else:
                select_parts.append(f"{agg_func}({measure.field}) AS {measure.field}_{measure.function}")
    
    if not select_parts:
        select_parts.append("*")
    
    select_clause = ", ".join(select_parts)
    
    # Build query
    query = f"SELECT {select_clause} FROM {base_table}"
    
    # Add WHERE clause for filters
    if execute_request.filters:
        where_conditions = []
        for filter_cond in execute_request.filters:
            if filter_cond.operator == 'LIKE':
                where_conditions.append(f"{filter_cond.field} LIKE '%{filter_cond.value}%'")
            elif filter_cond.operator == 'IN':
                values = filter_cond.value.split(',')
                quoted_values = [f"'{v.strip()}'" for v in values]
                where_conditions.append(f"{filter_cond.field} IN ({','.join(quoted_values)})")
            else:
                # For string values, add quotes
                if isinstance(filter_cond.value, str):
                    where_conditions.append(f"{filter_cond.field} {filter_cond.operator} '{filter_cond.value}'")
                else:
                    where_conditions.append(f"{filter_cond.field} {filter_cond.operator} {filter_cond.value}")
        
        if where_conditions:
            query += " WHERE " + " AND ".join(where_conditions)
    
    # Add GROUP BY for dimensions
    if execute_request.dimensions and execute_request.measures:
        group_by_clause = ", ".join(execute_request.dimensions)
        query += f" GROUP BY {group_by_clause}"
    
    # Add LIMIT
    if execute_request.limit:
        query += f" LIMIT {execute_request.limit}"
    
    try:
        # Execute query
        columns, rows, _ = DataSourceConnectionService.execute_query(
            datasource.type,
            datasource.config,
            query,
            limit=None  # Already in query
        )
        
        # Infer column types
        column_metadata = []
        for i, col in enumerate(columns):
            col_type = "string"
            if rows and len(rows) > 0:
                if isinstance(rows[0], dict):
                    val = rows[0].get(col)
                else:
                    val = rows[0][i] if i < len(rows[0]) else None
                
                if isinstance(val, bool):
                    col_type = "boolean"
                elif isinstance(val, (int, float, Decimal)):
                    col_type = "number"
            
            column_metadata.append(
                WorkspaceColumnMetadata(
                    name=col,
                    type=col_type,
                    nullable=True
                )
            )
        
        return ExecuteQueryResponse(
            columns=column_metadata,
            rows=rows
        )
    
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to execute query: {str(e)}"
        )


# ===== Datasource Table List Endpoint =====

@router.get(
    "/datasources/{datasource_id}/tables",
    response_model=List[DatasourceTable],
    tags=["datasources"]
)
def list_datasource_tables(
    datasource_id: int,
    search: Optional[str] = Query(None, description="Search query for table names"),
    db: Session = Depends(get_db)
):
    """List all tables from a datasource"""
    # Get datasource
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    
    try:
        tables = DataSourceConnectionService.list_tables(
            datasource.type,
            datasource.config,
            search_query=search
        )
        
        return [
            DatasourceTable(
                name=table["name"],
                schema=table.get("schema"),
                table_type=table.get("type", "table")
            )
            for table in tables
        ]
    
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list tables: {str(e)}"
        )
