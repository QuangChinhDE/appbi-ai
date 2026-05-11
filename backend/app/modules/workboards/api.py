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
    LEVEL_ORDER,
    get_current_user,
    get_effective_permission,
    require_edit_access,
    require_full_access,
    require_permission,
    require_view_access,
    _normalize_permissions,
)
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.core.logging import get_logger
from app.models.audit_log import AuditAction
from app.models.resource_share import ResourceType
from app.models.user import User
from app.modules.workboards.models import (
    Workboard,
    WorkboardAppUser,
    WorkboardWorkspace,
)
from app.modules.workboards.roles import is_owner_role, normalize_app_user_role
from app.modules.workboards.schemas import (
    AppUserCreate,
    AppUserResponse,
    AppUserUpdate,
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
from app.modules.workboards.services.app_user_service import is_default_pin_hash
from app.services.audit_service import audit
from app.modules.workboards.services.crud_service import WorkboardService
from app.modules.workboards.services.dashboard_link_service import (
    sync_workboard_dashboard_links as sync_managed_dashboard_links,
    delete_all_for_workboard as delete_managed_dashboard_links,
)
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
    stamp_owner_emails(db, items)
    return items


@router.post("/", response_model=WorkboardResponse, status_code=status.HTTP_201_CREATED)
def create_workboard(
    payload: WorkboardCreate,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("workboards", "edit")),
):
    try:
        wb = WorkboardService.create(db, payload, owner_id=current_user.id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    # Provision managed dashboard public links for any kind='dashboard' screens.
    wb = sync_managed_dashboard_links(db, wb, creator=current_user)
    audit(
        db,
        AuditAction.WORKBOARD_CREATED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(wb.id),
        details={"name": wb.name, "dataset_id": wb.dataset_id},
    )
    default_owner = getattr(wb, "_default_app_user", None)
    if isinstance(default_owner, dict):
        username = str(default_owner.get("username") or "").strip()
        pin = str(default_owner.get("pin") or "").strip()
        if username and pin:
            response.headers["X-AppBI-Default-Owner-Username"] = username
            response.headers["X-AppBI-Default-Owner-Pin"] = pin
    wb.user_permission = "full"
    return wb


@router.get("/{workboard_id}", response_model=WorkboardResponse)
def get_workboard(
    workboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    wb.user_permission = require_view_access(db, current_user, wb, "workboards")
    return wb


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
    # Reconcile managed dashboard public links whenever the layout might have
    # changed. The sync function is idempotent so calling on every PATCH is
    # cheap when no dashboard screen exists.
    if updated is not None and payload.model_dump(exclude_unset=True).get("layout_json") is not None:
        updated = sync_managed_dashboard_links(db, updated, creator=current_user)
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
    # Drop managed dashboard links first; once the workboard row is gone the
    # name-prefix lookup can no longer find them.
    delete_managed_dashboard_links(db, workboard_id)
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
    return wb


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
    include_credentials: bool = Query(
        default=False,
        description=(
            "When true, include bcrypt pin_hash for every app user in the "
            "bundle so re-importing produces a fully usable mini-app. "
            "Default false — admins set fresh PINs after import."
        ),
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    bundle = _template_svc.export_workboard(
        db, wb, include_credentials=include_credentials
    )
    return bundle


class _ImportTemplatePayload(__import__("pydantic").BaseModel):
    bundle: dict
    target_dataset_id: int
    target_name: Optional[str] = None
    target_workspace_id: Optional[int] = None
    table_mapping: Optional[Dict[str, Optional[int]]] = None
    column_mapping: Optional[Dict[str, Dict[str, str]]] = None


class _AutoMapRequest(__import__("pydantic").BaseModel):
    """Source schema (from the bundle) + target dataset id. Returns LLM-
    suggested table + column mappings the FE can pre-fill the import
    modal with — admin still confirms each row."""

    bundle: dict
    target_dataset_id: int


def _ensure_can_attach_workspace(user: User) -> None:
    perms = _normalize_permissions(user)
    if LEVEL_ORDER.get(perms.get("settings", "none"), 0) < LEVEL_ORDER["full"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Requires 'full' permission on module 'settings' to update workspace menu_config.",
        )


def _attach_workboard_to_workspace_menu(
    db: Session,
    *,
    workspace: WorkboardWorkspace,
    workboard: Workboard,
) -> Dict[str, Any]:
    slug = (workboard.slug or "").strip()
    if not slug:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Imported workboard has no slug to attach to workspace menu_config.",
        )

    menu: List[Dict[str, Any]] = [
        dict(item)
        for item in (workspace.menu_config or [])
        if isinstance(item, dict)
    ]
    already_linked = any((item.get("workboard_slug") or "") == slug for item in menu)
    if not already_linked:
        menu.append(
            {
                "workboard_slug": slug,
                "label": workboard.name or slug,
                "description": workboard.description,
                "icon": workboard.icon,
                "roles": [],
            }
        )
        workspace.menu_config = menu
        db.commit()
        db.refresh(workspace)

    return {
        "workspace_id": workspace.id,
        "workspace_name": workspace.name,
        "workboard_slug": slug,
        "attached": not already_linked,
    }


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
    target_workspace: WorkboardWorkspace | None = None
    if payload.target_workspace_id is not None:
        _ensure_can_attach_workspace(current_user)
        target_workspace = (
            db.query(WorkboardWorkspace)
            .filter(WorkboardWorkspace.id == payload.target_workspace_id)
            .first()
        )
        if target_workspace is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Target workspace not found.",
            )

    try:
        wb, report = _template_svc.import_workboard(
            db,
            payload.bundle,
            target_dataset_id=payload.target_dataset_id,
            target_name=payload.target_name,
            table_mapping=payload.table_mapping,
            column_mapping=payload.column_mapping,
            owner_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    workspace_attach_report: Dict[str, Any] | None = None
    if target_workspace is not None:
        workspace_attach_report = _attach_workboard_to_workspace_menu(
            db,
            workspace=target_workspace,
            workboard=wb,
        )

    # Snapshot the response BEFORE the audit call: import_workboard already
    # committed the new workboard, but if the subsequent audit insert fails
    # SQLAlchemy poisons the session and any later attribute load on ``wb``
    # would re-raise. Serialise first, then audit — that way audit failures
    # never shadow a successful import.
    response = WorkboardResponse.model_validate(wb).model_dump(mode="json")
    response["_import_report"] = report.to_dict()
    if workspace_attach_report is not None:
        response["_workspace_attach_report"] = workspace_attach_report
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
                "workspace_attach": workspace_attach_report,
            },
        )
    except Exception:
        logger.exception("audit insert failed during import-template (non-fatal)")
        try:
            db.rollback()
        except Exception:
            pass
    return response


