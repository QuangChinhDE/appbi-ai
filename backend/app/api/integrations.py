"""Machine-to-machine integration API.

- POST /integrations/embed/resolve  (HMAC-signed) — get-or-create a deduped,
  filter-locked embed link and return a fresh rotating 256-char embed URL.
- POST /integrations/clients        (admin) — provision an HMAC client; the
  secret is returned exactly once.
- GET  /integrations/clients        (admin) — list clients (no secrets).

See docs: embed grant tokens (prefix `emb_`) resolve through the existing public
endpoints via api/public.py:_get_dashboard_by_token — the underlying link token
is never exposed.
"""
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.core.integration_auth import (
    client_allows_dashboard,
    encrypt_client_secret,
    generate_client_credentials,
    require_integration_client,
)
from app.models.models import Dashboard, IntegrationClient
from app.models.user import User
from app.services.embed_link_service import (
    DEFAULT_TTL_SECONDS,
    canonicalize_filters,
    compute_filter_hash,
    get_or_create_embed_link,
    mint_embed_grant,
    validate_and_lock_filters,
)

router = APIRouter(prefix="/integrations", tags=["integrations"])
logger = logging.getLogger(__name__)
_limiter = Limiter(key_func=get_remote_address)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class EmbedResolveRequest(BaseModel):
    dashboard_id: int = Field(..., ge=1)
    filters: list[dict] = Field(default_factory=list)
    ttl_seconds: int | None = Field(default=None, ge=60, le=86400)


class EmbedResolveResponse(BaseModel):
    embed_url: str
    embed_path: str
    expires_at: datetime
    filter_hash: str


class IntegrationClientCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    allowed_dashboards: list[int] = Field(default_factory=list)
    allowed_ips: list[str] = Field(default_factory=list)
    allowed_origins: list[str] = Field(default_factory=list)
    max_ttl_seconds: int = Field(default=3600, ge=60, le=86400)


class IntegrationClientCreated(BaseModel):
    id: uuid.UUID
    key_id: str
    secret: str  # shown ONCE
    name: str
    max_ttl_seconds: int


class IntegrationClientInfo(BaseModel):
    id: uuid.UUID
    key_id: str
    name: str
    is_active: bool
    allowed_dashboards: list[int] | None
    allowed_ips: list[str] | None
    max_ttl_seconds: int
    created_at: datetime
    last_used_at: datetime | None


# ---------------------------------------------------------------------------
# Admin provisioning (session-authenticated, dashboards=full)
# ---------------------------------------------------------------------------

def _require_admin(current_user: User) -> None:
    level = str((current_user.permissions or {}).get("dashboards") or "none").lower()
    if level != "full":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Managing integration clients requires 'dashboards: full' permission.",
        )


@router.post("/clients", response_model=IntegrationClientCreated, status_code=status.HTTP_201_CREATED)
@_limiter.limit("10/minute")
def create_integration_client(
    body: IntegrationClientCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)
    key_id, secret = generate_client_credentials()
    secret_enc = encrypt_client_secret(secret)
    # Refuse to persist the shared secret in plaintext. HMAC verification needs
    # the raw secret, so it is stored reversibly-encrypted (Fernet); if the
    # encryption key is not configured, encrypt_client_secret returns the raw
    # value — which we must never store.
    if not secret_enc.startswith("_enc:"):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server encryption key (DATASOURCE_ENCRYPTION_KEY) is not configured; refusing to store client secret in plaintext.",
        )
    client = IntegrationClient(
        id=uuid.uuid4(),
        key_id=key_id,
        secret_enc=secret_enc,
        name=body.name.strip(),
        allowed_dashboards=body.allowed_dashboards or [],
        allowed_ips=body.allowed_ips or [],
        allowed_origins=body.allowed_origins or [],
        max_ttl_seconds=body.max_ttl_seconds,
        is_active=True,
    )
    db.add(client)
    db.commit()
    db.refresh(client)
    return IntegrationClientCreated(
        id=client.id, key_id=client.key_id, secret=secret,
        name=client.name, max_ttl_seconds=client.max_ttl_seconds,
    )


@router.get("/clients", response_model=list[IntegrationClientInfo])
def list_integration_clients(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)
    clients = db.query(IntegrationClient).order_by(IntegrationClient.created_at.desc()).all()
    return [
        IntegrationClientInfo(
            id=c.id, key_id=c.key_id, name=c.name, is_active=c.is_active,
            allowed_dashboards=c.allowed_dashboards, allowed_ips=c.allowed_ips,
            max_ttl_seconds=c.max_ttl_seconds, created_at=c.created_at, last_used_at=c.last_used_at,
        )
        for c in clients
    ]


@router.post("/clients/{client_id}/revoke", status_code=status.HTTP_200_OK)
def revoke_integration_client(
    client_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)
    client = db.query(IntegrationClient).filter(IntegrationClient.id == client_id).first()
    if not client:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Client not found.")
    client.is_active = False
    db.commit()
    return {"status": "revoked", "id": str(client_id)}


# ---------------------------------------------------------------------------
# HMAC-signed embed resolution (called by external software A)
# ---------------------------------------------------------------------------

def _request_origin(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}".rstrip("/")


@router.post("/embed/resolve", response_model=EmbedResolveResponse)
@_limiter.limit("120/minute")
def resolve_embed_link(
    body: EmbedResolveRequest,
    request: Request,
    db: Session = Depends(get_db),
    client: IntegrationClient = Depends(require_integration_client),
):
    # AuthZ: client scoped to this dashboard.
    if not client_allows_dashboard(client, body.dashboard_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client not authorized for this dashboard.")

    dash = db.query(Dashboard).filter(Dashboard.id == body.dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found.")

    # Validate + lock filters (RLS-style), then dedupe to one stable link.
    locked = validate_and_lock_filters(db, dash, body.filters)
    canonical = canonicalize_filters(locked)
    filter_hash = compute_filter_hash(dash.id, canonical)
    link = get_or_create_embed_link(db, dash, locked, filter_hash)

    # Mint a fresh rotating grant (TTL capped by the client).
    ttl = min(body.ttl_seconds or DEFAULT_TTL_SECONDS, client.max_ttl_seconds)
    raw_token, grant = mint_embed_grant(db, link, client.id, ttl)

    logger.info(
        "embed_resolve client=%s key=%s dashboard=%s filter_hash=%s ttl=%s ip=%s",
        client.id, client.key_id, dash.id, filter_hash[:12], ttl,
        (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "")),
    )
    origin = _request_origin(request)
    embed_path = f"/embed/{raw_token}"
    return EmbedResolveResponse(
        embed_url=f"{origin}{embed_path}",
        embed_path=embed_path,
        expires_at=grant.expires_at,
        filter_hash=filter_hash,
    )
