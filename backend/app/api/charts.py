"""
API router for chart endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.core import get_db
from app.core.dependencies import get_current_user, require_permission, require_edit_access, require_full_access, get_effective_permission
from app.core.permissions import _owned_or_shared
from app.models.models import Chart, DashboardChart, Dashboard
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas import (
    ChartCreate,
    ChartUpdate,
    ChartResponse,
    ChartDataResponse,
    ChartMetadataUpsert,
    ChartMetadataResponse,
    ChartParameterCreate,
    ChartParameterUpdate,
    ChartParameterResponse,
)
from app.services import ChartService
from app.core.logging import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/charts", tags=["charts"])


@router.get("/", response_model=List[ChartResponse])
def list_charts(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List charts visible to the current user."""
    items = (
        _owned_or_shared(db, Chart, ResourceType.CHART, current_user)
        .offset(skip)
        .limit(limit)
        .all()
    )
    for item in items:
        item.user_permission = get_effective_permission(db, current_user, item, "explore_charts")
    return items


@router.get("/{chart_id}", response_model=ChartResponse)
def get_chart(
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a chart by ID."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chart with ID {chart_id} not found"
        )
    chart.user_permission = get_effective_permission(db, current_user, chart, "explore_charts")
    return chart


@router.post("/", response_model=ChartResponse, status_code=status.HTTP_201_CREATED)
def create_chart(
    chart: ChartCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("explore_charts", "edit")),
):
    """Create a new chart."""
    try:
        return ChartService.create(db, chart, owner_id=current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/{chart_id}", response_model=ChartResponse)
def update_chart(
    chart_id: int,
    chart_update: ChartUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a chart."""
    chart_obj = db.query(Chart).filter(Chart.id == chart_id).first()
    if not chart_obj:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart with ID {chart_id} not found")
    require_edit_access(db, current_user, chart_obj, "explore_charts")
    try:
        chart = ChartService.update(db, chart_id, chart_update)
        return chart
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{chart_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_chart(
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a chart, blocked if it is used in any dashboard."""
    chart = db.query(Chart).filter(Chart.id == chart_id).first()
    if not chart:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chart with ID {chart_id} not found"
        )
    require_full_access(db, current_user, chart, "explore_charts")

    blocking_links = (
        db.query(DashboardChart)
        .filter(DashboardChart.chart_id == chart_id)
        .all()
    )
    if blocking_links:
        dashboard_ids = {lnk.dashboard_id for lnk in blocking_links}
        dashboards = db.query(Dashboard).filter(Dashboard.id.in_(dashboard_ids)).all()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": f"Chart \"{chart.name}\" đang được sử dụng trong {len(dashboards)} dashboard và không thể xóa.",
                "constraints": [
                    {"type": "dashboard", "id": d.id, "name": d.name}
                    for d in dashboards
                ],
            },
        )

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


# ---------------------------------------------------------------------------
# Metadata endpoints
# ---------------------------------------------------------------------------

@router.put("/{chart_id}/metadata", response_model=ChartMetadataResponse)
def upsert_chart_metadata(
    chart_id: int,
    data: ChartMetadataUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create or replace semantic metadata for a chart."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    return ChartService.upsert_metadata(db, chart_id, data)


@router.get("/{chart_id}/metadata", response_model=ChartMetadataResponse)
def get_chart_metadata(chart_id: int, db: Session = Depends(get_db)):
    """Get semantic metadata for a chart."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    meta = ChartService.get_metadata(db, chart_id)
    if not meta:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No metadata found for this chart")
    return meta


@router.delete("/{chart_id}/metadata", status_code=status.HTTP_204_NO_CONTENT)
def delete_chart_metadata(
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete semantic metadata for a chart."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    if not ChartService.delete_metadata(db, chart_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No metadata found for this chart")


# ---------------------------------------------------------------------------
# Parameter definition endpoints
# ---------------------------------------------------------------------------

@router.get("/{chart_id}/parameters", response_model=List[ChartParameterResponse])
def list_chart_parameters(chart_id: int, db: Session = Depends(get_db)):
    """List all parameter definitions for a chart."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    return ChartService.get_parameters(db, chart_id)


@router.put("/{chart_id}/parameters", response_model=List[ChartParameterResponse])
def replace_chart_parameters(
    chart_id: int,
    params: List[ChartParameterCreate],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Replace all parameter definitions for a chart (bulk replace)."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    return ChartService.replace_parameters(db, chart_id, params)


@router.post("/{chart_id}/parameters", response_model=ChartParameterResponse, status_code=status.HTTP_201_CREATED)
def add_chart_parameter(
    chart_id: int,
    data: ChartParameterCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a single parameter definition to a chart."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    return ChartService.add_parameter(db, chart_id, data)


@router.put("/{chart_id}/parameters/{param_id}", response_model=ChartParameterResponse)
def update_chart_parameter(
    chart_id: int,
    param_id: int,
    data: ChartParameterUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a parameter definition."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    param = ChartService.update_parameter(db, chart_id, param_id, data)
    if not param:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Parameter {param_id} not found")
    return param


@router.delete("/{chart_id}/parameters/{param_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_chart_parameter(
    chart_id: int,
    param_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a parameter definition."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    if not ChartService.delete_parameter(db, chart_id, param_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Parameter {param_id} not found")
