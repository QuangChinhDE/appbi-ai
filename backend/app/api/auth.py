"""
Auth router - password login, Google login, me, change-password, logout.

Rate limiting: /auth/login and /auth/google are limited to 5 requests/minute
per IP via slowapi.
"""
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse, RedirectResponse
from google.auth import exceptions as google_exceptions
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from jose import jwt
from passlib.context import CryptContext
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.dependencies import ALGORITHM, get_current_user
from app.models.audit_log import AuditAction
from app.models.revoked_token import RevokedToken
from app.models.user import AuthProvider, User, UserStatus
from app.schemas.auth import (
    ChangePasswordRequest,
    GoogleLoginRequest,
    LoginRequest,
    TokenResponse,
    UserPreferencesUpdate,
    UserResponse,
)
from app.services.audit_service import audit
from app.services.google_data_access_service import (
    assert_google_data_access_matches_user,
    build_google_data_access_authorization_url,
    build_google_data_access_state,
    decode_google_data_access_state,
    exchange_google_data_access_code,
    get_google_data_access_status,
    store_google_data_access_credentials,
)

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)
_limiter = Limiter(key_func=get_remote_address)

# App sessions use a 2-hour inactivity window. The refresh token is rotated
# on every refresh, so active users stay signed in while idle sessions expire.
ACCESS_TOKEN_EXPIRE_HOURS = 2
REFRESH_TOKEN_EXPIRE_HOURS = 2
_DUMMY_BCRYPT_HASH = "$2b$12$KIXBKl9Xv5iyYFiC.gEuQuT3s.d6OM2nqYbJt6n4PjNn2YGFQbZxO"
_ADMIN_PERMISSIONS = {
    "data_sources": "full",
    "datasets": "full",
    "explore_charts": "full",
    "dashboards": "full",
    "workboards": "full",
    "ai_chat": "full",
    "ai_agent": "full",
    "settings": "full",
}


def _infer_legacy_ai_agent_level(perms: dict[str, str]) -> str:
    ai_chat_level = perms.get("ai_chat", "none")
    dashboards_level = perms.get("dashboards", "none")
    charts_level = perms.get("explore_charts", "none")

    if (
        ai_chat_level in {"edit", "full"}
        and dashboards_level in {"edit", "full"}
        and charts_level in {"edit", "full"}
    ):
        return "edit"
    return "none"


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _get_user_by_email(db: Session, email: str) -> User | None:
    normalized_email = _normalize_email(email)
    return db.query(User).filter(func.lower(User.email) == normalized_email).first()


def _is_bootstrap_google_admin(email: str) -> bool:
    configured = settings.AUTH_GOOGLE_BOOTSTRAP_ADMIN_EMAIL.strip()
    if not configured:
        return False
    return _normalize_email(configured) == _normalize_email(email)


def _ensure_password_login_enabled() -> None:
    if settings.AUTH_PASSWORD_LOGIN_ENABLED:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Password login is disabled. Please sign in with Google.",
    )


def _ensure_google_login_enabled() -> None:
    if settings.AUTH_GOOGLE_ENABLED and settings.AUTH_GOOGLE_CLIENT_ID.strip():
        return
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Google sign-in is not configured.",
    )


def _assert_google_email_allowed(email: str) -> None:
    allowed_domains = settings.auth_google_allowed_domains_list
    if not allowed_domains:
        return

    domain = _normalize_email(email).split("@")[-1]
    if domain in allowed_domains:
        return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="This Google account is not allowed for this workspace.",
    )


def create_access_token(user: User) -> str:
    now = datetime.now(timezone.utc)
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
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": now + timedelta(hours=REFRESH_TOKEN_EXPIRE_HOURS),
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
        max_age=REFRESH_TOKEN_EXPIRE_HOURS * 3600,
        path="/api/v1/auth/refresh",
    )


def _verify_google_credential(credential: str) -> dict[str, Any]:
    _ensure_google_login_enabled()

    try:
        claims = google_id_token.verify_oauth2_token(
            credential,
            google_requests.Request(),
            settings.AUTH_GOOGLE_CLIENT_ID.strip(),
        )
    except (ValueError, google_exceptions.GoogleAuthError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Google credential.",
        )

    issuer = claims.get("iss")
    if issuer not in {"accounts.google.com", "https://accounts.google.com"}:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Google token issuer.",
        )

    email = claims.get("email")
    if not isinstance(email, str) or not email.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google account email is missing.",
        )
    if claims.get("email_verified") is not True:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Google account email is not verified.",
        )

    _assert_google_email_allowed(email)
    return claims


