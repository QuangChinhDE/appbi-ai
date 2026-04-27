"""
API router for the Workboard module.

Pattern mirrored from ``app.api.dashboards`` to keep the contract
consistent (list/owned-or-shared, batch effective permissions on listing,
``require_view/edit/full`` per-route, audit on mutation).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.core import get_db
from app.core.dependencies import (
    get_current_user,
    get_effective_permission,
    require_edit_access,
    require_full_access,
    require_permission,
    require_view_access,
)
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.core.logging import get_logger
from app.models.audit_log import AuditAction
from app.models.resource_share import ResourceType
from app.models.user import User
from app.modules.workboards.models import Workboard
from app.modules.workboards.schemas import (
    WorkboardCreate,
    WorkboardPublicLinkCreate,
    WorkboardPublicLinkResponse,
    WorkboardPublicLinkUpdate,
    WorkboardResponse,
    WorkboardRowDeletePayload,
    WorkboardRowPayload,
    WorkboardRowUpdatePayload,
    WorkboardRowsRequest,
    WorkboardRowsResponse,
    WorkboardUpdate,
    WorkboardWriteResult,
)
from app.modules.workboards.services import doc_export_service as doc_export
from app.services.audit_service import audit
from app.modules.workboards.services.runtime_service import WorkboardRuntimeService
from app.modules.workboards.services.crud_service import WorkboardService, load_layout_v2
from app.modules.workboards.services.public_links import WorkboardPublicLinkService
from app.modules.workboards.services.write_service import (
    OptimisticLockError,
    WorkboardValidationError,
    WorkboardWriteError,
    WorkboardWriteService,
)

logger = get_logger(__name__)
router = APIRouter(prefix="/workboards", tags=["workboards"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_or_404(db: Session, workboard_id: int) -> Workboard:
    wb = WorkboardService.get_by_id(db, workboard_id)
    if not wb:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workboard not found")
    return wb


def _stamp_v2(wb: Workboard) -> Workboard:
    """Inflate the workboard's stored layout_json to a v2 dict for responses.

    The DB row is not modified; only the in-memory attribute is replaced so
    downstream pydantic serialization sees v2 fields.
    """
    try:
        wb.layout_json = load_layout_v2(wb)
    except Exception:  # pragma: no cover — never block response on bad data
        logger.exception("layout v2 upgrade failed for workboard %s", wb.id)
    return wb


def _handle_write_exc(exc: WorkboardWriteError) -> HTTPException:
    detail: Any = str(exc)
    if isinstance(exc, WorkboardValidationError):
        detail = {"message": str(exc), "violations": exc.violations}
    return HTTPException(status_code=exc.status_code, detail=detail)


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[WorkboardResponse])
def list_workboards(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    items = (
        _owned_or_shared(db, Workboard, ResourceType.WORKBOARD, current_user)
        .offset(skip)
        .limit(limit)
        .all()
    )
    for item in items:
        item.user_permission = get_effective_permission(db, current_user, item, "workboards")
        _stamp_v2(item)
    stamp_owner_emails(db, items)
    return items


@router.post("/", response_model=WorkboardResponse, status_code=status.HTTP_201_CREATED)
def create_workboard(
    payload: WorkboardCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("workboards", "edit")),
):
    try:
        wb = WorkboardService.create(db, payload, owner_id=current_user.id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    audit(
        db,
        AuditAction.WORKBOARD_CREATED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(wb.id),
        details={"name": wb.name, "dataset_id": wb.dataset_id},
    )
    wb.user_permission = "full"
    return _stamp_v2(wb)


@router.get("/{workboard_id}", response_model=WorkboardResponse)
def get_workboard(
    workboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    wb.user_permission = require_view_access(db, current_user, wb, "workboards")
    return _stamp_v2(wb)


@router.patch("/{workboard_id}", response_model=WorkboardResponse)
def update_workboard(
    workboard_id: int,
    payload: WorkboardUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    try:
        updated = WorkboardService.update(db, workboard_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    audit(
        db,
        AuditAction.WORKBOARD_UPDATED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(workboard_id),
        details={"fields": list(payload.model_dump(exclude_unset=True).keys())},
    )
    if updated:
        updated.user_permission = "full"
        _stamp_v2(updated)
    return updated


@router.delete("/{workboard_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workboard(
    workboard_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_full_access(db, current_user, wb, "workboards")
    success = WorkboardService.delete(db, workboard_id)
    if not success:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workboard not found")
    audit(
        db,
        AuditAction.WORKBOARD_DELETED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(workboard_id),
    )


@router.post("/{workboard_id}/publish", response_model=WorkboardResponse)
def publish_workboard(
    workboard_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    wb = WorkboardService.refresh_schema_defaults(db, wb)
    wb.is_published = True
    db.commit()
    db.refresh(wb)
    audit(
        db,
        AuditAction.WORKBOARD_PUBLISHED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(workboard_id),
    )
    wb.user_permission = "full"
    return _stamp_v2(wb)


@router.get("/{workboard_id}/public-links", response_model=List[WorkboardPublicLinkResponse])
def list_public_links(
    workboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    return WorkboardPublicLinkService.list_links(wb)


@router.post(
    "/{workboard_id}/public-links",
    response_model=WorkboardPublicLinkResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_public_link(
    workboard_id: int,
    payload: WorkboardPublicLinkCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    if not wb.is_published:
        wb = WorkboardService.refresh_schema_defaults(db, wb)
        wb.is_published = True
        db.commit()
        db.refresh(wb)
    if payload.mode == "view" and payload.view_id:
        bundle = WorkboardRuntimeService.list_views(wb)
        view = next((item for item in (bundle.get("views") or []) if item.get("id") == payload.view_id), None)
        if not view:
            raise HTTPException(status_code=404, detail=f"View '{payload.view_id}' not found")
        if view.get("kind") not in {"table", "deck", "gallery"}:
            raise HTTPException(
                status_code=400,
                detail="Public view links currently support table, deck, and gallery views only.",
            )
    if payload.mode == "view" and not payload.view_id:
        raise HTTPException(status_code=400, detail="view_id is required when mode='view'")
    return WorkboardPublicLinkService.create_link(
        db,
        wb,
        name=payload.name,
        mode=payload.mode,
        view_id=payload.view_id,
        password=payload.password,
    )


@router.patch("/{workboard_id}/public-links/{link_id}", response_model=WorkboardPublicLinkResponse)
def update_public_link(
    workboard_id: int,
    link_id: str,
    payload: WorkboardPublicLinkUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    updated = WorkboardPublicLinkService.update_link(
        db,
        wb,
        link_id,
        name=payload.name,
        mode=payload.mode,
        view_id=payload.view_id,
        is_active=payload.is_active,
        password=payload.password,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Public link not found")
    return updated


@router.delete("/{workboard_id}/public-links/{link_id}", status_code=status.HTTP_200_OK)
def delete_public_link(
    workboard_id: int,
    link_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    deleted = WorkboardPublicLinkService.delete_link(db, wb, link_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Public link not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Runtime: form
# ---------------------------------------------------------------------------

@router.get("/{workboard_id}/form")
def get_form_spec(
    workboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    return WorkboardRuntimeService.render_form(db, wb)


@router.get("/{workboard_id}/lookups/{field_column}")
def get_lookup_options(
    workboard_id: int,
    field_column: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    spec = WorkboardRuntimeService.render_form(db, wb)
    options = (spec.get("lookups") or {}).get(field_column)
    if options is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No lookup configured for field '{field_column}'",
        )
    return {"field": field_column, "options": options}


# ---------------------------------------------------------------------------
# Runtime: rows (table view)
# ---------------------------------------------------------------------------

@router.post("/{workboard_id}/rows/list", response_model=WorkboardRowsResponse)
def list_rows(
    workboard_id: int,
    payload: WorkboardRowsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    page_size = payload.page_size or 50
    result = WorkboardRuntimeService.list_rows(
        db,
        wb,
        page=payload.page,
        page_size=page_size,
        filters=payload.filters,
    )
    return WorkboardRowsResponse(
        columns=result.get("columns") or [],
        rows=result.get("rows") or [],
        page=result.get("page") or payload.page,
        page_size=result.get("page_size") or page_size,
        has_more=len(result.get("rows") or []) == (result.get("page_size") or page_size),
    )


@router.post("/{workboard_id}/rows", response_model=WorkboardWriteResult)
def insert_row(
    workboard_id: int,
    payload: WorkboardRowPayload,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    try:
        result = WorkboardWriteService.insert_row(db, wb, payload.values, current_user)
    except WorkboardWriteError as exc:
        raise _handle_write_exc(exc) from exc
    audit(
        db,
        AuditAction.WORKBOARD_ROW_INSERTED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(workboard_id),
        details={"pk": result.get("pk")},
    )
    return WorkboardWriteResult(action="insert", **result)


@router.patch("/{workboard_id}/rows", response_model=WorkboardWriteResult)
def update_row(
    workboard_id: int,
    payload: WorkboardRowUpdatePayload,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    try:
        result = WorkboardWriteService.update_row(
            db,
            wb,
            payload.pk,
            payload.values,
            current_user,
            lock_token=payload.lock_token,
        )
    except OptimisticLockError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except WorkboardWriteError as exc:
        raise _handle_write_exc(exc) from exc
    audit(
        db,
        AuditAction.WORKBOARD_ROW_UPDATED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(workboard_id),
        details={"pk": payload.pk},
    )
    return WorkboardWriteResult(action="update", **result)


@router.delete("/{workboard_id}/rows", response_model=WorkboardWriteResult)
def delete_row(
    workboard_id: int,
    payload: WorkboardRowDeletePayload,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    try:
        result = WorkboardWriteService.delete_row(
            db, wb, payload.pk, current_user, lock_token=payload.lock_token
        )
    except OptimisticLockError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except WorkboardWriteError as exc:
        raise _handle_write_exc(exc) from exc
    audit(
        db,
        AuditAction.WORKBOARD_ROW_DELETED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(workboard_id),
        details={"pk": payload.pk},
    )
    return WorkboardWriteResult(action="delete", **result)


# ---------------------------------------------------------------------------
# Runtime: doc views
# ---------------------------------------------------------------------------

@router.get("/{workboard_id}/doc/{view_id}")
def render_doc_view(
    workboard_id: int,
    view_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    rendered = WorkboardRuntimeService.render_doc(
        db, wb, view_id=view_id, user=current_user
    )
    if rendered.get("missing"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Doc view '{view_id}' not found",
        )
    return rendered


@router.get("/{workboard_id}/doc/{view_id}/export")
def export_doc_view(
    workboard_id: int,
    view_id: str,
    format: str = Query("html", pattern="^(html|pdf|excel)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    rendered = WorkboardRuntimeService.render_doc(
        db, wb, view_id=view_id, user=current_user
    )
    if rendered.get("missing"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Doc view '{view_id}' not found",
        )
    base_filename = f"{wb.slug or wb.name or 'workboard'}-{view_id}".replace(" ", "_")
    if format == "html":
        return Response(
            content=doc_export.to_html(rendered),
            media_type="text/html; charset=utf-8",
        )
    if format == "pdf":
        return Response(
            content=doc_export.to_pdf(rendered),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{base_filename}.pdf"'},
        )
    if format == "excel":
        return Response(
            content=doc_export.to_excel(rendered),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{base_filename}.xlsx"'},
        )
    raise HTTPException(status_code=400, detail=f"Unsupported export format '{format}'")


# ---------------------------------------------------------------------------
# v2 — multi-table / multi-view runtime
# ---------------------------------------------------------------------------

@router.get("/{workboard_id}/v2/views")
def list_v2_views(
    workboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    return WorkboardRuntimeService.list_views(wb)


@router.post("/{workboard_id}/v2/views/{view_id}/render")
def render_v2_view(
    workboard_id: int,
    view_id: str,
    payload: Optional[Dict[str, Any]] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    payload = payload or {}
    result = WorkboardRuntimeService.render_view(
        db,
        wb,
        view_id,
        page=int(payload.get("page") or 1),
        page_size=int(payload.get("page_size") or 50),
        filters=payload.get("filters") or [],
        pk=payload.get("pk"),
    )
    if result.get("missing"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"View '{view_id}' not found",
        )
    return result


@router.post("/{workboard_id}/v2/actions/{action_id}/execute")
def execute_v2_action(
    workboard_id: int,
    action_id: str,
    payload: Optional[Dict[str, Any]] = None,
    request: Request = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    payload = payload or {}
    result = WorkboardRuntimeService.execute_action(
        db,
        wb,
        action_id,
        row_pk=payload.get("pk"),
        user=current_user,
    )
    if not result.get("ok") and result.get("error") == "action_not_found":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Action '{action_id}' not found",
        )
    return result



# ── Template export / import ──────────────────────────────────────────────
#
# Lets admins ship workboards as portable JSON bundles (for libraries, demos,
# cross-instance migrations). Bundle includes a snapshot of every dataset
# table referenced — import maps those to the matching tables on the target
# dataset and surfaces a per-table / per-column report so the admin can
# fix what didn't match in the builder afterwards.

from app.modules.workboards.services import template_service as _template_svc


@router.get("/{workboard_id}/export")
def export_workboard_template(
    workboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    bundle = _template_svc.export_workboard(db, wb)
    return bundle


class _ImportTemplatePayload(__import__("pydantic").BaseModel):
    bundle: dict
    target_dataset_id: int
    target_name: Optional[str] = None


@router.post("/_import_template")
def import_workboard_template(
    payload: _ImportTemplatePayload,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("workboards", "edit")),
):
    """Create a workboard from an export bundle.

    The response carries the new workboard plus a ``_import_report`` field
    describing which tables/columns matched, so the FE can show a clear
    "imported, but X table needs wiring" notification.
    """
    try:
        wb, report = _template_svc.import_workboard(
            db,
            payload.bundle,
            target_dataset_id=payload.target_dataset_id,
            target_name=payload.target_name,
            owner_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    # Snapshot the response BEFORE the audit call: import_workboard already
    # committed the new workboard, but if the subsequent audit insert fails
    # SQLAlchemy poisons the session and any later attribute load on ``wb``
    # would re-raise. Serialise first, then audit — that way audit failures
    # never shadow a successful import.
    response = WorkboardResponse.model_validate(wb).model_dump(mode="json")
    response["_import_report"] = report.to_dict()
    try:
        audit(
            db,
            AuditAction.WORKBOARD_CREATED,
            request=request,
            user_id=current_user.id,
            resource_type="workboard",
            resource_id=str(wb.id),
            details={
                "name": wb.name,
                "imported": True,
                "matched_tables": len(report.matched_tables),
                "missing_tables": len(report.missing_tables),
            },
        )
    except Exception:
        logger.exception("audit insert failed during import-template (non-fatal)")
        try:
            db.rollback()
        except Exception:
            pass
    return response
