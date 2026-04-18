"""
API router for dashboard endpoints.
"""
import json
import secrets
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from passlib.context import CryptContext
from sqlalchemy.orm import Session
from typing import Any, List, Optional

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

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
from app.models.models import Chart, DashboardChart, Dashboard, DashboardPublicLink
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas import (
    DashboardCreate,
    DashboardUpdate,
    DashboardShareRequest,
    DashboardResponse,
    DashboardAddChartRequest,
    DashboardUpdateLayoutRequest,
    PublicLinkCreate,
    PublicLinkUpdate,
    PublicLinkResponse,
    DashboardHtmlImportAnalyzeResponse,
    DashboardHtmlImportBuildResponse,
)
# Commented out - using hybrid approach with filters_config JSON field instead
# from app.schemas.dashboard_filter import (
#     DashboardFilterCreate,
#     DashboardFilterUpdate,
#     DashboardFilter as DashboardFilterSchema,
# )
# from app.models.dashboard_filter import DashboardFilter
from app.services import DashboardService
from app.services.dashboard_html_import_service import (
    _load_existing_source_profile,
    _load_uploaded_excel_source_profile,
    analyze_dashboard_html_import,
    build_dashboard_from_import as build_dashboard_from_html_import_service,
    parse_uploaded_source_sheets,
)
from app.core.logging import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/dashboards", tags=["dashboards"])
MAX_HTML_IMPORT_SIZE = 2 * 1024 * 1024
MAX_SOURCE_UPLOAD_SIZE = 10 * 1024 * 1024


def _require_chart_visibility(db: Session, current_user: User, chart_id: int) -> Chart:
    """Ensure the current user can attach the chart to a dashboard."""
    chart = db.query(Chart).filter(Chart.id == chart_id).first()
    if not chart:
        raise HTTPException(status_code=404, detail=f"Chart with ID {chart_id} not found")
    require_view_access(db, current_user, chart, "explore_charts")
    return chart


def _parse_optional_json_form_field(raw_value: Optional[str], field_name: str) -> Any:
    if raw_value is None or not str(raw_value).strip():
        return None
    try:
        return json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"{field_name} must be valid JSON.") from exc


def _normalize_import_source_mode(raw_value: str) -> str:
    normalized = str(raw_value or "").strip().lower()
    if normalized not in {"existing_dataset", "upload_excel"}:
        raise HTTPException(status_code=400, detail="source_mode must be existing_dataset or upload_excel.")
    return normalized


def _normalize_import_target_mode(raw_value: str) -> str:
    normalized = str(raw_value or "").strip().lower()
    if normalized not in {"new_dashboard", "append_to_dashboard"}:
        raise HTTPException(status_code=400, detail="target_mode must be new_dashboard or append_to_dashboard.")
    return normalized


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


