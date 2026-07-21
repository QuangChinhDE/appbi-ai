"""Self-service personal access token endpoints."""

from datetime import datetime, timedelta, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import (
    AUTH_TOKEN_KIND_ATTR,
    _normalize_permissions,
    get_current_user,
    require_permission,
)
from app.core.personal_access_tokens import (
    build_personal_access_token,
    build_personal_access_token_hint,
    create_personal_access_token_secret,
    ensure_scopes_within_user_permissions,
    hash_personal_access_token_secret,
    validate_personal_access_token_scopes,
)
from app.models.audit_log import AuditAction
from app.models.personal_access_token import PersonalAccessToken
from app.models.user import User
from app.schemas.personal_access_token import (
    AdminPersonalAccessTokenResponse,
    PersonalAccessTokenCreate,
    PersonalAccessTokenCreateResponse,
    PersonalAccessTokenResponse,
    PersonalAccessTokenUpdate,
)
from app.services.audit_service import audit

router = APIRouter(prefix="/auth/personal-access-tokens", tags=["personal-access-tokens"])
_limiter = Limiter(key_func=get_remote_address)


def _require_session_user(current_user: User = Depends(get_current_user)) -> User:
    if getattr(current_user, AUTH_TOKEN_KIND_ATTR, "session") != "session":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Personal access tokens must be managed from a signed-in user session.",
        )
    return current_user


def _require_admin_session(
    current_user: User = Depends(require_permission("settings", "full")),
) -> User:
    """Admin (settings=full) acting from a real browser session — not a PAT."""
    if getattr(current_user, AUTH_TOKEN_KIND_ATTR, "session") != "session":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Personal access tokens must be managed from a signed-in user session.",
        )
    return current_user


