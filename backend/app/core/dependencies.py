"""
Authentication dependencies — get_current_user, require_permission,
resource-level permission helpers.

Token is extracted from:
  1. httpOnly cookie named 'access_token'
  2. Authorization: Bearer <token> header (for AI service / API clients)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Sequence, Tuple

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.personal_access_tokens import (
    PAT_TOKEN_PREFIX,
    parse_personal_access_token,
    verify_personal_access_token_secret,
)
from app.models.personal_access_token import PersonalAccessToken
from app.models.user import User, UserStatus
from app.models.resource_share import ResourceShare, ResourceType
from app.models.revoked_token import RevokedToken

import logging as _logging
_dep_logger = _logging.getLogger(__name__)

_bearer = HTTPBearer(auto_error=False)

ALGORITHM = "HS256"
AUTH_TOKEN_KIND_ATTR = "_auth_token_kind"
PERSONAL_ACCESS_TOKEN_ID_ATTR = "_personal_access_token_id"
PERSONAL_ACCESS_TOKEN_NAME_ATTR = "_personal_access_token_name"
TOKEN_PERMISSION_CAPS_ATTR = "_permission_caps"
MODULE_KEYS = (
    "data_sources",
    "datasets",
    "explore_charts",
    "dashboards",
    "report_templates",
    "ai_chat",
    "ai_agent",
    "settings",
)


def _extract_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
) -> str | None:
    """Extract JWT from cookie or Authorization header."""
    if (
        credentials
        and credentials.scheme.lower() == "bearer"
        and credentials.credentials.startswith(PAT_TOKEN_PREFIX)
    ):
        return credentials.credentials
    # 1. httpOnly cookie (preferred for browser clients)
    token = request.cookies.get("access_token")
    if token:
        return token
    # 2. Authorization: Bearer header (API / ai-service / WS query param)
    if credentials and credentials.scheme.lower() == "bearer":
        return credentials.credentials
    return None


def _stamp_auth_context(
    user: User,
    *,
    token_kind: str,
    permission_caps: dict[str, str] | None = None,
    token_id: uuid.UUID | None = None,
    token_name: str | None = None,
) -> User:
    setattr(user, AUTH_TOKEN_KIND_ATTR, token_kind)
    if permission_caps:
        setattr(user, TOKEN_PERMISSION_CAPS_ATTR, permission_caps)
    if token_id is not None:
        setattr(user, PERSONAL_ACCESS_TOKEN_ID_ATTR, token_id)
    if token_name:
        setattr(user, PERSONAL_ACCESS_TOKEN_NAME_ATTR, token_name)
    return user


def _authenticate_personal_access_token(token: str, db: Session) -> User:
    parsed = parse_personal_access_token(token)
    if not parsed:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token_id, secret = parsed
    pat = db.query(PersonalAccessToken).filter(PersonalAccessToken.id == token_id).first()
    now = datetime.now(timezone.utc)

    if not pat or pat.revoked_at or (pat.expires_at and pat.expires_at <= now):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not verify_personal_access_token_secret(secret, pat.secret_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if pat.last_used_at is None or (now - pat.last_used_at).total_seconds() >= 60:
        pat.last_used_at = now
        db.commit()

    user = db.query(User).filter(User.id == pat.owner_id).first()
    if not user or user.status != UserStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or deactivated",
        )

    return _stamp_auth_context(
        user,
        token_kind="personal_access_token",
        permission_caps=pat.scopes or {},
        token_id=pat.id,
        token_name=pat.name,
    )


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
    if token.startswith(PAT_TOKEN_PREFIX):
        return _authenticate_personal_access_token(token, db)
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str | None = payload.get("sub")
        if not user_id:
            raise ValueError("missing sub")
        # Check server-side revocation blacklist
        jti = payload.get("jti")
        if jti:
            revoked = db.query(RevokedToken).filter(RevokedToken.jti == jti).first()
            if revoked:
                raise ValueError("token revoked")
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
    return _stamp_auth_context(user, token_kind="session")


# Module permission levels — order matters for comparison
LEVEL_ORDER = {"none": 0, "view": 1, "edit": 2, "full": 3}


def _normalize_permissions(user: User) -> dict:
    perms: dict = user.permissions or {}
    normalized = dict(perms)

    if "ai_agent" not in normalized:
        ai_chat_level = normalized.get("ai_chat", "none")
        dashboards_level = normalized.get("dashboards", "none")
        charts_level = normalized.get("explore_charts", "none")
        if (
            LEVEL_ORDER.get(ai_chat_level, 0) >= LEVEL_ORDER["edit"]
            and LEVEL_ORDER.get(dashboards_level, 0) >= LEVEL_ORDER["edit"]
            and LEVEL_ORDER.get(charts_level, 0) >= LEVEL_ORDER["edit"]
        ):
            normalized["ai_agent"] = "edit"
        else:
            normalized["ai_agent"] = "none"

    if "report_templates" not in normalized:
        normalized["report_templates"] = normalized.get("dashboards", "none")

    caps = _get_permission_caps(user)
    if caps:
        for module in MODULE_KEYS:
            normalized[module] = _min_permission_level(
                normalized.get(module, "none"),
                caps.get(module, "none"),
            )

    return normalized


def _sanitize_permission_level(level: str | None) -> str:
    text = str(level or "none").strip().lower()
    return text if text in LEVEL_ORDER else "none"


def _min_permission_level(left: str | None, right: str | None) -> str:
    left_level = _sanitize_permission_level(left)
    right_level = _sanitize_permission_level(right)
    if LEVEL_ORDER[left_level] <= LEVEL_ORDER[right_level]:
        return left_level
    return right_level


def _get_permission_caps(user: User) -> dict[str, str]:
    caps = getattr(user, TOKEN_PERMISSION_CAPS_ATTR, None)
    if not isinstance(caps, dict):
        return {}
    return {
        module: _sanitize_permission_level(level)
        for module, level in caps.items()
        if isinstance(module, str)
    }


def _cap_effective_permission(user: User, module: str, level: str) -> str:
    caps = _get_permission_caps(user)
    if not caps:
        return _sanitize_permission_level(level)
    return _min_permission_level(level, caps.get(module, "none"))


def require_permission(module: str, min_level: str = "view"):
    """
    FastAPI dependency factory for module-level permission checks.

    Usage:
        current_user: User = Depends(require_permission("dashboards", "edit"))

    Levels (ascending): none < view < edit < full
    Admins with settings=full always pass any non-settings check.
    """
    async def _check(user: User = Depends(get_current_user)) -> User:
        perms = _normalize_permissions(user)
        user_level = perms.get(module, "none")
        if LEVEL_ORDER.get(user_level, 0) < LEVEL_ORDER.get(min_level, 0):
            _dep_logger.warning(
                "PERMISSION_DENIED user=%s module=%s required=%s actual=%s",
                user.id, module, min_level, user_level,
            )
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
    "Dataset": ResourceType.DATASET,
}

_MODEL_TO_MODULE = {
    "DataSource": "data_sources",
    "Chart": "explore_charts",
    "Dashboard": "dashboards",
    "Dataset": "datasets",
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
    perms = _normalize_permissions(user)
    module_level = perms.get(module, "none")

    if module_level == "none":
        return "none"
    if module_level == "full":
        return _cap_effective_permission(user, module, "full")

    # Owner check
    owner_id = getattr(resource, "owner_id", None)
    if owner_id is not None and str(owner_id) == str(user.id):
        return _cap_effective_permission(user, module, "full")

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
                return _cap_effective_permission(user, module, share_level)
            return _cap_effective_permission(user, module, module_level)

    # Module access alone is not enough for object-level reads.
    # List endpoints must opt into broader visibility explicitly.
    return "none"


def batch_effective_permissions(
    db: Session,
    user: User,
    resources: list,
    module: str,
) -> dict[int, str]:
    """
    Batch version of get_effective_permission for list endpoints.
    Returns {resource.id: permission_level} using a single DB query for shares.
    """
    perms = _normalize_permissions(user)
    module_level = perms.get(module, "none")

    result: dict[int, str] = {}

    if module_level == "none":
        for r in resources:
            result[r.id] = "none"
        return result
    if module_level == "full":
        for r in resources:
            result[r.id] = "full"
        return {
            resource_id: _cap_effective_permission(user, module, level)
            for resource_id, level in result.items()
        }

    # Pre-fetch all shares for these resources in one query
    if not resources:
        return result

    class_name = type(resources[0]).__name__
    rt = _MODEL_TO_RESOURCE_TYPE.get(class_name)
    share_lookup: dict[str, str] = {}

    if rt:
        resource_ids = [str(r.id) for r in resources]
        shares = (
            db.query(ResourceShare.resource_id, ResourceShare.permission)
            .filter(
                ResourceShare.resource_type == rt,
                ResourceShare.resource_id.in_(resource_ids),
                ResourceShare.user_id == user.id,
            )
            .all()
        )
        share_lookup = {s.resource_id: s.permission.value for s in shares}

    for r in resources:
        owner_id = getattr(r, "owner_id", None)
        if owner_id is not None and str(owner_id) == str(user.id):
            result[r.id] = _cap_effective_permission(user, module, "full")
            continue

        share_level = share_lookup.get(str(r.id))
        if share_level:
            if LEVEL_ORDER.get(share_level, 0) <= LEVEL_ORDER.get(module_level, 0):
                result[r.id] = _cap_effective_permission(user, module, share_level)
            else:
                result[r.id] = _cap_effective_permission(user, module, module_level)
            continue

        result[r.id] = "none"

    return result


def require_view_access(db: Session, user: User, resource, module: str) -> str:
    """Raise 403 if user cannot view the resource (effective == none)."""
    eff = get_effective_permission(db, user, resource, module)
    if eff == "none":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied: view access required",
        )
    return eff


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
