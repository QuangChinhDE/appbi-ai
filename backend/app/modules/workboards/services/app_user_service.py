"""App-user authentication for workspace public links.

Workspace end-users (workers, foremen, drivers…) do **not** have AppBI
accounts. They authenticate against rows in ``workboard_app_users`` —
identity owned by the workboard itself, *not* by any project dataset.

Why this lives here and not in business data
--------------------------------------------
* Re-importing a dataset (e.g. updated Excel headers) used to silently
  invalidate the workspace's ``app_users_config`` because the dataset
  table id changed. With identity in AppBI's own DB that whole class of
  drift just disappears.
* PIN hashes never travel through dataset previews / chart endpoints /
  shared link APIs, so misconfiguration can't leak credentials.
* Schema is fixed (username/role/active/context); admins manage users
  through the Builder "Users" tab instead of editing dataset rows.

Login probes every workboard listed in the workspace's ``menu_config``
in order and stops at the first row whose (username, pin) verifies. The
``visible_for_roles`` per-screen / per-workboard filter then hides
mini-apps the matched user can't run.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.dependencies import ALGORITHM
from app.core.logging import get_logger
from app.modules.workboards.models import (
    Workboard,
    WorkboardAppLoginAttempt,
    WorkboardAppUser,
    WorkboardWorkspace,
)

logger = get_logger(__name__)

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

_SESSION_TYPE = "workspace_app_user"
_LOGIN_FAIL_WINDOW_MINUTES = 15
_LOGIN_FAIL_THRESHOLD = 5


# ── Hash helpers ──────────────────────────────────────────────────────────


def hash_pin(plain: str) -> str:
    """Bcrypt-hash a plaintext PIN. Used by admin CRUD + import flow."""
    return _pwd_ctx.hash(plain)


def verify_pin(plain: str, stored: Optional[str]) -> bool:
    if not stored:
        return False
    try:
        return _pwd_ctx.verify(plain, stored)
    except Exception:
        return False


# ── Workspace lookup ──────────────────────────────────────────────────────


def get_workspace_by_token(db: Session, token: str) -> Optional[WorkboardWorkspace]:
    if not token:
        return None
    return (
        db.query(WorkboardWorkspace)
        .filter(WorkboardWorkspace.token == token)
        .filter(WorkboardWorkspace.is_active.is_(True))
        .first()
    )


def list_workspace_workboards(
    db: Session,
    workspace: WorkboardWorkspace,
) -> List[Workboard]:
    """Return Workboard rows in menu order. Missing slugs are skipped."""
    slugs = [
        str(item.get("workboard_slug") or "").strip()
        for item in (workspace.menu_config or [])
        if isinstance(item, dict) and item.get("workboard_slug")
    ]
    slugs = [s for s in slugs if s]
    if not slugs:
        return []
    rows = db.query(Workboard).filter(Workboard.slug.in_(slugs)).all()
    by_slug = {wb.slug: wb for wb in rows}
    return [by_slug[s] for s in slugs if s in by_slug]


# ── Identity helpers ──────────────────────────────────────────────────────


def app_user_to_payload(user: WorkboardAppUser) -> Dict[str, Any]:
    """Serialise a WorkboardAppUser row to the dict the runtime carries
    around in the JWT and feeds to RLS placeholders.
    """
    payload: Dict[str, Any] = {
        "username": user.username,
        "role": user.role,
        "full_name": user.full_name,
        "workboard_id": user.workboard_id,
    }
    for k, v in (user.context or {}).items():
        # Don't let context overwrite the canonical identity keys.
        if k not in payload:
            payload[k] = v
    return payload


def can_app_user_access_workboard(
    db: Session,
    workboard: Workboard,
    app_user: Dict[str, Any],
) -> bool:
    """True when the JWT identity is allowed to open ``workboard``.

    AppBI staff (preview/internal-mode sessions) bypass; otherwise the
    identity must originate from this workboard's own users table —
    confirmed by the ``workboard_id`` claim baked into the JWT at login.
    """
    if not isinstance(app_user, dict):
        return False
    if app_user.get("_internal"):
        return True
    bound = app_user.get("workboard_id")
    if bound is None:
        # Legacy session minted before this migration — let it through but
        # log so we can spot lingering stale tokens.
        logger.info(
            "app_user session has no workboard_id binding (legacy token)"
        )
        return True
    try:
        return int(bound) == int(workboard.id)
    except (TypeError, ValueError):
        return False


# ── Rate limiting ─────────────────────────────────────────────────────────


def _recent_failures(
    db: Session,
    workspace_id: int,
    username: str,
    ip: Optional[str],
) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=_LOGIN_FAIL_WINDOW_MINUTES)
    q = db.query(func.count(WorkboardAppLoginAttempt.id)).filter(
        WorkboardAppLoginAttempt.workspace_id == workspace_id,
        WorkboardAppLoginAttempt.username_attempted == username,
        WorkboardAppLoginAttempt.success.is_(False),
        WorkboardAppLoginAttempt.attempted_at >= cutoff,
    )
    if ip:
        q = q.filter(WorkboardAppLoginAttempt.ip_address == ip)
    return int(q.scalar() or 0)


def _record_attempt(
    db: Session,
    workspace_id: int,
    username: str,
    ip: Optional[str],
    success: bool,
) -> None:
    attempt = WorkboardAppLoginAttempt(
        workspace_id=workspace_id,
        username_attempted=username[:255],
        ip_address=(ip or "")[:64] or None,
        success=success,
    )
    db.add(attempt)
    db.commit()


# ── Session JWT ───────────────────────────────────────────────────────────


def create_session_token(
    workspace: WorkboardWorkspace,
    user: WorkboardAppUser,
    *,
    extra_claims: Optional[Dict[str, Any]] = None,
) -> Tuple[str, int]:
    ttl = max(int(workspace.session_ttl_seconds or 28800), 60)
    now = datetime.now(timezone.utc)
    payload: Dict[str, Any] = {
        "sub": user.username,
        "type": _SESSION_TYPE,
        "ws": workspace.token,
        "exp": now + timedelta(seconds=ttl),
        "iat": now,
        "app_user": app_user_to_payload(user),
    }
    if extra_claims:
        for key, value in extra_claims.items():
            if key not in payload:
                payload[key] = value
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)
    return token, ttl


def create_internal_session_token(
    workspace: WorkboardWorkspace,
    *,
    appbi_user: Any,
    extra_claims: Optional[Dict[str, Any]] = None,
) -> Tuple[str, int]:
    """Mint a workspace session for an AppBI staff member (no workboard binding).

    Used by ``access_mode='internal'`` workspaces and by the admin preview
    flow so the iframe runtime gets a workspace cookie just like the
    public flow, except the embedded ``app_user`` carries the AppBI
    user's identity instead of a row from ``workboard_app_users``. The
    ``_internal`` flag tells the per-workboard guard to bypass the
    workboard-binding check.
    """
    ttl = max(int(workspace.session_ttl_seconds or 28800), 60)
    now = datetime.now(timezone.utc)
    username = str(getattr(appbi_user, "email", "") or getattr(appbi_user, "id", ""))
    full_name = getattr(appbi_user, "full_name", None) or username
    payload: Dict[str, Any] = {
        "sub": username,
        "type": _SESSION_TYPE,
        "ws": workspace.token,
        "exp": now + timedelta(seconds=ttl),
        "iat": now,
        "app_user": {
            "username": username,
            "role": "appbi_staff",
            "full_name": full_name,
            "_internal": True,
        },
    }
    if extra_claims:
        for key, value in extra_claims.items():
            if key not in payload:
                payload[key] = value
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)
    return token, ttl


def decode_session_token(
    token: str,
    expected_workspace_token: str,
) -> Optional[Dict[str, Any]]:
    if not token:
        return None
    try:
        data = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None
    if data.get("type") != _SESSION_TYPE:
        return None
    if data.get("ws") != expected_workspace_token:
        return None
    return data


# ── Login orchestration ───────────────────────────────────────────────────


def authenticate(
    db: Session,
    workspace: WorkboardWorkspace,
    username: str,
    pin: str,
    *,
    ip: Optional[str] = None,
) -> Tuple[WorkboardAppUser, Workboard]:
    """Verify (username, pin) against every workboard in the menu.

    Probes workboards in menu order and stops at the first row whose
    bcrypt-verified PIN matches and whose ``active=true``. Returns the
    matched ``WorkboardAppUser`` plus its parent ``Workboard`` so the
    caller can mint a session JWT bound to the right workboard.
    """
    if (workspace.access_mode or "internal") != "public_app_users":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Workspace này dùng access_mode='internal' — chỉ AppBI staff "
                "đã đăng nhập mới truy cập được, không có flow login PIN."
            ),
        )

    workboards = list_workspace_workboards(db, workspace)
    if not workboards:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Workspace chưa gắn workboard nào trong menu. Vào Workspace "
                "settings để thêm workboard trước khi cho user đăng nhập."
            ),
        )

    failures = _recent_failures(db, workspace.id, username, ip)
    if failures >= _LOGIN_FAIL_THRESHOLD:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"Too many failed login attempts. Try again in "
                f"{_LOGIN_FAIL_WINDOW_MINUTES} minutes."
            ),
        )

    deactivated_match = False
    workboard_ids = [wb.id for wb in workboards]
    candidates: List[WorkboardAppUser] = (
        db.query(WorkboardAppUser)
        .filter(
            WorkboardAppUser.workboard_id.in_(workboard_ids),
            WorkboardAppUser.username == username,
        )
        .all()
    )
    by_wb_id: Dict[int, WorkboardAppUser] = {c.workboard_id: c for c in candidates}

    for wb in workboards:
        candidate = by_wb_id.get(wb.id)
        if candidate is None:
            continue
        if not candidate.active:
            deactivated_match = True
            continue
        if not verify_pin(pin, candidate.pin_hash):
            continue
        _record_attempt(db, workspace.id, username, ip, success=True)
        return candidate, wb

    _record_attempt(db, workspace.id, username, ip, success=False)
    if deactivated_match:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been deactivated. Contact your administrator.",
        )
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid username or PIN.",
    )


# ── Duplicate-username guard ──────────────────────────────────────────────


def usernames_already_taken_outside(
    db: Session,
    *,
    workboard_id: int,
    usernames: List[str],
) -> Dict[str, List[Dict[str, Any]]]:
    """Find usernames that already exist in *another* workboard sharing a
    workspace menu with this one.

    The public login form has no idea which workboard a username belongs
    to until match time, so two workboards on the same workspace must not
    register the same username — the second login attempt would always
    win against whichever workboard came first in the menu order. We
    surface the conflicts on create/import so admins fix them up front
    instead of getting silent first-match-wins behaviour at runtime.

    Returns ``{username: [{"workspace_id": int, "workspace_name": str,
    "workboard_id": int, "workboard_name": str}, …]}`` for any username
    that conflicts. An empty dict means safe to insert.
    """
    if not usernames:
        return {}

    workboard = (
        db.query(Workboard).filter(Workboard.id == workboard_id).first()
    )
    if workboard is None or not workboard.slug:
        return {}

    # Workspaces that include this workboard via menu_config.
    related_workspaces = (
        db.query(WorkboardWorkspace)
        .filter(
            WorkboardWorkspace.menu_config.cast(_jsonb_text()).like(
                f"%\"{workboard.slug}\"%"
            )
        )
        .all()
    )

    sibling_slugs: set[str] = set()
    by_slug_workspace: Dict[str, WorkboardWorkspace] = {}
    for ws in related_workspaces:
        for item in ws.menu_config or []:
            if not isinstance(item, dict):
                continue
            slug = (item.get("workboard_slug") or "").strip()
            if slug and slug != workboard.slug:
                sibling_slugs.add(slug)
                by_slug_workspace.setdefault(slug, ws)
    if not sibling_slugs:
        return {}

    siblings = (
        db.query(Workboard).filter(Workboard.slug.in_(list(sibling_slugs))).all()
    )
    sibling_ids = [w.id for w in siblings]
    if not sibling_ids:
        return {}
    by_id = {w.id: w for w in siblings}

    conflicts = (
        db.query(WorkboardAppUser)
        .filter(
            WorkboardAppUser.workboard_id.in_(sibling_ids),
            WorkboardAppUser.username.in_(list(set(usernames))),
        )
        .all()
    )

    out: Dict[str, List[Dict[str, Any]]] = {}
    for hit in conflicts:
        wb = by_id.get(hit.workboard_id)
        if wb is None:
            continue
        ws = by_slug_workspace.get(wb.slug or "")
        out.setdefault(hit.username, []).append(
            {
                "workspace_id": ws.id if ws else None,
                "workspace_name": ws.name if ws else None,
                "workboard_id": wb.id,
                "workboard_name": wb.name,
            }
        )
    return out


def _jsonb_text():
    """Cast helper so we can do a string-LIKE on JSONB menu_config without
    pulling sqlalchemy.dialects.postgresql at the top of the file."""
    from sqlalchemy import String

    return String
