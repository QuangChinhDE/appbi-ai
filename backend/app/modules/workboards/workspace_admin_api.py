"""Authenticated admin endpoints for managing workspaces.

Lives behind ``settings`` permission so only AppBI admins (typically the
IT/DE persona) can list / inspect / create the public workspace links.
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
from app.core.dependencies import require_permission
from app.models.user import User
from app.modules.workboards.models import Workboard, WorkboardWorkspace

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


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
    branding: Optional[Dict[str, Any]] = None
    app_users_config: Dict[str, Any] = Field(default_factory=dict)
    menu_config: List[Dict[str, Any]] = Field(default_factory=list)


class WorkspaceCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    slug: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = None
    icon: Optional[str] = None
    app_users_config: Dict[str, Any] = Field(default_factory=dict)
    menu_config: List[Dict[str, Any]] = Field(default_factory=list)
    branding: Optional[Dict[str, Any]] = None
    session_ttl_seconds: int = Field(default=28800, ge=60, le=86400)


class WorkspaceUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = None
    icon: Optional[str] = None
    is_active: Optional[bool] = None
    app_users_config: Optional[Dict[str, Any]] = None
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
        branding=ws.branding,
        app_users_config=ws.app_users_config or {},
        menu_config=ws.menu_config or [],
    )


@router.get("", response_model=List[WorkspaceAdminResponse])
@router.get("/", response_model=List[WorkspaceAdminResponse])
def list_workspaces(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "view")),
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
    user: User = Depends(require_permission("settings", "full")),
):
    slug = body.slug
    if slug:
        if db.query(WorkboardWorkspace).filter(WorkboardWorkspace.slug == slug).first():
            raise HTTPException(status_code=409, detail=f"Workspace slug '{slug}' already exists.")
    ws = WorkboardWorkspace(
        name=body.name,
        slug=slug,
        description=body.description,
        icon=body.icon,
        token=secrets.token_urlsafe(24),
        app_users_config=body.app_users_config,
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
    _: User = Depends(require_permission("settings", "view")),
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
    _: User = Depends(require_permission("settings", "full")),
):
    ws = db.query(WorkboardWorkspace).filter(WorkboardWorkspace.id == workspace_id).first()
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    patch = body.model_dump(exclude_unset=True)
    for key, val in patch.items():
        setattr(ws, key, val)
    db.commit()
    db.refresh(ws)
    return _serialise(ws)


@router.post("/{workspace_id}/rotate-token", response_model=WorkspaceAdminResponse)
def rotate_token(
    workspace_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
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
    cfg = app_user_service.parse_app_users_config(ws)
    if cfg is None:
        raise HTTPException(status_code=400, detail="Workspace has no app_users_config.")

    # Pick a real app_user row matching the request — honours real RLS.
    if body.username:
        row = app_user_service._fetch_user_row(db, cfg, body.username.strip())
        if row is None:
            raise HTTPException(status_code=404, detail="App user not found.")
        username = body.username.strip()
    else:
        # Pick the first active row whose role matches.
        from app.models.dataset import DatasetTable
        from app.models.models import DataSource
        from app.services.live_query_service import LiveQueryService

        table = db.query(DatasetTable).filter(DatasetTable.id == cfg.table_id).first()
        ds = db.query(DataSource).filter(DataSource.id == table.datasource_id).first() if table else None
        if not table or not ds:
            raise HTTPException(status_code=400, detail="App users table missing.")
        result = LiveQueryService.execute_preview_query(
            ds, table, limit=20, offset=0, filters=[]
        )
        rows = result.get("rows") or []
        match = None
        target_role = (body.role or "").strip().lower()
        for r in rows:
            r_role = str(r.get(cfg.role_column or "") or "").strip().lower()
            if not target_role or r_role == target_role:
                match = r
                break
        if match is None:
            raise HTTPException(status_code=404, detail="No matching app user.")
        row = match
        username = str(row.get(cfg.username_column))

    extra_claims: Dict[str, Any] = {}
    if body.workboard_id is not None:
        exists = (
            db.query(Workboard.id)
            .filter(Workboard.id == body.workboard_id)
            .first()
        )
        if exists is None:
            raise HTTPException(status_code=404, detail="Workboard not found.")
        extra_claims["preview_workboard_id"] = body.workboard_id

    token, ttl = app_user_service.create_session_token(
        ws,
        username,
        cfg,
        row,
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


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace(
    workspace_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
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
    _: User = Depends(require_permission("workboards", "edit")),
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
