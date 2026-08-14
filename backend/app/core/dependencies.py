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
from app.core.resource_shares import get_highest_share_for_resource, get_highest_share_permissions
from app.models.personal_access_token import PersonalAccessToken
from app.models.user import User, UserStatus
from app.models.resource_share import ResourceType
from app.models.revoked_token import RevokedToken

import logging as _logging
_dep_logger = _logging.getLogger(__name__)

_bearer = HTTPBearer(auto_error=False)

ALGORITHM = "HS256"
#: `type` claim carried by an access token. Refresh tokens use "refresh", public
#: links and workspace sessions use their own values — all signed with the SAME
#: key, so the claim is the only thing separating them.
ACCESS_TOKEN_TYPE = "access"
AUTH_TOKEN_KIND_ATTR = "_auth_token_kind"
PERSONAL_ACCESS_TOKEN_ID_ATTR = "_personal_access_token_id"
PERSONAL_ACCESS_TOKEN_NAME_ATTR = "_personal_access_token_name"
TOKEN_PERMISSION_CAPS_ATTR = "_permission_caps"
#: THE canonical module list. Every other module-key list in the codebase is
#: derived from this one (see api/permissions.py::_ALL_MODULES), because keeping a
#: second hand-maintained copy is what let `agent_flows` be added to the admin
#: matrix while staying invisible to the personal-access-token cap below — a token
#: scoped to `dashboards: view` could still publish an agent flow.
#: Order is the order the admin matrix renders in.
MODULE_KEYS = (
    "data_sources",
    "datasets",
    "govern",
    "agent_flows",
    "observability",
    "explore_charts",
    "dashboards",
    "workboards",
    "settings",
)

# Nothing inherits any more. The four Intelligence keys existed because one
# Knowledge Hub was presented as five sidebar modules, and inheritance from the
# legacy 'govern' level was what kept users working through that split. The
# modules are gone: AI Readiness, AI Suggestions and AI Guidance were deleted, and
# Metrics & Terms became a tab inside Datasets, granted by `datasets`. A module
# each user can point at, and one key per module — which is what the rest of the
# matrix always did.
INTELLIGENCE_INHERIT: tuple[str, ...] = ()


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
        # One signing key mints four different tokens (access, refresh, public-link
        # session, workspace session) and only the `type` claim tells them apart.
        # Without this check a REFRESH token worked as an access token: 7 days of
        # access instead of 2 hours, and it side-stepped the rotate-on-use flow that
        # makes refresh tokens single-use. Absent claim = a legacy access token
        # issued before access tokens were stamped; those stay valid until they
        # expire on their own.
        token_type = payload.get("type")
        if token_type is not None and token_type != ACCESS_TOKEN_TYPE:
            raise ValueError("wrong token type")
        user_id: str | None = payload.get("sub")
        if not user_id:
            raise ValueError("missing sub")
        # Check server-side revocation blacklist
        jti = payload.get("jti")
        if jti:
            revoked = db.query(RevokedToken).filter(RevokedToken.jti == jti).first()
            if revoked:
                raise ValueError("token revoked")
        # Parsed inside the try: a token whose `sub` is not a UUID is an
        # authentication failure (401), not an unhandled 500.
        user_uuid = uuid.UUID(user_id)
    except (JWTError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.query(User).filter(User.id == user_uuid).first()
    if not user or user.status != UserStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or deactivated",
        )
    return _stamp_auth_context(user, token_kind="session")


# Module permission levels — order matters for comparison
LEVEL_ORDER = {"none": 0, "view": 1, "edit": 2, "full": 3}


