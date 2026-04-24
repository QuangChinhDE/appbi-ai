"""
API router for report template endpoints.
"""
import time
import uuid as _uuid
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core import get_db
from app.core.dependencies import (
    get_current_user,
    require_permission,
    require_edit_access,
    require_full_access,
    get_effective_permission,
)
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.models.report_template import ReportTemplate
from app.models import DataSource, Dataset
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas.dataset import ColumnMetadata, FilterCondition, TablePreviewResponse
from app.schemas.report_template import (
    ReportTemplateCreate,
    ReportTemplateUpdate,
    ReportTemplateResponse,
)
from app.services.report_template_service import ReportTemplateService
from app.services.dataset_crud import DatasetCRUDService
from app.services.dataset_table_sql_service import (
    DatasetTableSqlError,
    build_live_proxy_table_for_dataset_table,
    is_derived_table,
)
from app.services.dataset_calendar_service import is_generated_calendar_table
from app.services.live_query_service import LiveQueryService
from app.services.template_import_ai_service import (
    build_ai_assist_meta,
    refine_import_analysis_with_ai,
)
from app.services.template_document_runtime_service import build_template_document_runtime_preview
from app.services.template_document_schema import is_template_document_definition, normalize_template_document
from app.services.template_runtime_service import build_template_preview_table_proxy

# ── In-memory file cache for import workflow ─────────────────────────
_file_cache: Dict[str, Tuple[bytes, float]] = {}
_CACHE_TTL = 600  # 10 minutes


def _cache_file(file_bytes: bytes) -> str:
    token = str(_uuid.uuid4())
    _file_cache[token] = (file_bytes, time.time())
    # Cleanup expired entries
    cutoff = time.time() - _CACHE_TTL
    expired = [k for k, (_, t) in _file_cache.items() if t < cutoff]
    for k in expired:
        del _file_cache[k]
    return token


def _get_cached_file(token: str) -> Optional[bytes]:
    entry = _file_cache.get(token)
    if entry and (time.time() - entry[1]) < _CACHE_TTL:
        return entry[0]
    if entry:
        del _file_cache[token]
    return None


def _build_unique_name(db: Session, model: Any, base_name: str) -> str:
    candidate = str(base_name or "").strip() or "Imported Resource"
    suffix = 2
    while db.query(model).filter(model.name == candidate).first() is not None:
        candidate = f"{base_name} ({suffix})"
        suffix += 1
    return candidate


_ALLOWED_TEXT_ALIGN = {"left", "center", "right"}
_ALLOWED_FONT_SIZES = {"sm", "base", "lg", "xl"}


def _normalize_text_line(item: Any, *, default_font_size: str = "base", default_align: str = "left", default_bold: bool = False) -> Optional[Dict[str, Any]]:
    if isinstance(item, str):
        text = item.strip()
        if not text:
            return None
        return {
            "text": text,
            "rightText": None,
            "align": default_align,
            "bold": default_bold,
            "fontSize": default_font_size,
        }

    if not isinstance(item, dict):
        return None

    text = str(item.get("text") or "").strip()
    right_text = str(item.get("right_text") or item.get("rightText") or "").strip() or None
    if not text and not right_text:
        return None

    align = str(item.get("align") or default_align).lower()
    font_size = str(item.get("font_size") or item.get("fontSize") or default_font_size).lower()
    return {
        "text": text,
        "rightText": right_text,
        "align": align if align in _ALLOWED_TEXT_ALIGN else default_align,
        "bold": bool(item.get("bold", default_bold)),
        "fontSize": font_size if font_size in _ALLOWED_FONT_SIZES else default_font_size,
    }


def _normalize_title_style(style: Any) -> Dict[str, Any]:
    if not isinstance(style, dict):
        return {}

    normalized: Dict[str, Any] = {}
    align = str(style.get("align") or "").lower()
    if align in _ALLOWED_TEXT_ALIGN:
        normalized["titleAlign"] = align
    font_size = str(style.get("font_size") or style.get("fontSize") or "").lower()
    if font_size in _ALLOWED_FONT_SIZES:
        normalized["titleFontSize"] = font_size
    if "bold" in style:
        normalized["titleBold"] = bool(style.get("bold"))
    return normalized

router = APIRouter(prefix="/report-templates", tags=["report-templates"])


class TemplatePreviewDataSourceRequest(BaseModel):
    datasetId: int = Field(..., gt=0)
    tableId: int = Field(..., gt=0)