def _serialize_token(item: PersonalAccessToken) -> PersonalAccessTokenResponse:
    return PersonalAccessTokenResponse(
        id=item.id,
        name=item.name,
        token_hint=build_personal_access_token_hint(item.id, item.secret_suffix),
        scopes=item.scopes or {},
        last_used_at=item.last_used_at,
        expires_at=item.expires_at,
        revoked_at=item.revoked_at,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def _get_owned_personal_access_token(
    db: Session,
    current_user: User,
    token_id: uuid.UUID,
) -> PersonalAccessToken:
    token = (
        db.query(PersonalAccessToken)
        .filter(
            PersonalAccessToken.id == token_id,
            PersonalAccessToken.owner_id == current_user.id,
        )
        .first()
    )
    if not token:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Personal access token not found")
    return token


def _validate_personal_access_token_payload(body: PersonalAccessTokenCreate | PersonalAccessTokenUpdate, current_user: User) -> dict[str, str]:
    requested_scopes = validate_personal_access_token_scopes(body.scopes)
    ensure_scopes_within_user_permissions(requested_scopes, _normalize_permissions(current_user))
    return requested_scopes


def _build_token_expiry(expires_in_days: int | None) -> datetime | None:
    if not expires_in_days:
        return None
    return datetime.now(timezone.utc) + timedelta(days=expires_in_days)


@router.get("/", response_model=list[PersonalAccessTokenResponse])
def list_personal_access_tokens(
    db: Session = Depends(get_db),
    current_user: User = Depends(_require_session_user),
):
    items = (
        db.query(PersonalAccessToken)
        .filter(PersonalAccessToken.owner_id == current_user.id)
        .order_by(PersonalAccessToken.created_at.desc())
        .all()
    )
    return [_serialize_token(item) for item in items]


@router.post("/", response_model=PersonalAccessTokenCreateResponse, status_code=status.HTTP_201_CREATED)
@_limiter.limit("10/minute")
def create_personal_access_token(
    request: Request,
    body: PersonalAccessTokenCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(_require_session_user),
):
    try:
        requested_scopes = _validate_personal_access_token_payload(body, current_user)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    secret = create_personal_access_token_secret()
    token = PersonalAccessToken(
        owner_id=current_user.id,
        name=body.name,
        secret_hash=hash_personal_access_token_secret(secret),
        secret_suffix=secret[-6:],
        scopes=requested_scopes,
        expires_at=_build_token_expiry(body.expires_in_days),
    )
    db.add(token)
    db.commit()
    db.refresh(token)

    audit(
        db,
        AuditAction.PERSONAL_ACCESS_TOKEN_CREATED,
        request=request,
        user_id=current_user.id,
        resource_type="personal_access_token",
        resource_id=str(token.id),
        details={"name": token.name, "scopes": token.scopes or {}},
    )

    return PersonalAccessTokenCreateResponse(
        token=build_personal_access_token(token.id, secret),
        item=_serialize_token(token),
    )


# ── Admin oversight ───────────────────────────────────────────────────────────
# Declared before the "/{token_id}" routes so "/admin" is never captured as an id.

def _serialize_admin_token(item: PersonalAccessToken, owner: User) -> AdminPersonalAccessTokenResponse:
    base = _serialize_token(item)
    return AdminPersonalAccessTokenResponse(
        **base.model_dump(),
        owner_id=owner.id,
        owner_email=owner.email,
        owner_name=owner.full_name,
    )


@router.get("/admin", response_model=list[AdminPersonalAccessTokenResponse])
def list_all_personal_access_tokens(
    db: Session = Depends(get_db),
    _: User = Depends(_require_admin_session),
):
    """Every user's tokens (admin-only) — for the Settings token oversight view."""
    rows = (
        db.query(PersonalAccessToken, User)
        .join(User, PersonalAccessToken.owner_id == User.id)
        .order_by(PersonalAccessToken.created_at.desc())
        .all()
    )
    return [_serialize_admin_token(token, owner) for token, owner in rows]


@router.delete("/admin/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
@_limiter.limit("30/minute")
def admin_revoke_personal_access_token(
    token_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(_require_admin_session),
):
    """Revoke any user's token (admin-only). Idempotent."""
    token = db.query(PersonalAccessToken).filter(PersonalAccessToken.id == token_id).first()
    if not token:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Personal access token not found")

    if token.revoked_at is None:
        token.revoked_at = datetime.now(timezone.utc)
        db.commit()

        audit(
            db,
            AuditAction.PERSONAL_ACCESS_TOKEN_REVOKED,
            request=request,
            user_id=admin.id,
            resource_type="personal_access_token",
            resource_id=str(token.id),
            details={"name": token.name, "owner_id": str(token.owner_id), "admin_revoked": True},
        )


@router.put("/{token_id}", response_model=PersonalAccessTokenResponse)
@_limiter.limit("20/minute")
def update_personal_access_token(
    token_id: uuid.UUID,
    body: PersonalAccessTokenUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_require_session_user),
):
    token = _get_owned_personal_access_token(db, current_user, token_id)
    if token.revoked_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Revoked personal access tokens cannot be edited",
        )

    try:
        requested_scopes = _validate_personal_access_token_payload(body, current_user)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    token.name = body.name
    token.scopes = requested_scopes
    token.expires_at = _build_token_expiry(body.expires_in_days)
    db.commit()
    db.refresh(token)

    audit(
        db,
        AuditAction.PERSONAL_ACCESS_TOKEN_UPDATED,
        request=request,
        user_id=current_user.id,
        resource_type="personal_access_token",
        resource_id=str(token.id),
        details={"name": token.name, "scopes": token.scopes or {}},
    )

    return _serialize_token(token)


@router.delete("/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
@_limiter.limit("20/minute")
def revoke_personal_access_token(
    token_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_require_session_user),
):
    token = _get_owned_personal_access_token(db, current_user, token_id)

    if token.revoked_at is None:
        token.revoked_at = datetime.now(timezone.utc)
        db.commit()

        audit(
            db,
            AuditAction.PERSONAL_ACCESS_TOKEN_REVOKED,
            request=request,
            user_id=current_user.id,
            resource_type="personal_access_token",
            resource_id=str(token.id),
            details={"name": token.name},
        )


@router.delete("/{token_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
@_limiter.limit("20/minute")
def delete_personal_access_token_permanently(
    token_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_require_session_user),
):
    token = _get_owned_personal_access_token(db, current_user, token_id)
    token_name = token.name
    db.delete(token)
    db.commit()

    audit(
        db,
        AuditAction.PERSONAL_ACCESS_TOKEN_DELETED,
        request=request,
        user_id=current_user.id,
        resource_type="personal_access_token",
        resource_id=str(token_id),
        details={"name": token_name},
    )
