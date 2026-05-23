"""Authenticated admin endpoints for managing workspaces.

Lives behind ``workboards`` permission because workspace delivery is part of
the Workboard mini-app flow. A Workboards-scoped PAT should be able to
create/link/preview workspaces without also requiring Settings admin rights.
The public-facing flows (login, menu, screen rendering) live in
``app.api.public``.
"""
from __future__ import annotations

import secrets
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import (
    require_edit_access,
    require_permission,
)
from app.models.user import User
from app.modules.workboards.models import (
    Workboard,
    WorkboardAppUser,
    WorkboardWorkspace,
)
from app.modules.workboards.permissions import require_dataset_binding_access
from app.modules.workboards.workspace_schemas import WorkspaceAccessMode

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


def _require_menu_dataset_access(
    db: Session,
    user: User,
    menu_config: List[Dict[str, Any]],
) -> None:
    slugs = {
        str(item.get("workboard_slug") or "").strip()
        for item in menu_config
        if isinstance(item, dict)
    }
    slugs.discard("")
    if not slugs:
        return
    workboards = db.query(Workboard).filter(Workboard.slug.in_(slugs)).all()
    for workboard in workboards:
        require_dataset_binding_access(db, user, workboard.dataset_id)


class WorkspaceMenuItemAdmin(BaseModel):
    workboard_slug: str
    label: str
    description: Optional[str] = None
    icon: Optional[str] = None
    roles: List[str] = Field(default_factory=list)
    view_id: Optional[str] = None

    model_config = ConfigDict(extra="ignore")


class WorkspaceAdminResponse(BaseModel):
    id: int
    slug: Optional[str]
    name: str
    description: Optional[str]
    icon: Optional[str]
    token: str
    is_active: bool
    session_ttl_seconds: int
    access_mode: WorkspaceAccessMode = "internal"
    branding: Optional[Dict[str, Any]] = None
    menu_config: List[Dict[str, Any]] = Field(default_factory=list)


class WorkspaceCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    slug: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = None
    icon: Optional[str] = None
    # Default to ``public_app_users`` because that's how mini-apps are
    # actually used in the field. Identity now lives on each workboard,
    # so creating a workspace no longer requires extra user-source wiring -
    # admins just attach workboards through ``menu_config``.
    access_mode: WorkspaceAccessMode = "public_app_users"
    menu_config: List[Dict[str, Any]] = Field(default_factory=list)
    branding: Optional[Dict[str, Any]] = None
    session_ttl_seconds: int = Field(default=28800, ge=60, le=86400)


class WorkspaceUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = None
    icon: Optional[str] = None
    is_active: Optional[bool] = None
    access_mode: Optional[WorkspaceAccessMode] = None
    menu_config: Optional[List[Dict[str, Any]]] = None
    branding: Optional[Dict[str, Any]] = None
    session_ttl_seconds: Optional[int] = Field(default=None, ge=60, le=86400)


def _serialise(ws: WorkboardWorkspace) -> WorkspaceAdminResponse:
    return WorkspaceAdminResponse(
        id=ws.id,
        slug=ws.slug,
        name=ws.name,
        description=ws.description,
        icon=ws.icon,
        token=ws.token,
        is_active=ws.is_active,
        session_ttl_seconds=ws.session_ttl_seconds or 28800,
        access_mode=(ws.access_mode or "internal"),
        branding=ws.branding,
        menu_config=ws.menu_config or [],
    )


@router.get("", response_model=List[WorkspaceAdminResponse])
@router.get("/", response_model=List[WorkspaceAdminResponse])
def list_workspaces(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("workboards", "view")),
):
    rows = (
        db.query(WorkboardWorkspace)
        .order_by(WorkboardWorkspace.created_at.desc())
        .all()
    )
    return [_serialise(ws) for ws in rows]


@router.post("", response_model=WorkspaceAdminResponse, status_code=status.HTTP_201_CREATED)
def create_workspace(
    body: WorkspaceCreateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("workboards", "full")),
):
    slug = body.slug
    if slug:
        if db.query(WorkboardWorkspace).filter(WorkboardWorkspace.slug == slug).first():
            raise HTTPException(status_code=409, detail=f"Workspace slug '{slug}' already exists.")
    _require_menu_dataset_access(db, user, body.menu_config)
    ws = WorkboardWorkspace(
        name=body.name,
        slug=slug,
        description=body.description,
        icon=body.icon,
        token=secrets.token_urlsafe(24),
        access_mode=body.access_mode,
        menu_config=body.menu_config,
        branding=body.branding,
        is_active=True,
        session_ttl_seconds=body.session_ttl_seconds,
        owner_id=user.id,
    )
    db.add(ws)
    db.commit()
    db.refresh(ws)
    return _serialise(ws)


@router.get("/{workspace_id}", response_model=WorkspaceAdminResponse)
def get_workspace(
    workspace_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("workboards", "view")),
):
    ws = db.query(WorkboardWorkspace).filter(WorkboardWorkspace.id == workspace_id).first()
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    return _serialise(ws)


