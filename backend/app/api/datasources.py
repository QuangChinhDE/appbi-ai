"""
API router for data source endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.core import get_db
from app.schemas import (
    DataSourceCreate,
    DataSourceUpdate,
    DataSourceResponse,
    DataSourceTestRequest,
    DataSourceTestResponse,
    QueryExecuteRequest,
    QueryExecuteResponse,
)
from app.services import DataSourceCRUDService, DataSourceConnectionService
from app.core.logging import get_logger
import time

logger = get_logger(__name__)
router = APIRouter(prefix="/datasources", tags=["datasources"])


@router.get("/", response_model=List[DataSourceResponse])
def list_data_sources(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    """List all data sources with pagination."""
    return DataSourceCRUDService.get_all(db, skip=skip, limit=limit)


@router.get("/{data_source_id}", response_model=DataSourceResponse)
def get_data_source(data_source_id: int, db: Session = Depends(get_db)):
    """Get a data source by ID."""
    data_source = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not data_source:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {data_source_id} not found"
        )
    return data_source


@router.post("/", response_model=DataSourceResponse, status_code=status.HTTP_201_CREATED)
def create_data_source(data_source: DataSourceCreate, db: Session = Depends(get_db)):
    """Create a new data source."""
    try:
        return DataSourceCRUDService.create(db, data_source)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/{data_source_id}", response_model=DataSourceResponse)
def update_data_source(
    data_source_id: int,
    data_source_update: DataSourceUpdate,
    db: Session = Depends(get_db)
):
    """Update a data source."""
    try:
        data_source = DataSourceCRUDService.update(db, data_source_id, data_source_update)
        if not data_source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Data source with ID {data_source_id} not found"
            )
        return data_source
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{data_source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_data_source(data_source_id: int, db: Session = Depends(get_db)):
    """Delete a data source."""
    success = DataSourceCRUDService.delete(db, data_source_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {data_source_id} not found"
        )


@router.post("/test", response_model=DataSourceTestResponse)
def test_data_source_connection(request: DataSourceTestRequest):
    """Test a data source connection."""
    success, message = DataSourceConnectionService.test_connection(
        request.type.value,
        request.config
    )
    return DataSourceTestResponse(success=success, message=message)


@router.post("/query", response_model=QueryExecuteResponse)
def execute_query(request: QueryExecuteRequest, db: Session = Depends(get_db)):
    """Execute an ad-hoc SQL query against a data source."""
    data_source = DataSourceCRUDService.get_by_id(db, request.data_source_id)
    if not data_source:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {request.data_source_id} not found"
        )
    
    try:
        start_time = time.time()
        columns, data, execution_time_ms = DataSourceConnectionService.execute_query(
            data_source.type.value,
            data_source.config,
            request.sql_query,
            request.limit
        )
        
        return QueryExecuteResponse(
            columns=columns,
            data=data,
            row_count=len(data),
            execution_time_ms=execution_time_ms
        )
    except Exception as e:
        logger.error(f"Query execution failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Query execution failed: {str(e)}"
        )
