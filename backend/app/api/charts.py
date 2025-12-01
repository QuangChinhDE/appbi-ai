"""
API router for chart endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.core import get_db
from app.schemas import (
    ChartCreate,
    ChartUpdate,
    ChartResponse,
    ChartDataResponse,
)
from app.services import ChartService
from app.core.logging import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/charts", tags=["charts"])


@router.get("/", response_model=List[ChartResponse])
def list_charts(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    """List all charts with pagination."""
    return ChartService.get_all(db, skip=skip, limit=limit)


@router.get("/{chart_id}", response_model=ChartResponse)
def get_chart(chart_id: int, db: Session = Depends(get_db)):
    """Get a chart by ID."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chart with ID {chart_id} not found"
        )
    return chart


@router.post("/", response_model=ChartResponse, status_code=status.HTTP_201_CREATED)
def create_chart(chart: ChartCreate, db: Session = Depends(get_db)):
    """Create a new chart."""
    try:
        return ChartService.create(db, chart)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/{chart_id}", response_model=ChartResponse)
def update_chart(
    chart_id: int,
    chart_update: ChartUpdate,
    db: Session = Depends(get_db)
):
    """Update a chart."""
    try:
        chart = ChartService.update(db, chart_id, chart_update)
        if not chart:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Chart with ID {chart_id} not found"
            )
        return chart
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{chart_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_chart(chart_id: int, db: Session = Depends(get_db)):
    """Delete a chart."""
    success = ChartService.delete(db, chart_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chart with ID {chart_id} not found"
        )


@router.get("/{chart_id}/data", response_model=ChartDataResponse)
def get_chart_data(chart_id: int, db: Session = Depends(get_db)):
    """Get chart configuration with data."""
    try:
        result = ChartService.get_chart_data(db, chart_id)
        return ChartDataResponse(**result)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Failed to get chart data: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get chart data: {str(e)}"
        )
