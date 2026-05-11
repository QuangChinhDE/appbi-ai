"""
API router for dashboard endpoints.
"""
import json
import secrets
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from passlib.context import CryptContext
from sqlalchemy.orm import Session, joinedload
from typing import Any, Dict, List, Optional

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
from app.models.models import Chart, DashboardChart, Dashboard, DashboardPublicLink, DataSource, DataSourceType
from app.models.dataset import Dataset, DatasetTable
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas import (
    DashboardCreate,
    DashboardUpdate,
    DashboardShareRequest,
    DashboardResponse,
    DashboardAddChartRequest,
    DashboardUpdateLayoutRequest,
    DashboardUpdateWidgetRequest,
    PublicLinkCreate,
    PublicLinkUpdate,
    PublicLinkResponse,
    DashboardHtmlImportAnalyzeResponse,
    DashboardHtmlImportBatchAnalyzeResponse,
    DashboardHtmlImportBatchBuildResponse,
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
    _build_ai_fix_source_profiles,
    _load_existing_source_profile,
    _load_existing_dataset_profiles,
    _load_uploaded_excel_source_profile,
    _load_uploaded_multi_source_profiles,
    _load_uploaded_single_file_multi_sheet_profiles,
    ai_fix_chart_plan,
    analyze_dashboard_html_import,
    analyze_dashboard_html_import_batch,
    build_dashboard_from_import as build_dashboard_from_html_import_service,
    build_dashboard_from_import_batch,
    create_manual_dataset_from_excel_source,
    create_manual_dataset_from_multi_excel_source,
    parse_uploaded_source_sheets,
    validate_chart_plans,
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


def _normalize_batch_html_documents(raw_value: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_value, list) or not raw_value:
        raise HTTPException(status_code=400, detail="html_documents_json must decode to a non-empty array.")

    normalized_documents: List[Dict[str, Any]] = []
    for index, raw_document in enumerate(raw_value, start=1):
        if not isinstance(raw_document, dict):
            raise HTTPException(status_code=400, detail=f"html_documents_json[{index - 1}] must be an object.")

        document_id = str(raw_document.get("document_id") or f"document-{index}").strip()
        html_content = str(raw_document.get("html_content") or "").strip()
        if not html_content:
            raise HTTPException(status_code=400, detail=f"html_documents_json[{index - 1}].html_content is required.")
        if len(html_content.encode("utf-8")) > MAX_HTML_IMPORT_SIZE:
            raise HTTPException(status_code=400, detail=f"HTML document '{document_id}' is too large (max 2 MB).")

        html_summary = raw_document.get("html_summary")
        if html_summary is not None and not isinstance(html_summary, dict):
            raise HTTPException(status_code=400, detail=f"html_documents_json[{index - 1}].html_summary must be an object.")

        normalized_documents.append(
            {
                "document_id": document_id,
                "filename": str(raw_document.get("filename") or "").strip() or None,
                "page_name": str(raw_document.get("page_name") or "").strip() or None,
                "html_text": html_content,
                "html_summary": html_summary,
            }
        )

    return normalized_documents


def _normalize_batch_build_documents(raw_value: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_value, list) or not raw_value:
        raise HTTPException(status_code=400, detail="analyses_json must decode to a non-empty array.")

    normalized_documents: List[Dict[str, Any]] = []
    for index, raw_document in enumerate(raw_value, start=1):
        if not isinstance(raw_document, dict):
            raise HTTPException(status_code=400, detail=f"analyses_json[{index - 1}] must be an object.")

        analysis = raw_document.get("analysis")
        if not isinstance(analysis, dict):
            raise HTTPException(status_code=400, detail=f"analyses_json[{index - 1}].analysis must be an object.")

        included_block_ids = raw_document.get("included_block_ids")
        if included_block_ids is None:
            included_block_ids = []
        if not isinstance(included_block_ids, list) or any(not isinstance(item, str) for item in included_block_ids):
            raise HTTPException(status_code=400, detail=f"analyses_json[{index - 1}].included_block_ids must be a string array.")

        normalized_documents.append(
            {
                "document_id": str(raw_document.get("document_id") or f"document-{index}").strip(),
                "filename": str(raw_document.get("filename") or "").strip() or None,
                "page_name": str(raw_document.get("page_name") or "").strip() or None,
                "analysis": analysis,
                "included_block_ids": included_block_ids,
            }
        )

    return normalized_documents


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


@router.get("/accessible-summary")
def list_accessible_dashboards_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Slim list of dashboards the current user can view.

    Used by the Workboard builder to populate the dashboard picker on a
    ``kind='dashboard'`` screen. Returns just id + name + description +
    permission. The builder fetches per-dashboard filter columns separately
    via ``GET /dashboards/{id}/filter-fields`` once the user picks one — keeps
    this list endpoint cheap when an org has many dashboards.
    """
    items = (
        _owned_or_shared(db, Dashboard, ResourceType.DASHBOARD, current_user)
        .order_by(Dashboard.updated_at.desc())
        .all()
    )
    out = []
    for item in items:
        out.append(
            {
                "id": item.id,
                "name": item.name,
                "description": item.description,
                "permission": get_effective_permission(db, current_user, item, "dashboards"),
            }
        )
    return out


@router.get("/{dashboard_id}/filter-fields")
def get_dashboard_filter_fields(
    dashboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the slicer-style filter columns for a dashboard.

    Mirrors the shape produced by the public runtime so a workboard builder
    can preview the exact slots a managed link would expose. When the
    dashboard has ``public_filters_config`` set (DA configured Access filters
    in the share dialog), those slots are returned verbatim; otherwise we
    fall back to scanning chart semantic bindings — the same behaviour the
    public link uses when no Access filter has been pinned.

    Each entry has at minimum ``{datasetId: int, semanticField: 'view.col',
    label, type}`` — the workboard builder writes ``datasetId`` and
    ``semanticField`` straight into ``dashboard.role_filter_mapping`` on a
    dashboard screen so the runtime matches them against ``allowed_fields``.
    """
    dash = (
        db.query(Dashboard)
        .options(joinedload(Dashboard.dashboard_charts).joinedload(DashboardChart.chart))
        .filter(Dashboard.id == dashboard_id)
        .first()
    )
    if not dash:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    require_view_access(db, current_user, dash, "dashboards")

    from app.api.public import _build_public_filter_fields  # local import to dodge cycle

    public_filters = list(dash.public_filters_config or [])
    fields = _build_public_filter_fields(db, dash, public_filters if public_filters else None)
    return {
        "dashboard_id": dash.id,
        "fields": fields,
        "has_public_filters_config": bool(public_filters),
    }


@router.post("/import-html/analyze", response_model=DashboardHtmlImportAnalyzeResponse)
async def analyze_html_dashboard_import(
    html_content: str = Form(...),
    html_summary_json: Optional[str] = Form(None),
    source_mode: str = Form(...),
    dataset_id: Optional[int] = Form(None),
    dataset_table_id: Optional[int] = Form(None),
    selected_sheet_name: Optional[str] = Form(None),
    selected_source_key: Optional[str] = Form(None),
    excel_file: Optional[UploadFile] = File(None),
    excel_files: List[UploadFile] = File(default=[]),
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
            if dataset_id is not None:
                # Multi-table: load all tables from dataset
                primary_profile, all_profiles = _load_existing_dataset_profiles(
                    db, current_user=current_user, dataset_id=dataset_id,
                )
                if len(all_profiles) == 1:
                    return analyze_dashboard_html_import(
                        html_text=normalized_html,
                        html_summary=parsed_summary,
                        source_profile=primary_profile,
                    )
                return analyze_dashboard_html_import(
                    html_text=normalized_html,
                    html_summary=parsed_summary,
                    source_profile=primary_profile,
                    all_source_profiles=all_profiles,
                )
            elif dataset_table_id is not None:
                # Legacy single-table path
                source_profile = _load_existing_source_profile(
                    db,
                    current_user=current_user,
                    dataset_table_id=dataset_table_id,
                )
                return analyze_dashboard_html_import(
                    html_text=normalized_html,
                    html_summary=parsed_summary,
                    source_profile=source_profile,
                )
            else:
                raise HTTPException(status_code=400, detail="dataset_id or dataset_table_id is required for existing_dataset.")
        else:
            # Collect files: prefer excel_files (multi), fall back to excel_file (single)
            uploaded_files: List[UploadFile] = [f for f in excel_files if f and f.filename]
            if not uploaded_files and excel_file is not None:
                uploaded_files = [excel_file]
            if not uploaded_files:
                raise HTTPException(status_code=400, detail="excel_file(s) required for upload_excel.")

            file_pairs: List[tuple] = []
            for uf in uploaded_files:
                file_bytes = await uf.read()
                if len(file_bytes) == 0:
                    raise HTTPException(status_code=400, detail=f"Uploaded file '{uf.filename}' is empty.")
                if len(file_bytes) > MAX_SOURCE_UPLOAD_SIZE:
                    raise HTTPException(status_code=400, detail=f"File '{uf.filename}' is too large (max 10 MB).")
                file_pairs.append((file_bytes, uf.filename))

            if len(file_pairs) == 1:
                # If the workbook contains multiple sheets, expose them all as
                # source profiles keyed by bare sheet name so v1 metadata
                # source_key references (e.g. "customers") resolve correctly.
                multi_profiles, multi_primary = _load_uploaded_single_file_multi_sheet_profiles(
                    file_bytes=file_pairs[0][0],
                    filename=file_pairs[0][1],
                    primary_source_key=selected_source_key or selected_sheet_name or None,
                )
                if len(multi_profiles) > 1:
                    primary_profile = multi_profiles.get(multi_primary, next(iter(multi_profiles.values())))
                    return analyze_dashboard_html_import(
                        html_text=normalized_html,
                        html_summary=parsed_summary,
                        source_profile=primary_profile,
                        all_source_profiles=multi_profiles,
                    )
                source_profile = _load_uploaded_excel_source_profile(
                    file_bytes=file_pairs[0][0],
                    filename=file_pairs[0][1],
                    sheet_name=selected_sheet_name,
                )
                return analyze_dashboard_html_import(
                    html_text=normalized_html,
                    html_summary=parsed_summary,
                    source_profile=source_profile,
                )
            else:
                all_profiles, primary_key = _load_uploaded_multi_source_profiles(
                    files=file_pairs,
                    primary_source_key=selected_source_key or None,
                )
                primary_profile = all_profiles.get(primary_key, next(iter(all_profiles.values())))
                return analyze_dashboard_html_import(
                    html_text=normalized_html,
                    html_summary=parsed_summary,
                    source_profile=primary_profile,
                    all_source_profiles=all_profiles,
                )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to analyze HTML dashboard import")
        raise HTTPException(status_code=500, detail=f"Failed to analyze HTML import: {exc}") from exc


@router.post("/import-html/analyze-batch", response_model=DashboardHtmlImportBatchAnalyzeResponse)
async def analyze_html_dashboard_import_batch_route(
    html_documents_json: str = Form(...),
    source_mode: str = Form(...),
    dataset_id: Optional[int] = Form(None),
    dataset_table_id: Optional[int] = Form(None),
    selected_sheet_name: Optional[str] = Form(None),
    selected_source_key: Optional[str] = Form(None),
    excel_file: Optional[UploadFile] = File(None),
    excel_files: List[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Analyze multiple imported HTML documents and map each to a dashboard page."""
    parsed_documents = _parse_optional_json_form_field(html_documents_json, "html_documents_json")
    normalized_documents = _normalize_batch_html_documents(parsed_documents)
    normalized_source_mode = _normalize_import_source_mode(source_mode)

    try:
        if normalized_source_mode == "existing_dataset":
            if dataset_id is not None:
                primary_profile, all_profiles = _load_existing_dataset_profiles(
                    db, current_user=current_user, dataset_id=dataset_id,
                )
                if len(all_profiles) == 1:
                    return analyze_dashboard_html_import_batch(
                        documents=normalized_documents,
                        source_profile=primary_profile,
                    )
                return analyze_dashboard_html_import_batch(
                    documents=normalized_documents,
                    source_profile=primary_profile,
                    all_source_profiles=all_profiles,
                )
            if dataset_table_id is not None:
                source_profile = _load_existing_source_profile(
                    db,
                    current_user=current_user,
                    dataset_table_id=dataset_table_id,
                )
                return analyze_dashboard_html_import_batch(
                    documents=normalized_documents,
                    source_profile=source_profile,
                )
            raise HTTPException(status_code=400, detail="dataset_id or dataset_table_id is required for existing_dataset.")

        uploaded_files: List[UploadFile] = [f for f in excel_files if f and f.filename]
        if not uploaded_files and excel_file is not None:
            uploaded_files = [excel_file]
        if not uploaded_files:
            raise HTTPException(status_code=400, detail="excel_file(s) required for upload_excel.")

        file_pairs: List[tuple] = []
        for uf in uploaded_files:
            file_bytes = await uf.read()
            if len(file_bytes) == 0:
                raise HTTPException(status_code=400, detail=f"Uploaded file '{uf.filename}' is empty.")
            if len(file_bytes) > MAX_SOURCE_UPLOAD_SIZE:
                raise HTTPException(status_code=400, detail=f"File '{uf.filename}' is too large (max 10 MB).")
            file_pairs.append((file_bytes, uf.filename))

        if len(file_pairs) == 1:
            multi_profiles, multi_primary = _load_uploaded_single_file_multi_sheet_profiles(
                file_bytes=file_pairs[0][0],
                filename=file_pairs[0][1],
                primary_source_key=selected_source_key or selected_sheet_name or None,
            )
            if len(multi_profiles) > 1:
                primary_profile = multi_profiles.get(multi_primary, next(iter(multi_profiles.values())))
                return analyze_dashboard_html_import_batch(
                    documents=normalized_documents,
                    source_profile=primary_profile,
                    all_source_profiles=multi_profiles,
                )
            source_profile = _load_uploaded_excel_source_profile(
                file_bytes=file_pairs[0][0],
                filename=file_pairs[0][1],
                sheet_name=selected_sheet_name,
            )
            return analyze_dashboard_html_import_batch(
                documents=normalized_documents,
                source_profile=source_profile,
            )

        all_profiles, primary_key = _load_uploaded_multi_source_profiles(
            files=file_pairs,
            primary_source_key=selected_source_key or None,
        )
        primary_profile = all_profiles.get(primary_key, next(iter(all_profiles.values())))
        return analyze_dashboard_html_import_batch(
            documents=normalized_documents,
            source_profile=primary_profile,
            all_source_profiles=all_profiles,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to analyze batch HTML dashboard import")
        raise HTTPException(status_code=500, detail=f"Failed to analyze HTML batch import: {exc}") from exc


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
    dataset_id: Optional[int] = Form(None),
    dataset_table_id: Optional[int] = Form(None),
    prepared_dataset_id: Optional[int] = Form(None),
    selected_sheet_name: Optional[str] = Form(None),
    target_dashboard_id: Optional[int] = Form(None),
    included_block_ids_json: Optional[str] = Form(None),
    excel_file: Optional[UploadFile] = File(None),
    excel_files: List[UploadFile] = File(default=[]),
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

    # Wizard-prepared dataset mode: user may have transformed tables inside
    # the dataset editor before returning to build. We treat the prepared
    # dataset as an existing_dataset source and skip file processing.
    effective_source_mode = normalized_source_mode
    effective_dataset_id = dataset_id
    if prepared_dataset_id is not None:
        effective_source_mode = "existing_dataset"
        effective_dataset_id = prepared_dataset_id

    source_bytes: bytes | None = None
    source_filename: str | None = None
    source_file_pairs: List[tuple] | None = None

    if effective_source_mode == "upload_excel":
        uploaded_files: List[UploadFile] = [f for f in excel_files if f and f.filename]
        if not uploaded_files and excel_file is not None:
            uploaded_files = [excel_file]
        if not uploaded_files:
            raise HTTPException(status_code=400, detail="excel_file(s) required for upload_excel.")

        if len(uploaded_files) == 1:
            source_bytes = await uploaded_files[0].read()
            source_filename = uploaded_files[0].filename
            if len(source_bytes) == 0:
                raise HTTPException(status_code=400, detail="Uploaded source file is empty.")
            if len(source_bytes) > MAX_SOURCE_UPLOAD_SIZE:
                raise HTTPException(status_code=400, detail="Source file is too large (max 10 MB).")
        else:
            source_file_pairs = []
            for uf in uploaded_files:
                file_bytes = await uf.read()
                if len(file_bytes) == 0:
                    raise HTTPException(status_code=400, detail=f"Uploaded file '{uf.filename}' is empty.")
                if len(file_bytes) > MAX_SOURCE_UPLOAD_SIZE:
                    raise HTTPException(status_code=400, detail=f"File '{uf.filename}' is too large (max 10 MB).")
                source_file_pairs.append((file_bytes, uf.filename))

    try:
        result = build_dashboard_from_html_import_service(
            db,
            current_user=current_user,
            analysis=analysis,
            source_mode=effective_source_mode,
            dataset_table_id=dataset_table_id,
            dataset_id=effective_dataset_id,
            source_bytes=source_bytes,
            source_filename=source_filename,
            source_files=source_file_pairs,
            selected_sheet_name=selected_sheet_name,
            dashboard_name=dashboard_name,
            target_mode=normalized_target_mode,
            target_dashboard_id=target_dashboard_id,
            included_block_ids=included_block_ids,
        )
        if prepared_dataset_id is not None:
            # Promote the draft dataset into a regular dataset once charts
            # have been successfully created against it.
            draft_row = db.query(Dataset).filter(Dataset.id == prepared_dataset_id).first()
            if draft_row is not None and bool(getattr(draft_row, "is_draft", False)):
                draft_row.is_draft = False
                db.commit()
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to build HTML dashboard import")
        raise HTTPException(status_code=500, detail=f"Failed to build dashboard import: {exc}") from exc


@router.post("/import-html/dry-run-build")
async def dry_run_build_html_dashboard_import(
    analysis_json: str = Form(...),
    source_mode: str = Form(...),
    target_mode: str = Form("new_dashboard"),
    dashboard_name: Optional[str] = Form(None),
    dataset_id: Optional[int] = Form(None),
    dataset_table_id: Optional[int] = Form(None),
    prepared_dataset_id: Optional[int] = Form(None),
    selected_sheet_name: Optional[str] = Form(None),
    target_dashboard_id: Optional[int] = Form(None),
    included_block_ids_json: Optional[str] = Form(None),
    excel_file: Optional[UploadFile] = File(None),
    excel_files: List[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Run the full /import-html/build pipeline inside a savepoint that is
    rolled back at the end. Returns the would-be result without persisting.

    This lets the caller validate the entire materialization end-to-end
    (calculated-field SQL, semantic model uniqueness, type coercion) before
    committing for real. The response shape mirrors /import-html/build but
    adds ``dry_run: true`` and ``rolled_back: true`` markers.
    """
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

    effective_source_mode = normalized_source_mode
    effective_dataset_id = dataset_id
    if prepared_dataset_id is not None:
        effective_source_mode = "existing_dataset"
        effective_dataset_id = prepared_dataset_id

    source_bytes: bytes | None = None
    source_filename: str | None = None
    source_file_pairs: List[tuple] | None = None
    if effective_source_mode == "upload_excel":
        uploaded_files: List[UploadFile] = [f for f in excel_files if f and f.filename]
        if not uploaded_files and excel_file is not None:
            uploaded_files = [excel_file]
        if not uploaded_files:
            raise HTTPException(status_code=400, detail="excel_file(s) required for upload_excel.")
        if len(uploaded_files) == 1:
            source_bytes = await uploaded_files[0].read()
            source_filename = uploaded_files[0].filename
        else:
            source_file_pairs = []
            for uf in uploaded_files:
                file_bytes = await uf.read()
                source_file_pairs.append((file_bytes, uf.filename))

    # Use a SAVEPOINT (begin_nested) so any commits inside the service become
    # subordinate to this outer scope. After the service returns, we rollback
    # to the savepoint, undoing every INSERT/UPDATE/DELETE the build produced.
    #
    # Caveats (documented in the response):
    #   - Background embedding tasks scheduled during build are NOT rolled
    #     back. They will run with rows that no longer exist, but the workers
    #     handle missing rows gracefully.
    #   - Filesystem writes (preview HTML cache) and Redis cache writes are
    #     out-of-scope of the savepoint and may persist (harmless).
    try:
        savepoint = db.begin_nested()
        try:
            result = build_dashboard_from_html_import_service(
                db,
                current_user=current_user,
                analysis=analysis,
                source_mode=effective_source_mode,
                dataset_table_id=dataset_table_id,
                dataset_id=effective_dataset_id,
                source_bytes=source_bytes,
                source_filename=source_filename,
                source_files=source_file_pairs,
                selected_sheet_name=selected_sheet_name,
                dashboard_name=dashboard_name,
                target_mode=normalized_target_mode,
                target_dashboard_id=target_dashboard_id,
                included_block_ids=included_block_ids,
            )
            # Hydrate response payload BEFORE rollback so the client can see
            # exactly what would have been created (ids will be invalid after
            # rollback, but the structural diff is meaningful).
            payload = {
                "dry_run": True,
                "rolled_back": True,
                "would_create": {
                    "dashboard_id": result.get("dashboard_id"),
                    "created_chart_count": result.get("created_chart_count"),
                    "created_widget_count": result.get("created_widget_count"),
                    "layout_mode": result.get("layout_mode"),
                    "page_id": result.get("page_id"),
                    "page_name": result.get("page_name"),
                    "dataset_id": result.get("dataset_id"),
                    "dataset_table_id": result.get("dataset_table_id"),
                    "dataset_table_ids": result.get("dataset_table_ids"),
                    "type_changes": result.get("type_changes"),
                },
                "warnings": [
                    "Background embedding/LLM tasks scheduled during build were "
                    "NOT rolled back; they will run against rows that no longer exist.",
                ],
            }
        finally:
            # Always roll back, even on success.
            try:
                savepoint.rollback()
            except Exception:
                pass
        # Also rollback the outer transaction so any state outside the savepoint
        # (e.g. cascading commits inside the service) is fully reverted.
        try:
            db.rollback()
        except Exception:
            pass
        return payload
    except HTTPException:
        raise
    except ValueError as exc:
        try:
            db.rollback()
        except Exception:
            pass
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        logger.exception("Dry-run build failed")
        raise HTTPException(
            status_code=500,
            detail=f"Dry-run build failed (this means a real build would also fail): {exc}",
        ) from exc


@router.post(
    "/import-html/build-batch",
    response_model=DashboardHtmlImportBatchBuildResponse,
    status_code=status.HTTP_201_CREATED,
)
async def build_html_dashboard_import_batch_route(
    analyses_json: str = Form(...),
    source_mode: str = Form(...),
    target_mode: str = Form(...),
    dashboard_name: Optional[str] = Form(None),
    dataset_id: Optional[int] = Form(None),
    dataset_table_id: Optional[int] = Form(None),
    prepared_dataset_id: Optional[int] = Form(None),
    selected_sheet_name: Optional[str] = Form(None),
    target_dashboard_id: Optional[int] = Form(None),
    excel_file: Optional[UploadFile] = File(None),
    excel_files: List[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Materialize multiple analyzed HTML documents into multiple dashboard pages."""
    parsed_documents = _parse_optional_json_form_field(analyses_json, "analyses_json")
    normalized_documents = _normalize_batch_build_documents(parsed_documents)
    normalized_source_mode = _normalize_import_source_mode(source_mode)
    normalized_target_mode = _normalize_import_target_mode(target_mode)

    effective_source_mode = normalized_source_mode
    effective_dataset_id = dataset_id
    if prepared_dataset_id is not None:
        effective_source_mode = "existing_dataset"
        effective_dataset_id = prepared_dataset_id

    source_bytes: bytes | None = None
    source_filename: str | None = None
    source_file_pairs: List[tuple] | None = None

    if effective_source_mode == "upload_excel":
        uploaded_files: List[UploadFile] = [f for f in excel_files if f and f.filename]
        if not uploaded_files and excel_file is not None:
            uploaded_files = [excel_file]
        if not uploaded_files:
            raise HTTPException(status_code=400, detail="excel_file(s) required for upload_excel.")

        if len(uploaded_files) == 1:
            source_bytes = await uploaded_files[0].read()
            source_filename = uploaded_files[0].filename
            if len(source_bytes) == 0:
                raise HTTPException(status_code=400, detail="Uploaded source file is empty.")
            if len(source_bytes) > MAX_SOURCE_UPLOAD_SIZE:
                raise HTTPException(status_code=400, detail="Source file is too large (max 10 MB).")
        else:
            source_file_pairs = []
            for uf in uploaded_files:
                file_bytes = await uf.read()
                if len(file_bytes) == 0:
                    raise HTTPException(status_code=400, detail=f"Uploaded file '{uf.filename}' is empty.")
                if len(file_bytes) > MAX_SOURCE_UPLOAD_SIZE:
                    raise HTTPException(status_code=400, detail=f"File '{uf.filename}' is too large (max 10 MB).")
                source_file_pairs.append((file_bytes, uf.filename))

    try:
        result = build_dashboard_from_import_batch(
            db,
            current_user=current_user,
            documents=normalized_documents,
            source_mode=effective_source_mode,
            dataset_table_id=dataset_table_id,
            dataset_id=effective_dataset_id,
            source_bytes=source_bytes,
            source_filename=source_filename,
            source_files=source_file_pairs,
            selected_sheet_name=selected_sheet_name,
            dashboard_name=dashboard_name,
            target_mode=normalized_target_mode,
            target_dashboard_id=target_dashboard_id,
        )
        if prepared_dataset_id is not None:
            draft_row = db.query(Dataset).filter(Dataset.id == prepared_dataset_id).first()
            if draft_row is not None and bool(getattr(draft_row, "is_draft", False)):
                draft_row.is_draft = False
                db.commit()
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to build batch HTML dashboard import")
        raise HTTPException(status_code=500, detail=f"Failed to build dashboard batch import: {exc}") from exc


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


@router.post("/import-html/prepare-draft")
async def prepare_html_import_draft(
    source_mode: str = Form(...),
    dashboard_name: Optional[str] = Form(None),
    dataset_id: Optional[int] = Form(None),
    excel_file: Optional[UploadFile] = File(None),
    excel_files: List[UploadFile] = File(default=[]),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Prepare a dataset that the user can transform before materialising charts.

    - ``existing_dataset``: no DB writes; returns the selected dataset's
      ``display_name -> table_id`` map so the wizard can deep-link into the
      dataset editor.
    - ``upload_excel``: creates a draft Dataset + DatasetTable(s) + manual
      DataSource flagged ``is_draft=True``. If the wizard is cancelled the
      draft is deleted via ``DELETE /import-html/drafts/{id}``. On ``build``
      the draft flag is cleared instead of creating a new dataset.

    Response shape::

        {
          "dataset_id": int,
          "is_draft": bool,
          "table_id_map": {"<source_key>": int, ...}
        }
    """
    normalized_mode = _normalize_import_source_mode(source_mode)

    if normalized_mode == "existing_dataset":
        if dataset_id is None:
            raise HTTPException(status_code=400, detail="dataset_id is required for existing_dataset.")
        dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset_obj:
            raise HTTPException(status_code=404, detail="Dataset not found.")
        require_edit_access(db, current_user, dataset_obj, "datasets")
        db_tables = (
            db.query(DatasetTable)
            .filter(
                DatasetTable.dataset_id == dataset_id,
                DatasetTable.source_kind != "generated_calendar",
            )
            .order_by(DatasetTable.id)
            .all()
        )
        return {
            "dataset_id": dataset_id,
            "is_draft": False,
            "table_id_map": {t.display_name: t.id for t in db_tables},
        }

    # upload_excel → create draft dataset
    dataset_permission = (current_user.permissions or {}).get("datasets", "none")
    if dataset_permission not in {"edit", "full"}:
        raise HTTPException(status_code=403, detail="Creating a draft dataset requires datasets edit permission.")

    uploaded_files: List[UploadFile] = [f for f in excel_files if f and f.filename]
    if not uploaded_files and excel_file is not None:
        uploaded_files = [excel_file]
    if not uploaded_files:
        raise HTTPException(status_code=400, detail="excel_file(s) required for upload_excel.")

    file_pairs: List[tuple] = []
    for uf in uploaded_files:
        file_bytes = await uf.read()
        if len(file_bytes) == 0:
            raise HTTPException(status_code=400, detail=f"Uploaded file '{uf.filename}' is empty.")
        if len(file_bytes) > MAX_SOURCE_UPLOAD_SIZE:
            raise HTTPException(status_code=400, detail=f"File '{uf.filename}' is too large (max 10 MB).")
        file_pairs.append((file_bytes, uf.filename))

    draft_name = (dashboard_name or "Imported Dashboard").strip() or "Imported Dashboard"

    try:
        if len(file_pairs) == 1:
            file_bytes, filename = file_pairs[0]
            dataset_id_new, _primary_table_id = create_manual_dataset_from_excel_source(
                db,
                current_user=current_user,
                file_bytes=file_bytes,
                filename=filename,
                requested_name=draft_name,
            )
            tables = (
                db.query(DatasetTable)
                .filter(DatasetTable.dataset_id == dataset_id_new)
                .order_by(DatasetTable.id)
                .all()
            )
            table_id_map: dict = {}
            for t in tables:
                if t.source_table_name:
                    table_id_map[t.source_table_name] = t.id
                table_id_map.setdefault(t.display_name, t.id)
        else:
            dataset_id_new, table_id_map = create_manual_dataset_from_multi_excel_source(
                db,
                current_user=current_user,
                files=file_pairs,
                requested_name=draft_name,
            )

        dataset_row = db.query(Dataset).filter(Dataset.id == dataset_id_new).first()
        if dataset_row is None:
            raise HTTPException(status_code=500, detail="Draft dataset could not be retrieved after creation.")
        dataset_row.is_draft = True
        db.commit()
    except HTTPException:
        raise
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        db.rollback()
        logger.exception("Failed to prepare draft dataset for HTML import")
        raise HTTPException(status_code=500, detail=f"Failed to prepare draft: {exc}") from exc

    return {
        "dataset_id": dataset_id_new,
        "is_draft": True,
        "table_id_map": table_id_map,
    }


@router.delete("/import-html/drafts/{dataset_id}", status_code=204)
def cancel_html_import_draft(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Delete a draft dataset created by the HTML import wizard.

    Idempotent: returns 204 even if the dataset no longer exists. Refuses to
    delete if the dataset is NOT flagged as a draft (safety: protects real
    datasets from accidental wipe via a leaked dataset_id).
    """
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        return Response(status_code=204)
    if not bool(getattr(dataset_obj, "is_draft", False)):
        raise HTTPException(status_code=400, detail="Dataset is not a draft and will not be deleted.")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    table_ids = [t.id for t in dataset_obj.tables]
    datasource_ids = {t.datasource_id for t in dataset_obj.tables if t.datasource_id}

    try:
        if table_ids:
            # Drafts should have no charts but clean up defensively so the
            # dataset can be deleted without FK violations.
            db.query(Chart).filter(Chart.dataset_table_id.in_(table_ids)).delete(
                synchronize_session=False
            )
        db.delete(dataset_obj)
        db.flush()

        # Only delete manual datasources that were exclusively created for this
        # draft (name prefixed by our helper) and are no longer referenced.
        for ds_id in datasource_ids:
            ds_row = db.query(DataSource).filter(DataSource.id == ds_id).first()
            if not ds_row:
                continue
            if ds_row.type != DataSourceType.MANUAL:
                continue
            if not str(ds_row.name or "").startswith("[Dashboard Import]"):
                continue
            still_in_use = (
                db.query(DatasetTable)
                .filter(DatasetTable.datasource_id == ds_id)
                .first()
            )
            if still_in_use is None:
                db.delete(ds_row)
        db.commit()
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("Failed to cancel draft dataset %s", dataset_id)
        raise HTTPException(status_code=500, detail=f"Failed to cancel draft: {exc}") from exc

    return Response(status_code=204)


@router.post("/import-html/validate-plans")
async def validate_html_import_plans(
    analysis_json: str = Form(...),
    dataset_id: int = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Dry-run each chart plan's query and return per-block pass/fail results."""
    analysis = _parse_optional_json_form_field(analysis_json, "analysis_json")
    if not isinstance(analysis, dict):
        raise HTTPException(status_code=400, detail="analysis_json must decode to an object.")

    chart_plans = analysis.get("chart_plans") or []
    calculated_fields = analysis.get("calculated_fields") or []
    derived_tables = analysis.get("derived_tables") or []
    if not chart_plans:
        return {"results": []}

    try:
        results = validate_chart_plans(
            db,
            current_user=current_user,
            dataset_id=dataset_id,
            chart_plans=chart_plans,
            calculated_fields=calculated_fields,
            derived_tables=derived_tables,
        )
        return {"results": results}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to validate chart plans")
        raise HTTPException(status_code=500, detail=f"Validation failed: {exc}") from exc


@router.post("/import-html/preview-calculated")
async def preview_html_import_calculated_fields(
    sample_rows_json: str = Form(...),
    columns_json: str = Form(...),
    calculated_fields_json: str = Form(...),
    row_limit: int = Form(200),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Compute AI/manual calculated fields against sample rows via DuckDB.

    Used by the HTML import wizard so users can preview rows enriched with
    calculated fields BEFORE the dashboard/dataset is materialised. Only the
    first *row_limit* rows are returned.

    Request fields (multipart form):
    - ``sample_rows_json``: JSON array of row objects.
    - ``columns_json``: JSON array of ``{name, type}`` column metadata.
    - ``calculated_fields_json``: JSON array of
      ``{name, expression, label?, source_key?}``.

    Response shape::

        {
          "columns": [{"name": "...", "type": "..."}, ...],
          "rows": [...],
          "errors": [{"name": "...", "error": "..."}, ...]
        }
    """
    from app.services.transformation_compiler import TransformationCompiler

    rows = _parse_optional_json_form_field(sample_rows_json, "sample_rows_json")
    if not isinstance(rows, list):
        raise HTTPException(status_code=400, detail="sample_rows_json must decode to an array.")
    columns = _parse_optional_json_form_field(columns_json, "columns_json")
    if not isinstance(columns, list):
        raise HTTPException(status_code=400, detail="columns_json must decode to an array.")
    calc_fields = _parse_optional_json_form_field(calculated_fields_json, "calculated_fields_json")
    if not isinstance(calc_fields, list):
        raise HTTPException(status_code=400, detail="calculated_fields_json must decode to an array.")

    # Clamp row_limit to a sane range to protect DuckDB memory.
    limit = max(1, min(int(row_limit or 200), 1000))
    rows = rows[:limit]

    col_names: List[str] = []
    for col in columns:
        if not isinstance(col, dict):
            continue
        name = str(col.get("name") or "").strip()
        if name and name not in col_names:
            col_names.append(name)

    # Validate each calc field and keep only the safe ones.
    valid_fields: List[dict] = []
    field_errors: List[dict] = []
    seen: set = set()
    for field in calc_fields:
        if not isinstance(field, dict):
            continue
        name = str(field.get("name") or "").strip()
        expression = str(field.get("expression") or "").strip()
        if not name or name in seen:
            field_errors.append({"name": name, "error": "Duplicate or empty name."})
            continue
        if not expression:
            field_errors.append({"name": name, "error": "Expression is required."})
            continue
        ok, err = TransformationCompiler.validate_expression(expression)
        if not ok:
            field_errors.append({"name": name, "error": err or "Invalid expression."})
            continue
        seen.add(name)
        valid_fields.append({
            "name": name,
            "expression": expression,
            "label": str(field.get("label") or name),
        })

    # If there are no safe calc fields, just return the sample rows as-is so
    # the UI still has something to render.
    try:
        import duckdb  # local import so the rest of the module works without duckdb
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"DuckDB is unavailable: {exc}") from exc

    try:
        conn = duckdb.connect(database=":memory:")
        try:
            # Map the frontend-declared column types into DuckDB types so
            # arithmetic expressions like ``a + b`` evaluate correctly.
            def _duckdb_type(declared: str) -> str:
                normalized = (declared or "string").strip().lower()
                if normalized in {"number", "numeric", "integer", "int", "float", "double", "decimal"}:
                    return "DOUBLE"
                if normalized in {"bool", "boolean"}:
                    return "BOOLEAN"
                if normalized in {"date"}:
                    return "DATE"
                if normalized in {"datetime", "timestamp"}:
                    return "TIMESTAMP"
                return "VARCHAR"

            declared_types: Dict[str, str] = {}
            for col in columns:
                if not isinstance(col, dict) or not col.get("name"):
                    continue
                declared_types[str(col["name"])] = _duckdb_type(str(col.get("type") or "string"))

            # If the caller forgot to declare columns but provided rows, fall
            # back to column names from the first row and treat everything as
            # VARCHAR so the expressions compile at minimum.
            if not col_names and rows and isinstance(rows[0], dict):
                col_names = list(rows[0].keys())
                for name in col_names:
                    declared_types.setdefault(name, "VARCHAR")

            # Always declare at least one placeholder column so the CREATE
            # TABLE is valid even when the caller sent an empty schema.
            if not col_names:
                col_names = ["_placeholder"]
                declared_types["_placeholder"] = "VARCHAR"

            column_defs = ", ".join(
                f'"{name}" {declared_types.get(name, "VARCHAR")}' for name in col_names
            )
            conn.execute(f"CREATE TEMP TABLE _preview_src ({column_defs})")

            # Coerce row values to match their declared type so INSERT doesn't
            # blow up on mixed JSON input (e.g. numbers arriving as strings).
            def _coerce(value: Any, type_name: str) -> Any:
                if value is None or value == "":
                    return None
                try:
                    if type_name == "DOUBLE":
                        return float(value)
                    if type_name == "BOOLEAN":
                        if isinstance(value, bool):
                            return value
                        return str(value).strip().lower() in {"1", "true", "yes", "y"}
                except (TypeError, ValueError):
                    return None
                return value

            if rows:
                placeholders = ",".join(["?"] * len(col_names))
                insert_sql = f"INSERT INTO _preview_src VALUES ({placeholders})"
                batched = [
                    tuple(
                        _coerce(row.get(name) if isinstance(row, dict) else None,
                                declared_types.get(name, "VARCHAR"))
                        for name in col_names
                    )
                    for row in rows
                ]
                conn.executemany(insert_sql, batched)

            transformations = [
                {
                    "type": "add_column",
                    "enabled": True,
                    "params": {"newField": f["name"], "expression": f["expression"]},
                }
                for f in valid_fields
            ]
            compiled_sql, _result_columns = TransformationCompiler.compile_transformations(
                base_query="SELECT * FROM _preview_src",
                transformations=transformations,
                dialect="duckdb",
                available_columns=list(col_names),
            )

            cursor = conn.execute(f"SELECT * FROM ({compiled_sql}) AS _final LIMIT {limit}")
            desc = cursor.description or []
            out_columns = [str(col[0]) for col in desc]
            data_rows = cursor.fetchall()
        finally:
            conn.close()
    except Exception as exc:
        logger.exception("Preview calculated fields failed")
        raise HTTPException(status_code=400, detail=f"Could not evaluate expressions: {exc}") from exc

    # Re-assemble row dicts and infer simple column metadata from sample values.
    enriched_rows: List[dict] = []
    for row in data_rows:
        enriched_rows.append({out_columns[i]: row[i] for i in range(len(out_columns))})

    def _infer_type(values: List[Any]) -> str:
        for value in values:
            if value is None:
                continue
            if isinstance(value, bool):
                return "boolean"
            if isinstance(value, (int, float)):
                return "numeric"
            return "string"
        return "string"

    original_types: dict = {}
    for col in columns:
        if isinstance(col, dict) and col.get("name"):
            original_types[str(col["name"])] = str(col.get("type") or "string")

    response_columns: List[dict] = []
    for name in out_columns:
        if name in original_types:
            response_columns.append({"name": name, "type": original_types[name]})
            continue
        sample_values = [row.get(name) for row in enriched_rows]
        response_columns.append({"name": name, "type": _infer_type(sample_values)})

    return {
        "columns": response_columns,
        "rows": enriched_rows,
        "errors": field_errors,
    }



@router.post("/import-html/fix-chart-plan")
async def fix_html_import_chart_plan(
    chart_plan_json: str = Form(...),
    error_message: str = Form(...),
    source_profile_json: str = Form(...),
    all_source_profiles_json: Optional[str] = Form(None),
    derived_tables_json: Optional[str] = Form(None),
    dataset_id: Optional[int] = Form(None),
    calculated_fields_json: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("dashboards", "edit")),
):
    """Use AI to fix a chart plan that failed validation.

    When *dataset_id* is supplied, the fix is validated against the live data
    source.  If validation fails, the AI is retried with the new error message
    (up to 2 additional attempts).
    """
    chart_plan = _parse_optional_json_form_field(chart_plan_json, "chart_plan_json")
    if not isinstance(chart_plan, dict):
        raise HTTPException(status_code=400, detail="chart_plan_json must decode to an object.")

    source_profile = _parse_optional_json_form_field(source_profile_json, "source_profile_json")
    if not isinstance(source_profile, dict):
        raise HTTPException(status_code=400, detail="source_profile_json must decode to an object.")

    all_source_profiles = _parse_optional_json_form_field(all_source_profiles_json, "all_source_profiles_json")
    calc_fields = _parse_optional_json_form_field(calculated_fields_json, "calculated_fields_json")
    if not isinstance(calc_fields, list):
        calc_fields = []
    derived_tables = _parse_optional_json_form_field(derived_tables_json, "derived_tables_json")
    if not isinstance(derived_tables, list):
        derived_tables = []

    MAX_RETRIES = 3
    last_error = str(error_message or "")
    current_plan = dict(chart_plan)
    effective_source_profiles = _build_ai_fix_source_profiles(
        source_profile=source_profile,
        all_source_profiles=all_source_profiles if isinstance(all_source_profiles, dict) else None,
        derived_tables=derived_tables,
    )

    try:
        for attempt in range(MAX_RETRIES):
            fixed = ai_fix_chart_plan(
                chart_plan=current_plan,
                error_message=last_error,
                source_profile=source_profile,
                all_source_profiles=effective_source_profiles,
            )
            if fixed is None:
                raise HTTPException(status_code=422, detail="AI could not produce a fix for this chart plan.")

            # If dataset_id is provided, validate the fix against real data
            if dataset_id:
                val_results = validate_chart_plans(
                    db,
                    current_user=current_user,
                    dataset_id=dataset_id,
                    chart_plans=[fixed],
                    calculated_fields=calc_fields,
                    derived_tables=derived_tables,
                )
                if val_results and val_results[0].get("status") == "error":
                    new_error = val_results[0].get("error", "")
                    logger.warning(
                        "AI fix attempt %d for block_id=%s failed validation: %s",
                        attempt + 1, fixed.get("block_id"), new_error,
                    )
                    last_error = f"Previous fix attempt still fails: {new_error}"
                    current_plan = fixed  # feed the AI's output back so it can iterate
                    continue
                # Validation passed
                fixed["fix_validated"] = True

            return {"fixed_plan": fixed}

        # All retries exhausted — return last fix with warning
        if fixed:
            fixed["fix_note"] = (fixed.get("fix_note") or "") + " (Warning: fix could not be validated)"
            return {"fixed_plan": fixed}

        raise HTTPException(status_code=422, detail="AI could not produce a valid fix after multiple attempts.")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to fix chart plan via AI")
        raise HTTPException(status_code=500, detail=f"AI fix failed: {exc}") from exc


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


@router.post("/{dashboard_id}/widgets", response_model=DashboardResponse)
def add_widget_to_dashboard(
    dashboard_id: int,
    request: DashboardAddChartRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a non-chart widget (text/countdown/image/shape/parameter_switcher) to a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dashboard with ID {dashboard_id} not found")
    require_edit_access(db, current_user, dash, "dashboards")
    widget_type = request.widget_type or "text"
    if widget_type == "chart":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Use /charts endpoint for chart widgets")
    try:
        dashboard = DashboardService.add_widget(
            db,
            dashboard_id,
            widget_type,
            request.layout,
            request.widget_config,
        )
        return dashboard
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.patch("/{dashboard_id}/widgets/{dashboard_chart_id}", response_model=DashboardResponse)
def update_widget_config(
    dashboard_id: int,
    dashboard_chart_id: int,
    request: DashboardUpdateWidgetRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update widget_config for a non-chart widget on a dashboard."""
    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dashboard with ID {dashboard_id} not found")
    require_edit_access(db, current_user, dash, "dashboards")

    item = db.query(DashboardChart).filter(
        DashboardChart.id == dashboard_chart_id,
        DashboardChart.dashboard_id == dashboard_id,
    ).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Widget not found")
    if not item.widget_type or item.widget_type == "chart":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Target is not a widget")

    item.widget_config = request.widget_config or {}
    db.commit()
    return DashboardService.get_by_id(db, dashboard_id)


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


def _sanitize_link_for_admin(link: DashboardPublicLink) -> DashboardPublicLink:
    """Strip ai_bot_key from a public link before returning to admin clients.

    The actual key stays in the DB; the response gets ai_bot_key_configured=True/False
    instead. This prevents the key from appearing in browser Network/Console logs.
    """
    if link.appearance_config:
        raw = dict(link.appearance_config)
        key_present = bool(raw.pop("ai_bot_key", None))
        raw["ai_bot_key_configured"] = key_present
        link.appearance_config = raw
    return link


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
    # Hide workboard-managed links — they belong to a workboard screen's
    # lifecycle and are surfaced through the Workboard builder UI instead.
    links = (
        db.query(DashboardPublicLink)
        .filter(
            DashboardPublicLink.dashboard_id == dashboard_id,
            DashboardPublicLink.source == "user",
        )
        .order_by(DashboardPublicLink.created_at.desc())
        .all()
    )
    return [_sanitize_link_for_admin(link) for link in links]


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
    return _sanitize_link_for_admin(link)


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
    if link.source == "workboard":
        raise HTTPException(
            status_code=403,
            detail="This link is managed by a workboard. Edit it from the Workboard builder.",
        )
    if request.name is not None:
        link.name = request.name
    if request.filters_config is not None:
        link.filters_config = request.filters_config
    if request.appearance_config is not None:
        new_config = dict(request.appearance_config)
        existing_config = dict(link.appearance_config or {})
        incoming_key = new_config.get("ai_bot_key")
        if incoming_key is None or incoming_key == "":
            # Key absent or empty → keep existing key (empty string = explicit clear)
            existing_key = existing_config.get("ai_bot_key")
            if incoming_key is None and existing_key:
                # No key field sent at all — preserve current key silently
                new_config["ai_bot_key"] = existing_key
            else:
                # Empty string sent explicitly → delete the key
                new_config.pop("ai_bot_key", None)
                new_config.pop("ai_bot_key_configured", None)
        # ai_bot_key_configured is computed server-side; strip any client-sent value
        new_config.pop("ai_bot_key_configured", None)
        link.appearance_config = new_config
    if request.is_active is not None:
        link.is_active = request.is_active
    if request.password is not None:
        link.password_hash = _pwd_context.hash(request.password) if request.password else None
    db.commit()
    db.refresh(link)
    return _sanitize_link_for_admin(link)


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
    if link.source == "workboard":
        raise HTTPException(
            status_code=403,
            detail="This link is managed by a workboard. Delete the workboard screen to remove it.",
        )
    db.delete(link)
    db.commit()
    return {"deleted": True}


# ── Admin: AI Chat Sessions ────────────────────────────────────────────────────

@router.get("/{dashboard_id}/ai/sessions")
def list_ai_chat_sessions(
    dashboard_id: int,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return paginated list of AI chat sessions for a dashboard.

    Requires at least view access.  Only returns metadata rows (no messages)
    so the list is fast.  Fetch individual rows with the GET /session/{key}
    public endpoint if you need to inspect messages.
    """
    from app.models.ai_chat_session import AiChatSession
    from app.models.models import DashboardPublicLink

    dash = db.query(Dashboard).filter(Dashboard.id == dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    require_view_access(db, current_user, dash, "dashboards")

    # Collect all tokens for this dashboard
    tokens = [
        row.token
        for row in db.query(DashboardPublicLink.token).filter(
            DashboardPublicLink.dashboard_id == dashboard_id
        ).all()
    ]
    if not tokens:
        return {"total": 0, "items": []}

    q = (
        db.query(AiChatSession)
        .filter(AiChatSession.token.in_(tokens))
        .order_by(AiChatSession.updated_at.desc())
    )
    total = q.count()
    rows = q.offset(offset).limit(min(limit, 200)).all()
    return {
        "total": total,
        "items": [
            {
                "id": r.id,
                "session_key": r.session_key,
                "token": r.token,
                "provider": r.provider,
                "model": r.model,
                "turn_count": r.turn_count,
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ],
    }


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