@router.patch("/{workspace_id}", response_model=WorkspaceAdminResponse)
def update_workspace(
    workspace_id: int,
    body: WorkspaceUpdateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("workboards", "full")),
):
    ws = db.query(WorkboardWorkspace).filter(WorkboardWorkspace.id == workspace_id).first()
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    patch = body.model_dump(exclude_unset=True)
    if "menu_config" in patch:
        _require_menu_dataset_access(db, user, patch["menu_config"] or [])
    for key, val in patch.items():
        setattr(ws, key, val)
    db.commit()
    db.refresh(ws)
    return _serialise(ws)


@router.post("/{workspace_id}/rotate-token", response_model=WorkspaceAdminResponse)
def rotate_token(
    workspace_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("workboards", "full")),
):
    ws = db.query(WorkboardWorkspace).filter(WorkboardWorkspace.id == workspace_id).first()
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    ws.token = secrets.token_urlsafe(24)
    db.commit()
    db.refresh(ws)
    return _serialise(ws)


class PreviewSessionRequest(BaseModel):
    username: Optional[str] = Field(default=None, max_length=255)
    role: Optional[str] = Field(default=None, max_length=64)
    workboard_id: Optional[int] = Field(default=None, gt=0)


class PreviewSessionResponse(BaseModel):
    ok: bool
    preview_url: str
    workspace_token: str
    cookie_name: str
    expires_in: int


from fastapi import Response as FastApiResponse  # noqa: E402


def _secure_cookie_for_request(request: Request, cookie_secure: bool) -> bool:
    if not cookie_secure:
        return False
    proto = (
        request.headers.get("x-forwarded-proto")
        or request.url.scheme
        or ""
    ).split(",")[0].strip().lower()
    return proto == "https"


@router.post("/{workspace_id}/preview-session", response_model=PreviewSessionResponse)
def preview_session(
    workspace_id: int,
    body: PreviewSessionRequest,
    request: Request,
    response: FastApiResponse,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("workboards", "edit")),
):
    """Mint a preview session cookie for the workspace so AppBI admins can
    open the public mini-app in an iframe without separately logging in.

    The cookie is the same JWT format the public login endpoint issues, so
    every downstream check (RLS, write enforcement) behaves exactly as a
    real worker would experience.
    """
    from app.modules.workboards.services import app_user_service
    from app.core.config import settings as app_settings

    ws = db.query(WorkboardWorkspace).filter(WorkboardWorkspace.id == workspace_id).first()
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")

    access_mode = (ws.access_mode or "internal")
    preview_workboard: Workboard | None = None
    if body.workboard_id is not None:
        preview_workboard = (
            db.query(Workboard)
            .filter(Workboard.id == body.workboard_id)
            .first()
        )
        if preview_workboard is None:
            raise HTTPException(status_code=404, detail="Workboard not found.")
        require_edit_access(db, user, preview_workboard, "workboards")
        require_dataset_binding_access(db, user, preview_workboard.dataset_id)

    # Internal-mode previews use the AppBI staff identity directly so the
    # iframe runtime gets a workspace cookie just like the public flow.
    if access_mode == "internal":
        extra_claims: Dict[str, Any] = {}
        if preview_workboard is not None:
            extra_claims["preview_workboard_id"] = body.workboard_id
        token, ttl = app_user_service.create_internal_session_token(
            ws,
            appbi_user=user,
            extra_claims=extra_claims or None,
        )
        import hashlib

        cookie_name = (
            "wbws_" + hashlib.sha256(ws.token.encode("utf-8")).hexdigest()[:12]
        )
        response.set_cookie(
            key=cookie_name,
            value=token,
            max_age=ttl,
            httponly=True,
            secure=_secure_cookie_for_request(request, app_settings.COOKIE_SECURE),
            samesite="lax",
            path="/",
        )
        return PreviewSessionResponse(
            ok=True,
            preview_url=(
                f"/ws/{ws.token}/workboards/{body.workboard_id}"
                if body.workboard_id is not None
                else f"/ws/{ws.token}"
            ),
            workspace_token=ws.token,
            cookie_name=cookie_name,
            expires_in=ttl,
        )

    # Public-app-users mode: pick a real WorkboardAppUser row to preview as.
    # Without ``body.workboard_id`` we don't know which workboard's user
    # pool to draw from; ask the FE to specify which mini-app it's
    # previewing — the BuilderLivePreview always passes this.
    if body.workboard_id is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "preview-session cần workboard_id để chọn user trong bảng "
                "users của workboard tương ứng."
            ),
        )
    wb = preview_workboard
    if wb is None:
        raise HTTPException(status_code=404, detail="Workboard not found.")

    target_username = (body.username or "").strip()
    target_role = (body.role or "").strip().lower()

    user_query = db.query(WorkboardAppUser).filter(
        WorkboardAppUser.workboard_id == wb.id,
        WorkboardAppUser.active.is_(True),
    )
    if target_username:
        user_query = user_query.filter(WorkboardAppUser.username == target_username)
    if target_role:
        user_query = user_query.filter(
            WorkboardAppUser.role.ilike(target_role)
        )

    matched_user = user_query.order_by(WorkboardAppUser.id.asc()).first()
    if matched_user is None:
        if target_username:
            raise HTTPException(
                status_code=404,
                detail=f"App user '{target_username}' không tồn tại hoặc đã bị tắt.",
            )
        # No filter at all → bảng users rỗng — admin chưa tạo user nào.
        raise HTTPException(
            status_code=400,
            detail=(
                "Workboard chưa có app user nào để preview. Vào tab 'Users' "
                "trong Builder để tạo user trước."
            ),
        )

    extra_claims: Dict[str, Any] = {"preview_workboard_id": wb.id}
    token, ttl = app_user_service.create_session_token(
        ws,
        matched_user,
        db=db,
        extra_claims=extra_claims,
    )
    import hashlib

    cookie_name = (
        "wbws_" + hashlib.sha256(ws.token.encode("utf-8")).hexdigest()[:12]
    )
    response.set_cookie(
        key=cookie_name,
        value=token,
        max_age=ttl,
        httponly=True,
        secure=_secure_cookie_for_request(request, app_settings.COOKIE_SECURE),
        samesite="lax",
        path="/",
    )
    return PreviewSessionResponse(
        ok=True,
        preview_url=(
            f"/ws/{ws.token}/workboards/{body.workboard_id}"
            if body.workboard_id is not None
            else f"/ws/{ws.token}"
        ),
        workspace_token=ws.token,
        cookie_name=cookie_name,
        expires_in=ttl,
    )


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace(
    workspace_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("workboards", "full")),
):
    ws = db.query(WorkboardWorkspace).filter(WorkboardWorkspace.id == workspace_id).first()
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    db.delete(ws)
    db.commit()


