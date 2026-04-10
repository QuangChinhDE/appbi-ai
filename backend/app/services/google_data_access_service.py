"""
Helpers for Google OAuth data-access grants used by BigQuery and Google Sheets.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import credentials as google_user_credentials
from google.oauth2 import id_token as google_id_token
from google_auth_oauthlib.flow import Flow
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.crypto import decrypt_value, encrypt_value
from app.core.database import SessionLocal
from app.core.dependencies import ALGORITHM
from app.models.user import User

GOOGLE_DATA_ACCESS_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/bigquery",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]

_GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
_GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
_STATE_EXPIRY_MINUTES = 15


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def google_data_access_is_configured() -> bool:
    return bool(
        settings.AUTH_GOOGLE_CLIENT_ID.strip()
        and settings.AUTH_GOOGLE_CLIENT_SECRET.strip()
        and settings.AUTH_GOOGLE_DATA_REDIRECT_URI.strip()
    )


def assert_google_data_access_is_configured() -> None:
    if google_data_access_is_configured():
        return
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            "Google data access is not configured. Set AUTH_GOOGLE_CLIENT_ID, "
            "AUTH_GOOGLE_CLIENT_SECRET, and AUTH_GOOGLE_DATA_REDIRECT_URI."
        ),
    )


def _build_client_config() -> dict[str, Any]:
    assert_google_data_access_is_configured()
    return {
        "web": {
            "client_id": settings.AUTH_GOOGLE_CLIENT_ID.strip(),
            "client_secret": settings.AUTH_GOOGLE_CLIENT_SECRET.strip(),
            "auth_uri": _GOOGLE_AUTH_URI,
            "token_uri": _GOOGLE_TOKEN_URI,
        }
    }


def _build_flow(state: str | None = None) -> Flow:
    flow = Flow.from_client_config(
        _build_client_config(),
        scopes=GOOGLE_DATA_ACCESS_SCOPES,
        state=state,
    )
    flow.redirect_uri = settings.AUTH_GOOGLE_DATA_REDIRECT_URI.strip()
    return flow


def build_google_data_access_authorization_url(state: str) -> str:
    flow = _build_flow(state=state)
    authorization_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    return authorization_url


def build_google_data_access_state(
    *,
    user: User,
    return_to: str,
    popup: bool,
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "email": _normalize_email(user.email),
        "purpose": "google_data_access",
        "return_to": return_to,
        "popup": popup,
        "iat": now,
        "exp": now + timedelta(minutes=_STATE_EXPIRY_MINUTES),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def decode_google_data_access_state(state_token: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(state_token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired Google OAuth state.",
        )

    if payload.get("purpose") != "google_data_access":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Google OAuth state purpose.",
        )
    return payload


def _verify_google_oauth_id_token(id_token_value: str | None) -> dict[str, Any]:
    if not id_token_value:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google OAuth response did not include an ID token.",
        )

    try:
        claims = google_id_token.verify_oauth2_token(
            id_token_value,
            GoogleRequest(),
            settings.AUTH_GOOGLE_CLIENT_ID.strip(),
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Google OAuth ID token.",
        )

    issuer = claims.get("iss")
    if issuer not in {"accounts.google.com", "https://accounts.google.com"}:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Google OAuth token issuer.",
        )

    email = claims.get("email")
    if not isinstance(email, str) or not email.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google OAuth account email is missing.",
        )
    if claims.get("email_verified") is not True:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Google OAuth account email is not verified.",
        )
    return claims


def exchange_google_data_access_code(code: str) -> tuple[google_user_credentials.Credentials, dict[str, Any]]:
    flow = _build_flow()
    try:
        flow.fetch_token(code=code)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to exchange Google OAuth authorization code.",
        )

    credentials = flow.credentials
    claims = _verify_google_oauth_id_token(getattr(credentials, "id_token", None))
    identity = {
        "sub": str(claims["sub"]),
        "email": _normalize_email(str(claims["email"])),
        "scopes": list(getattr(credentials, "scopes", None) or GOOGLE_DATA_ACCESS_SCOPES),
    }
    return credentials, identity


def assert_google_data_access_matches_user(user: User, identity: dict[str, Any]) -> None:
    email = _normalize_email(str(identity.get("email") or ""))
    sub = str(identity.get("sub") or "")

    if user.google_sub and sub and user.google_sub != sub:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Google data access must be granted from the same Google account "
                "used to sign in to AppBI."
            ),
        )

    if _normalize_email(user.email) != email:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Google data access must use the same email address as your AppBI account."
            ),
        )


def store_google_data_access_credentials(
    db: Session,
    *,
    user: User,
    credentials: google_user_credentials.Credentials,
    identity: dict[str, Any],
) -> None:
    user.google_oauth_credentials = encrypt_value(credentials.to_json())
    user.google_oauth_email = _normalize_email(str(identity["email"]))
    user.google_oauth_scopes = list(identity.get("scopes") or GOOGLE_DATA_ACCESS_SCOPES)
    user.google_oauth_connected_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user)


def get_google_data_access_status(user: User) -> dict[str, Any]:
    scopes = user.google_oauth_scopes if isinstance(user.google_oauth_scopes, list) else []
    return {
        "configured": google_data_access_is_configured(),
        "connected": bool(user.google_oauth_credentials and user.google_oauth_email),
        "email": user.google_oauth_email,
        "scopes": scopes,
        "redirect_uri": settings.AUTH_GOOGLE_DATA_REDIRECT_URI.strip() or None,
    }


def _load_user_google_credentials(user: User) -> google_user_credentials.Credentials:
    encrypted = (user.google_oauth_credentials or "").strip()
    if not encrypted:
        raise ValueError(
            "Google data access is not connected for this user. Connect Google access in AppBI first."
        )

    try:
        payload = json.loads(decrypt_value(encrypted))
    except Exception as exc:
        raise ValueError(f"Stored Google OAuth credential is invalid: {exc}") from exc

    scopes = payload.get("scopes") or user.google_oauth_scopes or GOOGLE_DATA_ACCESS_SCOPES
    credentials = google_user_credentials.Credentials.from_authorized_user_info(
        payload,
        scopes=scopes,
    )
    if not credentials.valid and credentials.refresh_token:
        try:
            credentials.refresh(GoogleRequest())
        except Exception as exc:
            raise ValueError(
                "Stored Google OAuth credential can no longer be refreshed. Please reconnect Google access."
            ) from exc
    return credentials


def get_google_credentials_for_user_id(user_id: str) -> google_user_credentials.Credentials:
    try:
        parsed_user_id = uuid.UUID(str(user_id))
    except ValueError as exc:
        raise ValueError("Invalid Google OAuth credential owner id.") from exc

    with SessionLocal() as db:
        user = db.query(User).filter(User.id == parsed_user_id).first()
        if not user:
            raise ValueError("Google OAuth credential owner was not found.")

        credentials = _load_user_google_credentials(user)

        refreshed_json = credentials.to_json()
        current_json = decrypt_value(user.google_oauth_credentials) if user.google_oauth_credentials else ""
        if refreshed_json != current_json:
            user.google_oauth_credentials = encrypt_value(refreshed_json)
            user.google_oauth_scopes = list(getattr(credentials, "scopes", None) or user.google_oauth_scopes or [])
            db.commit()

        return credentials
