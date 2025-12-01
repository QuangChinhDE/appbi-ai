"""
API router for dataset endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.core import get_db
from app.schemas import (
    DatasetCreate,
    DatasetUpdate,
    DatasetResponse,
    DatasetExecuteRequest,
    DatasetExecuteResponse,
)
from app.services import DatasetService
from app.core.logging import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/datasets", tags=["datasets"])


@router.get("/", response_model=List[DatasetResponse])
def list_datasets(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    """List all datasets with pagination."""
    return DatasetService.get_all(db, skip=skip, limit=limit)


@router.get("/{dataset_id}", response_model=DatasetResponse)
def get_dataset(dataset_id: int, db: Session = Depends(get_db)):
    """Get a dataset by ID."""
    dataset = DatasetService.get_by_id(db, dataset_id)
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset with ID {dataset_id} not found"
        )
    return dataset


@router.post("/", response_model=DatasetResponse, status_code=status.HTTP_201_CREATED)
def create_dataset(dataset: DatasetCreate, db: Session = Depends(get_db)):
    """Create a new dataset."""
    try:
        return DatasetService.create(db, dataset)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/{dataset_id}", response_model=DatasetResponse)
def update_dataset(
    dataset_id: int,
    dataset_update: DatasetUpdate,
    db: Session = Depends(get_db)
):
    """Update a dataset."""
    try:
        dataset = DatasetService.update(db, dataset_id, dataset_update)
        if not dataset:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Dataset with ID {dataset_id} not found"
            )
        return dataset
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(dataset_id: int, db: Session = Depends(get_db)):
    """Delete a dataset."""
    success = DatasetService.delete(db, dataset_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset with ID {dataset_id} not found"
        )


@router.post("/{dataset_id}/execute", response_model=DatasetExecuteResponse)
def execute_dataset(
    dataset_id: int,
    request: DatasetExecuteRequest,
    db: Session = Depends(get_db)
):
    """Execute a dataset query and return the results."""
    try:
        result = DatasetService.execute(db, dataset_id, request.limit)
        return DatasetExecuteResponse(**result)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Dataset execution failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Dataset execution failed: {str(e)}"
        )
