"""App-user authentication for workspace public links.

Workspace end-users (workers, foremen, drivers…) do **not** have AppBI
accounts. They authenticate against a project-owned table inside the
dataset; this module is the only place that turns a (username, pin) pair
into a verified app-user identity + a short-lived session JWT.

Design notes
------------
* The user list lives in the project's own dataset, never in AppBI's
  own ``users`` table. The workspace stores only a config pointer
  (``app_users_config``) telling us which table + columns to use.
* PINs are stored hashed via passlib's bcrypt scheme — same hashing the
  rest of the app uses for AppBI passwords. ``credential_kind`` is kept
  in the config so we can grow alternative schemes (argon2, sha256_salted)
  without a migration.
* Failed attempts are logged in ``workboard_app_login_attempts`` and used
  to enforce a sliding-window lockout (5 failures / 15 min / username+ip).
* Sessions are JWTs signed with ``settings.SECRET_KEY`` so we don't need a
  server-side store; the workspace's ``session_ttl_seconds`` controls TTL.
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
from app.models import DataSource
from app.models.dataset import DatasetTable
from app.modules.workboards.models import (
    WorkboardAppLoginAttempt,
    WorkboardWorkspace,
)
from app.modules.workboards.workspace_schemas import AppUsersConfig
from app.services.live_query_service import LiveQueryService

logger = get_logger(__name__)

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

_SESSION_TYPE = "workspace_app_user"
_LOGIN_FAIL_WINDOW_MINUTES = 15
_LOGIN_FAIL_THRESHOLD = 5


# ── Hash helpers ──────────────────────────────────────────────────────────

def hash_pin(plain: str) -> str:
    """Hash a plaintext PIN/password using bcrypt.

    IT/DE seed scripts call this once when inserting an app user; runtime
    code only ever verifies, never re-hashes existing values.
    """
    return _pwd_ctx.hash(plain)


def _verify_credential(plain: str, stored: Any, kind: str) -> bool:
    if not isinstance(stored, str) or not stored:
        return False
    if kind == "bcrypt":
        try:
            return _pwd_ctx.verify(plain, stored)
        except Exception:
            return False
    # Future: argon2, sha256_salted, ... — fail closed for now.
    return False


# ── Active-flag normalisation ─────────────────────────────────────────────

def _is_active(row: Dict[str, Any], cfg: AppUsersConfig) -> bool:
    if not cfg.active_column:
        return True
    raw = row.get(cfg.active_column)
    if cfg.active_value is not None:
        return raw == cfg.active_value
    if raw is None:
        return False
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return raw != 0
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "active", "enabled", "y", "t"}
    return bool(raw)


# ── Workspace lookup ──────────────────────────────────────────────────────

def get_workspace_by_token(db: Session, token: str) -> Optional[WorkboardWorkspace]:
    if not token:
        return None
    ws = (
        db.query(WorkboardWorkspace)
        .filter(WorkboardWorkspace.token == token)
        .filter(WorkboardWorkspace.is_active.is_(True))
        .first()
    )
    return ws


def parse_app_users_config(workspace: WorkboardWorkspace) -> Optional[AppUsersConfig]:
    raw = workspace.app_users_config or {}
    if not raw:
        return None
    try:
        return AppUsersConfig.model_validate(raw)
    except Exception:
        logger.exception("workspace #%s has invalid app_users_config", workspace.id)
        return None


# ── User table lookup ─────────────────────────────────────────────────────

def _load_dataset_table(db: Session, table_id: int) -> Optional[DatasetTable]:
    return db.query(DatasetTable).filter(DatasetTable.id == table_id).first()


def _load_datasource(db: Session, table: DatasetTable) -> Optional[DataSource]:
    return db.query(DataSource).filter(DataSource.id == table.datasource_id).first()


def _fetch_user_row(
    db: Session,
    cfg: AppUsersConfig,
    username: str,
) -> Optional[Dict[str, Any]]:
    """Return the matching row for ``username`` or None.

    We query through LiveQueryService so caching/cost-guards stay consistent
    with the rest of workboards. The rate of distinct username lookups is
    small (≤ 1 per attempted login) so this stays cheap even for tables
    with thousands of users.
    """
    table = _load_dataset_table(db, cfg.table_id)
    if table is None:
        logger.warning("app_users_config points to missing table_id=%s", cfg.table_id)
        return None
    datasource = _load_datasource(db, table)
    if datasource is None:
        logger.warning("app_users_config table_id=%s has no datasource", cfg.table_id)
        return None
    try:
        result = LiveQueryService.execute_preview_query(
            datasource,
            table,
            limit=2,
            offset=0,
            filters=[
                {
                    "field": cfg.username_column,
                    "operator": "eq",
                    "value": username,
                }
            ],
        )
    except Exception:
        logger.exception("app-user lookup failed (workspace dataset=%s)", cfg.table_id)
        return None
    rows: List[Dict[str, Any]] = result.get("rows") or []
    return rows[0] if rows else None


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

def _build_app_user_payload(
    username: str,
    cfg: AppUsersConfig,
    row: Dict[str, Any],
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"username": username}
    if cfg.role_column:
        payload["role"] = row.get(cfg.role_column)
    for col in cfg.context_columns or []:
        payload[col] = row.get(col)
    return payload


def create_session_token(
    workspace: WorkboardWorkspace,
    username: str,
    cfg: AppUsersConfig,
    row: Dict[str, Any],
    *,
    extra_claims: Optional[Dict[str, Any]] = None,
) -> Tuple[str, int]:
    ttl = max(int(workspace.session_ttl_seconds or 28800), 60)
    now = datetime.now(timezone.utc)
    payload = {
        "sub": username,
        "type": _SESSION_TYPE,
        "ws": workspace.token,
        "exp": now + timedelta(seconds=ttl),
        "iat": now,
        "app_user": _build_app_user_payload(username, cfg, row),
    }
    if extra_claims:
        for key, value in extra_claims.items():
            if key not in payload:
                payload[key] = value
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)
    return token, ttl


def decode_session_token(token: str, expected_workspace_token: str) -> Optional[Dict[str, Any]]:
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
) -> Dict[str, Any]:
    """Verify (username, pin) against the configured app-user table.

    Returns the validated app_user payload (dict ready for FE). Raises
    HTTPException with appropriate status codes on any failure path.
    """
    cfg = parse_app_users_config(workspace)
    if cfg is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="This workspace is not configured for user login.",
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

    row = _fetch_user_row(db, cfg, username)
    if row is None:
        _record_attempt(db, workspace.id, username, ip, success=False)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or PIN.",
        )

    if not _is_active(row, cfg):
        _record_attempt(db, workspace.id, username, ip, success=False)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been deactivated. Contact your administrator.",
        )

    if not _verify_credential(pin, row.get(cfg.credential_column), cfg.credential_kind):
        _record_attempt(db, workspace.id, username, ip, success=False)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or PIN.",
        )

    _record_attempt(db, workspace.id, username, ip, success=True)
    return _build_app_user_payload(username, cfg, row)