# ── Relationship suggestions (used by the mini-app builder) ───────────────


class JoinSuggestion(BaseModel):
    target_table_id: int
    target_table_display: str
    target_table_source: str
    from_column: str
    to_column: str
    suggested_label_columns: List[str] = Field(default_factory=list)


from fastapi import Query  # noqa: E402


_relationships_router = APIRouter(prefix="/workboard-relationships", tags=["workboards"])


@_relationships_router.get(
    "",
    response_model=List[JoinSuggestion],
    summary="Suggest join targets from dataset semantic joins",
)
def suggest_relationships(
    from_table_id: int = Query(..., gt=0),
    dataset_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("workboards", "edit")),
):
    """Return tables joinable from ``from_table_id`` along with the columns
    a Builder dropdown can prefill into a lookup ``relationship_path``.

    Reads dataset semantic explores (the same join graph charts use) so
    the mini-app builder doesn't ask IT/DE to retype joins. When the
    dataset has no semantic model yet, returns an empty list.
    """
    from app.models.dataset import DatasetTable
    from app.services.dataset_model_service import get_dataset_model

    from_table = db.query(DatasetTable).filter(DatasetTable.id == from_table_id).first()
    if from_table is None:
        raise HTTPException(status_code=404, detail="Source table not found.")
    if dataset_id is None:
        dataset_id = from_table.dataset_id
    elif int(dataset_id) != int(from_table.dataset_id):
        raise HTTPException(
            status_code=400,
            detail="Source table does not belong to the requested dataset.",
        )
    require_dataset_binding_access(db, user, dataset_id)

    model = get_dataset_model(db, dataset_id) or {}
    explores = model.get("explores") or []
    views = {v.get("name"): v for v in (model.get("views") or []) if isinstance(v, dict)}

    # Build a (source_view_name → [join]) map from semantic explores.
    joins_by_source: Dict[str, List[dict]] = {}
    for exp in explores:
        base_view = exp.get("base_view_name")
        for j in exp.get("joins") or []:
            src = j.get("from_view") or base_view
            if not src:
                continue
            joins_by_source.setdefault(src, []).append(j)

    src_view_name = from_table.source_table_name or from_table.display_name
    candidates = joins_by_source.get(src_view_name, [])

    # Index dataset tables by source_table_name → id for resolution.
    table_by_source = {
        t.source_table_name: t
        for t in db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .all()
        if t.source_table_name
    }

    out: List[JoinSuggestion] = []
    for j in candidates:
        target_view_name = j.get("view")
        if not target_view_name:
            continue
        target_t = table_by_source.get(target_view_name)
        if target_t is None:
            continue
        from_col = j.get("from_column") or ""
        to_col = j.get("to_column") or ""
        if not from_col or not to_col:
            continue
        # Heuristic label suggestions: any string column on the target.
        cols = []
        for c in target_t.columns_cache or []:
            if isinstance(c, dict):
                name = c.get("name")
                ctype = (c.get("type") or "").lower()
                if name and ctype in {"string", "text", "varchar"}:
                    cols.append(name)
        out.append(
            JoinSuggestion(
                target_table_id=target_t.id,
                target_table_display=target_t.display_name or target_view_name,
                target_table_source=target_t.source_table_name or target_view_name,
                from_column=from_col,
                to_column=to_col,
                suggested_label_columns=cols[:6],
            )
        )
    return out
