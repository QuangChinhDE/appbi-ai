"""
API router for the Workboard module.

Pattern mirrored from ``app.api.dashboards`` to keep the contract
consistent (list/owned-or-shared, batch effective permissions on listing,
``require_view/edit/full`` per-route, audit on mutation).
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel as PydanticBaseModel, ValidationError
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
from app.modules.workboards.permissions import (
    require_dataset_binding_access,
    assert_workboard_dataset_supported,
    assert_workboard_tables_supported,
)
from app.modules.workboards.roles import is_owner_role, normalize_app_user_role
from app.modules.workboards.schemas import (
    AppUserCreate,
    AppUserResponse,
    AppUserUpdate,
    LayoutJson,
    Screen,
    WorkboardCreate,
    WorkboardPublicLinkCreate,
    WorkboardPublicLinkResponse,
    WorkboardPublicLinkUpdate,
    WorkboardResponse,
    WorkboardUpdate,
)
from app.modules.workboards.services.app_user_service import is_default_pin_hash
from app.services.audit_service import audit
from app.modules.workboards.services.crud_service import WorkboardService
from app.modules.workboards.services import workboard_presence
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
    # Serialize per-row so one workboard with an unexpected stored layout_json
    # can never 500 the whole list. The Screen schema already heals known
    # pre-Phase-13 legacy shapes; this is the last-resort net for anything else
    # — the row still shows up (name/status/permission/buttons) with its layout
    # cleared, so the user can open + re-save (or delete) it to recover.
    out: List[WorkboardResponse] = []
    for item in items:
        try:
            out.append(WorkboardResponse.model_validate(item))
        except ValidationError as exc:
            logger.warning(
                "list_workboards: workboard %s has an un-serializable "
                "layout_json; returning a degraded row. %s",
                item.id,
                exc,
            )
            out.append(_degraded_workboard_response(item))
    return out


def _degraded_workboard_response(item: Workboard) -> WorkboardResponse:
    """Best-effort response for a workboard whose stored ``layout_json`` no
    longer validates against the current schema. Clears the layout so the row
    still serializes and appears in the list; everything else is preserved."""
    return WorkboardResponse(
        id=item.id,
        name=item.name,
        slug=item.slug,
        description=item.description,
        icon=item.icon,
        dataset_id=item.dataset_id,
        primary_table_id=item.primary_table_id,
        primary_key_columns=list(item.primary_key_columns or []),
        lookup_tables=list(item.lookup_tables or []),
        layout_json=LayoutJson(),
        write_mode=item.write_mode,
        optimistic_lock_column=item.optimistic_lock_column,
        is_published=item.is_published,
        version=item.version,
        settings=item.settings,
        owner_id=item.owner_id,
        owner_email=getattr(item, "owner_email", None),
        user_permission=getattr(item, "user_permission", None),
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


@router.post("/", response_model=WorkboardResponse, status_code=status.HTTP_201_CREATED)
def create_workboard(
    payload: WorkboardCreate,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("workboards", "edit")),
):
    require_dataset_binding_access(db, current_user, payload.dataset_id)
    assert_workboard_dataset_supported(db, payload.dataset_id)
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
    # Mask OCR tokens before the layout leaves the server (owner sees only
    # "đã cấu hình", never the raw key). Transient — no commit, not persisted.
    from app.modules.workboards.services.ocr_secrets import mask_layout_ocr_keys
    if isinstance(wb.layout_json, dict):
        wb.layout_json = mask_layout_ocr_keys(wb.layout_json)
    return wb


@router.get("/{workboard_id}/ocr-key")
def reveal_workboard_ocr_key(
    workboard_id: int,
    screen_id: str = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Reveal the DECRYPTED OCR token for one form screen — owner/editor only.

    Backs the "eye" toggle in the builder so the person who configured the
    token can verify it. Gated by edit access; never exposed to the runtime.
    """
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    from app.modules.workboards.services.ocr_secrets import get_screen_ocr_config
    cfg = get_screen_ocr_config(wb.layout_json or {}, screen_id)
    return {"api_key": (cfg or {}).get("api_key") or ""}


