"""Bearer-token auth for machine-to-machine integration clients.

An external system (e.g. "software A") authenticates each request with a single
opaque Bearer token:

    Authorization: Bearer appbi_embed_<secret>

Only the SHA-256 hash of the token is stored, so a database leak can't recover
it. The token is server-to-server only (it must never be shipped to a browser);
the embed URL returned to the caller carries a separate short-lived opaque
grant, not this token. Used by POST /api/v1/integrations/embed/resolve.
"""
import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.models import IntegrationClient

EMBED_TOKEN_PREFIX = "appbi_embed_"


def generate_client_token() -> str:
    """Return a fresh opaque client token (shown to the operator once)."""
    return f"{EMBED_TOKEN_PREFIX}{secrets.token_urlsafe(32)}"


def hash_client_token(raw_token: str) -> str:
    """SHA-256 hex of the raw token — what we store + compare against."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _client_ip(request: Request) -> str:
    # First X-Forwarded-For hop when behind the app's reverse proxy, else peer.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


async def require_integration_client(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> IntegrationClient:
    """FastAPI dependency: authenticate a Bearer-token integration request.

    Returns the active IntegrationClient or raises 401. Dashboard scope is
    enforced by the endpoint; the IP allowlist (if set) is enforced here.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token (Authorization: Bearer <token>).",
            headers={"WWW-Authenticate": "Bearer"},
        )
    raw = authorization[len("bearer "):].strip()
    if not raw.startswith(EMBED_TOKEN_PREFIX):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.")

    client = (
        db.query(IntegrationClient)
        .filter(
            IntegrationClient.token_hash == hash_client_token(raw),
            IntegrationClient.is_active == True,
        )
        .first()
    )
    if not client:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or inactive token.")

    # IP allowlist (empty/null = any).
    allowed_ips = client.allowed_ips or []
    if allowed_ips and _client_ip(request) not in {str(ip).strip() for ip in allowed_ips}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client IP not allowed.")

    client.last_used_at = datetime.now(timezone.utc)
    db.commit()
    return client


def client_allows_dashboard(client: IntegrationClient, dashboard_id: int) -> bool:
    allowed = client.allowed_dashboards or []
    if not allowed:  # empty/null = any dashboard
        return True
    return dashboard_id in {int(d) for d in allowed if str(d).isdigit() or isinstance(d, int)}
