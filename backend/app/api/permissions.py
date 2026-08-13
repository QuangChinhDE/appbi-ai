"""
Permission Matrix API — admin manages per-user module permissions (JSONB on users table).

GET  /permissions/matrix          → full matrix (all users × all modules)
GET  /permissions/me              → current user's effective permissions
PUT  /permissions/{user_id}       → bulk-update one user's module permissions
GET  /permissions/presets         → list all available presets
PUT  /permissions/{user_id}/preset → apply a preset to a user
"""

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.core.config import settings
from app.core.database import get_db
from app.core.dependencies import (
    MODULE_KEYS,
    get_current_user,
    require_permission,
    INTELLIGENCE_INHERIT,
)
from app.models.audit_log import AuditAction
from app.models.team import Team, TeamMembership
from app.models.user import User, UserStatus
from app.services.audit_service import audit

router = APIRouter(prefix="/permissions", tags=["permissions"])

# ── Module definitions ────────────────────────────────────────────────────────

# Optional / feature-flagged modules: included only when the corresponding
# overlay is active. Keeps the FE sidebar and admin matrix in sync with what
# the API actually serves.
_OPTIONAL_MODULES = {
    "workboards": settings.WORKBOARDS_ENABLED,
    # Catalog surfaces: each module its own flag, but both need the /catalog
    # backend deployed (METADATA_CATALOG_ENABLED) — so a stray module flag can't
    # produce dead-nav pointing at an unregistered router.
    "govern": settings.METADATA_CATALOG_ENABLED and settings.GOVERN_ENABLED,
    "agent_flows": settings.METADATA_CATALOG_ENABLED and settings.GOVERN_ENABLED,
    # Intelligence group — same enablement as govern (same catalog backend).
    # Flow Studio — same catalog backend, but its OWN key: publishing a flow
    # changes AI behaviour on a live published report (deploy-sized blast
    # radius), so it must not inherit an authoring-level grant.
    "observability": settings.METADATA_CATALOG_ENABLED and settings.OBSERVABILITY_ENABLED,
}


def _module_enabled(name: str) -> bool:
    return _OPTIONAL_MODULES.get(name, True)


# DERIVED, never re-typed. core.dependencies.MODULE_KEYS is the single source of
# truth for "what modules exist"; it is what require_permission() caps a scoped
# token against. Keeping a second hand-written copy here is exactly how
# `agent_flows` came to sit in this matrix while being invisible to that cap.
_ALL_MODULES = list(MODULE_KEYS)

MODULES = [m for m in _ALL_MODULES if _module_enabled(m)]

# Per-module allowed levels (enforces business rules)
_ALL_MODULE_ALLOWED_LEVELS: Dict[str, List[str]] = {
    "data_sources":      ["none", "view", "edit", "full"],
    "datasets":          ["none", "view", "edit", "full"],
    "govern":            ["none", "view", "edit", "full"],
    "agent_flows":            ["none", "view", "edit", "full"],
    "observability":     ["none", "view", "edit", "full"],
    "explore_charts":    ["none", "view", "edit", "full"],
    "dashboards":        ["none", "view", "edit", "full"],
    "workboards":        ["none", "view", "edit", "full"],
    "settings":          ["none", "full"],
}

MODULE_ALLOWED_LEVELS: Dict[str, List[str]] = {
    k: v for k, v in _ALL_MODULE_ALLOWED_LEVELS.items() if _module_enabled(k)
}

LEVEL_ORDER = {"none": 0, "view": 1, "edit": 2, "full": 3}

# ── Presets ───────────────────────────────────────────────────────────────────

PRESETS: Dict[str, Dict[str, str]] = {
    "admin": {
        "data_sources": "full",
        "datasets": "full",
        "govern": "full",
        "agent_flows": "full",
        "observability": "full",
        "explore_charts": "full",
        "dashboards": "full",
        "workboards": "full",
        "settings": "full",
    },
    "editor": {
        "data_sources": "view",
        "datasets": "edit",
        "govern": "edit",
        "agent_flows": "edit",
        "observability": "edit",
        "explore_charts": "edit",
        "dashboards": "edit",
        "workboards": "edit",
        "settings": "none",
    },
    "viewer": {
        "data_sources": "view",
        "datasets": "view",
        "govern": "view",
        "agent_flows": "view",
        "observability": "view",
        "explore_charts": "view",
        "dashboards": "view",
        "workboards": "view",
        "settings": "none",
    },
    "minimal": {
        "data_sources": "none",
        "datasets": "none",
        "govern": "none",
        "agent_flows": "none",
        "observability": "none",
        "explore_charts": "none",
        "dashboards": "view",
        "workboards": "none",
        "settings": "none",
    },
}

