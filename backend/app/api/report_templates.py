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
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas.report_template import (
    ReportTemplateCreate,
    ReportTemplateUpdate,
    ReportTemplateResponse,
)
from app.services.report_template_service import ReportTemplateService

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

router = APIRouter(prefix="/report-templates", tags=["report-templates"])


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
    updated = ReportTemplateService.update(db, template_id, payload)
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
        from app.services.excel_export_service import export_template_to_excel

        xlsx_bytes = export_template_to_excel(db, tpl, payload.active_filters)
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


# ── Excel import ───────────────────────────────────────────────────────

MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10 MB


@router.post("/import-excel")
async def import_excel(
    file: UploadFile = File(...),
    format: str = Query("blocks", regex="^(blocks|sheet)$"),
    _current_user: User = Depends(require_permission("report_templates", "edit")),
):
    """
    Parse an uploaded .xlsx file and return template data.

    Query params:
      format=blocks  → legacy TemplateBlock[] list (default)
      format=sheet   → SheetData v2 dict for spreadsheet editor
    """
    # Validate content type
    if file.content_type not in (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/octet-stream",
    ):
        raise HTTPException(
            status_code=400,
            detail="Only .xlsx files are supported.",
        )

    # Read with size limit
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail="File too large (max 10 MB).")
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        if format == "sheet":
            from app.services.excel_parser import parse_excel_to_sheet
            return parse_excel_to_sheet(contents)
        else:
            from app.services.excel_parser import parse_excel_to_blocks
            blocks = parse_excel_to_blocks(contents)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Failed to parse Excel file: {exc}",
        )

    return blocks


# ── Smart import: analyze + confirm ───────────────────────────────────


@router.post("/import-analyze")
async def import_analyze(
    file: UploadFile = File(...),
    sheet_name: Optional[str] = Query(None),
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

    token = _cache_file(contents)
    result["file_token"] = token
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
    report_meta: Optional[str] = None
    header_lines: List[Dict[str, Any]] = Field(default_factory=list)
    columns: List[Dict[str, Any]] = Field(default_factory=list)
    column_groups: List[Dict[str, Any]] = Field(default_factory=list)
    group_by_column: Optional[str] = None
    show_subtotals: bool = False
    footer_lines: List[str] = Field(default_factory=list)
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
        {
            "text": hl.get("text", ""),
            "rightText": hl.get("right_text"),
            "align": hl.get("align", "center"),
            "bold": hl.get("bold", True),
            "fontSize": hl.get("font_size", "base"),
        }
        for hl in payload.header_lines
    ]

    footer_def = {}
    if payload.footer_lines:
        footer_def["lines"] = [
            {"text": line, "align": "left", "fontSize": "sm"}
            for line in payload.footer_lines
        ]
    if payload.signature_count > 0:
        footer_def["signatureSlots"] = payload.signature_count
        footer_def["signatureLabels"] = payload.signature_labels

    definition: Dict[str, Any] = {
        "version": 3,
        "layout": "table",
        "columns": columns_def,
        "header": {
            "title": payload.report_title,
            "meta": payload.report_meta,
            "lines": header_lines_def,
        },
        "groupBy": payload.group_by_column,
        "showSubtotals": payload.show_subtotals,
        "theme": payload.theme or None,
    }
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
            from app.api.datasources import _parse_excel_bytes, _parse_csv_bytes
            # Detect format from analyzed_sheet name or try both
            try:
                parsed = _parse_excel_bytes(file_bytes)
            except Exception:
                parsed = _parse_csv_bytes(file_bytes, payload.analyzed_sheet)
            sheet_data = parsed.get(payload.analyzed_sheet)
            if not sheet_data:
                # Fallback: first sheet
                sheet_data = next(iter(parsed.values())) if parsed else None
            if not sheet_data:
                raise ValueError("No data found in the uploaded file.")

            # Create manual datasource
            from app.schemas.schemas import DataSourceCreate as DSCreate
            from app.services.datasource_crud_service import DataSourceCRUDService

            ds_name = f"[Import] {payload.template_name or payload.report_title or 'Template'}"
            ds = DataSourceCRUDService.create(
                db,
                DSCreate(
                    name=ds_name,
                    type="manual",
                    config={"sheets": {payload.analyzed_sheet: sheet_data}},
                ),
                owner_id=current_user.id,
            )
            datasource_id = ds.id

            # Create dataset
            from app.schemas.dataset import DatasetCreate as DSETCreate
            from app.services.dataset_crud import DatasetCRUDService

            dataset_name = payload.template_name or payload.report_title or "Imported Data"
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
                    source_table_name=payload.analyzed_sheet,
                    display_name=payload.analyzed_sheet,
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
