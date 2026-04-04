"""
Auth router — login, me, change-password, logout.

Rate limiting: /auth/login is limited to 5 requests/minute per IP via slowapi.
"""
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Cookie, Depends, HTTPException, Request, Response, status
from jose import jwt
from passlib.context import CryptContext
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.dependencies import ALGORITHM, get_current_user
from app.models.user import User, UserStatus
from app.models.revoked_token import RevokedToken
from app.schemas.auth import ChangePasswordRequest, LoginRequest, TokenResponse, UserPreferencesUpdate, UserResponse
from app.services.audit_service import audit
from app.models.audit_log import AuditAction

router = APIRouter(prefix="/auth", tags=["auth"])

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)
_limiter = Limiter(key_func=get_remote_address)

ACCESS_TOKEN_EXPIRE_HOURS = 1
REFRESH_TOKEN_EXPIRE_DAYS = 7


def _infer_legacy_ai_agent_level(perms: dict[str, str]) -> str:
    ai_chat_level = perms.get("ai_chat", "none")
    dashboards_level = perms.get("dashboards", "none")
    charts_level = perms.get("explore_charts", "none")

    if ai_chat_level in {"edit", "full"} and dashboards_level in {"edit", "full"} and charts_level in {"edit", "full"}:
        return "edit"
    return "none"


def create_access_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    # Embed AI module levels so AI services can enforce RBAC without
    # a round-trip to the backend on every request.
    perms = user.permissions or {}
    ai_chat_level: str = perms.get("ai_chat", "none") if isinstance(perms, dict) else "none"
    if isinstance(perms, dict):
        ai_agent_level = perms.get("ai_agent")
        if ai_agent_level is None:
            ai_agent_level = _infer_legacy_ai_agent_level(perms)
    else:
        ai_agent_level = "none"
    payload = {
        "sub": str(user.id),
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": now + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS),
        "ai_level": ai_chat_level,
        "ai_chat_level": ai_chat_level,
        "ai_agent_level": ai_agent_level,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(user: User) -> str:
    """Create a long-lived refresh token for token rotation."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        "type": "refresh",
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def _set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=settings.COOKIE_SECURE,
        max_age=ACCESS_TOKEN_EXPIRE_HOURS * 3600,
        path="/",
    )


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="refresh_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=settings.COOKIE_SECURE,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/api/v1/auth/refresh",  # only sent to refresh endpoint
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
@_limiter.limit("5/minute")
def login(
    request: Request,
    response: Response,
    body: LoginRequest = Body(...),
    db: Session = Depends(get_db),
):
    """Authenticate user and return JWT in httpOnly cookie + response body."""
    user = db.query(User).filter(User.email == body.email).first()

    # Constant-time failure to prevent email enumeration
    dummy_hash = "$2b$12$KIXBKl9Xv5iyYFiC.gEuQuT3s.d6OM2nqYbJt6n4PjNn2YGFQbZxO"
    check_hash = user.password_hash if user else dummy_hash

    if not _pwd.verify(body.password, check_hash) or not user:
        audit(db, AuditAction.LOGIN_FAILED, request=request,
              details={"email": body.email})
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if user.status.value == "deactivated":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is deactivated",
        )

    # Update last login. Capture PK before commit (PK is never expired by SQLAlchemy).
    from datetime import datetime, timezone
    user_pk = user.id
    user.last_login_at = datetime.now(timezone.utc)
    db.commit()
    # Re-query after commit — bypasses identity-map expiry and avoids
    # both ObjectDeletedError and InvalidRequestError from db.refresh().
    user = db.query(User).filter(User.id == user_pk).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail="User not found after login commit")

    token = create_access_token(user)
    refresh = create_refresh_token(user)
    _set_auth_cookie(response, token)
    _set_refresh_cookie(response, refresh)

    audit(db, AuditAction.LOGIN_SUCCESS, request=request, user_id=user.id)

    return TokenResponse(access_token=token, user=UserResponse.model_validate(user))


@router.get("/me", response_model=UserResponse)
def me(current_user: User = Depends(get_current_user)):
    """Return current user profile."""
    return UserResponse.model_validate(current_user)


@router.post("/change-password")
@_limiter.limit("3/minute")
def change_password(
    request: Request,
    body: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Change current user's password."""
    if not _pwd.verify(body.old_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Old password is incorrect",
        )
    current_user.password_hash = _pwd.hash(body.new_password)
    db.commit()
    audit(db, AuditAction.PASSWORD_CHANGED, request=request, user_id=current_user.id)
    return {"message": "Password changed successfully"}


@router.patch("/preferences", response_model=UserResponse)
def update_preferences(
    body: UserPreferencesUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update current user's UI preferences."""
    current_user.preferred_language = body.preferred_language
    db.commit()
    db.refresh(current_user)
    return UserResponse.model_validate(current_user)


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    """Clear authentication cookie and revoke the token server-side."""
    token = request.cookies.get("access_token")
    logout_user_id = None
    if token:
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
            jti = payload.get("jti")
            exp = payload.get("exp")
            logout_user_id = payload.get("sub")
            if jti and exp:
                from datetime import datetime, timezone
                expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
                revoked = RevokedToken(
                    jti=jti,
                    user_id=logout_user_id,
                    expires_at=expires_at,
                )
                db.merge(revoked)
                db.commit()
        except Exception:
            pass  # Best-effort — always clear cookie regardless

    response.delete_cookie(key="access_token", path="/")
    response.delete_cookie(key="refresh_token", path="/api/v1/auth/refresh")
    audit(db, AuditAction.LOGOUT, request=request, user_id=logout_user_id)
    return {"message": "Logged out"}


@router.post("/refresh", response_model=TokenResponse)
@_limiter.limit("10/minute")
def refresh_access_token(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    """Exchange a valid refresh token for a new access token + refresh token (rotation)."""
    refresh = request.cookies.get("refresh_token")
    if not refresh:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token missing",
        )

    try:
        payload = jwt.decode(refresh, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    if payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type",
        )

    # Check if refresh token was already revoked (reuse detection)
    old_jti = payload.get("jti")
    if old_jti:
        revoked = db.query(RevokedToken).filter(RevokedToken.jti == old_jti).first()
        if revoked:
            # Possible token theft — revoke all tokens for this user
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Refresh token already used — please login again",
            )

    user_id = payload.get("sub")
    user = db.query(User).filter(User.id == uuid.UUID(user_id)).first()
    if not user or user.status != UserStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or deactivated",
        )

    # Revoke old refresh token (rotation — each refresh token used exactly once)
    if old_jti:
        exp = payload.get("exp")
        if exp:
            expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
            db.merge(RevokedToken(jti=old_jti, user_id=user_id, expires_at=expires_at))
            db.commit()

    # Issue new token pair
    new_access = create_access_token(user)
    new_refresh = create_refresh_token(user)
    _set_auth_cookie(response, new_access)
    _set_refresh_cookie(response, new_refresh)

    audit(db, AuditAction.TOKEN_REFRESHED, request=request, user_id=user.id)

    return TokenResponse(access_token=new_access, user=UserResponse.model_validate(user))


# ── Password utility (used by seed script) ────────────────────────────────────

def hash_password(plain: str) -> str:
    return _pwd.hash(plain)