def _build_google_user_from_claims(db: Session, claims: dict[str, Any]) -> tuple[User, bool]:
    email = _normalize_email(str(claims["email"]))
    google_sub = str(claims["sub"])
    name = str(claims.get("name") or email.split("@")[0])
    picture = claims.get("picture")

    user = db.query(User).filter(User.google_sub == google_sub).first()
    created = False

    if not user:
        user = _get_user_by_email(db, email)

    if not user:
        if _is_bootstrap_google_admin(email):
            user = User(
                email=email,
                full_name=name,
                auth_provider=AuthProvider.GOOGLE.value,
                google_sub=google_sub,
                avatar_url=picture if isinstance(picture, str) else None,
                permissions=_ADMIN_PERMISSIONS.copy(),
            )
            db.add(user)
            created = True
            return user, created
        if not settings.AUTH_GOOGLE_AUTO_CREATE_USERS:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This Google account is not provisioned in AppBI yet. Ask an admin to add your email first.",
            )
        user = User(
            email=email,
            full_name=name,
            auth_provider=AuthProvider.GOOGLE.value,
            google_sub=google_sub,
            avatar_url=picture if isinstance(picture, str) else None,
        )
        db.add(user)
        created = True
        return user, created

    if user.status == UserStatus.DEACTIVATED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is deactivated",
        )

    if user.google_sub and user.google_sub != google_sub:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This Google account does not match the user record assigned to this email.",
        )

    if _normalize_email(user.email) != email:
        existing_email_owner = _get_user_by_email(db, email)
        if existing_email_owner and existing_email_owner.id != user.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Another AppBI user already uses this Google email address.",
            )
        user.email = email

    user.auth_provider = AuthProvider.GOOGLE.value
    user.google_sub = google_sub
    if isinstance(picture, str) and picture.strip():
        user.avatar_url = picture
    if not user.full_name.strip():
        user.full_name = name

    return user, created


def _sanitize_return_to(raw: str | None) -> str:
    if not raw:
        return "/datasources/new"

    parsed = urlparse(raw)
    if parsed.scheme or parsed.netloc:
        return "/datasources/new"
    if not parsed.path.startswith("/") or parsed.path.startswith("/api/"):
        return "/datasources/new"
    return urlunparse(("", "", parsed.path, "", parsed.query, ""))


def _append_query_params(url: str, **params: str) -> str:
    parsed = urlparse(url)
    merged = dict(parse_qsl(parsed.query, keep_blank_values=True))
    for key, value in params.items():
        if value:
            merged[key] = value
    return urlunparse(parsed._replace(query=urlencode(merged)))


def _popup_close_response(status_value: str, message: str | None = None) -> HTMLResponse:
    html = f"""<!doctype html>
<html>
  <body>
    <script>
      (function() {{
        var payload = {{
          type: "google-data-access",
          status: {json.dumps(status_value)},
          message: {json.dumps(message or "")}
        }};
        if (window.opener) {{
          window.opener.postMessage(payload, window.location.origin);
        }}
        window.close();
      }})();
    </script>
    <p>You can close this window.</p>
  </body>
</html>"""
    return HTMLResponse(content=html)


def _finalize_login(
    *,
    request: Request,
    response: Response,
    db: Session,
    user: User,
    provider: str,
    created: bool = False,
) -> TokenResponse:
    if not user.id:
        db.flush()

    user_pk = user.id
    user.last_login_at = datetime.now(timezone.utc)
    db.commit()

    user = db.query(User).filter(User.id == user_pk).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="User not found after login commit",
        )

    token = create_access_token(user)
    refresh = create_refresh_token(user)
    _set_auth_cookie(response, token)
    _set_refresh_cookie(response, refresh)

    audit(
        db,
        AuditAction.LOGIN_SUCCESS,
        request=request,
        user_id=user.id,
        details={"provider": provider, "created_user": created},
    )

    return TokenResponse(access_token=token, user=UserResponse.model_validate(user))


@router.post("/login", response_model=TokenResponse)
@_limiter.limit("5/minute")
def login(
    request: Request,
    response: Response,
    body: LoginRequest = Body(...),
    db: Session = Depends(get_db),
):
    """Authenticate a password-based user and return AppBI session tokens."""
    _ensure_password_login_enabled()
    user = _get_user_by_email(db, body.email)
    check_hash = user.password_hash if user and user.password_hash else _DUMMY_BCRYPT_HASH
    password_ok = _pwd.verify(body.password, check_hash)

    if (
        not user
        or not user.password_hash
        or user.auth_provider != AuthProvider.PASSWORD.value
        or not password_ok
    ):
        audit(
            db,
            AuditAction.LOGIN_FAILED,
            request=request,
            details={"email": _normalize_email(body.email), "provider": "password"},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if user.status == UserStatus.DEACTIVATED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is deactivated",
        )

    return _finalize_login(
        request=request,
        response=response,
        db=db,
        user=user,
        provider="password",
    )


