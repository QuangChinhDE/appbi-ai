"""
Public (unauthenticated) endpoints for shared dashboard links.

POST /public/dashboards/{token}/auth               → exchange password for session token
GET  /public/dashboards/{token}                    → dashboard + chart configs
GET  /public/dashboards/{token}/charts/{chart_id}/data → chart query data

Password-protected links require a session token obtained from /auth.
Session tokens are JWTs signed with the app SECRET_KEY, valid for 2 hours.
Send them via the X-Public-Session request header.
"""
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
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
from app.services.dataset_model_service import get_dataset_model, get_distinct_field_values

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


def _semantic_dimension_to_filter_type(dimension_type: str | None) -> str:
    normalized = str(dimension_type or "").lower()
    if normalized in {"date", "datetime"}:
        return "date"
    if normalized == "number":
        return "number"
    return "dropdown"


def _collect_join_key_fields(model: dict | None) -> set[str]:
    fields: set[str] = set()

    for explore in model.get("explores", []) if isinstance(model, dict) else []:
        base_view_name = str(explore.get("base_view_name") or "").strip()
        for join in explore.get("joins", []) or []:
            if join.get("origin") == "auto_calendar":
                continue

            from_view = str(join.get("from_view") or base_view_name or "").strip()
            from_column = str(join.get("from_column") or "").strip()
            to_view = str(join.get("view") or "").strip()
            to_column = str(join.get("to_column") or "").strip()

            if from_view and from_column:
                fields.add(f"{from_view}.{from_column}")
            if to_view and to_column:
                fields.add(f"{to_view}.{to_column}")

    return fields


def _build_public_calendar_filter_fields(dash: Dashboard) -> list[dict]:
    semantic_fields: set[str] = set()
    charts_with_calendar: set[int] = set()
    dataset_ids: set[int] = set()
    total_dashboard_chart_count = len(dash.dashboard_charts or [])

    for dashboard_chart in dash.dashboard_charts or []:
        chart_config = dashboard_chart.chart.config if dashboard_chart.chart else {}
        binding = chart_config.get("semanticBinding") if isinstance(chart_config, dict) else None
        if not isinstance(binding, dict):
            continue

        dataset_id = binding.get("datasetId")
        if isinstance(dataset_id, int):
            dataset_ids.add(dataset_id)

        date_mappings = [
            mapping for mapping in (binding.get("calendarFieldMappings") or [])
            if isinstance(mapping, dict)
            and mapping.get("calendarField") == "date"
            and isinstance(mapping.get("semanticField"), str)
            and "." in str(mapping.get("semanticField"))
        ]
        if not date_mappings:
            continue

        charts_with_calendar.add(dashboard_chart.chart_id)
        for mapping in date_mappings:
            semantic_fields.add(str(mapping["semanticField"]))

    ordered_semantic_fields = sorted(semantic_fields)
    if not ordered_semantic_fields:
        return []

    return [{
        "key": ordered_semantic_fields[0],
        "name": "date",
        "label": "Date",
        "type": "date",
        "semanticField": ordered_semantic_fields[0],
        "datasetId": next(iter(dataset_ids)) if len(dataset_ids) == 1 else None,
        "defaultLinkedFields": ordered_semantic_fields[1:],
        "chartCoverage": len(charts_with_calendar),
        "datasetChartCount": total_dashboard_chart_count,
        "sharedAcrossDataset": total_dashboard_chart_count > 0 and len(charts_with_calendar) == total_dashboard_chart_count,
    }]


def _build_public_filter_fields(db: Session, dash: Dashboard) -> list[dict]:
    dataset_models: dict[int, dict] = {}
    dataset_join_key_fields: dict[int, set[str]] = {}
    columns: dict[str, dict] = {}
    counts: dict[str, set[int]] = {}
    total_dashboard_chart_count = len(dash.dashboard_charts or [])

    for dashboard_chart in dash.dashboard_charts or []:
        chart_config = dashboard_chart.chart.config if dashboard_chart.chart else {}
        binding = chart_config.get("semanticBinding") if isinstance(chart_config, dict) else None
        if not isinstance(binding, dict):
            continue

        dataset_id = binding.get("datasetId")
        if not isinstance(dataset_id, int):
            continue

        if dataset_id not in dataset_models:
            model = get_dataset_model(db, dataset_id)
            if not model:
                continue
            dataset_models[dataset_id] = model
            dataset_join_key_fields[dataset_id] = _collect_join_key_fields(model)

        model = dataset_models.get(dataset_id)
        if not model:
            continue

        views_by_name = {
            str(view.get("name")): view
            for view in model.get("views", [])
            if isinstance(view, dict) and view.get("name")
        }
        join_key_fields = dataset_join_key_fields.get(dataset_id, set())
        candidate_fields = binding.get("dimensionFields") or list((binding.get("fieldMap") or {}).values())

        for semantic_field in candidate_fields:
            if not isinstance(semantic_field, str) or "." not in semantic_field:
                continue
            view_name, field_name = semantic_field.split(".", 1)
            view = views_by_name.get(view_name)
            if not isinstance(view, dict) or view.get("hidden_in_canvas"):
                continue

            dimension = next(
                (
                    item for item in (view.get("dimensions") or [])
                    if isinstance(item, dict) and item.get("name") == field_name
                ),
                None,
            )
            if not isinstance(dimension, dict):
                continue

            if bool(dimension.get("hidden")) and semantic_field not in join_key_fields:
                continue

            if semantic_field not in columns:
                columns[semantic_field] = {
                    "key": semantic_field,
                    "name": field_name,
                    "label": dimension.get("label") or field_name,
                    "type": _semantic_dimension_to_filter_type(dimension.get("type")),
                    "datasetId": dataset_id,
                    "semanticField": semantic_field,
                }

            counts.setdefault(semantic_field, set()).add(dashboard_chart.chart_id)

    normalized_columns: list[dict] = []
    for key, column in columns.items():
        chart_coverage = len(counts.get(key, set()))
        normalized_columns.append({
            **column,
            "chartCoverage": chart_coverage,
            "datasetChartCount": total_dashboard_chart_count,
            "sharedAcrossDataset": total_dashboard_chart_count > 0 and chart_coverage == total_dashboard_chart_count,
        })

    normalized_columns.sort(
        key=lambda item: (
            -(1 if item.get("sharedAcrossDataset") else 0),
            -(item.get("chartCoverage") or 0),
            str(item.get("label") or item.get("name") or ""),
        )
    )

    calendar_columns = _build_public_calendar_filter_fields(dash)
    if calendar_columns:
        non_date_columns = [item for item in normalized_columns if item.get("type") != "date"]
        return [*calendar_columns, *non_date_columns]

    return normalized_columns