# ---------------------------------------------------------------------------
# App-user CRUD (Builder "Users" tab)
# ---------------------------------------------------------------------------


def _app_user_to_response(user: WorkboardAppUser) -> AppUserResponse:
    using_default_pin = bool(user.pin_hash) and is_owner_role(user.role) and is_default_pin_hash(user.pin_hash)
    return AppUserResponse(
        id=user.id,
        workboard_id=user.workboard_id,
        username=user.username,
        full_name=user.full_name,
        role=normalize_app_user_role(user.role),
        active=user.active,
        context=user.context or {},
        has_pin=bool(user.pin_hash),
        using_default_pin=using_default_pin,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


def _check_username_conflicts(
    db: Session,
    workboard_id: int,
    usernames: List[str],
) -> None:
    """Raise 409 with structured detail when a username is already taken in
    a sibling workboard sharing a workspace menu with this one. Lets the FE
    show "đã tồn tại trong Workboard X / Workspace Y" instead of an opaque
    500 from the DB-level uniqueness violation we'd otherwise hit at login."""
    from app.modules.workboards.services import app_user_service

    conflicts = app_user_service.usernames_already_taken_outside(
        db, workboard_id=workboard_id, usernames=usernames
    )
    if conflicts:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "Một số username đã tồn tại trong workboard khác cùng "
                    "workspace — login sẽ ambiguous, vui lòng đổi tên."
                ),
                "conflicts": conflicts,
            },
        )