class TemplatePreviewColumnRequest(BaseModel):
    key: str = Field(..., min_length=1)
    type: Optional[str] = None
    sourceColumn: Optional[str] = None
    expression: Optional[str] = None


class TemplatePreviewActiveFilterRequest(BaseModel):
    filterId: str = Field(..., min_length=1)
    value: Any = None


class TemplatePreviewRequest(BaseModel):
    templateId: Optional[int] = Field(default=None, gt=0)
    dataSource: TemplatePreviewDataSourceRequest
    columns: List[TemplatePreviewColumnRequest] = Field(default_factory=list)
    templateFilters: List[Dict[str, Any]] = Field(default_factory=list)
    filters: List[FilterCondition] = Field(default_factory=list)
    activeFilters: List[TemplatePreviewActiveFilterRequest] = Field(default_factory=list)
    limit: int = Field(default=100, ge=1, le=1000)
    offset: int = Field(default=0, ge=0)


class TemplateDocumentRuntimePreviewRequest(BaseModel):
    blocks: Optional[Dict[str, Any]] = None
    limit: int = Field(default=8, ge=1, le=50)


class TemplateDocumentRuntimePreviewResponse(BaseModel):
    sources: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    blocks: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    warnings: List[str] = Field(default_factory=list)


@router.post("/preview-data", response_model=TablePreviewResponse)
def preview_template_data(
    payload: TemplatePreviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Preview template data with server-side formula evaluation."""
    dataset_id = payload.dataSource.datasetId
    table_id = payload.dataSource.tableId
    template_obj: Optional[ReportTemplate] = None

    if payload.templateId is not None:
        template_obj = ReportTemplateService.get_by_id(db, payload.templateId)
        if not template_obj:
            raise HTTPException(status_code=404, detail="Report template not found")

        template_perm = get_effective_permission(db, current_user, template_obj, "report_templates")
        if template_perm == "none":
            raise HTTPException(status_code=403, detail="Access denied")

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")

    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    datasource: Optional[DataSource] = None
    target_table = db_table

    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        try:
            datasource, target_table = build_live_proxy_table_for_dataset_table(
                db,
                dataset_obj,
                db_table,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)})
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
        if not datasource:
            raise HTTPException(status_code=404, detail="Datasource not found")

    preview_table, formula_errors = build_template_preview_table_proxy(
        target_table,
        [column.model_dump(exclude_none=True) for column in payload.columns],
    )
    if formula_errors:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Some template formulas are invalid.",
                "column_errors": formula_errors,
            },
        )

    runtime_filters = [item.model_dump() for item in payload.filters] if payload.filters else []
    if template_obj is not None or payload.templateFilters:
        from app.services.template_runtime_service import resolve_template_runtime_filters

        filter_definitions = payload.templateFilters or (template_obj.filters if template_obj is not None else []) or []
        runtime_filters.extend(
            resolve_template_runtime_filters(
                filter_definitions,
                [item.model_dump() for item in payload.activeFilters],
                dataset_id=dataset_id,
                table_id=table_id,
            )
        )

    result = LiveQueryService.execute_preview_query(
        datasource=datasource,
        db_table=preview_table,
        limit=payload.limit,
        offset=payload.offset,
        filters=runtime_filters or None,
    )

    rows = result.get("rows", [])
    columns = result.get("columns", [])
    total_rows = len(rows)
    serialized_rows: List[Dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict):
            serialized_rows.append(row)
        else:
            serialized_rows.append({str(columns[idx]): row[idx] for idx in range(len(columns))})

    column_meta = [
        ColumnMetadata(name=str(column), type="string", nullable=True)
        for column in columns
    ]
    for meta in column_meta:
        values = [r.get(meta.name) for r in serialized_rows if isinstance(r, dict)]
        for value in values:
            if value is None:
                continue
            if isinstance(value, bool):
                meta.type = "boolean"
                break
            if isinstance(value, (int, float)):
                meta.type = "number"
                break
            meta.type = "string"
            break

    return TablePreviewResponse(
        columns=column_meta,
        rows=serialized_rows,
        total=total_rows,
        has_more=total_rows >= payload.limit,
    )


@router.post("/{template_id}/document-runtime-preview", response_model=TemplateDocumentRuntimePreviewResponse)
def preview_template_document_runtime(
    template_id: int,
    payload: TemplateDocumentRuntimePreviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Build block-level runtime preview payloads for the clean document engine."""
    tpl = ReportTemplateService.get_by_id(db, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Report template not found")

    perm = get_effective_permission(db, current_user, tpl, "report_templates")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    raw_blocks = payload.blocks if payload.blocks is not None else tpl.blocks
    if payload.blocks is not None:
        raw_blocks = ReportTemplateService._serialize_blocks(payload.blocks)

    if not is_template_document_definition(raw_blocks):
        raise HTTPException(status_code=400, detail="Document runtime preview is only available for document-engine templates.")

    definition = normalize_template_document(raw_blocks)
    source_previews: Dict[str, Dict[str, Any]] = {}
    warnings: List[str] = []

    for raw_source in definition.get("dataSources") or []:
        if not isinstance(raw_source, dict):
            continue

        source_id = str(raw_source.get("id") or "").strip()
        source_kind = str(raw_source.get("kind") or "").strip().lower()
        if not source_id:
            continue
        if source_kind != "dataset_table":
            warnings.append(f"Source '{source_id}' uses unsupported kind '{source_kind or 'unknown'}' for runtime preview.")
            continue

        dataset_id = raw_source.get("datasetId")
        table_id = raw_source.get("tableId")
        try:
            dataset_id = int(dataset_id)
            table_id = int(table_id)
        except (TypeError, ValueError):
            warnings.append(f"Source '{source_id}' is missing a valid dataset/table binding.")
            continue

        preview = preview_template_data(
            TemplatePreviewRequest(
                dataSource=TemplatePreviewDataSourceRequest(datasetId=dataset_id, tableId=table_id),
                columns=[],
                limit=payload.limit,
                offset=0,
            ),
            db=db,
            current_user=current_user,
        )
        source_previews[source_id] = {
            "sourceId": source_id,
            "datasetId": dataset_id,
            "tableId": table_id,
            "columns": [column.model_dump() for column in preview.columns],
            "rows": preview.rows,
            "total": preview.total,
        }

    runtime_preview = build_template_document_runtime_preview(definition, source_previews)
    runtime_preview["warnings"] = [*warnings, *(runtime_preview.get("warnings") or [])]
    return TemplateDocumentRuntimePreviewResponse(**runtime_preview)


@router.get("/", response_model=List[ReportTemplateResponse])
def list_templates(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List report templates visible to the current user."""
    items = (
        _owned_or_shared(db, ReportTemplate, ResourceType.REPORT_TEMPLATE, current_user)
        .order_by(ReportTemplate.updated_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    for item in items:
        item.user_permission = get_effective_permission(
            db, current_user, item, "report_templates",
        )
    stamp_owner_emails(db, items)
    return items


@router.get("/{template_id}", response_model=ReportTemplateResponse)
def get_template(
    template_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single report template by ID."""
    tpl = ReportTemplateService.get_by_id(db, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Report template not found")
    tpl.user_permission = get_effective_permission(
        db, current_user, tpl, "report_templates",
    )
    stamp_owner_emails(db, [tpl])
    return tpl


@router.post("/", response_model=ReportTemplateResponse, status_code=status.HTTP_201_CREATED)
def create_template(
    payload: ReportTemplateCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report_templates", "edit")),
):
    """Create a new report template."""
    try:
        tpl = ReportTemplateService.create(db, payload, owner_id=current_user.id)
        tpl.user_permission = "full"
        stamp_owner_emails(db, [tpl])
        return tpl
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{template_id}", response_model=ReportTemplateResponse)
def update_template(
    template_id: int,
    payload: ReportTemplateUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a report template."""
    tpl = ReportTemplateService.get_by_id(db, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Report template not found")
    require_edit_access(db, current_user, tpl, "report_templates")
    try:
        updated = ReportTemplateService.update(db, template_id, payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    updated.user_permission = get_effective_permission(
        db, current_user, updated, "report_templates",
    )
    stamp_owner_emails(db, [updated])
    return updated


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(
    template_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a report template."""
    tpl = ReportTemplateService.get_by_id(db, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Report template not found")
    require_full_access(db, current_user, tpl, "report_templates")
    ReportTemplateService.delete(db, template_id)


# ── Excel export ──────────────────────────────────────────────────────


class ExportExcelRequest(BaseModel):
    active_filters: List[Dict[str, Any]] = Field(default_factory=list)
    blocks: Optional[Dict[str, Any]] = None
    filters: Optional[List[Dict[str, Any]]] = None


class TemplateManualWritebackRequest(BaseModel):
    blocks: Optional[Dict[str, Any]] = None
    rows: List[Dict[str, Any]] = Field(default_factory=list)


class TemplateManualWritebackResponse(BaseModel):
    rows_saved: int


@router.post("/{template_id}/export-excel")
def export_template_excel(
    template_id: int,
    payload: ExportExcelRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Export a report template as .xlsx with live dataset data applied.
    The client passes active filter values; the service resolves all bound
    data fields and returns a ready-to-open Excel file.
    """
    tpl = ReportTemplateService.get_by_id(db, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Report template not found")

    perm = get_effective_permission(db, current_user, tpl, "report_templates")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    try:
        from app.services.template_excel_export_service import export_template_to_excel

        xlsx_bytes = export_template_to_excel(
            db,
            tpl,
            payload.active_filters,
            definition_override=payload.blocks,
            filter_definitions=payload.filters,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to export template: {exc}",
        )

    safe_name = (tpl.name or "report").replace(" ", "_").replace("/", "_")
    filename = f"{safe_name}.xlsx"
    return StreamingResponse(
        iter([xlsx_bytes]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{template_id}/manual-writeback", response_model=TemplateManualWritebackResponse)
def save_template_manual_rows(
    template_id: int,
    payload: TemplateManualWritebackRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Persist full-row manual datasource edits for a template-bound table."""
    tpl = ReportTemplateService.get_by_id(db, template_id)
    if not tpl:
        raise HTTPException(status_code=404, detail="Report template not found")
    require_edit_access(db, current_user, tpl, "report_templates")

    definition = ReportTemplateService._serialize_blocks(payload.blocks if payload.blocks is not None else tpl.blocks)
    data_source = definition.get("dataSource") or {}
    dataset_id = int(data_source.get("datasetId") or 0)
    table_id = int(data_source.get("tableId") or 0)
    if dataset_id <= 0 or table_id <= 0:
        raise HTTPException(status_code=400, detail="Template must be bound to a dataset table before saving data.")

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    datasource_type = datasource.type.value if hasattr(datasource.type, "value") else str(datasource.type)
    if datasource_type != "manual":
        raise HTTPException(status_code=400, detail="Template writeback is only supported for manual datasources.")
    if db_table.source_kind != "physical_table":
        raise HTTPException(status_code=400, detail="Template writeback currently requires a physical manual table.")

    from app.core.crypto import decrypt_config
    from app.schemas import DataSourceUpdate
    from app.services.datasource_crud_service import DataSourceCRUDService
    from app.services.template_runtime_service import build_template_manual_writeback_config

    next_config = build_template_manual_writeback_config(
        decrypt_config(dict(datasource.config or {})),
        str(db_table.source_table_name or db_table.display_name or "manual_data"),
        payload.rows,
        list(definition.get("columns") or []),
    )
    updated_datasource = DataSourceCRUDService.update(
        db,
        datasource.id,
        DataSourceUpdate(config=next_config),
    )
    if not updated_datasource:
        raise HTTPException(status_code=500, detail="Failed to update manual datasource.")

    return TemplateManualWritebackResponse(rows_saved=len(payload.rows))


# ── Smart import ───────────────────────────────────────────────────────

MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10 MB


# ── Smart import: analyze + confirm ───────────────────────────────────


@router.post("/import-analyze")
async def import_analyze(
    file: UploadFile = File(...),
    sheet_name: Optional[str] = Query(None),
    ai_enhance: bool = Query(False),
    _current_user: User = Depends(require_permission("report_templates", "edit")),
):
    """
    Upload an .xlsx file and receive a structural analysis result.

    The response describes detected header, columns, column groups,
    data zone, footer, signatures, theme, and a recommended dataset
    table schema.  A ``file_token`` is included so the file does not
    need to be re-uploaded for the confirm step (cached for 10 min).
    """
    fname = (file.filename or "").lower()
    allowed_types = (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "text/csv",
        "application/csv",
        "application/octet-stream",
    )
    if file.content_type not in allowed_types and not (fname.endswith(".xlsx") or fname.endswith(".xls") or fname.endswith(".csv")):
        raise HTTPException(status_code=400, detail="Supported formats: .xlsx, .xls, .csv")

    contents = await file.read()
    if len(contents) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail="File too large (max 10 MB).")
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        is_csv = fname.endswith(".csv") or file.content_type in ("text/csv", "application/csv")
        if is_csv:
            from app.services.excel_structure_detector import analyze_csv_structure
            result = analyze_csv_structure(contents, filename=file.filename)
        else:
            from app.services.excel_structure_detector import analyze_excel_structure
            result = analyze_excel_structure(contents, sheet_name=sheet_name)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Failed to analyze Excel file: {exc}",
        )

    ai_meta = build_ai_assist_meta(requested=ai_enhance, applied=False, status="not_requested")
    if ai_enhance:
        result, ai_meta = refine_import_analysis_with_ai(
            file_bytes=contents,
            analysis=result,
            filename=file.filename,
            sheet_name=sheet_name,
            is_csv=is_csv,
        )

    token = _cache_file(contents)
    result["file_token"] = token
    result["ai_assist"] = ai_meta
    return result


class ImportConfirmRequest(BaseModel):
    file_token: str
    template_name: Optional[str] = None
    page_size: str = "A4"
    orientation: str = "portrait"
    include_data: bool = False
    analyzed_sheet: str = "Sheet1"
    # Confirmed analysis (possibly user-edited)
    report_title: str = ""
    report_title_style: Dict[str, Any] = Field(default_factory=dict)
    report_meta: Optional[str] = None
    header_lines: List[Dict[str, Any]] = Field(default_factory=list)
    columns: List[Dict[str, Any]] = Field(default_factory=list)
    column_groups: List[Dict[str, Any]] = Field(default_factory=list)
    group_by_column: Optional[str] = None
    show_subtotals: bool = False
    footer_lines: List[Any] = Field(default_factory=list)
    signature_count: int = 0
    signature_labels: List[str] = Field(default_factory=list)
    theme: Dict[str, str] = Field(default_factory=dict)
    recommended_table_schema: List[Dict[str, str]] = Field(default_factory=list)


@router.post("/import-confirm")
def import_confirm(
    payload: ImportConfirmRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("report_templates", "edit")),
):
    """
    Confirm a previously analyzed Excel import.

    Creates a ReportTemplate with the confirmed structure.  When
    ``include_data`` is true, also creates a manual Datasource,
    Dataset, and Table from the uploaded file data, binding
    them to the new template.
    """
    import uuid as _u

    # ── 1. Build TemplateDefinition v3 ───────────────────────────────
    theme_def = None
    if payload.theme:
        theme_def = {
            "headerBg": payload.theme.get("header_bg") or "#073763",
            "headerText": payload.theme.get("header_text") or "#ffffff",
            "groupBg": payload.theme.get("group_bg") or "#c9daf8",
            "groupText": payload.theme.get("group_text") or "#073763",
            "subtotalBg": payload.theme.get("subtotal_bg") or "#dbeafe",
            "subtotalText": payload.theme.get("subtotal_text") or "#1e40af",
            "accentColor": payload.theme.get("accent_color") or payload.theme.get("header_bg") or "#073763",
            "sectionBg": payload.theme.get("group_bg") or "#c9daf8",
            "sectionText": payload.theme.get("group_text") or "#073763",
        }

    columns_def = []
    for i, col in enumerate(payload.columns):
        col_id = str(_u.uuid4())
        columns_def.append({
            "id": col_id,
            "key": col.get("key", f"col_{i+1}"),
            "label": col.get("label", f"Column {i+1}"),
            "type": "raw",
            "sourceColumn": col.get("key", f"col_{i+1}"),
            "width": col.get("width_px", 120),
            "align": col.get("align", "left"),
            "format": col.get("format", "text"),
            "suffix": col.get("suffix"),
            "bold": col.get("bold", False),
            "highlightNegative": col.get("highlight_negative", False),
            "visible": True,
        })

    # Map column groups to column IDs
    column_groups_def = []
    for cg in payload.column_groups:
        start = cg.get("start_col_idx", 0)
        span = cg.get("span", 0)
        group_col_ids = [
            columns_def[j]["id"]
            for j in range(start, min(start + span, len(columns_def)))
        ]
        if group_col_ids:
            column_groups_def.append({
                "id": str(_u.uuid4()),
                "label": cg.get("label", ""),
                "columnIds": group_col_ids,
            })

    header_lines_def = [
        line
        for line in (
            _normalize_text_line(hl, default_font_size="base", default_align="left", default_bold=True)
            for hl in payload.header_lines
        )
        if line
    ]

    footer_def = {}
    if payload.footer_lines:
        footer_lines_def = [
            line
            for line in (
                _normalize_text_line(line, default_font_size="sm", default_align="left", default_bold=False)
                for line in payload.footer_lines
            )
            if line
        ]
        if footer_lines_def:
            footer_def["lines"] = footer_lines_def
    if payload.signature_count > 0:
        footer_def["signatureSlots"] = payload.signature_count
        footer_def["signatureLabels"] = payload.signature_labels

    header_def: Dict[str, Any] = {
        "title": payload.report_title,
        "meta": payload.report_meta,
        "lines": header_lines_def,
    }
    header_def.update(_normalize_title_style(payload.report_title_style))

    definition: Dict[str, Any] = {
        "version": 3,
        "layout": "table",
        "columns": columns_def,
        "header": header_def,
        "groupBy": payload.group_by_column,
        "showSubtotals": payload.show_subtotals,
    }
    if theme_def:
        definition["theme"] = theme_def
    if column_groups_def:
        definition["columnGroups"] = column_groups_def
    if footer_def:
        definition["footer"] = footer_def

    # ── 2. Optionally create datasource + dataset + table ────────────
    dataset_id: Optional[int] = None
    datasource_id: Optional[int] = None

    if payload.include_data:
        file_bytes = _get_cached_file(payload.file_token)
        if not file_bytes:
            raise HTTPException(
                status_code=400,
                detail="File token expired. Please re-upload the file.",
            )

        try:
            from app.services.excel_structure_detector import (
                extract_csv_import_sheet_data,
                extract_excel_import_sheet_data,
            )

            analyzed_name = payload.analyzed_sheet or "Sheet1"
            if str(analyzed_name).lower().endswith(".csv"):
                actual_sheet_name, sheet_data = extract_csv_import_sheet_data(file_bytes, filename=analyzed_name)
            else:
                try:
                    actual_sheet_name, sheet_data = extract_excel_import_sheet_data(file_bytes, sheet_name=analyzed_name)
                except Exception:
                    actual_sheet_name, sheet_data = extract_csv_import_sheet_data(file_bytes, filename=analyzed_name)

            actual_sheet_name = " ".join(str(actual_sheet_name or analyzed_name or "Sheet1").split()) or "Sheet1"

            if not sheet_data:
                raise ValueError("No data found in the uploaded file.")

            # Create manual datasource
            from app.schemas.schemas import DataSourceCreate as DSCreate
            from app.services.datasource_crud_service import DataSourceCRUDService

            ds_name = _build_unique_name(
                db,
                DataSource,
                f"[Import] {payload.template_name or payload.report_title or 'Template'}",
            )
            ds = DataSourceCRUDService.create(
                db,
                DSCreate(
                    name=ds_name,
                    type="manual",
                    config={"sheets": {actual_sheet_name: sheet_data}},
                ),
                owner_id=current_user.id,
            )
            datasource_id = ds.id

            # Create dataset
            from app.schemas.dataset import DatasetCreate as DSETCreate
            from app.services.dataset_crud import DatasetCRUDService

            dataset_name = _build_unique_name(
                db,
                Dataset,
                payload.template_name or payload.report_title or "Imported Data",
            )
            dataset = DatasetCRUDService.create_dataset(
                db,
                DSETCreate(name=dataset_name),
                owner_id=current_user.id,
            )
            dataset_id = dataset.id

            # Add table to dataset
            from app.schemas.dataset import TableCreate
            table = DatasetCRUDService.add_table_to_dataset(
                db,
                dataset.id,
                TableCreate(
                    datasource_id=ds.id,
                    source_kind="physical_table",
                    source_table_name=actual_sheet_name,
                    display_name=actual_sheet_name,
                ),
            )

            # Bind to template definition
            definition["dataSource"] = {
                "datasetId": dataset.id,
                "tableId": table.id,
                "datasetName": dataset.name,
                "tableName": table.display_name,
            }

        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to create data resources: {exc}",
            )

    # ── 3. Create template ───────────────────────────────────────────
    tpl_name = payload.template_name or payload.report_title or "Imported Template"
    tpl = ReportTemplateService.create(
        db,
        ReportTemplateCreate(
            name=tpl_name,
            page_size=payload.page_size,
            orientation=payload.orientation,
            blocks=definition,
        ),
        owner_id=current_user.id,
    )

    # Cleanup cached file
    if payload.file_token in _file_cache:
        del _file_cache[payload.file_token]

    return {
        "template_id": tpl.id,
        "dataset_id": dataset_id,
        "datasource_id": datasource_id,
    }
