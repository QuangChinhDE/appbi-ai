"""App-user authentication for workspace public links.

Workspace end-users (workers, foremen, drivers…) do **not** have AppBI
accounts. They authenticate against rows in ``workboard_app_users`` —
identity owned by the workboard itself, *not* by any project dataset.

Why this lives here and not in business data
--------------------------------------------
* Re-importing a dataset (e.g. updated Excel headers) used to invalidate
  legacy dataset-backed user wiring when table ids changed. With identity
  in AppBI's own DB that whole class of drift just disappears.
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

import json
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
from app.modules.workboards.roles import normalize_app_user_role
from app.modules.workboards.roles import DEFAULT_APP_USER_PIN

logger = get_logger(__name__)

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

_SESSION_TYPE = "workspace_app_user"
_LOGIN_FAIL_WINDOW_MINUTES = 15
_LOGIN_FAIL_THRESHOLD = 5
_MANAGER_CONTEXT_KEYS = ("manager_username", "reports_to", "manager_usernames")
_SCOPE_USER_CONTEXT_KEYS = (
    "scope_usernames",
    "managed_usernames",
    "visible_usernames",
)
_SCOPE_ADMIN_CONTEXT_KEYS = (
    "scope_admin_usernames",
    "managed_admins",
    "managed_admin_usernames",
)


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


def is_default_pin_hash(stored: Optional[str]) -> bool:
    return verify_pin(DEFAULT_APP_USER_PIN, stored)


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


def _dedupe_strings(values: List[str]) -> List[str]:
    seen: set[str] = set()
    out: List[str] = []
    for value in values:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _as_string_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        if text.startswith("[") and text.endswith("]"):
            try:
                parsed = json.loads(text)
            except Exception:
                parsed = None
            if isinstance(parsed, list):
                return _as_string_list(parsed)
        return _dedupe_strings([part.strip() for part in text.split(",")])
    if isinstance(value, (list, tuple, set)):
        return _dedupe_strings([str(item).strip() for item in value])
    text = str(value).strip()
    return [text] if text else []


def _context_string_list(
    context: Dict[str, Any],
    keys: Tuple[str, ...],
) -> List[str]:
    values: List[str] = []
    for key in keys:
        values.extend(_as_string_list(context.get(key)))
    return _dedupe_strings(values)


def compute_scope_context(db: Session, user: WorkboardAppUser) -> Dict[str, Any]:
    """Return computed mini-app hierarchy fields for an app user.

    Stored app-user context remains the source of truth:
    - manager_username/reports_to marks a direct parent.
    - scope_admin_usernames/managed_admins grants visibility into other
      admin branches.
    - scope_usernames/managed_usernames grants explicit direct usernames.
    """
    if db is None or user is None:
        return {}

    rows: List[WorkboardAppUser] = (
        db.query(WorkboardAppUser)
        .filter(
            WorkboardAppUser.workboard_id == user.workboard_id,
            WorkboardAppUser.active.is_(True),
        )
        .all()
    )
    by_username = {row.username: row for row in rows if row.username}
    children_by_manager: Dict[str, List[str]] = {}
    for row in rows:
        context = dict(row.context or {})
        for manager in _context_string_list(context, _MANAGER_CONTEXT_KEYS):
            children_by_manager.setdefault(manager, []).append(row.username)

    own_context = dict(user.context or {})
    manager_usernames = _context_string_list(own_context, _MANAGER_CONTEXT_KEYS)
    direct_reports = _dedupe_strings(children_by_manager.get(user.username, []))

    root_admins = _context_string_list(own_context, _SCOPE_ADMIN_CONTEXT_KEYS)
    explicit_users = _context_string_list(own_context, _SCOPE_USER_CONTEXT_KEYS)
    stack = _dedupe_strings([user.username, *root_admins, *explicit_users])
    seen: set[str] = set()
    scope_usernames: List[str] = []
    scope_admin_usernames: List[str] = []

    while stack:
        username = stack.pop(0)
        if username in seen:
            continue
        seen.add(username)
        scope_usernames.append(username)

        scoped_user = by_username.get(username)
        if (
            scoped_user is not None
            and normalize_app_user_role(scoped_user.role) == "admin"
        ):
            scope_admin_usernames.append(username)

        for child_username in children_by_manager.get(username, []):
            if child_username not in seen:
                stack.append(child_username)

    return {
        "manager_username": manager_usernames[0] if manager_usernames else None,
        "manager_usernames": manager_usernames,
        "direct_report_usernames": direct_reports,
        "scope_usernames": scope_usernames,
        "scope_admin_usernames": _dedupe_strings(scope_admin_usernames),
    }


def app_user_to_payload(
    user: WorkboardAppUser,
    scope_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Serialise a WorkboardAppUser row to the dict the runtime carries
    around in the JWT and feeds to RLS placeholders.
    """
    payload: Dict[str, Any] = {
        "username": user.username,
        "role": normalize_app_user_role(user.role),
        "full_name": user.full_name,
        "workboard_id": user.workboard_id,
    }
    for k, v in (user.context or {}).items():
        # Don't let context overwrite the canonical identity keys.
        if k not in payload:
            payload[k] = v
    for k, v in (scope_context or {}).items():
        if k not in {"username", "role", "full_name", "workboard_id"}:
            payload[k] = v
    return payload


def can_app_user_access_workboard(
    db: Session,
    workboard: Workboard,
    app_user: Dict[str, Any],
) -> bool:
    """True when the JWT identity is allowed to open ``workboard``.

    AppBI staff (preview/internal-mode sessions) bypass; otherwise the
    identity must originate from this workboard's own app-user rows -
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
    db: Optional[Session] = None,
    extra_claims: Optional[Dict[str, Any]] = None,
) -> Tuple[str, int]:
    ttl = max(int(workspace.session_ttl_seconds or 28800), 60)
    now = datetime.now(timezone.utc)
    scope_context = compute_scope_context(db, user) if db is not None else None
    payload: Dict[str, Any] = {
        "sub": user.username,
        "type": _SESSION_TYPE,
        "ws": workspace.token,
        "exp": now + timedelta(seconds=ttl),
        "iat": now,
        "app_user": app_user_to_payload(user, scope_context=scope_context),
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
