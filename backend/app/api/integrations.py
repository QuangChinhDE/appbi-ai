"""Machine-to-machine embed API.

- POST /integrations/embed/resolve — authenticated with the caller's Personal
  Access Token (PAT, the same token the MCP uses). Given a dashboard the PAT's
  user can view, it returns a fresh, rotating, ~256-char embed URL
  (`/embed/emb_...`) valid ~1h, scoped to a set of LOCKED filters. Call again
  after it expires to get a new URL. This link is DIFFERENT from a public-share
  link created in the Public Link modal: it rotates and self-expires.

The embed (`emb_`) token resolves through the existing public endpoints via
api/public.py:_get_dashboard_by_token — the underlying managed link's own token
is never exposed, and normal public/share links are unaffected.
"""
import hashlib
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session
from datetime import datetime

from app.core.config import settings
from app.core.database import get_db
from app.core.dependencies import get_current_user, require_view_access
from app.models.models import Dashboard
from app.models.user import User
from app.services.embed_link_service import (
    DEFAULT_TTL_SECONDS,
    HEADER_MAX_LENGTH,
    canonicalize_filters,
    compute_filter_hash,
    get_or_create_embed_link,
    mint_embed_grant,
    sanitize_embed_header,
    validate_and_lock_filters,
)

router = APIRouter(prefix="/integrations", tags=["integrations"])
logger = logging.getLogger(__name__)
_limiter = Limiter(key_func=get_remote_address)


def _resolve_rate_key(request: Request) -> str:
    """Rate-limit key for /embed/resolve: the caller's PAT (Authorization
    header), NOT their IP. A host app mints one scoped link per viewer from a
    single server IP — keying by IP would throttle the whole integration as if
    it were one abusive client. Keying by the (hashed) bearer token gives each
    integrating account its own generous budget. Falls back to IP when no
    Authorization header is present (shouldn't happen — the route is authed)."""
    auth = (request.headers.get("authorization") or "").strip()
    if auth:
        return "pat:" + hashlib.sha256(auth.encode("utf-8")).hexdigest()
    return get_remote_address(request)


class EmbedResolveRequest(BaseModel):
    dashboard_id: int = Field(..., ge=1)
    filters: list[dict] = Field(default_factory=list)
    ttl_seconds: int | None = Field(default=None, ge=60, le=86400)
    # Title the embedded report should show, e.g. "Doanh thu — Chi nhánh Hà Nội".
    # Omitted → the report keeps its managed link's internal name
    # ("embed:<dashboard>:<filter-hash>"), which is fine for debugging but reads
    # as a code to whoever opens the iframe. Stored per grant, so two host apps
    # embedding the same data slice can title it differently.
    header: str | None = Field(default=None, max_length=HEADER_MAX_LENGTH)
    # Safety gate: embedding the WHOLE report (no row-scoping) must be explicit.
    # No filters + full_report=False → 400, so a caller can't accidentally leak
    # the entire dataset by forgetting the per-viewer scope.
    full_report: bool = Field(default=False)


class EmbedResolveResponse(BaseModel):
    embed_url: str
    embed_path: str
    expires_at: datetime
    filter_hash: str
    # The title this link will actually display, after trimming/normalising the
    # requested `header` (null = the report falls back to its link name). Echoed
    # back so the caller can assert what the viewer will see.
    header: str | None = None


def _request_origin(request: Request) -> str:
    # Prefer the configured public URL so the returned embed_url is correct even
    # behind a reverse proxy (which may expose an internal Host).
    configured = (settings.PUBLIC_BASE_URL or "").strip().rstrip("/")
    if configured:
        return configured
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}".rstrip("/")


@router.post("/embed/resolve", response_model=EmbedResolveResponse)
@_limiter.limit(lambda: settings.EMBED_RESOLVE_RATE_LIMIT, key_func=_resolve_rate_key)
def resolve_embed_link(
    body: EmbedResolveRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mint a rotating embed link for a dashboard the PAT's user can view."""
    dash = db.query(Dashboard).filter(Dashboard.id == body.dashboard_id).first()
    if not dash:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dashboard not found.")

    # Scope guardrail: the caller can only embed a dashboard they can access.
    require_view_access(db, current_user, dash, "dashboards")

    # Safety gate — see EmbedResolveRequest.full_report.
    if not body.filters and not body.full_report:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide at least one filter to scope the report, or set full_report=true to embed the whole report intentionally.",
        )

    # Validate + lock filters (RLS-style), dedupe to one managed link, mint grant.
    locked = validate_and_lock_filters(db, dash, body.filters)
    canonical = canonicalize_filters(locked)
    filter_hash = compute_filter_hash(dash.id, canonical)
    link = get_or_create_embed_link(db, dash, locked, filter_hash)

    ttl = min(body.ttl_seconds or DEFAULT_TTL_SECONDS, DEFAULT_TTL_SECONDS)
    header = sanitize_embed_header(body.header)
    raw_token, grant = mint_embed_grant(db, link, current_user.id, ttl, header=header)

    logger.info(
        "embed_resolve user=%s dashboard=%s filter_hash=%s ttl=%s header=%r ip=%s",
        current_user.id, dash.id, filter_hash[:12], ttl, header,
        (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "")),
    )
    origin = _request_origin(request)
    embed_path = f"/embed/{raw_token}"
    return EmbedResolveResponse(
        embed_url=f"{origin}{embed_path}",
        embed_path=embed_path,
        expires_at=grant.expires_at,
        filter_hash=filter_hash,
        header=header,
    )
