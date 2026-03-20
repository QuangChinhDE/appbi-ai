"""
Authentication dependencies — get_current_user, require_permission,
resource-level permission helpers.

Token is extracted from:
  1. httpOnly cookie named 'access_token'
  2. Authorization: Bearer <token> header (for AI service / API clients)
"""
from __future__ import annotations

import uuid
from typing import Sequence, Tuple

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models.user import User, UserStatus
from app.models.resource_share import ResourceShare, ResourceType

_bearer = HTTPBearer(auto_error=False)

ALGORITHM = "HS256"


def _extract_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
) -> str | None:
    """Extract JWT from cookie or Authorization header."""
    # 1. httpOnly cookie (preferred for browser clients)
    token = request.cookies.get("access_token")
    if token:
        return token
    # 2. Authorization: Bearer header (API / ai-service / WS query param)
    if credentials and credentials.scheme.lower() == "bearer":
        return credentials.credentials
    return None


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """Decode JWT and return the active User. Raises 401 on any failure."""
    token = _extract_token(request, credentials)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str | None = payload.get("sub")
        if not user_id:
            raise ValueError("missing sub")
    except (JWTError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.query(User).filter(User.id == uuid.UUID(user_id)).first()
    if not user or user.status != UserStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or deactivated",
        )
    return user


# Module permission levels — order matters for comparison
LEVEL_ORDER = {"none": 0, "view": 1, "edit": 2, "full": 3}


def require_permission(module: str, min_level: str = "view"):
    """
    FastAPI dependency factory for module-level permission checks.

    Usage:
        current_user: User = Depends(require_permission("dashboards", "edit"))

    Levels (ascending): none < view < edit < full
    Admins with settings=full always pass any non-settings check.
    """
    async def _check(user: User = Depends(get_current_user)) -> User:
        perms: dict = user.permissions or {}
        user_level = perms.get(module, "none")
        if LEVEL_ORDER.get(user_level, 0) < LEVEL_ORDER.get(min_level, 0):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires '{min_level}' permission on module '{module}'",
            )
        return user
    return _check


# ── Resource-type → Module mapping ──────────────────────────
_MODEL_TO_RESOURCE_TYPE = {
    "DataSource": ResourceType.DATASOURCE,
    "Chart": ResourceType.CHART,
    "Dashboard": ResourceType.DASHBOARD,
    "DatasetWorkspace": ResourceType.WORKSPACE,
}

_MODEL_TO_MODULE = {
    "DataSource": "data_sources",
    "Chart": "explore_charts",
    "Dashboard": "dashboards",
    "DatasetWorkspace": "workspaces",
}


def get_effective_permission(db: Session, user: User, resource, module: str) -> str:
    """
    Compute the effective permission for *user* on a specific *resource*.

    Returns one of: 'none', 'view', 'edit', 'full'.

    Logic:
      module = none              → none
      module = full              → full   (admin sees everything)
      user is owner              → full   (owner has total control)
      shared as 'edit' + module >= edit → edit
      shared as 'view'          → view
      else                       → none
    """
    perms: dict = user.permissions or {}
    module_level = perms.get(module, "none")

    if module_level == "none":
        return "none"
    if module_level == "full":
        return "full"

    # Owner check
    owner_id = getattr(resource, "owner_id", None)
    if owner_id is not None and str(owner_id) == str(user.id):
        return "full"

    # Share check
    class_name = type(resource).__name__
    rt = _MODEL_TO_RESOURCE_TYPE.get(class_name)
    if rt:
        share = (
            db.query(ResourceShare)
            .filter(
                ResourceShare.resource_type == rt,
                ResourceShare.resource_id == str(resource.id),
                ResourceShare.user_id == user.id,
            )
            .first()
        )
        if share:
            share_level = share.permission.value  # "view" or "edit"
            # Effective = min(module_level, share_level)
            if LEVEL_ORDER.get(share_level, 0) <= LEVEL_ORDER.get(module_level, 0):
                return share_level
            return module_level

    # Fallback: user has module access but no ownership/share on this resource
    # They can see it (list endpoints show it) → effective = "view"
    return "view"


def require_edit_access(db: Session, user: User, resource, module: str):
    """Raise 403 if user cannot edit the resource (effective < edit)."""
    eff = get_effective_permission(db, user, resource, module)
    if LEVEL_ORDER.get(eff, 0) < LEVEL_ORDER["edit"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied: edit access required",
        )


def require_full_access(db: Session, user: User, resource, module: str):
    """Raise 403 if user cannot delete/share the resource (effective < full)."""
    eff = get_effective_permission(db, user, resource, module)
    if eff != "full":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied: owner or full access required",
        )
