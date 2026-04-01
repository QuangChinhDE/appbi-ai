"""
Public (unauthenticated) endpoints for shared dashboard links.

POST /public/dashboards/{token}/auth               → exchange password for session token
GET  /public/dashboards/{token}                    → dashboard + chart configs
GET  /public/dashboards/{token}/charts/{chart_id}/data → chart query data

Password-protected links require a session token obtained from /auth.
Session tokens are JWTs signed with the app SECRET_KEY, valid for 2 hours.
Send them via the X-Public-Session request header.
"""
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core import get_db
from app.core.config import settings
from app.core.dependencies import ALGORITHM
from app.core.logging import get_logger
from app.models.models import Dashboard, DashboardChart, DashboardPublicLink
from app.schemas import DashboardResponse
from app.services import ChartService

from slowapi import Limiter
from slowapi.util import get_remote_address

router = APIRouter(prefix="/public", tags=["public"])
_limiter = Limiter(key_func=get_remote_address)
logger = get_logger(__name__)
_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

# 2 hours — covers a full business meeting/presentation session without excessive re-auth
# friction, while limiting the exposure window for forgotten open browser tabs.
PUBLIC_SESSION_SECONDS = 7200


class _PasswordBody(BaseModel):
    password: str


def _create_public_session(link_token: str) -> str:
    payload = {
        "sub": link_token,
        "type": "public_link_session",
        "exp": datetime.now(timezone.utc) + timedelta(seconds=PUBLIC_SESSION_SECONDS),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def _verify_public_session(session_token: str, link_token: str) -> bool:
    try:
        data = jwt.decode(session_token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        return data.get("sub") == link_token and data.get("type") == "public_link_session"
    except JWTError:
        return False


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


def _get_dashboard_by_token(
    token: str,
    db: Session,
    session_token: str | None = None,
) -> tuple[Dashboard, list[dict]]:
    """Look up dashboard by token. Checks new multi-link table first, falls back to legacy share_token.
    Returns (dashboard, filters_config_for_this_link)."""
    # Try new multi-link table first
    link = db.query(DashboardPublicLink).filter(
        DashboardPublicLink.token == token,
        DashboardPublicLink.is_active == True,
    ).first()
    if link:
        # Check expiry
        if link.expires_at and datetime.now(timezone.utc) > link.expires_at:
            raise HTTPException(status_code=status.HTTP_410_GONE, detail="This shared link has expired.")

        # Check max access count
        if link.max_access_count and (link.access_count or 0) >= link.max_access_count:
            raise HTTPException(status_code=status.HTTP_410_GONE, detail="This shared link has reached its access limit.")

        # Check password protection — require a valid session token
        if link.password_hash:
            if not session_token or not _verify_public_session(session_token, token):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="This shared link requires a password.",
                    headers={"X-Link-Password-Required": "true"},
                )

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


@router.post("/dashboards/{token}/auth")
@_limiter.limit("10/minute")
def auth_public_link(
    token: str,
    body: _PasswordBody,
    request: Request,
    db: Session = Depends(get_db),
):
    """Authenticate a password-protected public link. Returns a short-lived session token.

    The session token (JWT, valid for 2 hours) must be sent as the
    X-Public-Session header on subsequent GET requests for this link.
    """
    link = db.query(DashboardPublicLink).filter(
        DashboardPublicLink.token == token,
        DashboardPublicLink.is_active == True,
    ).first()
    if not link:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shared dashboard not found or link has been revoked.")
    if link.expires_at and datetime.now(timezone.utc) > link.expires_at:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="This shared link has expired.")
    if not link.password_hash:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This link does not require a password.")
    if not _pwd_ctx.verify(body.password, link.password_hash):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Incorrect password.")
    return {"session_token": _create_public_session(token), "expires_in": PUBLIC_SESSION_SECONDS}


@router.get("/dashboards/{token}", response_model=DashboardResponse)
@_limiter.limit("30/minute")
def get_public_dashboard(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Return dashboard structure for a public shared link. No auth required.
    Password-protected links require X-Public-Session header from /auth."""
    dash, public_filters = _get_dashboard_by_token(token, db, session_token=x_public_session)
    # Public viewers get view-level permission (read-only, no edit actions)
    dash.user_permission = "view"
    # Expose the link-specific filters so the frontend can display filter badges
    dash.public_filters_config = public_filters
    return dash


@router.get("/dashboards/{token}/charts/{chart_id}/data")
@_limiter.limit("30/minute")
def get_public_chart_data(
    token: str,
    chart_id: int,
    request: Request,
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Return chart data for a public shared link.

    Validates that chart_id belongs to the shared dashboard so a stray token
    cannot be used to access arbitrary charts.
    Password-protected links require X-Public-Session header from /auth.
    """
    dash, public_filters = _get_dashboard_by_token(token, db, session_token=x_public_session)

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
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chart data not found.")
    except Exception as exc:
        logger.error(f"Public chart data error for token={token} chart={chart_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load chart data.",
        )