# Strip disabled modules from presets so /presets and apply-preset never
# return values that would fail _validate_permissions.
PRESETS = {
    name: {k: v for k, v in spec.items() if _module_enabled(k)}
    for name, spec in PRESETS.items()
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


class TeamMemberSummary(BaseModel):
    user_id: str
    email: str
    full_name: str


class TeamResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    member_count: int
    members: List[TeamMemberSummary]
    created_at: datetime
    updated_at: datetime


class TeamCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)
    member_ids: List[uuid.UUID] = Field(default_factory=list)


class TeamUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)
    member_ids: Optional[List[uuid.UUID]] = None

    @model_validator(mode="after")
    def validate_patch(self) -> "TeamUpdateRequest":
        if self.name is None and self.description is None and self.member_ids is None:
            raise ValueError("At least one field must be provided")
        return self


# ── Helpers ───────────────────────────────────────────────────────────────────

def _default_permissions() -> Dict[str, str]:
    return {m: "none" for m in MODULES}


def _get_user_permissions(user: User) -> Dict[str, str]:
    base = _default_permissions()
    stored: dict = user.permissions or {}
    base.update({k: v for k, v in stored.items() if k in MODULES})
    # Intelligence group inherits the legacy 'govern' level when its own key is not
    # explicitly stored — so existing govern:X users keep full Intelligence access.
    resolved = set(stored)
    _gv = stored.get("govern")
    if _gv is not None:
        for _m in INTELLIGENCE_INHERIT:
            if _m in MODULES and _m not in stored:
                base[_m] = _gv
                resolved.add(_m)
    # Admin (settings=full) implicitly has any module added AFTER their
    # permissions row was created — surface those (e.g. govern/observability
    # enabled today) so the sidebar/matrix show them instead of hiding a new
    # module behind a missing key. Mirrors require_permission()'s admin rule;
    # an explicit stored level (even "none") is left untouched.
    if str(stored.get("settings", "")).strip().lower() == "full":
        for m in MODULES:
            if m != "settings" and m not in resolved:
                base[m] = "full"
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


def _normalize_team_name(name: str) -> str:
    return " ".join(name.strip().split())


def _load_team_or_404(db: Session, team_id: uuid.UUID) -> Team:
    team = (
        db.query(Team)
        .options(joinedload(Team.memberships).joinedload(TeamMembership.user))
        .filter(Team.id == team_id)
        .first()
    )
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    return team


def _serialize_team(team: Team) -> TeamResponse:
    members = [
        TeamMemberSummary(
            user_id=str(membership.user.id),
            email=membership.user.email,
            full_name=membership.user.full_name,
        )
        for membership in team.memberships
        if membership.user and membership.user.status == UserStatus.ACTIVE
    ]
    members.sort(key=lambda item: (item.full_name or item.email).lower())
    return TeamResponse(
        id=str(team.id),
        name=team.name,
        description=team.description,
        member_count=len(members),
        members=members,
        created_at=team.created_at,
        updated_at=team.updated_at,
    )


def _ensure_unique_team_name(db: Session, name: str, team_id: uuid.UUID | None = None) -> None:
    existing = (
        db.query(Team)
        .filter(func.lower(Team.name) == name.lower())
        .first()
    )
    if existing and existing.id != team_id:
        raise HTTPException(status_code=409, detail=f"Team '{name}' already exists")


def _replace_team_members(db: Session, team: Team, member_ids: List[uuid.UUID]) -> None:
    unique_member_ids = list(dict.fromkeys(member_ids))
    if not unique_member_ids:
        team.memberships = []
        return

    users = (
        db.query(User)
        .filter(User.id.in_(unique_member_ids), User.status == UserStatus.ACTIVE)
        .all()
    )
    resolved_ids = {user.id for user in users}
    missing = [str(member_id) for member_id in unique_member_ids if member_id not in resolved_ids]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown or inactive user ids: {', '.join(missing)}",
        )

    existing_memberships = {membership.user_id: membership for membership in team.memberships}
    team.memberships = [
        existing_memberships.get(user.id) or TeamMembership(user_id=user.id)
        for user in users
    ]


# ── Endpoints ─────────────────────────────────────────────────────────────────

def _is_admin_permissions(perms: Dict[str, str] | None) -> bool:
    return str((perms or {}).get("settings", "")).strip().lower() == "full"


def _assert_admin_remains(db: Session, target: User, new_permissions: Dict[str, str]) -> None:
    """Refuse a change that would leave the deployment with no administrator.

    Nothing stopped an admin from applying the `viewer` preset to themselves, or to
    the last remaining admin. Either one locks Settings for everybody — including
    the person who would have to undo it. `users.py` already refuses self-deactivate
    and self-delete; this is the same guard on the more dangerous door.
    """
    if _is_admin_permissions(new_permissions):
        return
    if not _is_admin_permissions(target.permissions):
        return  # target was not an admin — no admin is being removed

    remaining = (
        db.query(User)
        .filter(
            User.id != target.id,
            User.status == UserStatus.ACTIVE,
            User.permissions["settings"].astext == "full",
        )
        .count()
    )
    if remaining == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Đây là quản trị viên cuối cùng còn hoạt động. Hãy cấp quyền "
                "Settings = full cho một người khác trước khi hạ quyền tài khoản này."
            ),
        )


