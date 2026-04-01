"""
Public (unauthenticated) endpoints for shared dashboard links.

GET /public/dashboards/{token}                    → dashboard + chart configs
GET /public/dashboards/{token}/charts/{chart_id}/data → chart query data
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core import get_db
from app.models.models import Dashboard, DashboardChart, DashboardPublicLink
from app.schemas import DashboardResponse
from app.services import ChartService

router = APIRouter(prefix="/public", tags=["public"])


def _apply_filters_to_rows(rows: list[dict[str, Any]], filters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows or not filters:
        return rows

    def _resolve_field(row: dict[str, Any], f: dict[str, Any]) -> str | None:
        """Find the first matching field name for this filter in the row (primary or linkedFields)."""
        field = f.get("field")
        if field and field in row:
            return field
        for lf in (f.get("linkedFields") or []):
            if lf in row:
                return lf
        return None

    def matches(row: dict[str, Any], f: dict[str, Any]) -> bool:
        field = _resolve_field(row, f)
        if not field:
            return True  # filter doesn't apply to this row's columns
        operator = f.get("operator")
        filter_type = f.get("type")
        value = f.get("value")
        cell = row.get(field)
        if cell is None:
            return False

        # Handle multi-value operators first (type-agnostic)
        if operator == "in":
            selected = [str(item) for item in (value if isinstance(value, list) else []) if item is not None]
            if not selected:
                return True
            return str(cell) in selected
        if operator == "not_in":
            excluded = [str(item) for item in (value if isinstance(value, list) else []) if item is not None]
            if not excluded:
                return True
            return str(cell) not in excluded

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


def _get_dashboard_by_token(token: str, db: Session) -> tuple[Dashboard, list[dict]]:
    """Look up dashboard by token. Checks new multi-link table first, falls back to legacy share_token.
    Returns (dashboard, filters_config_for_this_link)."""
    from datetime import datetime, timezone

    # Try new multi-link table first
    link = db.query(DashboardPublicLink).filter(
        DashboardPublicLink.token == token,
        DashboardPublicLink.is_active == True,
    ).first()
    if link:
        dash = db.query(Dashboard).filter(Dashboard.id == link.dashboard_id).first()
        if not dash:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found.")
        # Track access
        link.access_count = (link.access_count or 0) + 1
        link.last_accessed_at = datetime.now(timezone.utc)
        db.commit()
        return dash, link.filters_config or []

    # Fallback to legacy share_token on Dashboard model
    dash = db.query(Dashboard).filter(Dashboard.share_token == token).first()
    if not dash:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Shared dashboard not found or link has been revoked.",
        )
    return dash, dash.public_filters_config or []


@router.get("/dashboards/{token}", response_model=DashboardResponse)
def get_public_dashboard(token: str, db: Session = Depends(get_db)):
    """Return dashboard structure for a public shared link. No auth required."""
    dash, public_filters = _get_dashboard_by_token(token, db)
    # Public viewers get view-level permission (read-only, no edit actions)
    dash.user_permission = "view"
    # Expose the link-specific filters so the frontend can display filter badges
    dash.public_filters_config = public_filters
    return dash


@router.get("/dashboards/{token}/charts/{chart_id}/data")
def get_public_chart_data(token: str, chart_id: int, db: Session = Depends(get_db)):
    """Return chart data for a public shared link.

    Validates that chart_id belongs to the shared dashboard so a stray token
    cannot be used to access arbitrary charts.
    """
    dash, public_filters = _get_dashboard_by_token(token, db)

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