def _normalize_permissions(user: User) -> dict:
    """The user's permissions as every reader must see them.

    THIS IS THE ONE PLACE THE TWO IMPLICIT RULES LIVE. Both used to be written out
    again at each call site, and they had drifted apart:

    * `require_permission` back-filled the admin rule, so an administrator whose
      row predates a module PASSED the route gate.
    * `api/permissions._get_user_permissions` back-filled it too, so the Settings
      matrix DISPLAYED that module as "full".
    * This function did not, so `get_user_module_permission` → `_owned_or_shared`
      answered `none` and filtered every row away.

    The result was a door that opened onto an empty room: an admin could reach
    /govern and /agent-flows, was told they had full access, and saw nothing —
    because `agent_flows` and `govern` were simply absent from their JSONB and
    nothing had ever migrated them in.

    ADMIN BACK-FILL — a user with `settings: full` implicitly holds any module key
    that is ABSENT from their row. An explicitly stored level (including "none") is
    always respected, so revoking a module still works.

    TOKEN SCOPE — applied AFTER the back-fill, so a scoped personal access token is
    still capped by what it actually asked for; an implicit `full` a token never
    named is capped straight back to `none`.
    """
    perms: dict = user.permissions or {}
    normalized = dict(perms)

    if _sanitize_permission_level(normalized.get("settings")) == "full":
        for module in MODULE_KEYS:
            if module != "settings" and module not in perms:
                normalized[module] = "full"

    caps = _get_permission_caps(user)
    if caps:
        for module in set(MODULE_KEYS) | set(normalized):
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
        # The admin back-fill and the token cap both live in
        # `_normalize_permissions` now. This function used to re-implement the
        # back-fill locally, which is how the route gate came to disagree with the
        # data filter: the door opened, the room was empty.
        perms = _normalize_permissions(user)
        user_level = perms.get(module, "none")
        # Intelligence group inherits the legacy 'govern' level when its own key
        # is not explicitly set (keeps existing govern:X users fully working).
        raw_perms = user.permissions or {}
        if module in INTELLIGENCE_INHERIT and module not in raw_perms and "govern" in raw_perms:
            user_level = perms.get("govern", "none")
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
    "Workboard": ResourceType.WORKBOARD,
    "GovernKnowledgeDoc": ResourceType.KNOWLEDGE_DOC,
    # Was missing here while present in core.permissions._RESOURCE_TO_MODULE — the
    # two maps are the same fact written twice, and they had drifted. Without this
    # entry no share on a brain could ever be found, so object-level checks on a
    # flow silently fell through to "not shared".
    "AgentBrainVersion": ResourceType.AGENT_BRAIN,
}

_MODEL_TO_MODULE = {
    "DataSource": "data_sources",
    "Chart": "explore_charts",
    "Dashboard": "dashboards",
    "Dataset": "datasets",
    "Workboard": "workboards",
    "GovernKnowledgeDoc": "govern",
    "AgentBrainVersion": "agent_flows",
}


def _share_key_for(resource) -> str:
    """The id a ResourceShare row carries for *resource*.

    Almost always the primary key. An agent flow is the exception: its shares are
    keyed by `brain_key` so one share covers the flow across every version of it,
    rather than pinning to the version row that happened to exist at the time.
    """
    brain_key = getattr(resource, "brain_key", None)
    if brain_key:
        return str(brain_key)
    return str(getattr(resource, "id", ""))


def _relation_level(db: Session, user: User, resource, module_level: str) -> str:
    """How *user* is attached to THIS row, independent of their module ceiling.

    Returns 'full' (owner, or a module-wide administrator), the share's level for a
    shared row, or 'none'. Kept separate from the module level so the two questions
    a permission check actually asks stay separate:

        "how far may this user go in this module?"   → module_level
        "what is this user to this particular row?"  → _relation_level

    Module access alone is never enough for an object-level read; a row the user
    neither owns nor was given returns 'none'.
    """
    if _sanitize_permission_level(module_level) == "full":
        return "full"

    owner_id = getattr(resource, "owner_id", None)
    if owner_id is not None and str(owner_id) == str(user.id):
        return "full"

    # Some tables key ownership by email rather than by FK (agent_brain_versions).
    owner_email = getattr(resource, "owner_email", None)
    user_email = str(getattr(user, "email", "") or "").strip().lower()
    if owner_email and user_email and str(owner_email).strip().lower() == user_email:
        return "full"

    class_name = type(resource).__name__
    rt = _MODEL_TO_RESOURCE_TYPE.get(class_name)
    if rt:
        share = get_highest_share_for_resource(db, user, rt, _share_key_for(resource))
        if share:
            return _sanitize_permission_level(share.permission.value)

    return "none"


