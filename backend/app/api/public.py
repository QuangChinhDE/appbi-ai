"""
Public (unauthenticated) endpoints for shared dashboard links.

GET /public/dashboards/{token}                    → dashboard + chart configs
GET /public/dashboards/{token}/charts/{chart_id}/data → chart query data
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core import get_db
from app.models.models import Dashboard, DashboardChart
from app.schemas import DashboardResponse
from app.services import ChartService

router = APIRouter(prefix="/public", tags=["public"])


def _apply_filters_to_rows(rows: list[dict[str, Any]], filters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows or not filters:
        return rows

    def matches(row: dict[str, Any], f: dict[str, Any]) -> bool:
        field = f.get("field")
        operator = f.get("operator")
        filter_type = f.get("type")
        value = f.get("value")
        if not field:
            return True
        cell = row.get(field)
        if cell is None:
            return False

        if filter_type == "date":
            str_val = str(cell)[:10]
            if operator == "between" and isinstance(value, list):
                start = str(value[0])[:10] if len(value) > 0 and value[0] is not None else None
                end = str(value[1])[:10] if len(value) > 1 and value[1] is not None else None
                if start and str_val < start:
                    return False
                if end and str_val > end:
                    return False
                return True
            filter_val = str(value or "")[:10]
            return {
                "eq": str_val == filter_val,
                "neq": str_val != filter_val,
                "gt": str_val > filter_val,
                "gte": str_val >= filter_val,
                "lt": str_val < filter_val,
                "lte": str_val <= filter_val,
            }.get(operator, True)

        if filter_type == "dropdown":
            selected = value if isinstance(value, list) else [value]
            selected = [str(item) for item in selected if item is not None]
            if not selected:
                return True
            if operator == "not_in":
                return str(cell) not in selected
            return str(cell) in selected

        if filter_type == "number":
            try:
                num_val = float(cell)
            except (TypeError, ValueError):
                return False
            if operator == "between" and isinstance(value, list):
                lower = value[0] if len(value) > 0 else None
                upper = value[1] if len(value) > 1 else None
                if lower is not None and num_val < float(lower):
                    return False
                if upper is not None and num_val > float(upper):
                    return False
                return True
            try:
                filter_val = float(value)
            except (TypeError, ValueError):
                return True
            return {
                "eq": num_val == filter_val,
                "neq": num_val != filter_val,
                "gt": num_val > filter_val,
                "gte": num_val >= filter_val,
                "lt": num_val < filter_val,
                "lte": num_val <= filter_val,
            }.get(operator, True)

        str_val = str(cell)
        filter_val = str(value or "")
        return {
            "eq": str_val == filter_val,
            "neq": str_val != filter_val,
            "contains": filter_val.lower() in str_val.lower(),
            "starts_with": str_val.lower().startswith(filter_val.lower()),
        }.get(operator, True)

    return [row for row in rows if all(matches(row, f) for f in filters)]


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
        public_filters = dash.public_filters_config or []
        rows = result.get("data")
        if isinstance(rows, list) and public_filters:
            result = {
                **result,
                "data": _apply_filters_to_rows(rows, [f for f in public_filters if isinstance(f, dict)]),
            }
        return result
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to load chart data: {exc}",
        )
