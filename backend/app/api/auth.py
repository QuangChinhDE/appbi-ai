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
from app.models.user import User
from app.schemas.auth import ChangePasswordRequest, LoginRequest, TokenResponse, UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)
_limiter = Limiter(key_func=get_remote_address)

ACCESS_TOKEN_EXPIRE_HOURS = 24


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


def _set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,   # set True when behind HTTPS
        max_age=ACCESS_TOKEN_EXPIRE_HOURS * 3600,
        path="/",
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
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if user.status.value == "deactivated":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is deactivated",
        )

    # Update last login
    from sqlalchemy.sql import func
    user.last_login_at = func.now()
    db.commit()
    db.refresh(user)

    token = create_access_token(user)
    _set_auth_cookie(response, token)

    return TokenResponse(access_token=token, user=UserResponse.model_validate(user))


@router.get("/me", response_model=UserResponse)
def me(current_user: User = Depends(get_current_user)):
    """Return current user profile."""
    return UserResponse.model_validate(current_user)


@router.post("/change-password")
def change_password(
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
    return {"message": "Password changed successfully"}


@router.post("/logout")
def logout(response: Response):
    """Clear authentication cookie (phase 1 — cookie-based invalidation)."""
    response.delete_cookie(key="access_token", path="/")
    return {"message": "Logged out"}


# ── Password utility (used by seed script) ────────────────────────────────────

def hash_password(plain: str) -> str:
    return _pwd.hash(plain)