def get_effective_permission(db: Session, user: User, resource, module: str) -> str:
    """
    Compute the effective permission for *user* on a specific *resource*.

    Returns one of: 'none', 'view', 'edit', 'full'.

    THE RULE:

        relation = 'full' if owner or module-administrator
                 | the share's level if shared
                 | 'none'

        module none                    → none
        no relation                    → none
        relation full AND module ≥edit → full   (they manage THIS row outright)
        otherwise                      → min(module_level, relation)

    The module level is a CEILING on what the user may do ACROSS the module — it
    decides which rows they can see at all. Within a row they own, an owner who is
    allowed to change anything (module ≥ edit) manages that row completely, which
    is why the third line returns `full` rather than `edit`.

    What this is NOT is the old behaviour, where an owner got `full` regardless of
    the module level. That made `view` indistinguishable from `edit` on anything a
    user owned: demoting somebody to view-only left them still able to update,
    delete, share and publish their own dashboards, and the module docstring
    promised "read-only, no CRUD". The `module ≥ edit` condition is the fix.

    This value is also what the API returns as `user_permission`, and the frontend
    keys "may I delete / share this?" off it being `full` — so the rule here and
    `require_full_access` below must stay in step, or the UI hides a button the API
    would have honoured.
    """
    perms = _normalize_permissions(user)
    module_level = _sanitize_permission_level(perms.get(module, "none"))

    if module_level == "none":
        return "none"

    relation = _relation_level(db, user, resource, module_level)
    if relation == "none":
        return "none"

    if relation == "full" and LEVEL_ORDER[module_level] >= LEVEL_ORDER["edit"]:
        return _cap_effective_permission(user, module, "full")

    return _cap_effective_permission(
        user, module, _min_permission_level(module_level, relation)
    )


def batch_effective_permissions(
    db: Session,
    user: User,
    resources: list,
    module: str,
) -> dict[int, str]:
    """
    Batch version of get_effective_permission for list endpoints.
    Returns {resource.id: permission_level} using a single DB query for shares.

    Must agree with get_effective_permission() row for row — including the
    min(module_level, relation) cap on owned rows, which is why the owner branch
    here goes through _min_permission_level rather than returning "full".
    """
    perms = _normalize_permissions(user)
    module_level = _sanitize_permission_level(perms.get(module, "none"))

    result: dict[int, str] = {}

    if module_level == "none":
        for r in resources:
            result[r.id] = "none"
        return result
    if module_level == "full":
        return {
            r.id: _cap_effective_permission(user, module, "full") for r in resources
        }

    # Pre-fetch all shares for these resources in one query
    if not resources:
        return result

    class_name = type(resources[0]).__name__
    rt = _MODEL_TO_RESOURCE_TYPE.get(class_name)
    share_lookup: dict[str, str] = {}

    if rt:
        resource_ids = [_share_key_for(r) for r in resources]
        share_lookup = get_highest_share_permissions(db, user, rt, resource_ids)

    user_email = str(getattr(user, "email", "") or "").strip().lower()

    for r in resources:
        owner_id = getattr(r, "owner_id", None)
        owner_email = getattr(r, "owner_email", None)
        is_owner = (owner_id is not None and str(owner_id) == str(user.id)) or bool(
            owner_email and user_email and str(owner_email).strip().lower() == user_email
        )

        relation = "full" if is_owner else share_lookup.get(_share_key_for(r)) or "none"
        if relation == "none":
            result[r.id] = "none"
            continue

        if relation == "full" and LEVEL_ORDER[module_level] >= LEVEL_ORDER["edit"]:
            result[r.id] = _cap_effective_permission(user, module, "full")
            continue

        result[r.id] = _cap_effective_permission(
            user, module, _min_permission_level(module_level, relation)
        )

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
    """Raise 403 unless the user MANAGES this resource — delete, share, publish.

    Deliberately just `effective == "full"`. `get_effective_permission` already
    encodes what managing means (own the row, or administer the module, and hold at
    least `edit` on it), and it is the same value the API hands the frontend as
    `user_permission`. One rule, one place: if this check and that value ever
    disagree, the UI hides a button the API would have allowed — which is exactly
    what happened when an earlier version of this function answered a different
    question from the one the response was reporting.
    """
    eff = get_effective_permission(db, user, resource, module)
    if eff != "full":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied: owner or full access required",
        )
