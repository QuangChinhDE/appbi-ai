"""Self-service personal access token endpoints."""

from datetime import datetime, timedelta, timezone
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.crypto import decrypt_value, encrypt_value, is_encrypted, is_encryption_configured
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
    PersonalAccessTokenRevealResponse,
    PersonalAccessTokenUpdate,
)
from app.services.audit_service import audit
from app.services.embed_link_service import (
    InvalidEmbedOrigin,
    normalize_allowed_origins,
    resolve_pat_allowed_origins,
)

router = APIRouter(prefix="/auth/personal-access-tokens", tags=["personal-access-tokens"])
_limiter = Limiter(key_func=get_remote_address)
logger = logging.getLogger(__name__)


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
        revealable=bool(item.secret_enc),
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


def _reveal_full_token(token: PersonalAccessToken) -> str:
    """Decrypt and rebuild the full token string, or 409 if it isn't revealable."""
    if not token.secret_enc or not is_encrypted(token.secret_enc):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This token can't be revealed (created before reveal was enabled). Create a new token instead.",
        )
    secret = decrypt_value(token.secret_enc)
    return build_personal_access_token(token.id, secret)


def _apply_new_secret(token: PersonalAccessToken) -> str:
    """Issue a fresh secret on an existing token (same id/name/scopes) — the old
    secret stops working. Returns the plaintext to show once. Caller commits."""
    secret = create_personal_access_token_secret()
    token.secret_hash = hash_personal_access_token_secret(secret)
    token.secret_suffix = secret[-6:]
    encrypted = encrypt_value(secret) if is_encryption_configured() else None
    token.secret_enc = encrypted if (encrypted and is_encrypted(encrypted)) else None
    return secret


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
    # Store the secret reversibly-encrypted so it can be revealed again. Fail
    # closed: if no encryption key is configured, leave it null (reveal disabled)
    # rather than persist a plaintext secret a DB leak could expose.
    encrypted = encrypt_value(secret) if is_encryption_configured() else None
    token = PersonalAccessToken(
        owner_id=current_user.id,
        name=body.name,
        secret_hash=hash_personal_access_token_secret(secret),
        secret_enc=encrypted if (encrypted and is_encrypted(encrypted)) else None,
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


@router.post("/admin/{token_id}/rotate", response_model=PersonalAccessTokenCreateResponse)
@_limiter.limit("20/minute")
def admin_rotate_personal_access_token(
    token_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(_require_admin_session),
):
    """Issue a fresh secret for any user's token (admin-only)."""
    token = db.query(PersonalAccessToken).filter(PersonalAccessToken.id == token_id).first()
    if not token:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Personal access token not found")
    if token.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Revoked tokens can't be regenerated")
    secret = _apply_new_secret(token)
    db.commit()
    db.refresh(token)
    audit(
        db,
        AuditAction.PERSONAL_ACCESS_TOKEN_UPDATED,
        request=request,
        user_id=admin.id,
        resource_type="personal_access_token",
        resource_id=str(token.id),
        details={"name": token.name, "action": "rotated", "owner_id": str(token.owner_id), "admin_rotated": True},
    )
    return PersonalAccessTokenCreateResponse(
        token=build_personal_access_token(token.id, secret),
        item=_serialize_token(token),
    )


@router.get("/admin/{token_id}/reveal", response_model=PersonalAccessTokenRevealResponse)
@_limiter.limit("30/minute")
def admin_reveal_personal_access_token(
    token_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(_require_admin_session),
):
    """Reveal any user's full token (admin-only). Audited."""
    token = db.query(PersonalAccessToken).filter(PersonalAccessToken.id == token_id).first()
    if not token:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Personal access token not found")
    full = _reveal_full_token(token)
    audit(
        db,
        AuditAction.PERSONAL_ACCESS_TOKEN_UPDATED,
        request=request,
        user_id=admin.id,
        resource_type="personal_access_token",
        resource_id=str(token.id),
        details={"name": token.name, "action": "revealed", "owner_id": str(token.owner_id), "admin_revealed": True},
    )
    return PersonalAccessTokenRevealResponse(token=full)


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


class _EmbedOriginsBody(BaseModel):
    """Empty list = clear the restriction (links become embeddable anywhere)."""

    allowed_origins: list[str] = []


@router.get("/admin/{token_id}/embed-origins")
def admin_get_embed_origins(
    token_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(_require_admin_session),
):
    """Which sites may iframe the embed links this token mints.

    Exists so "the customer's iframe went blank" is answerable in one call
    without asking them for their token secret.
    """
    token = db.query(PersonalAccessToken).filter(PersonalAccessToken.id == token_id).first()
    if not token:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Personal access token not found")
    origins = resolve_pat_allowed_origins(token)
    return {"token_id": str(token.id), "name": token.name, "allowed_origins": origins, "enforced": bool(origins)}


@router.put("/admin/{token_id}/embed-origins")
@_limiter.limit("30/minute")
def admin_set_embed_origins(
    token_id: uuid.UUID,
    body: _EmbedOriginsBody,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(_require_admin_session),
):
    """Declare (or clear) the embed origin allowlist on someone else's token.

    The host app can also declare it itself via /integrations/embed/resolve, but
    that requires an integration change. This endpoint lets an operator switch the
    restriction on for an integration that has ALREADY shipped — the partner's code
    keeps sending the exact same payload it always did.

    Unlike the resolve path, an empty list here DOES clear the restriction: this is
    a deliberate operator action, not a value assembled from someone's config file.
    """
    token = db.query(PersonalAccessToken).filter(PersonalAccessToken.id == token_id).first()
    if not token:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Personal access token not found")
    try:
        origins = normalize_allowed_origins(body.allowed_origins)
    except InvalidEmbedOrigin as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    token.embed_allowed_origins = origins or None
    db.commit()
    logger.info(
        "embed_origins_set_by_admin admin=%s pat=%s origins=%s",
        admin.id, token_id, origins or "any",
    )
    # Existing grants keep the policy they were minted with; they expire within
    # the hour, so the new setting is fully in force after one rotation.
    return {"token_id": str(token.id), "name": token.name, "allowed_origins": origins, "enforced": bool(origins)}


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


@router.post("/{token_id}/rotate", response_model=PersonalAccessTokenCreateResponse)
@_limiter.limit("10/minute")
def rotate_personal_access_token(
    token_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_require_session_user),
):
    """Issue a fresh secret for a token you own — the old secret stops working."""
    token = _get_owned_personal_access_token(db, current_user, token_id)
    if token.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Revoked tokens can't be regenerated")
    secret = _apply_new_secret(token)
    db.commit()
    db.refresh(token)
    audit(
        db,
        AuditAction.PERSONAL_ACCESS_TOKEN_UPDATED,
        request=request,
        user_id=current_user.id,
        resource_type="personal_access_token",
        resource_id=str(token.id),
        details={"name": token.name, "action": "rotated"},
    )
    return PersonalAccessTokenCreateResponse(
        token=build_personal_access_token(token.id, secret),
        item=_serialize_token(token),
    )


@router.get("/{token_id}/reveal", response_model=PersonalAccessTokenRevealResponse)
@_limiter.limit("20/minute")
def reveal_personal_access_token(
    token_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(_require_session_user),
):
    """Reveal the full secret of a token you own. Audited."""
    token = _get_owned_personal_access_token(db, current_user, token_id)
    full = _reveal_full_token(token)
    audit(
        db,
        AuditAction.PERSONAL_ACCESS_TOKEN_UPDATED,
        request=request,
        user_id=current_user.id,
        resource_type="personal_access_token",
        resource_id=str(token.id),
        details={"name": token.name, "action": "revealed"},
    )
    return PersonalAccessTokenRevealResponse(token=full)


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
