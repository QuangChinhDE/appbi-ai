"""HMAC request-signing auth for machine-to-machine integration clients.

An external system (e.g. "software A") signs each request with a shared secret
so the secret itself never travels on the wire, and each request is tamper- and
replay-protected. Used by POST /api/v1/integrations/embed/resolve.

Signature scheme (symmetric HMAC-SHA256):

    canonical = METHOD \\n PATH \\n X-Timestamp \\n X-Nonce \\n sha256hex(body)
    X-Signature = hex( HMAC_SHA256(secret, canonical) )

Verification: recompute + constant-time compare, enforce a timestamp window,
reject a reused (client_id, nonce) inside that window, then check IP allowlist.
The shared secret is stored ENCRYPTED (Fernet, reversible) — not hashed —
because the server must recompute the signature.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.crypto import decrypt_value, encrypt_value
from app.core.database import get_db
from app.models.models import IntegrationClient, IntegrationNonce

INTEGRATION_KEY_PREFIX = "appbi_ic_"
# How far a request timestamp may drift from server time (seconds). Bounds the
# replay window; nonces are retained for this long.
SIGNATURE_WINDOW_SECONDS = 300


def generate_client_credentials() -> tuple[str, str]:
    """Return (key_id, secret). key_id is public; secret is shown once."""
    key_id = f"{INTEGRATION_KEY_PREFIX}{secrets.token_hex(8)}"
    secret = secrets.token_urlsafe(32)
    return key_id, secret


def encrypt_client_secret(secret: str) -> str:
    return encrypt_value(secret)


def decrypt_client_secret(secret_enc: str) -> str:
    return decrypt_value(secret_enc)


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_canonical_string(method: str, path: str, timestamp: str, nonce: str, body: bytes) -> str:
    return "\n".join([method.upper(), path, str(timestamp), str(nonce), _sha256_hex(body or b"")])


def sign_request(secret: str, method: str, path: str, timestamp: str, nonce: str, body: bytes) -> str:
    canonical = build_canonical_string(method, path, timestamp, nonce, body)
    return hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


def _client_ip(request: Request) -> str:
    # Honor the first X-Forwarded-For hop when behind the app's reverse proxy,
    # else the socket peer.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


def _prune_expired_nonces(db: Session) -> None:
    # Cheap opportunistic cleanup so the table can't grow unbounded.
    try:
        db.query(IntegrationNonce).filter(
            IntegrationNonce.expires_at < datetime.now(timezone.utc)
        ).delete(synchronize_session=False)
        db.commit()
    except Exception:
        db.rollback()


async def require_integration_client(
    request: Request,
    db: Session = Depends(get_db),
    x_client_id: str | None = Header(default=None),
    x_timestamp: str | None = Header(default=None),
    x_nonce: str | None = Header(default=None),
    x_signature: str | None = Header(default=None),
) -> IntegrationClient:
    """FastAPI dependency: authenticate an HMAC-signed integration request.

    Returns the active IntegrationClient or raises 401. IP + dashboard scope are
    enforced by the endpoint (IP here, dashboards where the target is known).
    """
    if not (x_client_id and x_timestamp and x_nonce and x_signature):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing HMAC auth headers (X-Client-Id, X-Timestamp, X-Nonce, X-Signature).",
        )

    # 1. Timestamp window (bounds replay + rejects stale/premature requests).
    try:
        ts = int(x_timestamp)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid X-Timestamp.")
    now = int(datetime.now(timezone.utc).timestamp())
    if abs(now - ts) > SIGNATURE_WINDOW_SECONDS:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Request timestamp outside allowed window.")

    # 2. Look up the client.
    client = (
        db.query(IntegrationClient)
        .filter(IntegrationClient.key_id == x_client_id, IntegrationClient.is_active == True)
        .first()
    )
    if not client:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown or inactive client.")

    # 3. Verify signature (constant-time) over the RAW body.
    body = await request.body()
    secret = decrypt_client_secret(client.secret_enc)
    expected = sign_request(secret, request.method, request.url.path, x_timestamp, x_nonce, body)
    if not hmac.compare_digest(expected, str(x_signature)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature.")

    # 4. Replay protection: a (client, nonce) may be used once in the window.
    _prune_expired_nonces(db)
    nonce_row = IntegrationNonce(
        client_id=client.id,
        nonce=str(x_nonce)[:128],
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=SIGNATURE_WINDOW_SECONDS),
    )
    db.add(nonce_row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Replay detected (nonce already used).")

    # 5. IP allowlist (empty/null = any).
    allowed_ips = client.allowed_ips or []
    if allowed_ips:
        if _client_ip(request) not in {str(ip).strip() for ip in allowed_ips}:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Client IP not allowed.")

    client.last_used_at = datetime.now(timezone.utc)
    db.commit()
    return client


def client_allows_dashboard(client: IntegrationClient, dashboard_id: int) -> bool:
    allowed = client.allowed_dashboards or []
    if not allowed:  # empty/null = any dashboard
        return True
    return dashboard_id in {int(d) for d in allowed if str(d).isdigit() or isinstance(d, int)}
