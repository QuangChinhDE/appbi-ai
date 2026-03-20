"""
Permission Matrix API — admin manages per-user module permissions (JSONB on users table).

GET  /permissions/matrix          → full matrix (all users × all modules)
GET  /permissions/me              → current user's effective permissions
PUT  /permissions/{user_id}       → bulk-update one user's module permissions
GET  /permissions/presets         → list all available presets
PUT  /permissions/{user_id}/preset → apply a preset to a user
"""

import uuid
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.models.user import User, UserStatus

router = APIRouter(prefix="/permissions", tags=["permissions"])

# ── Module definitions ────────────────────────────────────────────────────────

MODULES = [
    "data_sources",
    "datasets",
    "workspaces",
    "explore_charts",
    "dashboards",
    "ai_chat",
    "settings",
]

# Per-module allowed levels (enforces business rules)
MODULE_ALLOWED_LEVELS: Dict[str, List[str]] = {
    "data_sources":   ["none", "view", "full"],
    "datasets":       ["none", "view", "edit", "full"],
    "workspaces":     ["none", "view", "edit", "full"],
    "explore_charts": ["none", "view", "edit", "full"],
    "dashboards":     ["none", "view", "edit", "full"],
    "ai_chat":        ["none", "view", "edit"],
    "settings":       ["none", "full"],
}

LEVEL_ORDER = {"none": 0, "view": 1, "edit": 2, "full": 3}

# ── Presets ───────────────────────────────────────────────────────────────────

PRESETS: Dict[str, Dict[str, str]] = {
    "admin": {
        "data_sources": "full",
        "datasets": "full",
        "workspaces": "full",
        "explore_charts": "full",
        "dashboards": "full",
        "ai_chat": "edit",
        "settings": "full",
    },
    "editor": {
        "data_sources": "view",
        "datasets": "edit",
        "workspaces": "edit",
        "explore_charts": "edit",
        "dashboards": "edit",
        "ai_chat": "edit",
        "settings": "none",
    },
    "viewer": {
        "data_sources": "view",
        "datasets": "view",
        "workspaces": "view",
        "explore_charts": "view",
        "dashboards": "view",
        "ai_chat": "view",
        "settings": "none",
    },
    "minimal": {
        "data_sources": "none",
        "datasets": "none",
        "workspaces": "none",
        "explore_charts": "none",
        "dashboards": "view",
        "ai_chat": "none",
        "settings": "none",
    },
}

# ── Schemas ───────────────────────────────────────────────────────────────────

class UserPermissionRow(BaseModel):
    user_id: str
    email: str
    full_name: str
    permissions: Dict[str, str]


class PermissionMatrixResponse(BaseModel):
    modules: List[str]
    module_levels: Dict[str, List[str]]
    users: List[UserPermissionRow]


class UpdatePermissionsRequest(BaseModel):
    permissions: Dict[str, str]


class ApplyPresetRequest(BaseModel):
    preset: str


class MyPermissionsResponse(BaseModel):
    permissions: Dict[str, str]
    module_levels: Dict[str, List[str]]


class PresetsResponse(BaseModel):
    presets: Dict[str, Dict[str, str]]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _default_permissions() -> Dict[str, str]:
    return {m: "none" for m in MODULES}


def _get_user_permissions(user: User) -> Dict[str, str]:
    base = _default_permissions()
    stored: dict = user.permissions or {}
    base.update({k: v for k, v in stored.items() if k in MODULES})
    return base


def _validate_permissions(perms: Dict[str, str]) -> None:
    for module, level in perms.items():
        if module not in MODULES:
            raise HTTPException(status_code=400, detail=f"Invalid module: {module}")
        allowed = MODULE_ALLOWED_LEVELS.get(module, [])
        if level not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid level '{level}' for module '{module}'. Allowed: {allowed}",
            )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/presets", response_model=PresetsResponse)
def get_presets(_: User = Depends(require_permission("settings", "full"))):
    """Return all available permission presets."""
    return PresetsResponse(presets=PRESETS)


@router.get("/matrix", response_model=PermissionMatrixResponse)
def get_permission_matrix(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
):
    """Full permission matrix — all active users × all modules."""
    users = (
        db.query(User)
        .filter(User.status == UserStatus.ACTIVE)
        .order_by(User.full_name)
        .all()
    )

    rows = [
        UserPermissionRow(
            user_id=str(u.id),
            email=u.email,
            full_name=u.full_name,
            permissions=_get_user_permissions(u),
        )
        for u in users
    ]

    return PermissionMatrixResponse(
        modules=MODULES,
        module_levels=MODULE_ALLOWED_LEVELS,
        users=rows,
    )


@router.get("/me", response_model=MyPermissionsResponse)
def get_my_permissions(current_user: User = Depends(get_current_user)):
    """Current user's effective permissions (used by sidebar/UI)."""
    return MyPermissionsResponse(
        permissions=_get_user_permissions(current_user),
        module_levels=MODULE_ALLOWED_LEVELS,
    )


@router.put("/{user_id}/preset", status_code=status.HTTP_200_OK)
def apply_preset_to_user(
    user_id: uuid.UUID,
    body: ApplyPresetRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
):
    """Apply a named preset to a user's permissions."""
    if body.preset not in PRESETS:
        raise HTTPException(status_code=400, detail=f"Unknown preset: {body.preset}. Valid: {list(PRESETS.keys())}")

    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    target.permissions = PRESETS[body.preset].copy()
    db.commit()
    return {"status": "ok", "preset": body.preset, "permissions": target.permissions}


@router.put("/{user_id}", status_code=status.HTTP_200_OK)
def update_user_permissions(
    user_id: uuid.UUID,
    body: UpdatePermissionsRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
):
    """
    Bulk-update a user's module permissions.
    Merges the provided values into the existing JSONB, so you can send partial updates.
    """
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    _validate_permissions(body.permissions)

    current: dict = dict(target.permissions or {})
    current.update(body.permissions)
    target.permissions = current
    db.commit()

    return {"status": "ok", "updated": len(body.permissions), "permissions": _get_user_permissions(target)}