def _resolve_public_filter_field(
    db: Session,
    dash: Dashboard,
    dataset_id: int,
    field: str,
) -> dict | None:
    return next(
        (
            item for item in _build_public_filter_fields(db, dash)
            if item.get("datasetId") == dataset_id and item.get("semanticField") == field
        ),
        None,
    )


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


def _get_dashboard_by_token(
    token: str,
    db: Session,
    session_token: str | None = None,
    *,
    track_access: bool = True,
) -> tuple[Dashboard, list[dict], str | None, dict]:
    """Look up dashboard by token. Checks new multi-link table first, falls back to legacy share_token.
    Returns (dashboard, filters_config_for_this_link, link_name, appearance_config)."""
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
        if track_access:
            link.access_count = (link.access_count or 0) + 1
            link.last_accessed_at = datetime.now(timezone.utc)
            db.commit()
        return dash, link.filters_config or [], link.name, link.appearance_config or {}

    # Fallback to legacy share_token on Dashboard model
    dash = db.query(Dashboard).filter(Dashboard.share_token == token).first()
    if not dash:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Shared dashboard not found or link has been revoked.",
        )
    return dash, dash.public_filters_config or [], dash.name, {}


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
    dash, public_filters, link_name, appearance_config = _get_dashboard_by_token(
        token,
        db,
        session_token=x_public_session,
    )
    # Public viewers get view-level permission (read-only, no edit actions)
    dash.user_permission = "view"
    for dashboard_chart in dash.dashboard_charts or []:
        ChartService.hydrate_runtime_config(db, dashboard_chart.chart)
    # Expose the link-specific filters so the frontend can display filter badges
    dash.public_filters_config = public_filters
    dash.available_filter_fields = _build_public_filter_fields(db, dash)
    dash.public_link_name = link_name
    dash.public_link_appearance = appearance_config or {}
    return dash


@router.get("/dashboards/{token}/filters/distinct-values")
@_limiter.limit("30/minute")
def get_public_filter_distinct_values(
    token: str,
    request: Request,
    dataset_id: int = Query(..., ge=1),
    field: str = Query(..., description="Qualified field name, e.g. orders.country"),
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    dash, _, _, _ = _get_dashboard_by_token(
        token,
        db,
        session_token=x_public_session,
        track_access=False,
    )

    allowed_field = _resolve_public_filter_field(db, dash, dataset_id, field)
    if not allowed_field:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Filter field is not available for this shared dashboard.",
        )

    try:
        return {
            "field": field,
            "values": get_distinct_field_values(db, dataset_id, field, limit=limit),
        }
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        logger.error(f"Public distinct values error for token={token} dataset={dataset_id} field={field}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load distinct values.",
        )


@router.get("/dashboards/{token}/charts/{chart_id}/data")
@_limiter.limit("30/minute")
def get_public_chart_data(
    token: str,
    chart_id: int,
    request: Request,
    filters: str | None = Query(
        default=None,
        description="JSON-encoded list of additional viewer filter objects.",
    ),
    db: Session = Depends(get_db),
    x_public_session: str | None = Header(default=None),
):
    """Return chart data for a public shared link.

    Validates that chart_id belongs to the shared dashboard so a stray token
    cannot be used to access arbitrary charts.
    Password-protected links require X-Public-Session header from /auth.
    """
    dash, public_filters, _, _ = _get_dashboard_by_token(
        token,
        db,
        session_token=x_public_session,
        track_access=False,
    )

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

    viewer_filters: list[dict] = []
    if filters:
        try:
            parsed_filters = json.loads(filters)
            if not isinstance(parsed_filters, list):
                raise ValueError("filters must be a JSON array")
            viewer_filters = [item for item in parsed_filters if isinstance(item, dict)]
        except (json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid filters parameter: {exc}",
            ) from exc

    combined_filters = [
        *[item for item in (public_filters or []) if isinstance(item, dict)],
        *viewer_filters,
    ]

    try:
        return ChartService.get_chart_data(
            db,
            chart_id,
            extra_filters=combined_filters or None,
            filter_context="dashboard",
        )
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chart data not found.")
    except Exception as exc:
        logger.error(f"Public chart data error for token={token} chart={chart_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load chart data.",
        )
