"""
API endpoints for Dataset Models (multi-table datasets)
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.core.database import get_db
from app.schemas import (
    DatasetModelCreate,
    DatasetModelUpdate,
    DatasetModelResponse,
    DatasetModelDetail,
    DatasetModelTableCreate,
    DatasetModelTableUpdate,
    DatasetModelTableResponse,
    DatasetRelationshipCreate,
    DatasetRelationshipUpdate,
    DatasetRelationshipResponse,
    DatasetCalculatedColumnCreate,
    DatasetCalculatedColumnUpdate,
    DatasetCalculatedColumnResponse,
    DatasetModelPreviewRequest,
    DatasetModelPreviewResponse,
    DatasetModelExecuteRequest,
    DatasetModelExecuteResponse,
)
# Aliases for backward compatibility in this file
DatasetTableCreate = DatasetModelTableCreate
DatasetTableUpdate = DatasetModelTableUpdate
DatasetTableResponse = DatasetModelTableResponse
from app.schemas import DatasetModelTablePreviewRequest, DatasetModelTablePreviewResponse
TablePreviewRequest = DatasetModelTablePreviewRequest
TablePreviewResponse = DatasetModelTablePreviewResponse
from app.services import DatasetModelCRUDService, DatasetModelCompilerService
from app.services.datasource_service import DataSourceConnectionService
from app.models import DataSource

router = APIRouter(prefix="/dataset-models", tags=["dataset-models"])


# ============================================================================
# Dataset Model CRUD Endpoints
# ============================================================================

@router.get("", response_model=List[DatasetModelResponse])
def get_dataset_models(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db)
):
    """Get all dataset models"""
    service = DatasetModelCRUDService(db)
    return service.get_dataset_models(skip=skip, limit=limit)


@router.post("", response_model=DatasetModelResponse, status_code=status.HTTP_201_CREATED)
def create_dataset_model(
    data: DatasetModelCreate,
    db: Session = Depends(get_db)
):
    """Create a new dataset model"""
    service = DatasetModelCRUDService(db)
    return service.create_dataset_model(data)


@router.get("/{model_id}", response_model=DatasetModelDetail)
def get_dataset_model(
    model_id: int,
    db: Session = Depends(get_db)
):
    """Get dataset model by ID with all tables, relationships, and calculated columns"""
    service = DatasetModelCRUDService(db)
    model = service.get_dataset_model(model_id)
    
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset model {model_id} not found"
        )
    
    return model


@router.put("/{model_id}", response_model=DatasetModelResponse)
def update_dataset_model(
    model_id: int,
    data: DatasetModelUpdate,
    db: Session = Depends(get_db)
):
    """Update dataset model"""
    service = DatasetModelCRUDService(db)
    model = service.update_dataset_model(model_id, data)
    
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset model {model_id} not found"
        )
    
    return model


@router.delete("/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset_model(
    model_id: int,
    db: Session = Depends(get_db)
):
    """Delete dataset model"""
    service = DatasetModelCRUDService(db)
    success = service.delete_dataset_model(model_id)
    
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset model {model_id} not found"
        )


# ============================================================================
# Table Endpoints
# ============================================================================

@router.post("/{model_id}/tables", response_model=DatasetTableResponse, status_code=status.HTTP_201_CREATED)
def create_table(
    model_id: int,
    data: DatasetTableCreate,
    db: Session = Depends(get_db)
):
    """Create a new table in dataset model"""
    service = DatasetModelCRUDService(db)
    
    # Verify model exists
    model = service.get_dataset_model(model_id)
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset model {model_id} not found"
        )
    
    return service.create_table(model_id, data)


@router.put("/{model_id}/tables/{table_id}", response_model=DatasetTableResponse)
def update_table(
    model_id: int,
    table_id: int,
    data: DatasetTableUpdate,
    db: Session = Depends(get_db)
):
    """Update table"""
    service = DatasetModelCRUDService(db)
    table = service.update_table(table_id, data)
    
    if not table:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Table {table_id} not found"
        )
    
    if table.dataset_model_id != model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Table {table_id} does not belong to model {model_id}"
        )
    
    return table


@router.delete("/{model_id}/tables/{table_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_table(
    model_id: int,
    table_id: int,
    db: Session = Depends(get_db)
):
    """Delete table"""
    service = DatasetModelCRUDService(db)
    
    # Verify table belongs to model
    table = service.get_table(table_id)
    if not table:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Table {table_id} not found"
        )
    
    if table.dataset_model_id != model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Table {table_id} does not belong to model {model_id}"
        )
    
    service.delete_table(table_id)


@router.post("/{model_id}/tables/{table_id}/preview", response_model=TablePreviewResponse)
async def preview_table(
    model_id: int,
    table_id: int,
    request: TablePreviewRequest,
    db: Session = Depends(get_db)
):
    """Preview individual table with transformations"""
    crud_service = DatasetModelCRUDService(db)
    compiler_service = DatasetModelCompilerService(db)
    
    # Get table
    table = crud_service.get_table(table_id)
    if not table:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Table {table_id} not found"
        )
    
    if table.dataset_model_id != model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Table {table_id} does not belong to model {model_id}"
        )
    
    try:
        result = await compiler_service.preview_table(table, limit=request.limit)
        
        # Update cached columns
        crud_service.update_table_columns_cache(table_id, result["columns"])
        
        return TablePreviewResponse(**result)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# ============================================================================
# Relationship Endpoints
# ============================================================================

@router.post("/{model_id}/relationships", response_model=DatasetRelationshipResponse, status_code=status.HTTP_201_CREATED)
def create_relationship(
    model_id: int,
    data: DatasetRelationshipCreate,
    db: Session = Depends(get_db)
):
    """Create a new relationship between tables"""
    crud_service = DatasetModelCRUDService(db)
    compiler_service = DatasetModelCompilerService(db)
    
    # Verify model exists
    model = crud_service.get_dataset_model(model_id)
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset model {model_id} not found"
        )
    
    # Verify tables exist and belong to model
    left_table = crud_service.get_table(data.left_table_id)
    right_table = crud_service.get_table(data.right_table_id)
    
    if not left_table or not right_table:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="One or both tables not found"
        )
    
    if left_table.dataset_model_id != model_id or right_table.dataset_model_id != model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tables must belong to the same dataset model"
        )
    
    # Validate cross-source joins
    is_valid, error = compiler_service.validate_cross_source_joins(model)
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error
        )
    
    return crud_service.create_relationship(model_id, data)


@router.put("/{model_id}/relationships/{rel_id}", response_model=DatasetRelationshipResponse)
def update_relationship(
    model_id: int,
    rel_id: int,
    data: DatasetRelationshipUpdate,
    db: Session = Depends(get_db)
):
    """Update relationship"""
    service = DatasetModelCRUDService(db)
    relationship = service.update_relationship(rel_id, data)
    
    if not relationship:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Relationship {rel_id} not found"
        )
    
    if relationship.dataset_model_id != model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Relationship {rel_id} does not belong to model {model_id}"
        )
    
    return relationship


@router.delete("/{model_id}/relationships/{rel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_relationship(
    model_id: int,
    rel_id: int,
    db: Session = Depends(get_db)
):
    """Delete relationship"""
    service = DatasetModelCRUDService(db)
    success = service.delete_relationship(rel_id)
    
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Relationship {rel_id} not found"
        )


# ============================================================================
# Calculated Column Endpoints
# ============================================================================

@router.post("/{model_id}/calculated-columns", response_model=DatasetCalculatedColumnResponse, status_code=status.HTTP_201_CREATED)
def create_calculated_column(
    model_id: int,
    data: DatasetCalculatedColumnCreate,
    db: Session = Depends(get_db)
):
    """Create a new calculated column"""
    service = DatasetModelCRUDService(db)
    
    # Verify model exists
    model = service.get_dataset_model(model_id)
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset model {model_id} not found"
        )
    
    return service.create_calculated_column(model_id, data)


@router.put("/{model_id}/calculated-columns/{col_id}", response_model=DatasetCalculatedColumnResponse)
def update_calculated_column(
    model_id: int,
    col_id: int,
    data: DatasetCalculatedColumnUpdate,
    db: Session = Depends(get_db)
):
    """Update calculated column"""
    service = DatasetModelCRUDService(db)
    column = service.update_calculated_column(col_id, data)
    
    if not column:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Calculated column {col_id} not found"
        )
    
    if column.dataset_model_id != model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Calculated column {col_id} does not belong to model {model_id}"
        )
    
    return column


@router.delete("/{model_id}/calculated-columns/{col_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_calculated_column(
    model_id: int,
    col_id: int,
    db: Session = Depends(get_db)
):
    """Delete calculated column"""
    service = DatasetModelCRUDService(db)
    success = service.delete_calculated_column(col_id)
    
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Calculated column {col_id} not found"
        )


# ============================================================================
# Preview & Execute Endpoints
# ============================================================================

@router.post("/{model_id}/preview", response_model=DatasetModelPreviewResponse)
async def preview_dataset_model(
    model_id: int,
    request: DatasetModelPreviewRequest,
    db: Session = Depends(get_db)
):
    """Preview dataset model with optional stop-at stage"""
    crud_service = DatasetModelCRUDService(db)
    compiler_service = DatasetModelCompilerService(db)
    connection_service = DataSourceConnectionService(db)
    
    # Get model with all relationships
    model = crud_service.get_dataset_model(model_id)
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset model {model_id} not found"
        )
    
    if not model.tables:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Dataset model has no tables"
        )
    
    # Validate cross-source joins
    is_valid, error = compiler_service.validate_cross_source_joins(model)
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error
        )
    
    # Get datasource type from first table
    first_table = model.tables[0]
    datasource = db.query(DataSource).filter(DataSource.id == first_table.data_source_id).first()
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"DataSource {first_table.data_source_id} not found"
        )
    
    try:
        # Compile SQL
        compiled_sql = compiler_service.compile_final_sql(
            dataset_model=model,
            datasource_type=datasource.type.value,
            limit=request.limit,
            stop_at=request.stop_at
        )
        
        # Execute query
        result = await connection_service.execute_query(datasource, compiled_sql)
        
        return DatasetModelPreviewResponse(
            columns=result["columns"],
            rows=result["rows"],
            total_rows=len(result["rows"]),
            compiled_sql=compiled_sql
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Preview failed: {str(e)}"
        )


@router.post("/{model_id}/execute", response_model=DatasetModelExecuteResponse)
async def execute_dataset_model(
    model_id: int,
    request: DatasetModelExecuteRequest,
    db: Session = Depends(get_db)
):
    """Execute dataset model and return final joined+calculated data"""
    crud_service = DatasetModelCRUDService(db)
    compiler_service = DatasetModelCompilerService(db)
    connection_service = DataSourceConnectionService(db)
    
    # Get model
    model = crud_service.get_dataset_model(model_id)
    if not model:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset model {model_id} not found"
        )
    
    if not model.tables:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Dataset model has no tables"
        )
    
    # Validate cross-source joins
    is_valid, error = compiler_service.validate_cross_source_joins(model)
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error
        )
    
    # Get datasource
    first_table = model.tables[0]
    datasource = db.query(DataSource).filter(DataSource.id == first_table.data_source_id).first()
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"DataSource {first_table.data_source_id} not found"
        )
    
    try:
        # Compile SQL (stop_at="final" by default)
        compiled_sql = compiler_service.compile_final_sql(
            dataset_model=model,
            datasource_type=datasource.type.value,
            limit=request.limit,
            stop_at="final"
        )
        
        # Execute query
        result = await connection_service.execute_query(datasource, compiled_sql)
        
        return DatasetModelExecuteResponse(
            columns=result["columns"],
            rows=result["rows"],
            total_rows=len(result["rows"])
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Execution failed: {str(e)}"
        )
