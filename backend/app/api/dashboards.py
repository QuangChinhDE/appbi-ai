"""
API router for dashboard endpoints.
"""
import secrets
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.core import get_db
from app.core.dependencies import (
    get_current_user,
    require_permission,
    require_view_access,
    require_edit_access,
    require_full_access,
    get_effective_permission,
)
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.models.models import Chart, DashboardChart, Dashboard
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas import (
    DashboardCreate,
    DashboardUpdate,
    DashboardResponse,
    DashboardAddChartRequest,
    DashboardUpdateLayoutRequest,
)
# Commented out - using hybrid approach with filters_config JSON field instead
# from app.schemas.dashboard_filter import (
#     DashboardFilterCreate,
#     DashboardFilterUpdate,
#     DashboardFilter as DashboardFilterSchema,
# )
# from app.models.dashboard_filter import DashboardFilter
from app.services import DashboardService
from app.core.logging import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/dashboards", tags=["dashboards"])


def _require_chart_visibility(db: Session, current_user: User, chart_id: int) -> Chart:
    """Ensure the current user can attach the chart to a dashboard."""
    chart = db.query(Chart).filter(Chart.id == chart_id).first()
    if not chart:
        raise HTTPException(status_code=404, detail=f"Chart with ID {chart_id} not found")
    require_view_access(db, current_user, chart, "explore_charts")
    return chart


@router.get("/", response_model=List[DashboardResponse])
def list_dashboards(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List dashboards visible to the current user."""
    items = (
        _owned_or_shared(db, Dashboard, ResourceType.DASHBOARD, current_user)
        .offset(skip)
        .limit(limit)
        .all()
    )
    for item in items:
        item.user_permission = get_effective_permission(db, current_user, item, "dashboards")
    stamp_owner_emails(db, items)
    return items


@router.get("/{dashboard_id}", response_model=DashboardResponse)
def get_dashboard(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a dashboard by ID."""
    dashboard = DashboardService.get_by_id(db, dashboard_id)
    if not dashboard:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dashboard with ID {dashboard_id} not found"
        )
    dashboard.user_permission = require_view_access(db, current_user, dashboard, "dashboards")
    return dashboard