def _audit_permission_change(
    db: Session,
    request: Request,
    actor: User,
    target: User,
    before: Dict[str, str],
    after: Dict[str, str],
    *,
    preset: str | None = None,
) -> None:
    """Record WHO changed WHOSE permissions, and exactly what moved.

    `USER_PERMISSIONS_CHANGED` existed in the AuditAction enum and in the severity
    table from the start, but was never emitted anywhere — so the single most
    security-relevant action in the product left no trace at all. The diff is
    recorded, not just the new state: "who granted this, and what did they change
    it from" is the question an investigation actually asks.
    """
    changed = {
        module: {"from": before.get(module, "none"), "to": after.get(module, "none")}
        for module in set(before) | set(after)
        if before.get(module, "none") != after.get(module, "none")
    }
    if not changed:
        return
    details: Dict[str, Any] = {
        "target_email": target.email,
        "changed": changed,
        "self_change": str(actor.id) == str(target.id),
    }
    if preset:
        details["preset"] = preset
    audit(
        db,
        AuditAction.USER_PERMISSIONS_CHANGED,
        request=request,
        user_id=actor.id,
        resource_type="user",
        resource_id=str(target.id),
        details=details,
    )


@router.get("/presets", response_model=PresetsResponse)
def get_presets(_: User = Depends(require_permission("settings", "full"))):
    """Return all available permission presets."""
    return PresetsResponse(presets=PRESETS)


@router.get("/matrix", response_model=PermissionMatrixResponse)
def get_permission_matrix(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
):
    """Full permission matrix — all users × all modules (active listed first).

    Includes deactivated users so the People console can show and manage their
    access (reactivate / delete) instead of a blank panel."""
    users = (
        db.query(User)
        .order_by(User.status.asc(), User.full_name.asc())
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


@router.get("/teams", response_model=List[TeamResponse])
def list_teams(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
):
    teams = (
        db.query(Team)
        .options(joinedload(Team.memberships).joinedload(TeamMembership.user))
        .order_by(Team.name.asc())
        .all()
    )
    return [_serialize_team(team) for team in teams]


@router.post("/teams", response_model=TeamResponse, status_code=status.HTTP_201_CREATED)
def create_team(
    body: TeamCreateRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
):
    normalized_name = _normalize_team_name(body.name)
    _ensure_unique_team_name(db, normalized_name)

    team = Team(
        name=normalized_name,
        description=(body.description or "").strip() or None,
    )
    db.add(team)
    db.flush()
    _replace_team_members(db, team, body.member_ids)
    db.commit()

    return _serialize_team(_load_team_or_404(db, team.id))


@router.put("/teams/{team_id}", response_model=TeamResponse)
def update_team(
    team_id: uuid.UUID,
    body: TeamUpdateRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
):
    team = _load_team_or_404(db, team_id)

    if body.name is not None:
        normalized_name = _normalize_team_name(body.name)
        _ensure_unique_team_name(db, normalized_name, team.id)
        team.name = normalized_name

    if body.description is not None:
        team.description = body.description.strip() or None

    if body.member_ids is not None:
        _replace_team_members(db, team, body.member_ids)

    db.commit()
    return _serialize_team(_load_team_or_404(db, team.id))


@router.delete("/teams/{team_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_team(
    team_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("settings", "full")),
):
    team = db.query(Team).filter(Team.id == team_id).first()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    db.delete(team)
    db.commit()


@router.put("/{user_id}/preset", status_code=status.HTTP_200_OK)
def apply_preset_to_user(
    user_id: uuid.UUID,
    body: ApplyPresetRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("settings", "full")),
):
    """Apply a named preset to a user's permissions."""
    if body.preset not in PRESETS:
        raise HTTPException(status_code=400, detail=f"Unknown preset: {body.preset}. Valid: {list(PRESETS.keys())}")

    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    before = dict(target.permissions or {})
    after = PRESETS[body.preset].copy()
    _assert_admin_remains(db, target, after)
    target.permissions = after
    db.commit()

    _audit_permission_change(db, request, actor, target, before, after, preset=body.preset)

    return {"status": "ok", "preset": body.preset, "permissions": target.permissions}


@router.put("/{user_id}", status_code=status.HTTP_200_OK)
def update_user_permissions(
    user_id: uuid.UUID,
    body: UpdatePermissionsRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_permission("settings", "full")),
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
    before = dict(current)
    current.update(body.permissions)
    _assert_admin_remains(db, target, current)
    target.permissions = current
    db.commit()

    _audit_permission_change(db, request, actor, target, before, current)

    return {"status": "ok", "updated": len(body.permissions), "permissions": _get_user_permissions(target)}