@router.get(
    "/{workboard_id}/app-users",
    response_model=List[AppUserResponse],
)
def list_app_users(
    workboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    rows = (
        db.query(WorkboardAppUser)
        .filter(WorkboardAppUser.workboard_id == wb.id)
        .order_by(WorkboardAppUser.username.asc())
        .all()
    )
    return [_app_user_to_response(r) for r in rows]


@router.post(
    "/{workboard_id}/app-users",
    response_model=AppUserResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_app_user(
    workboard_id: int,
    payload: AppUserCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.modules.workboards.services import app_user_service

    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")

    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username không được rỗng.")

    existing = (
        db.query(WorkboardAppUser)
        .filter(
            WorkboardAppUser.workboard_id == wb.id,
            WorkboardAppUser.username == username,
        )
        .first()
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"Username '{username}' đã tồn tại trong workboard này.",
        )

    _check_username_conflicts(db, wb.id, [username])

    user = WorkboardAppUser(
        workboard_id=wb.id,
        username=username,
        pin_hash=app_user_service.hash_pin(payload.pin),
        full_name=payload.full_name,
        role=normalize_app_user_role(payload.role),
        active=payload.active,
        context=payload.context or {},
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    # A newly added role may need its own managed dashboard public link.
    sync_managed_dashboard_links(db, wb, creator=current_user)
    return _app_user_to_response(user)


@router.patch(
    "/{workboard_id}/app-users/{app_user_id}",
    response_model=AppUserResponse,
)
def update_app_user(
    workboard_id: int,
    app_user_id: int,
    payload: AppUserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.modules.workboards.services import app_user_service

    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")

    user = (
        db.query(WorkboardAppUser)
        .filter(
            WorkboardAppUser.id == app_user_id,
            WorkboardAppUser.workboard_id == wb.id,
        )
        .first()
    )
    if user is None:
        raise HTTPException(status_code=404, detail="App user not found.")

    data = payload.model_dump(exclude_unset=True)

    new_username = data.get("username")
    if new_username is not None:
        new_username = new_username.strip()
        if not new_username:
            raise HTTPException(status_code=400, detail="Username không được rỗng.")
        if new_username != user.username:
            clash = (
                db.query(WorkboardAppUser)
                .filter(
                    WorkboardAppUser.workboard_id == wb.id,
                    WorkboardAppUser.username == new_username,
                )
                .first()
            )
            if clash is not None:
                raise HTTPException(
                    status_code=409,
                    detail=f"Username '{new_username}' đã tồn tại trong workboard này.",
                )
            _check_username_conflicts(db, wb.id, [new_username])
        user.username = new_username

    if "pin" in data and data["pin"]:
        user.pin_hash = app_user_service.hash_pin(data["pin"])

    for field in ("full_name", "role", "active"):
        if field in data:
            value = data[field]
            if field == "role":
                value = normalize_app_user_role(value)
            setattr(user, field, value)

    if "context" in data and data["context"] is not None:
        user.context = data["context"]

    db.commit()
    db.refresh(user)
    # Role / active may have changed, which affects managed-link fan-out.
    sync_managed_dashboard_links(db, wb, creator=current_user)
    return _app_user_to_response(user)


@router.delete(
    "/{workboard_id}/app-users/{app_user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_app_user(
    workboard_id: int,
    app_user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")

    user = (
        db.query(WorkboardAppUser)
        .filter(
            WorkboardAppUser.id == app_user_id,
            WorkboardAppUser.workboard_id == wb.id,
        )
        .first()
    )
    if user is None:
        raise HTTPException(status_code=404, detail="App user not found.")
    db.delete(user)
    db.commit()
    # The removed app_user may have been the last holder of its role on this
    # workboard; sync drops the corresponding managed links.
    sync_managed_dashboard_links(db, wb, creator=current_user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# AI auto-map for import
# ---------------------------------------------------------------------------


@router.post("/import-auto-map")
def import_auto_map(
    body: _AutoMapRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("workboards", "edit")),
):
    """Suggest table + column mappings from a bundle's source schema to a
    target dataset, using an LLM.

    Returns ``{table_mapping, column_mapping}`` shaped to drop straight
    into the import modal's existing controlled state. Mappings are
    suggestions only — the admin still confirms each one before clicking
    Import. When the LLM is unavailable (no API key, all keys exhausted),
    returns name-based heuristic mappings instead so the UX never
    degrades to "AI unavailable, do it by hand".
    """
    from app.models.dataset import DatasetTable
    from app.services.llm_client import LLMClient
    import json as _json
    import re as _re

    bundle = body.bundle or {}
    tables_meta = bundle.get("tables_meta") or {}
    if not isinstance(tables_meta, dict) or not tables_meta:
        return {"table_mapping": {}, "column_mapping": {}}

    target_tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == body.target_dataset_id)
        .all()
    )
    if not target_tables:
        return {"table_mapping": {}, "column_mapping": {}}

    # Build compact JSON the LLM can reason about. Names are kept verbatim
    # so the model doesn't have to re-derive them; types help when names
    # clash (target ``id`` integer vs. ``id`` text).
    source_payload: List[Dict[str, Any]] = []
    for old_id, meta in tables_meta.items():
        cols = meta.get("columns") or []
        source_payload.append({
            "old_id": str(old_id),
            "source_table_name": meta.get("source_table_name"),
            "display_name": meta.get("display_name"),
            "columns": [
                {"name": c.get("name"), "type": c.get("type")}
                for c in cols
                if isinstance(c, dict) and c.get("name")
            ],
        })

    target_payload: List[Dict[str, Any]] = []
    for t in target_tables:
        cols: List[Dict[str, Any]] = []
        cache = t.columns_cache
        raw = cache if isinstance(cache, list) else (cache or {}).get("columns", [])
        for c in raw or []:
            if isinstance(c, dict) and c.get("name"):
                cols.append({"name": c["name"], "type": c.get("type")})
        target_payload.append({
            "id": t.id,
            "source_table_name": t.source_table_name,
            "display_name": t.display_name,
            "columns": cols,
        })

    # Heuristic baseline — used as fallback and as a sanity floor for LLM
    # output. Same logic the FE uses when "AI" button is not pressed.
    def _norm(s: Any) -> str:
        return _re.sub(r"[^a-z0-9]+", "", str(s or "").strip().lower())

    target_by_norm: Dict[str, int] = {}
    for t in target_payload:
        for cand in (t["source_table_name"], t["display_name"]):
            n = _norm(cand)
            if n and n not in target_by_norm:
                target_by_norm[n] = t["id"]

    heuristic_table_map: Dict[str, Optional[int]] = {}
    heuristic_col_map: Dict[str, Dict[str, str]] = {}
    for s in source_payload:
        s_id = s["old_id"]
        n = _norm(s["source_table_name"]) or _norm(s["display_name"])
        tid = target_by_norm.get(n)
        heuristic_table_map[s_id] = tid
        if tid:
            target = next((t for t in target_payload if t["id"] == tid), None)
            if target:
                cols_by_norm = {_norm(c["name"]): c["name"] for c in target["columns"]}
                heuristic_col_map[s_id] = {
                    sc["name"]: cols_by_norm.get(_norm(sc["name"]), "")
                    for sc in s["columns"]
                    if sc.get("name")
                }

    # Ask the LLM. Cheap + bounded — schemas rarely exceed ~30 tables.
    prompt = _json.dumps(
        {
            "task": (
                "Map each source table+column to the most plausible target "
                "table+column. Prefer exact name match, then normalised "
                "name (lowercase, alphanumeric only), then type-compatible "
                "best-effort. Leave column blank ('') when nothing fits."
            ),
            "source_tables": source_payload,
            "target_tables": [
                {k: v for k, v in t.items() if k != "id"} | {"id": t["id"]}
                for t in target_payload
            ],
            "expected_response_schema": {
                "table_mapping": {"<source_old_id>": "<target_id_or_null>"},
                "column_mapping": {
                    "<source_old_id>": {"<source_col>": "<target_col_or_empty>"}
                },
            },
        },
        ensure_ascii=False,
    )
    llm_out = LLMClient.complete_json(
        prompt=prompt,
        system=(
            "You are a schema mapping assistant. Reply with strictly valid "
            "JSON matching expected_response_schema. No commentary."
        ),
        max_tokens=1500,
    )

    final_table: Dict[str, Optional[int]] = dict(heuristic_table_map)
    final_columns: Dict[str, Dict[str, str]] = {
        k: dict(v) for k, v in heuristic_col_map.items()
    }

    if isinstance(llm_out, dict):
        target_ids = {t["id"] for t in target_payload}
        proposed_table = llm_out.get("table_mapping") or {}
        if isinstance(proposed_table, dict):
            for s_id, t_id in proposed_table.items():
                if t_id in (None, "", "null"):
                    continue
                try:
                    t_id_int = int(t_id)
                except (TypeError, ValueError):
                    continue
                if t_id_int in target_ids:
                    final_table[str(s_id)] = t_id_int

        proposed_col = llm_out.get("column_mapping") or {}
        if isinstance(proposed_col, dict):
            for s_id, mapping in proposed_col.items():
                if not isinstance(mapping, dict):
                    continue
                tid = final_table.get(str(s_id))
                if tid is None:
                    continue
                target = next((t for t in target_payload if t["id"] == tid), None)
                if not target:
                    continue
                valid_cols = {c["name"] for c in target["columns"]}
                clean: Dict[str, str] = {}
                for sc, tc in mapping.items():
                    if not isinstance(sc, str):
                        continue
                    if isinstance(tc, str) and tc in valid_cols:
                        clean[sc] = tc
                    else:
                        # Keep heuristic suggestion if LLM gave nonsense.
                        clean[sc] = final_columns.get(str(s_id), {}).get(sc, "")
                final_columns[str(s_id)] = clean

    return {
        "table_mapping": final_table,
        "column_mapping": final_columns,
        "ai_used": isinstance(llm_out, dict),
    }