@router.post("/", response_model=DashboardResponse, status_code=status.HTTP_201_CREATED)
def create_dashboard(
    dashboard: DashboardCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Create a new dashboard."""
    try:
        for chart_item in dashboard.charts:
            _require_chart_visibility(db, current_user, chart_item.chart_id)
        return DashboardService.create(db, dashboard, owner_id=current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/{dashboard_id}", response_model=DashboardResponse)
def update_dashboard(
    dashboard_id: int,
    dashboard_update: DashboardUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dashboard with ID {dashboard_id} not found")
    require_edit_access(db, current_user, dash, "dashboards")
    try:
        dashboard = DashboardService.update(db, dashboard_id, dashboard_update)
        return dashboard
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dashboard(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dashboard with ID {dashboard_id} not found")
    require_full_access(db, current_user, dash, "dashboards")
    success = DashboardService.delete(db, dashboard_id)
    if not success:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dashboard with ID {dashboard_id} not found")


@router.post("/{dashboard_id}/charts", response_model=DashboardResponse)
def add_chart_to_dashboard(
    dashboard_id: int,
    request: DashboardAddChartRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a chart to a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dashboard with ID {dashboard_id} not found")
    require_edit_access(db, current_user, dash, "dashboards")
    _require_chart_visibility(db, current_user, request.chart_id)
    try:
        dashboard = DashboardService.add_chart(
            db,
            dashboard_id,
            request.chart_id,
            request.layout,
            request.parameters,
        )
        return dashboard
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{dashboard_id}/charts/{chart_id}", response_model=DashboardResponse)
def remove_chart_from_dashboard(
    dashboard_id: int,
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a chart from a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dashboard with ID {dashboard_id} not found")
    require_edit_access(db, current_user, dash, "dashboards")
    try:
        dashboard = DashboardService.remove_chart(db, dashboard_id, chart_id)
        return dashboard
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/{dashboard_id}/layout", response_model=DashboardResponse)
def update_dashboard_layout(
    dashboard_id: int,
    request: DashboardUpdateLayoutRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update the layout of charts in a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dashboard with ID {dashboard_id} not found")
    require_edit_access(db, current_user, dash, "dashboards")
    dashboard = DashboardService.update_layout(
        db,
        dashboard_id,
        request.chart_layouts
    )
    return dashboard


# ============ Public Link Sharing ============

@router.post("/{dashboard_id}/share", status_code=status.HTTP_200_OK)
def share_dashboard(
    dashboard_id: int,
    request: DashboardShareRequest | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate (or return existing) a public share token for a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
    require_edit_access(db, current_user, dash, "dashboards")
    if not dash.share_token:
        dash.share_token = secrets.token_urlsafe(32)
    if request is not None and request.public_filters_config is not None:
        dash.public_filters_config = request.public_filters_config
    elif dash.public_filters_config is None:
        dash.public_filters_config = []
    db.commit()
    db.refresh(dash)
    return {
        "share_token": dash.share_token,
        "public_filters_config": dash.public_filters_config or [],
    }


@router.delete("/{dashboard_id}/share", status_code=status.HTTP_200_OK)
def unshare_dashboard(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Revoke the public share token for a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found")
    require_edit_access(db, current_user, dash, "dashboards")
    dash.share_token = None
    dash.public_filters_config = []
    db.commit()
    return {"share_token": None}


# ============ Dashboard Filters ============
# Commented out - using hybrid approach with filters_config JSON field instead
# Filters are now stored directly in dashboard.filters_config as JSON array
# and managed client-side for v1, with future server-side filtering in v2

# @router.get("/{dashboard_id}/filters", response_model=List[DashboardFilterSchema])
# def get_dashboard_filters(dashboard_id: int, db: Session = Depends(get_db)):
#     """Get all filters for a dashboard"""
#     # Verify dashboard exists
#     dashboard = DashboardService.get_by_id(db, dashboard_id)
#     if not dashboard:
#         raise HTTPException(
#             status_code=status.HTTP_404_NOT_FOUND,
#             detail=f"Dashboard with ID {dashboard_id} not found"
#         )
#     
#     filters = db.query(DashboardFilter).filter(
#         DashboardFilter.dashboard_id == dashboard_id
#     ).all()
#     
#     return filters


# @router.post("/{dashboard_id}/filters", response_model=DashboardFilterSchema, status_code=status.HTTP_201_CREATED)
# def create_dashboard_filter(
#     dashboard_id: int,
#     filter_data: DashboardFilterCreate,
#     db: Session = Depends(get_db)
# ):
#     """Create a new dashboard filter"""
#     # Verify dashboard exists
#     dashboard = DashboardService.get_by_id(db, dashboard_id)
#     if not dashboard:
#         raise HTTPException(
#             status_code=status.HTTP_404_NOT_FOUND,
#             detail=f"Dashboard with ID {dashboard_id} not found"
#         )
#     
#     # Create filter
#     db_filter = DashboardFilter(
#         dashboard_id=dashboard_id,
#         name=filter_data.name,
#         field=filter_data.field,
#         type=filter_data.type,
#         operator=filter_data.operator,
#         value=filter_data.value
#     )
#     
#     db.add(db_filter)
#     db.commit()
#     db.refresh(db_filter)
#     
#     return db_filter


# @router.put("/{dashboard_id}/filters/{filter_id}", response_model=DashboardFilterSchema)
# def update_dashboard_filter(
#     dashboard_id: int,
#     filter_id: int,
#     filter_data: DashboardFilterUpdate,
#     db: Session = Depends(get_db)
# ):
#     """Update a dashboard filter"""
#     # Get filter
#     db_filter = db.query(DashboardFilter).filter(
#         DashboardFilter.id == filter_id,
#         DashboardFilter.dashboard_id == dashboard_id
#     ).first()
#     
#     if not db_filter:
#         raise HTTPException(
#             status_code=status.HTTP_404_NOT_FOUND,
#             detail=f"Filter with ID {filter_id} not found in dashboard {dashboard_id}"
#         )
#     
#     # Update fields
#     update_data = filter_data.model_dump(exclude_unset=True)
#     for key, value in update_data.items():
#         setattr(db_filter, key, value)
#     
#     db.commit()
#     db.refresh(db_filter)
#     
#     return db_filter


# @router.delete("/{dashboard_id}/filters/{filter_id}", status_code=status.HTTP_204_NO_CONTENT)
# def delete_dashboard_filter(
#     dashboard_id: int,
#     filter_id: int,
#     db: Session = Depends(get_db)
# ):
#     """Delete a dashboard filter"""
#     # Get filter
#     db_filter = db.query(DashboardFilter).filter(
#         DashboardFilter.id == filter_id,
#         DashboardFilter.dashboard_id == dashboard_id
#     ).first()
#     
#     if not db_filter:
#         raise HTTPException(
#             status_code=status.HTTP_404_NOT_FOUND,
#             detail=f"Filter with ID {filter_id} not found in dashboard {dashboard_id}"
#         )
#     
#     db.delete(db_filter)
#     db.commit()
#     
#     return None