@router.post("/import-html/analyze", response_model=DashboardHtmlImportAnalyzeResponse)
async def analyze_html_dashboard_import(
    html_content: str = Form(...),
    html_summary_json: Optional[str] = Form(None),
    source_mode: str = Form(...),
    dataset_table_id: Optional[int] = Form(None),
    selected_sheet_name: Optional[str] = Form(None),
    excel_file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Analyze imported HTML and map it into native chart plans."""
    normalized_html = str(html_content or "").strip()
    if not normalized_html:
        raise HTTPException(status_code=400, detail="html_content is required.")
    if len(normalized_html.encode("utf-8")) > MAX_HTML_IMPORT_SIZE:
        raise HTTPException(status_code=400, detail="HTML content is too large (max 2 MB).")

    parsed_summary = _parse_optional_json_form_field(html_summary_json, "html_summary_json")
    if parsed_summary is not None and not isinstance(parsed_summary, dict):
        raise HTTPException(status_code=400, detail="html_summary_json must decode to an object.")

    normalized_source_mode = _normalize_import_source_mode(source_mode)

    try:
        if normalized_source_mode == "existing_dataset":
            if dataset_table_id is None:
                raise HTTPException(status_code=400, detail="dataset_table_id is required for existing_dataset.")
            source_profile = _load_existing_source_profile(
                db,
                current_user=current_user,
                dataset_table_id=dataset_table_id,
            )
        else:
            if excel_file is None:
                raise HTTPException(status_code=400, detail="excel_file is required for upload_excel.")
            file_bytes = await excel_file.read()
            if len(file_bytes) == 0:
                raise HTTPException(status_code=400, detail="Uploaded source file is empty.")
            if len(file_bytes) > MAX_SOURCE_UPLOAD_SIZE:
                raise HTTPException(status_code=400, detail="Source file is too large (max 10 MB).")
            source_profile = _load_uploaded_excel_source_profile(
                file_bytes=file_bytes,
                filename=excel_file.filename,
                sheet_name=selected_sheet_name,
            )

        return analyze_dashboard_html_import(
            html_text=normalized_html,
            html_summary=parsed_summary,
            source_profile=source_profile,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to analyze HTML dashboard import")
        raise HTTPException(status_code=500, detail=f"Failed to analyze HTML import: {exc}") from exc


@router.post(
    "/import-html/build",
    response_model=DashboardHtmlImportBuildResponse,
    status_code=status.HTTP_201_CREATED,
)
async def build_html_dashboard_import(
    analysis_json: str = Form(...),
    source_mode: str = Form(...),
    target_mode: str = Form(...),
    dashboard_name: Optional[str] = Form(None),
    dataset_table_id: Optional[int] = Form(None),
    selected_sheet_name: Optional[str] = Form(None),
    target_dashboard_id: Optional[int] = Form(None),
    included_block_ids_json: Optional[str] = Form(None),
    excel_file: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Materialize analyzed chart plans into a native dashboard."""
    analysis = _parse_optional_json_form_field(analysis_json, "analysis_json")
    if not isinstance(analysis, dict):
        raise HTTPException(status_code=400, detail="analysis_json must decode to an object.")

    included_block_ids = _parse_optional_json_form_field(included_block_ids_json, "included_block_ids_json")
    if included_block_ids is None:
        included_block_ids = []
    if not isinstance(included_block_ids, list) or any(not isinstance(item, str) for item in included_block_ids):
        raise HTTPException(status_code=400, detail="included_block_ids_json must decode to a string array.")

    normalized_source_mode = _normalize_import_source_mode(source_mode)
    normalized_target_mode = _normalize_import_target_mode(target_mode)

    source_bytes: bytes | None = None
    source_filename: str | None = None
    if normalized_source_mode == "upload_excel":
        if excel_file is None:
            raise HTTPException(status_code=400, detail="excel_file is required for upload_excel.")
        source_bytes = await excel_file.read()
        source_filename = excel_file.filename
        if len(source_bytes) == 0:
            raise HTTPException(status_code=400, detail="Uploaded source file is empty.")
        if len(source_bytes) > MAX_SOURCE_UPLOAD_SIZE:
            raise HTTPException(status_code=400, detail="Source file is too large (max 10 MB).")

    try:
        return build_dashboard_from_html_import_service(
            db,
            current_user=current_user,
            analysis=analysis,
            source_mode=normalized_source_mode,
            dataset_table_id=dataset_table_id,
            source_bytes=source_bytes,
            source_filename=source_filename,
            selected_sheet_name=selected_sheet_name,
            dashboard_name=dashboard_name,
            target_mode=normalized_target_mode,
            target_dashboard_id=target_dashboard_id,
            included_block_ids=included_block_ids,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to build HTML dashboard import")
        raise HTTPException(status_code=500, detail=f"Failed to build dashboard import: {exc}") from exc


@router.post("/import-html/source-preview")
async def preview_html_dashboard_import_source(
    excel_file: UploadFile = File(...),
    _current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Preview uploaded CSV/XLSX sheets before analyze/build."""
    file_bytes = await excel_file.read()
    if len(file_bytes) == 0:
        raise HTTPException(status_code=400, detail="Uploaded source file is empty.")
    if len(file_bytes) > MAX_SOURCE_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail="Source file is too large (max 10 MB).")

    try:
        sheets = parse_uploaded_source_sheets(file_bytes=file_bytes, filename=excel_file.filename)
        if not sheets:
            raise ValueError("Uploaded file does not contain any previewable sheets.")
        default_sheet_name = next(iter(sheets.keys()))
        return {
            "filename": excel_file.filename,
            "default_sheet_name": default_sheet_name,
            "sheets": sheets,
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to preview HTML dashboard import source")
        raise HTTPException(status_code=500, detail=f"Failed to preview source file: {exc}") from exc


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


@router.delete("/{dashboard_id}/charts/{dashboard_chart_id}", response_model=DashboardResponse)
def remove_chart_from_dashboard(
    dashboard_id: int,
    dashboard_chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a chart instance from a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dashboard with ID {dashboard_id} not found")
    require_edit_access(db, current_user, dash, "dashboards")
    try:
        dashboard = DashboardService.remove_chart(db, dashboard_id, dashboard_chart_id)
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
    try:
        dashboard = DashboardService.update_layout(
            db,
            dashboard_id,
            request.chart_layouts
        )
        return dashboard
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


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


# ============ Multi Public Links ============

@router.get("/{dashboard_id}/public-links", response_model=List[PublicLinkResponse])
def list_public_links(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all public links for a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    require_view_access(db, current_user, dash, "dashboards")
    links = (
        db.query(DashboardPublicLink)
        .filter(DashboardPublicLink.dashboard_id == dashboard_id)
        .order_by(DashboardPublicLink.created_at.desc())
        .all()
    )
    return links


@router.post("/{dashboard_id}/public-links", response_model=PublicLinkResponse, status_code=status.HTTP_201_CREATED)
def create_public_link(
    dashboard_id: int,
    request: PublicLinkCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new named public link with its own filters."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    require_edit_access(db, current_user, dash, "dashboards")
    link = DashboardPublicLink(
        dashboard_id=dashboard_id,
        name=request.name,
        token=secrets.token_urlsafe(32),
        filters_config=request.filters_config or [],
        appearance_config=request.appearance_config or {},
        created_by=current_user.id,
        password_hash=_pwd_context.hash(request.password) if request.password else None,
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


@router.patch("/{dashboard_id}/public-links/{link_id}", response_model=PublicLinkResponse)
def update_public_link(
    dashboard_id: int,
    link_id: int,
    request: PublicLinkUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update name, filters, or active state of a public link."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    require_edit_access(db, current_user, dash, "dashboards")
    link = (
        db.query(DashboardPublicLink)
        .filter(DashboardPublicLink.id == link_id, DashboardPublicLink.dashboard_id == dashboard_id)
        .first()
    )
    if not link:
        raise HTTPException(status_code=404, detail="Public link not found")
    if request.name is not None:
        link.name = request.name
    if request.filters_config is not None:
        link.filters_config = request.filters_config
    if request.appearance_config is not None:
        link.appearance_config = request.appearance_config
    if request.is_active is not None:
        link.is_active = request.is_active
    if request.password is not None:
        link.password_hash = _pwd_context.hash(request.password) if request.password else None
    db.commit()
    db.refresh(link)
    return link


@router.delete("/{dashboard_id}/public-links/{link_id}", status_code=status.HTTP_200_OK)
def delete_public_link(
    dashboard_id: int,
    link_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a public link permanently."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    require_edit_access(db, current_user, dash, "dashboards")
    link = (
        db.query(DashboardPublicLink)
        .filter(DashboardPublicLink.id == link_id, DashboardPublicLink.dashboard_id == dashboard_id)
        .first()
    )
    if not link:
        raise HTTPException(status_code=404, detail="Public link not found")
    db.delete(link)
    db.commit()
    return {"deleted": True}


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
