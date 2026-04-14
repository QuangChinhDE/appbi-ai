"""
API router for report template endpoints.
"""
from typing import Any, Dict, List, Optional

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