@router.post("/google", response_model=TokenResponse)
@_limiter.limit("5/minute")
def google_login(
    request: Request,
    response: Response,
    body: GoogleLoginRequest = Body(...),
    db: Session = Depends(get_db),
):
    """Authenticate a user with a Google ID token and return AppBI session tokens."""
    claims: dict[str, Any] | None = None

    try:
        claims = _verify_google_credential(body.credential)
        user, created = _build_google_user_from_claims(db, claims)
    except HTTPException as exc:
        if exc.status_code in {status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN}:
            details: dict[str, Any] = {"provider": "google"}
            if claims and isinstance(claims.get("email"), str):
                details["email"] = _normalize_email(str(claims["email"]))
            audit(db, AuditAction.LOGIN_FAILED, request=request, details=details)
        raise

    return _finalize_login(
        request=request,
        response=response,
        db=db,
        user=user,
        provider="google",
        created=created,
    )


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
    """Change the current user's password."""
    if current_user.auth_provider != AuthProvider.PASSWORD.value or not current_user.password_hash:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This account signs in with Google and does not support password changes.",
        )

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
    """Update the current user's UI preferences."""
    current_user.preferred_language = body.preferred_language
    db.commit()
    db.refresh(current_user)
    return UserResponse.model_validate(current_user)


@router.get("/google/data-access/status")
def google_data_access_status(current_user: User = Depends(get_current_user)):
    """Return whether the current user has connected Google data access."""
    return get_google_data_access_status(current_user)


@router.get("/google/data-access/start")
def start_google_data_access(
    return_to: str | None = None,
    popup: bool = False,
    current_user: User = Depends(get_current_user),
):
    """Start the Google OAuth flow used for BigQuery and Google Sheets access."""
    safe_return_to = _sanitize_return_to(return_to)
    state = build_google_data_access_state(
        user=current_user,
        return_to=safe_return_to,
        popup=popup,
    )
    return RedirectResponse(
        build_google_data_access_authorization_url(state),
        status_code=status.HTTP_302_FOUND,
    )


@router.get("/google/data-access/callback")
def google_data_access_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
    db: Session = Depends(get_db),
):
    """
    Complete the Google OAuth flow for user-scoped BigQuery / Sheets access.

    The callback uses the signed `state` token to map the OAuth response back to
    the AppBI user who initiated the consent flow.
    """
    default_return_to = "/datasources/new"
    popup = False
    return_to = default_return_to

    try:
        if not state:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing Google OAuth state.",
            )

        state_payload = decode_google_data_access_state(state)
        popup = bool(state_payload.get("popup"))
        return_to = _sanitize_return_to(str(state_payload.get("return_to") or default_return_to))

        if error:
            message = error_description or error
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Google access was not granted: {message}",
            )
        if not code:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing Google OAuth authorization code.",
            )

        user = db.query(User).filter(User.id == uuid.UUID(str(state_payload["sub"]))).first()
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found for Google OAuth callback.",
            )

        credentials, identity = exchange_google_data_access_code(code)
        assert_google_data_access_matches_user(user, identity)
        store_google_data_access_credentials(
            db,
            user=user,
            credentials=credentials,
            identity=identity,
        )
        audit(
            db,
            AuditAction.DATASOURCE_CONNECTED,
            request=request,
            user_id=user.id,
            details={
                "provider": "google_oauth",
                "email": identity["email"],
                "scopes": identity["scopes"],
            },
        )
    except HTTPException as exc:
        message = str(exc.detail)
        logger.warning("Google data access callback failed: %s", message)
        if popup:
            return _popup_close_response("error", message)
        return RedirectResponse(
            _append_query_params(
                return_to,
                google_data_access="error",
                google_data_access_message=message,
            ),
            status_code=status.HTTP_302_FOUND,
        )

    if popup:
        return _popup_close_response("connected", f"Connected {identity['email']}")
    return RedirectResponse(
        _append_query_params(
            return_to,
            google_data_access="connected",
            google_data_access_email=identity["email"],
        ),
        status_code=status.HTTP_302_FOUND,
    )


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
                expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
                revoked = RevokedToken(
                    jti=jti,
                    user_id=logout_user_id,
                    expires_at=expires_at,
                )
                db.merge(revoked)
                db.commit()
        except Exception:
            pass

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
    """Exchange a valid refresh token for a new access token + refresh token."""
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

    old_jti = payload.get("jti")
    if old_jti:
        revoked = db.query(RevokedToken).filter(RevokedToken.jti == old_jti).first()
        if revoked:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Refresh token already used - please login again",
            )

    user_id = payload.get("sub")
    user = db.query(User).filter(User.id == uuid.UUID(user_id)).first()
    if not user or user.status != UserStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or deactivated",
        )

    if old_jti:
        exp = payload.get("exp")
        if exp:
            expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
            db.merge(RevokedToken(jti=old_jti, user_id=user_id, expires_at=expires_at))
            db.commit()

    new_access = create_access_token(user)
    new_refresh = create_refresh_token(user)
    _set_auth_cookie(response, new_access)
    _set_refresh_cookie(response, new_refresh)

    audit(db, AuditAction.TOKEN_REFRESHED, request=request, user_id=user.id)

    return TokenResponse(access_token=new_access, user=UserResponse.model_validate(user))


def hash_password(plain: str) -> str:
    return _pwd.hash(plain)