@router.post("/{workboard_id}/screens/{screen_id}/ocr-test")
def test_workboard_ocr_connection(
    workboard_id: int,
    screen_id: str,
    body: Dict[str, Any] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Verify an OCR provider/model/token actually connects.

    Backs the builder "Kiểm tra kết nối" button so the configurer knows the
    key works BEFORE relying on it. Uses the key typed in the request; if none
    is sent, falls back to the stored (decrypted) key for this screen. Makes a
    tiny text-only request — never returns model content. Always 200 (the
    result is in ``ok``) unless the caller lacks edit access.
    """
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    body = body or {}
    from app.modules.workboards.services.ocr_secrets import get_screen_ocr_config
    cfg = get_screen_ocr_config(wb.layout_json or {}, screen_id) or {}
    provider = (body.get("provider") or "").strip().lower() or cfg.get("provider") or "anthropic"
    model = (body.get("model") or "").strip() or cfg.get("model")
    typed = (body.get("api_key") or "").strip()
    api_key = typed or (cfg.get("api_key") or "")
    from app.modules.workboards.services import form_ocr_service
    if not api_key:
        return {"ok": False, "message": "Chưa có token để kiểm tra. Hãy dán token rồi thử lại."}
    try:
        result = form_ocr_service.test_connection(provider=provider, api_key=api_key, model=model)
        return {"ok": True, "provider": result["provider"], "model": result["model"]}
    except form_ocr_service.OcrError as exc:
        return {"ok": False, "message": str(exc)}


@router.patch("/{workboard_id}", response_model=WorkboardResponse)
def update_workboard(
    workboard_id: int,
    payload: WorkboardUpdate,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    # Optimistic concurrency: reject a stale DRAFT save so an older autosave (or a
    # concurrent tab/session) can't clobber a newer edit. Only enforced when the
    # client sends the token it last saw.
    if payload.expected_version is not None and int(payload.expected_version) != int(wb.version or 1):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "stale_version",
                "message": "Bản nháp đã bị thay đổi ở nơi khác — tải lại để tiếp tục chỉnh sửa.",
                "expected_version": payload.expected_version,
                "current_version": wb.version,
            },
        )
    patch = payload.model_dump(exclude_unset=True)
    if any(field in patch for field in ("dataset_id", "primary_table_id", "layout_json")):
        require_dataset_binding_access(
            db,
            current_user,
            patch.get("dataset_id") or wb.dataset_id,
        )
        # Sheets-only gate at the binding moment. Changing the dataset must point
        # at a Sheets-backed dataset; any screen table must be a Sheets table.
        if "dataset_id" in patch and patch.get("dataset_id"):
            assert_workboard_dataset_supported(db, patch["dataset_id"])
        if "layout_json" in patch and payload.layout_json is not None:
            assert_workboard_tables_supported(
                db, [s.table_id for s in payload.layout_json.screens]
            )
    try:
        updated = WorkboardService.update(db, workboard_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    # Reconcile managed dashboard public links whenever the layout might have
    # changed. The sync function is idempotent so calling on every PATCH is
    # cheap when no dashboard screen exists.
    if updated is not None and payload.model_dump(exclude_unset=True).get("layout_json") is not None:
        updated = sync_managed_dashboard_links(db, updated, creator=current_user)
    # Surface the rebind-cleanup manifest set by WorkboardService.update so
    # the builder can warn the user about screens that were nullified when
    # the dataset/primary-table binding changed. Header is the least
    # intrusive carrier — keeps WorkboardResponse stable.
    cleared = getattr(updated, "_cleared_screens", None) if updated else None
    if isinstance(cleared, list) and cleared:
        import json as _json
        response.headers["X-AppBI-Cleared-Screens"] = str(len(cleared))
        # Truncate to ~6KB to stay within typical HTTP header limits.
        encoded = _json.dumps(cleared, ensure_ascii=False)
        if len(encoded) <= 6000:
            response.headers["X-AppBI-Cleared-Screens-Detail"] = encoded
    audit(
        db,
        AuditAction.WORKBOARD_UPDATED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(workboard_id),
        details={
            "fields": list(payload.model_dump(exclude_unset=True).keys()),
            "cleared_screen_count": len(cleared) if isinstance(cleared, list) else 0,
        },
    )
    if updated:
        updated.user_permission = "full"
    return updated


@router.patch("/{workboard_id}/screens/{screen_id}", response_model=WorkboardResponse)
def update_workboard_screen(
    workboard_id: int,
    screen_id: str,
    payload: Screen,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Screen-scoped autosave — merge ONE screen into the CURRENT stored layout
    and leave every other screen + all app-level config untouched.

    This is what makes many people editing DIFFERENT screens safe. The
    whole-board ``PATCH /{id}`` replaces the entire ``layout_json`` from the
    client's (possibly stale) copy, so two editors on different screens either
    409 or clobber each other. Here the server merges only the one screen from
    the payload into ITS OWN latest layout, so a save can neither overwrite a
    sibling screen a collaborator just edited nor conflict with it — there is
    deliberately NO board-version guard on this path. Same-screen concurrency is
    handled up front by the soft screen-lock (see workboard_presence). Structural
    edits (add/delete/reorder screens, nav, groups, dataset, branding) still go
    through ``PATCH /{id}`` with the board-version guard."""
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    if payload.id != screen_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Screen id in body must match the URL.",
        )
    current = deepcopy(wb.layout_json or {})
    screens = current.get("screens") or []
    idx = next((i for i, s in enumerate(screens) if s.get("id") == screen_id), None)
    if idx is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"Screen '{screen_id}' not found — use PATCH /{workboard_id} "
                "for new or structural changes."
            ),
        )
    # Sheets-only gate on the (possibly changed) table binding for this screen.
    if payload.table_id is not None:
        require_dataset_binding_access(db, current_user, wb.dataset_id)
        assert_workboard_tables_supported(db, [payload.table_id])
    screens[idx] = payload.model_dump()
    current["screens"] = screens
    try:
        updated = WorkboardService.update(
            db, workboard_id, WorkboardUpdate(layout_json=current)
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    # Keep managed dashboard links reconciled (idempotent; cheap when no
    # dashboard screen exists).
    if updated is not None:
        updated = sync_managed_dashboard_links(db, updated, creator=current_user)
    audit(
        db,
        AuditAction.WORKBOARD_UPDATED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(workboard_id),
        details={"screen_scoped": True, "screen_id": screen_id},
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


# ============ Editor presence + soft screen-lock (co-edit safety) ============
# Adapted from the dashboard co-edit model, but the concurrency UNIT is a
# SCREEN (not a tile) and it adds a soft edit-lock so two people can't sit on
# the same screen at once. See services/workboard_presence for the rationale.

class _WorkboardHeartbeatRequest(PydanticBaseModel):
    """``editing_screen_id`` = the screen the caller currently has open in the
    builder (their cursor). None while on the canvas / app-settings."""
    editing_screen_id: Optional[str] = None


class _WorkboardTakeoverRequest(PydanticBaseModel):
    screen_id: str


@router.post("/{workboard_id}/editing/heartbeat", status_code=status.HTTP_200_OK)
def workboard_editing_heartbeat(
    workboard_id: int,
    request: Request,
    payload: Optional[_WorkboardHeartbeatRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Register the caller as editing this workboard (on ``editing_screen_id``)
    and return the OTHER active editors, the caller's soft-lock state for the
    screen they're on, and the holder map for all locked screens. Best-effort,
    in-memory, TTL-expired (see services/workboard_presence)."""
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    return workboard_presence.heartbeat(
        workboard_id,
        str(current_user.id),
        getattr(current_user, "full_name", None) or current_user.email,
        current_user.email,
        editing_screen_id=payload.editing_screen_id if payload else None,
    )


@router.post("/{workboard_id}/editing/leave", status_code=status.HTTP_200_OK)
def workboard_editing_leave(
    workboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Best-effort removal when an editor closes the builder + releases any
    locks they held so a collaborator can claim immediately. TTL would expire
    them anyway; this just makes the handoff instant."""
    workboard_presence.leave(workboard_id, str(current_user.id))
    return {"ok": True}


@router.post("/{workboard_id}/editing/takeover", status_code=status.HTTP_200_OK)
def workboard_editing_takeover(
    workboard_id: int,
    payload: _WorkboardTakeoverRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Force-claim the soft-lock on a screen ("Chiếm quyền chỉnh sửa"). Requires
    edit access. The previous holder drops to view-only on its next heartbeat."""
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    lock = workboard_presence.takeover(
        workboard_id,
        str(current_user.id),
        getattr(current_user, "full_name", None) or current_user.email,
        current_user.email,
        payload.screen_id,
    )
    return {"lock": lock}


def _assert_owner_pin_rotated(db: Session, workboard_id: int) -> None:
    """Block publish / public-link creation while any owner still uses the
    factory-default PIN. Owners bypass all RLS, so a default PIN on a publicly
    reachable workboard is an open door."""
    owners = (
        db.query(WorkboardAppUser)
        .filter(WorkboardAppUser.workboard_id == workboard_id)
        .all()
    )
    offenders = [
        u.username
        for u in owners
        if is_owner_role(u.role) and u.pin_hash and is_default_pin_hash(u.pin_hash)
    ]
    if offenders:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Đổi PIN mặc định cho tài khoản owner ("
                f"{', '.join(offenders)}) trước khi publish hoặc chia sẻ workboard."
            ),
        )


def _promote_workboard_to_published(
    db: Session, wb: Workboard, *, creator: Optional[User] = None
) -> Workboard:
    """The ONE routine every "make this board Live" path funnels through.

    Applies the complete draft → published promotion atomically: slug backfill
    (the public Cổng menu is keyed by ``workboard_slug``) + schema-default
    refresh + MANDATORY readiness gate + managed-dashboard-link sync/promote +
    a snapshot of the WHOLE deployment boundary (layout + non-layout
    runtime-config + version/at) + ``is_published``. Every publish trigger — the
    Publish button, public-link creation, an MCP/script call — MUST go through
    here so none of them can leave a board half-published (``is_published=True``
    with no snapshot/slug → an empty or Cổng-unreachable Live app).

    Raises 422 if the readiness audit has blocking errors; on any failure the
    caller's transaction rolls back and the previous Live deployment stays fully
    intact. Does NOT write the WORKBOARD_PUBLISHED audit-log row — that is the
    endpoint's job (it owns the ``Request``)."""
    # A workboard needs a slug to be shareable (the public Cổng menu is keyed by
    # workboard_slug). New boards get one at create; backfill any legacy/blank
    # board here so going Live never produces an unshareable app.
    if not (wb.slug or "").strip():
        wb.slug = WorkboardService.build_unique_slug(db, wb.name, exclude_id=wb.id)
    wb = WorkboardService.refresh_schema_defaults(db, wb)

    # Readiness gate — MANDATORY, server-side. A workboard with blocking errors
    # (missing table/column/dashboard, broken references) must never go live.
    # Enforced here (not just in the builder UI) so every publish path — button,
    # public-link, MCP/script — is gated identically. Warnings do not block.
    audit_result = compute_workboard_audit(db, wb)
    if not audit_result["ok"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "message": (
                    "Không thể xuất bản: ứng dụng còn lỗi chặn "
                    "(thiếu bảng/cột/dashboard hoặc tham chiếu hỏng). "
                    "Sửa hết lỗi rồi xuất bản lại."
                ),
                "audit": audit_result,
            },
        )

    # Atomic draft → published promotion of the WHOLE deployment boundary in a
    # single commit — layout snapshot + non-layout runtime-config snapshot +
    # version/at. The public/live runtime serves ONLY these, so end users keep
    # seeing the PREVIOUS live deployment until this runs; a failure before the
    # commit rolls back and leaves the previous Live fully intact.
    import copy as _copy
    from datetime import datetime, timezone

    from app.modules.workboards.services.runtime_config import (
        build_published_runtime_config,
    )
    from app.modules.workboards.services.dashboard_link_service import (
        sync_workboard_dashboard_links,
        promote_dashboard_links_to_published,
        rewrite_managed_links_to_published,
    )

    # Refresh the DRAFT managed dashboard links (no commit — part of this atomic
    # publish), then PROMOTE them to published-stage rows the Live runtime uses.
    sync_workboard_dashboard_links(db, wb, creator=creator, commit=False)
    published_tokens = promote_dashboard_links_to_published(db, wb)

    # Snapshot the layout, then rewrite its managed_links to the PUBLISHED tokens
    # so Live (which reads published_layout_json) resolves the published-stage
    # links, never the draft ones.
    published_layout = _copy.deepcopy(wb.layout_json or {})
    rewrite_managed_links_to_published(published_layout, wb.id, published_tokens)

    wb.published_layout_json = published_layout
    wb.published_runtime_config = build_published_runtime_config(wb)
    wb.published_version = wb.version
    wb.published_at = datetime.now(timezone.utc)
    wb.is_published = True
    db.commit()
    db.refresh(wb)
    return wb


@router.post("/{workboard_id}/publish", response_model=WorkboardResponse)
def publish_workboard(
    workboard_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    require_dataset_binding_access(db, current_user, wb.dataset_id)
    _assert_owner_pin_rotated(db, wb.id)
    wb = _promote_workboard_to_published(db, wb, creator=current_user)
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


@router.post("/{workboard_id}/unpublish", response_model=WorkboardResponse)
def unpublish_workboard(
    workboard_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Take a Workboard down from Live. Dedicated endpoint (not a generic PATCH)
    so lifecycle transitions stay exclusive. Flips ``is_published`` off — the
    public runtime resolver then 404s the app — but keeps the published snapshot
    intact so a later Publish can promote the (possibly edited) draft again."""
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    wb.is_published = False
    db.commit()
    db.refresh(wb)
    audit(
        db,
        AuditAction.WORKBOARD_UNPUBLISHED,
        request=request,
        user_id=current_user.id,
        resource_type="workboard",
        resource_id=str(workboard_id),
    )
    wb.user_permission = "full"
    return wb


class _RebindPreviewBody(__import__("pydantic").BaseModel):
    dataset_id: int


@router.post("/{workboard_id}/rebind/preview")
def preview_workboard_rebind(
    workboard_id: int,
    body: _RebindPreviewBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Two-phase dataset rebind — phase 1 (ANALYZE, dry-run). Reports which screen
    table refs would AUTO-REMAP to a same-named table in the target dataset vs be
    CLEARED, WITHOUT mutating anything, so the builder can show the impact before
    the user confirms. The apply (PATCH dataset_id) mutates only the DRAFT; Live
    keeps its published binding until the next Publish."""
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    require_dataset_binding_access(db, current_user, body.dataset_id)
    assert_workboard_dataset_supported(db, body.dataset_id)
    from app.modules.workboards.services.crud_service import build_rebind_plan

    _, manifest = build_rebind_plan(db, wb.layout_json or {}, body.dataset_id)
    remapped = [m for m in manifest if m.get("reason") == "remapped"]
    cleared = [m for m in manifest if m.get("reason") != "remapped"]
    return {
        "workboard_id": wb.id,
        "target_dataset_id": body.dataset_id,
        "remap_count": len(remapped),
        "clear_count": len(cleared),
        "remapped": remapped,
        "cleared": cleared,
    }


@router.get("/{workboard_id}/audit")
def audit_workboard(
    workboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Inventory broken references inside a workboard's layout.

    Cross-checks every screen against the live dataset state. Catches the
    common rot path where a column / table / dashboard the workboard
    points at was removed in the dataset editor but the workboard layout
    still references it.

    Read-only — does NOT mutate the layout. Combine with the workboard
    builder's "Fix" buttons to actually clean each issue up.

    Returns::

        {
          "workboard_id": int,
          "screen_count": int,
          "issue_count": int,
          "ok": bool,
          "issues": [
            {
              "severity": "error" | "warning",
              "screen_id": str | None,
              "screen_kind": str | None,
              "screen_title": str | None,
              "code": str,         # e.g. "missing_table", "missing_column"
              "detail": str,
              "context": {...}
            }
          ]
        }
    """
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    require_dataset_binding_access(db, current_user, wb.dataset_id)
    return compute_workboard_audit(db, wb)


def compute_workboard_audit(db: Session, wb: Workboard) -> dict[str, Any]:
    """Inventory broken references inside a workboard's DRAFT layout.

    Extracted from the GET /audit endpoint so the publish readiness-gate shares
    one code path (single source of truth). Read-only — never mutates layout.
    Audits the DRAFT (``layout_json``) because that is what a subsequent Publish
    would promote to live.
    """
    from app.models.dataset import DatasetTable
    from app.models.models import Dashboard
    from app.modules.workboards.services.crud_service import (
        _collect_table_column_names,
    )

    issues: list[dict[str, Any]] = []

    # Build dataset table index once.
    dataset_tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == wb.dataset_id)
        .all()
    )
    tables_by_id = {int(t.id): t for t in dataset_tables}
    columns_by_table_id: dict[int, set[str]] = {
        int(t.id): set(_collect_table_column_names(t)) for t in dataset_tables
    }

    def _column_set(table_id: int | None) -> set[str]:
        if table_id is None:
            return set()
        return columns_by_table_id.get(int(table_id), set())

    def _add(
        *,
        severity: str,
        code: str,
        detail: str,
        screen: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
    ) -> None:
        issues.append({
            "severity": severity,
            "screen_id": (screen or {}).get("id"),
            "screen_kind": (screen or {}).get("kind"),
            "screen_title": (screen or {}).get("title"),
            "code": code,
            "detail": detail,
            "context": context or {},
        })

    # ── Workboard-level checks ────────────────────────────────────────────
    if wb.primary_table_id and int(wb.primary_table_id) not in tables_by_id:
        _add(
            severity="error",
            code="missing_primary_table",
            detail=(
                f"Primary table {wb.primary_table_id} no longer exists in "
                f"dataset {wb.dataset_id}."
            ),
            context={"primary_table_id": wb.primary_table_id},
        )

    # ── Screen-level checks ───────────────────────────────────────────────
    layout = wb.layout_json or {}
    screens = layout.get("screens") if isinstance(layout, dict) else None
    screens_iter: list[dict[str, Any]] = (
        [s for s in screens if isinstance(s, dict)] if isinstance(screens, list) else []
    )

    # Distinct dashboard ids referenced — fetched once.
    referenced_dashboard_ids: set[int] = set()
    for screen in screens_iter:
        if screen.get("kind") == "dashboard":
            dash_spec = screen.get("dashboard") or {}
            dash_id = dash_spec.get("dashboard_id") if isinstance(dash_spec, dict) else None
            if isinstance(dash_id, int):
                referenced_dashboard_ids.add(int(dash_id))
    existing_dashboard_ids: set[int] = set()
    if referenced_dashboard_ids:
        existing_dashboard_ids = {
            int(row[0])
            for row in db.query(Dashboard.id)
            .filter(Dashboard.id.in_(referenced_dashboard_ids))
            .all()
        }

    for screen in screens_iter:
        kind = str(screen.get("kind") or "").strip()
        table_id = screen.get("table_id")
        # 1. table_id existence (skipped for dashboard kind — it doesn't use one).
        if kind != "dashboard":
            if table_id is None:
                _add(
                    severity="error",
                    code="missing_table_binding",
                    detail="Screen has no table_id — it cannot render or write.",
                    screen=screen,
                )
                continue
            if int(table_id) not in tables_by_id:
                _add(
                    severity="error",
                    code="missing_table",
                    detail=(
                        f"Screen references dataset_table {table_id} which is "
                        "no longer in this dataset."
                    ),
                    screen=screen,
                    context={"table_id": table_id},
                )
                continue

        cols = _column_set(table_id) if kind != "dashboard" else set()

        # 2. App-user row access must be explicit for every data screen.
        if kind != "dashboard":
            raw_rls_rules = screen.get("rls")
            rls_rules = raw_rls_rules if isinstance(raw_rls_rules, list) else []
            rls_default = screen.get("rls_default")
            if not rls_rules and not isinstance(rls_default, dict):
                _add(
                    severity="warning",
                    code="missing_app_user_rls",
                    detail=(
                        "Screen has no app-user row access rule or default. "
                        "Standard app users are denied until RLS is configured."
                    ),
                    screen=screen,
                )

            rls_to_check = [
                (f"role '{rule.get('role') or ''}'", rule)
                for rule in rls_rules
                if isinstance(rule, dict)
            ]
            if isinstance(rls_default, dict):
                rls_to_check.append(("default", rls_default))
            for rule_label, rule in rls_to_check:
                if rule.get("unrestricted"):
                    continue
                filter_column = str(rule.get("filter_column") or "").strip()
                if filter_column and filter_column not in cols:
                    _add(
                        severity="error",
                        code="missing_rls_filter_column",
                        detail=(
                            f"RLS {rule_label} filters on missing column "
                            f"'{filter_column}'."
                        ),
                        screen=screen,
                        context={"column": filter_column, "rule": rule_label},
                    )

        # 3. Per-kind column references
        if kind == "form":
            form_spec = screen.get("form") or {}
            for index, field in enumerate(form_spec.get("fields") or []):
                if not isinstance(field, dict):
                    continue
                col = field.get("column")
                if col and col not in cols:
                    _add(
                        severity="error",
                        code="missing_column",
                        detail=f"Form field '{field.get('label') or col}' references missing column '{col}'.",
                        screen=screen,
                        context={"column": col, "field_index": index},
                    )
        elif kind == "table":
            table_spec = screen.get("table") or {}
            computed_names = {
                str(c.get("name") or "").strip()
                for c in (table_spec.get("computed_columns") or [])
                if isinstance(c, dict) and c.get("name")
            }
            lookup_names = {
                str(c.get("name") or "").strip()
                for c in (table_spec.get("lookup_columns") or [])
                if isinstance(c, dict) and c.get("name")
            }
            rollup_names = {
                str(c.get("name") or "").strip()
                for c in (table_spec.get("rollup_columns") or [])
                if isinstance(c, dict) and c.get("name")
            }
            valid_table_cols = cols | computed_names | lookup_names | rollup_names
            for col in table_spec.get("columns") or []:
                if col and col not in valid_table_cols:
                    _add(
                        severity="error",
                        code="missing_column",
                        detail=f"Table surfaces missing column '{col}'.",
                        screen=screen,
                        context={"column": col},
                    )
            for col in table_spec.get("editable_columns") or []:
                if col and col not in cols:
                    _add(
                        severity="error",
                        code="non_editable_column",
                        detail=(
                            f"Table marks '{col}' as editable but it is not a "
                            "physical column of the bound table."
                        ),
                        screen=screen,
                        context={"column": col},
                    )
            sort_col = table_spec.get("default_sort_column")
            if sort_col and sort_col not in valid_table_cols:
                _add(
                    severity="warning",
                    code="missing_sort_column",
                    detail=f"Default sort column '{sort_col}' is missing.",
                    screen=screen,
                    context={"column": sort_col},
                )
            for index, lookup in enumerate(table_spec.get("lookup_columns") or []):
                if not isinstance(lookup, dict):
                    continue
                from_id = lookup.get("from_table_id")
                if from_id and int(from_id) not in tables_by_id:
                    _add(
                        severity="error",
                        code="missing_lookup_table",
                        detail=(
                            f"Lookup column '{lookup.get('name')}' joins table "
                            f"{from_id} which is no longer in this dataset."
                        ),
                        screen=screen,
                        context={"lookup_index": index, "from_table_id": from_id},
                    )
        elif kind == "doc":
            doc_spec = screen.get("doc") or {}
            for block_index, block in enumerate(doc_spec.get("blocks") or []):
                if not isinstance(block, dict) or block.get("type") != "data_table":
                    continue
                source = block.get("source") or "primary"
                effective_table_id: int | None = None
                if source == "primary":
                    effective_table_id = int(table_id) if table_id else None
                elif isinstance(source, str) and source.startswith("lookup:"):
                    try:
                        effective_table_id = int(source.split(":", 1)[1])
                    except (ValueError, IndexError):
                        effective_table_id = None
                    if effective_table_id and effective_table_id not in tables_by_id:
                        _add(
                            severity="error",
                            code="missing_doc_lookup_table",
                            detail=(
                                f"Doc data_table block #{block_index} sources "
                                f"missing table {effective_table_id}."
                            ),
                            screen=screen,
                            context={"block_index": block_index, "source": source},
                        )
                        continue
                block_cols = _column_set(effective_table_id)
                if effective_table_id and int(effective_table_id) != int(table_id):
                    for rule_label, rule in rls_to_check:
                        if rule.get("unrestricted"):
                            continue
                        filter_column = str(rule.get("filter_column") or "").strip()
                        if filter_column and filter_column not in block_cols:
                            _add(
                                severity="error",
                                code="missing_doc_rls_filter_column",
                                detail=(
                                    f"Doc data_table block #{block_index} sources "
                                    f"table {effective_table_id}, but RLS {rule_label} "
                                    f"filters on missing column '{filter_column}'."
                                ),
                                screen=screen,
                                context={
                                    "block_index": block_index,
                                    "source": source,
                                    "column": filter_column,
                                    "rule": rule_label,
                                },
                            )
                for col in block.get("columns") or []:
                    if col and col not in block_cols:
                        _add(
                            severity="error",
                            code="missing_column",
                            detail=(
                                f"Doc data_table block #{block_index} requests "
                                f"missing column '{col}'."
                            ),
                            screen=screen,
                            context={"block_index": block_index, "column": col},
                        )
        elif kind == "dashboard":
            dash_spec = screen.get("dashboard") or {}
            dash_id = dash_spec.get("dashboard_id") if isinstance(dash_spec, dict) else None
            share_token = dash_spec.get("share_token") if isinstance(dash_spec, dict) else None
            if dash_id is None and not share_token:
                _add(
                    severity="error",
                    code="dashboard_unbound",
                    detail="Dashboard screen has neither dashboard_id nor share_token.",
                    screen=screen,
                )
            elif isinstance(dash_id, int) and int(dash_id) not in existing_dashboard_ids:
                _add(
                    severity="error",
                    code="missing_dashboard",
                    detail=(
                        f"Dashboard {dash_id} referenced by this screen has been "
                        "deleted; the embedded iframe will 404."
                    ),
                    screen=screen,
                    context={"dashboard_id": dash_id},
                )

    # ── Cross-screen reference integrity ─────────────────────────────────────
    # Every screen-id reference (navigation, row/scan actions, bulk recipes,
    # workspace membership) must resolve to a screen that still exists. This is
    # what makes /audit the single source of truth for App Health + the Publish
    # gate. Severity by runtime blast radius: refs that HARD-404 at runtime
    # (bulk source/parent/step screens) are errors (block publish); refs that
    # silently drop (dead button / lost nav entry) are warnings.
    live_screen_ids = {str(s.get("id")) for s in screens_iter if s.get("id")}

    def _check_ref(target, *, code, label, severity="error", screen=None, context=None):
        if target is None:
            return
        tid = str(target).strip()
        if not tid or tid in live_screen_ids:
            return
        _add(
            severity=severity,
            code=code,
            detail=f"{label} points at screen '{tid}', which no longer exists.",
            screen=screen,
            context={**(context or {}), "target_screen_id": tid},
        )

    for screen in screens_iter:
        table = screen.get("table") if isinstance(screen.get("table"), dict) else {}
        form = screen.get("form") if isinstance(screen.get("form"), dict) else {}

        after = form.get("after_submit") if isinstance(form.get("after_submit"), dict) else {}
        _check_ref(after.get("go_to_screen"), code="dangling_after_submit_screen",
                   label="Form after-submit navigation", severity="warning", screen=screen)
        for fld in (form.get("fields") or []):
            if isinstance(fld, dict):
                _check_ref(fld.get("scan_go_to_screen"), code="dangling_scan_go_to_screen",
                           label=f"Barcode scan target on field '{fld.get('column')}'",
                           severity="warning", screen=screen)

        for ra in (table.get("row_actions") or []):
            if isinstance(ra, dict):
                _check_ref(ra.get("go_to_screen"), code="dangling_go_to_screen",
                           label=f"Row action '{ra.get('label') or ra.get('id')}'",
                           severity="warning", screen=screen)
        pos = table.get("pos_cart") if isinstance(table.get("pos_cart"), dict) else {}
        _check_ref(pos.get("header_screen_id"), code="dangling_pos_header_screen",
                   label="POS cart header screen", severity="warning", screen=screen)
        _check_ref(pos.get("after_submit_screen"), code="dangling_pos_after_submit_screen",
                   label="POS cart after-submit screen", severity="warning", screen=screen)
        for ba in (table.get("bulk_actions") or []):
            if not isinstance(ba, dict):
                continue
            balabel = ba.get("label") or ba.get("id")
            _check_ref(ba.get("parent_screen_id"), code="dangling_bulk_parent_screen",
                       label=f"Bulk action '{balabel}' parent screen", screen=screen)
            for ri in (ba.get("resource_inputs") or []):
                if isinstance(ri, dict):
                    _check_ref(ri.get("source_screen_id"), code="dangling_bulk_resource_screen",
                               label=f"Bulk action '{balabel}' resource '{ri.get('id')}'", screen=screen)
            for st in (ba.get("steps") or []):
                if isinstance(st, dict):
                    _check_ref(st.get("screen_id"), code="dangling_bulk_step_screen",
                               label=f"Bulk action '{balabel}' step '{st.get('id')}'", screen=screen)

    nav = layout.get("mini_app_nav") if isinstance(layout.get("mini_app_nav"), dict) else {}
    for sid in (nav.get("items") or []):
        _check_ref(sid, code="dangling_nav_item", label="Navigation item", severity="warning")
    for grp in (layout.get("screen_groups") or []):
        if isinstance(grp, dict):
            glabel = grp.get("label") or grp.get("id")
            for sid in (grp.get("screen_ids") or []):
                _check_ref(sid, code="dangling_workspace_member",
                           label=f"Workspace '{glabel}' member", severity="warning",
                           context={"group_id": grp.get("id")})

    return {
        "workboard_id": int(wb.id),
        "screen_count": len(screens_iter),
        "issue_count": len(issues),
        "ok": not any(issue["severity"] == "error" for issue in issues),
        "issues": issues,
    }


@router.get("/{workboard_id}/access-audit")
def access_audit_workboard(
    workboard_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Per-table access-mode audit (Phase-16).

    Classifies every DatasetTable that backs a screen into one of:
    per_user, joined_through, shared, unknown — see access_mode_service
    for definitions. The App-users tab consumes this to render precise
    banners instead of a single "needs miniapp_user" message.
    """
    from app.modules.workboards.services.access_mode_service import (
        audit_workboard_access,
    )

    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    require_dataset_binding_access(db, current_user, wb.dataset_id)

    return audit_workboard_access(db, workboard=wb)


@router.put("/{workboard_id}/tables/{table_id}/miniapp-share")
def set_table_miniapp_share(
    workboard_id: int,
    table_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Toggle the `miniapp_share` flag on a DatasetTable.

    Builder uses this from the access-audit banner to mark a table as
    "shared / public reference data" so the audit stops warning about
    it. Edit-rights on the workboard's dataset are required.
    """
    from app.models.dataset import DatasetTable as _DatasetTable

    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    require_dataset_binding_access(db, current_user, wb.dataset_id)

    table = (
        db.query(_DatasetTable)
        .filter(_DatasetTable.id == table_id, _DatasetTable.dataset_id == wb.dataset_id)
        .first()
    )
    if table is None:
        raise HTTPException(status_code=404, detail="Table not found in dataset")
    table.miniapp_share = bool(payload.get("shared"))
    db.commit()
    db.refresh(table)
    return {"table_id": table.id, "miniapp_share": table.miniapp_share}


@router.post("/{workboard_id}/screens/{screen_id}/test-js")
def test_js_computed_column(
    workboard_id: int,
    screen_id: str,
    body: Dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Sandboxed live preview for ``TableComputedColumn(engine='js')``.

    Builder editors call this on each keystroke (debounced) so the user
    sees what their JS will evaluate to BEFORE saving the layout. Returns
    one result per row provided in the body.

    Request::

        {
          "code": "return row.qty * row.price",
          "rows": [{"qty": 2, "price": 3}, {"qty": 5, "price": 4}],
          "index_offset": 0   // optional — start ``index`` arg from here
        }

    Response::

        {
          "ok": bool,
          "compile_error": null | "Syntax error: ...",
          "results": [
            {"ok": true,  "value": 6,  "error": null},
            {"ok": false, "value": null, "error": "TypeError: ..."}
          ]
        }

    Only requires ``workboards.view`` permission since this is read-only
    AND the sandbox can't reach the DB / network.
    """
    from app.modules.workboards.services.js_evaluator import (
        JsCompileError,
        JsEvalError,
        compile_js_column,
        evaluate_js_cell,
    )

    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")

    code = str(body.get("code") or "").strip()
    if not code:
        return {
            "ok": False,
            "compile_error": "Empty code.",
            "results": [],
        }
    raw_rows = body.get("rows") or []
    if not isinstance(raw_rows, list):
        raise HTTPException(status_code=400, detail="`rows` must be a list of objects.")
    rows: List[Dict[str, Any]] = [r for r in raw_rows if isinstance(r, dict)]
    index_offset = int(body.get("index_offset") or 0)

    try:
        compiled = compile_js_column("test", code)
    except JsCompileError as exc:
        return {
            "ok": False,
            "compile_error": str(exc),
            "results": [],
        }

    out: list[Dict[str, Any]] = []
    for idx, row in enumerate(rows):
        try:
            value = evaluate_js_cell(compiled, row, rows, index_offset + idx)
            out.append({"ok": True, "value": value, "error": None})
        except JsEvalError as exc:
            out.append({"ok": False, "value": None, "error": str(exc)})
    return {
        "ok": all(r["ok"] for r in out),
        "compile_error": None,
        "results": out,
    }


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
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    require_dataset_binding_access(db, current_user, wb.dataset_id)
    _assert_owner_pin_rotated(db, wb.id)
    if not wb.is_published:
        # Creating a public link makes the board Live — funnel through the SAME
        # atomic publish routine as the Publish button so it gets a slug, passes
        # the readiness gate, and snapshots the deployment boundary. Previously
        # this only flipped is_published=True, leaving the board with no
        # snapshot/slug → an empty or Cổng-unreachable Live app.
        wb = _promote_workboard_to_published(db, wb, creator=current_user)
        audit(
            db,
            AuditAction.WORKBOARD_PUBLISHED,
            request=request,
            user_id=current_user.id,
            resource_type="workboard",
            resource_id=str(wb.id),
        )
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
    require_dataset_binding_access(db, current_user, wb.dataset_id)
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
    download: bool = Query(
        default=False,
        description=(
            "When true, return the bundle as a file download "
            "(Content-Disposition: attachment) instead of a JSON API body. "
            "Lets the browser save it reliably as <slug>-workboard.json without "
            "relying on a client-side Blob + a.download (which some browsers "
            "saved as a bare UUID with no extension)."
        ),
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    require_dataset_binding_access(db, current_user, wb.dataset_id)
    bundle = _template_svc.export_workboard(
        db, wb, include_credentials=include_credentials
    )
    if download:
        import json as _json
        from urllib.parse import quote as _quote
        from fastapi import Response

        slug = (wb.slug or f"workboard-{wb.id}").strip()
        filename = f"{slug}-workboard.json"
        # ASCII fallback for the legacy ``filename=`` param + RFC 5987
        # ``filename*`` for the real (possibly non-ASCII) name.
        ascii_name = filename.encode("ascii", "ignore").decode() or "workboard.json"
        body = _json.dumps(bundle, ensure_ascii=False, indent=2)
        return Response(
            content=body,
            media_type="application/json",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{ascii_name}"; '
                    f"filename*=UTF-8''{_quote(filename)}"
                ),
            },
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
        # Generate one on demand instead of failing the share: the Cổng menu is
        # keyed by workboard_slug, and a blank slug (legacy board, or any path
        # that skipped create-time generation) must never make an app
        # unshareable. Persist it so the link stays stable.
        slug = WorkboardService.build_unique_slug(db, workboard.name, exclude_id=workboard.id)
        workboard.slug = slug
        db.add(workboard)
        db.flush()

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
    require_dataset_binding_access(db, current_user, payload.target_dataset_id)
    assert_workboard_dataset_supported(db, payload.target_dataset_id)
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


# ── v2 import: pick a Source → auto-create Dataset → import ────────────────


class _InspectSourcePayload(__import__("pydantic").BaseModel):
    """Dry-run: a v2 bundle + a chosen target Source per bundle datasource
    ``ref`` (``{ref: datasource_id}``). Returns the per-table match report so
    the FE can preview + let the user manually map mismatched tables."""

    bundle: dict
    datasource_map: Dict[str, int] = {}


class _ImportFromSourcePayload(__import__("pydantic").BaseModel):
    bundle: dict
    # bundle datasource ``ref`` -> target datasource id (for auto-create).
    datasource_map: Dict[str, int] = {}
    # Skip auto-create + import straight onto an existing dataset (legacy path).
    reuse_dataset_id: Optional[int] = None
    target_name: Optional[str] = None
    target_workspace_id: Optional[int] = None
    table_mapping: Optional[Dict[str, Optional[int]]] = None
    column_mapping: Optional[Dict[str, Dict[str, str]]] = None
    # old bundle table id (str) -> source_table_name to use on the target source
    # (manual override for a renamed table). Optional.
    table_source_overrides: Optional[Dict[str, str]] = None


def _validate_datasources_exist(db: Session, datasource_map: Dict[str, int]) -> None:
    from app.models.models import DataSource

    for ref, ds_id in (datasource_map or {}).items():
        if not db.query(DataSource).filter(DataSource.id == ds_id).first():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Source được chọn (id={ds_id}) cho '{ref}' không tồn tại.",
            )


@router.post("/import/inspect-source")
def import_inspect_source(
    payload: _InspectSourcePayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("workboards", "edit")),
):
    """Dry-run table-match preview for the v2 'pick a Source' import. Creates
    nothing — just reports which bundle tables exist on the chosen Source(s)."""
    _validate_datasources_exist(db, payload.datasource_map)
    try:
        return _template_svc.inspect_source_match(db, payload.bundle, payload.datasource_map or {})
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.post("/import/from-source")
def import_from_source_endpoint(
    payload: _ImportFromSourcePayload,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("workboards", "edit")),
):
    """v2 import: auto-create a Dataset on the chosen Source(s) from the bundle
    (or reuse an existing dataset), then import the workboard + app users onto
    it. Response carries ``_import_report`` (incl. ``dataset_rebuild``)."""
    target_workspace: WorkboardWorkspace | None = None

    if payload.reuse_dataset_id is not None:
        require_dataset_binding_access(db, current_user, payload.reuse_dataset_id)
        assert_workboard_dataset_supported(db, payload.reuse_dataset_id)
    else:
        if not payload.datasource_map:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cần chọn ít nhất một Source để tự tạo dataset (datasource_map rỗng).",
            )
        _validate_datasources_exist(db, payload.datasource_map)

    if payload.target_workspace_id is not None:
        _ensure_can_attach_workspace(current_user)
        target_workspace = (
            db.query(WorkboardWorkspace)
            .filter(WorkboardWorkspace.id == payload.target_workspace_id)
            .first()
        )
        if target_workspace is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Target workspace not found."
            )

    overrides = None
    if payload.table_source_overrides:
        overrides = {}
        for k, v in payload.table_source_overrides.items():
            try:
                overrides[int(k)] = str(v)
            except (TypeError, ValueError):
                continue

    try:
        wb, report = _template_svc.import_from_source(
            db,
            payload.bundle,
            datasource_map=payload.datasource_map or {},
            owner_id=current_user.id,
            target_name=payload.target_name,
            reuse_dataset_id=payload.reuse_dataset_id,
            table_mapping=payload.table_mapping,
            column_mapping=payload.column_mapping,
            table_source_overrides=overrides,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    workspace_attach_report: Dict[str, Any] | None = None
    if target_workspace is not None:
        workspace_attach_report = _attach_workboard_to_workspace_menu(
            db, workspace=target_workspace, workboard=wb
        )

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
                "import_kind": "from_source",
                "reused_dataset": payload.reuse_dataset_id,
                "matched_tables": len(report.matched_tables),
                "missing_tables": len(report.missing_tables),
            },
        )
    except Exception:
        logger.exception("audit insert failed during import-from-source (non-fatal)")
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
    require_dataset_binding_access(db, current_user, wb.dataset_id)

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
    require_dataset_binding_access(db, current_user, wb.dataset_id)

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
    require_dataset_binding_access(db, current_user, wb.dataset_id)

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
    current_user: User = Depends(require_permission("workboards", "edit")),
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

    require_dataset_binding_access(db, current_user, body.target_dataset_id)
    assert_workboard_dataset_supported(db, body.target_dataset_id)
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
