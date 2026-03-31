"""
Public (unauthenticated) endpoints for shared dashboard links.

GET /public/dashboards/{token}                    → dashboard + chart configs
GET /public/dashboards/{token}/charts/{chart_id}/data → chart query data
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core import get_db
from app.models.models import Dashboard, DashboardChart
from app.schemas import DashboardResponse
from app.services import ChartService

router = APIRouter(prefix="/public", tags=["public"])


def _get_dashboard_by_token(token: str, db: Session) -> Dashboard:
    dash = db.query(Dashboard).filter(Dashboard.share_token == token).first()
    if not dash:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Shared dashboard not found or link has been revoked.",
        )
    return dash


@router.get("/dashboards/{token}", response_model=DashboardResponse)
def get_public_dashboard(token: str, db: Session = Depends(get_db)):
    """Return dashboard structure for a public shared link. No auth required."""
    dash = _get_dashboard_by_token(token, db)
    # Public viewers get view-level permission (read-only, no edit actions)
    dash.user_permission = "view"
    return dash


@router.get("/dashboards/{token}/charts/{chart_id}/data")
def get_public_chart_data(token: str, chart_id: int, db: Session = Depends(get_db)):
    """Return chart data for a public shared link.

    Validates that chart_id belongs to the shared dashboard so a stray token
    cannot be used to access arbitrary charts.
    """
    dash = _get_dashboard_by_token(token, db)

    # Confirm the chart belongs to this dashboard
    link = (
        db.query(DashboardChart)
        .filter(
            DashboardChart.dashboard_id == dash.id,
            DashboardChart.chart_id == chart_id,
        )
        .first()
    )
    if not link:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chart not found in this shared dashboard.",
        )

    try:
        result = ChartService.get_chart_data(db, chart_id)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to load chart data: {exc}",
        )
