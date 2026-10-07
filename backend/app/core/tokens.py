"""Signed-token domains. One function to mint, one to verify, per purpose.

Before this, six token kinds (access, refresh, public-link session, workspace
session, internal staff session, Google OAuth state) were all HS256 JWTs signed
with the same ``SECRET_KEY`` and told apart only by an optional ``type`` claim
that several decoders never checked: a refresh token or an OAuth ``state``
(which travels in a URL) was accepted as a staff bearer, and a token without
``type`` was accepted as an access token.

Now every domain has:
* its OWN key, derived from SECRET_KEY with HKDF (label ``appbi/jwt/<domain>/v1``)
  - a token of one domain does not even verify in another;
* a fixed ``iss`` and a per-domain ``aud`` that are verified;
* a mandatory ``type`` equal to the domain.

``decode`` returns the claims or None. It never raises on a bad token and never
falls back to another domain or to the raw SECRET_KEY.

Personal access tokens are not JWTs; their HMAC keeps its own key (unchanged
by this module, so no PAT is invalidated).

Cutover: tokens minted before this change no longer verify. Users sign in once
again (access 2h / refresh 7d); public-link password sessions and workspace
sessions re-authenticate.
"""
from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Dict, Optional

from jose import JWTError, jwt

ALGORITHM = "HS256"
ISSUER = "appbi"

ACCESS = "access"
REFRESH = "refresh"
PUBLIC_SESSION = "public_link_session"
WORKSPACE_SESSION = "workspace_session"
OAUTH_STATE = "google_data_access_state"

DOMAINS = (ACCESS, REFRESH, PUBLIC_SESSION, WORKSPACE_SESSION, OAUTH_STATE)


@lru_cache(maxsize=None)
def _key(domain: str, root: str) -> str:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    if domain not in DOMAINS:
        raise ValueError(f"unknown token domain {domain!r}")
    raw = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None,
        info=f"appbi/jwt/{domain}/v1".encode(),
    ).derive(root.encode())
    return base64.urlsafe_b64encode(raw).decode()


def _root() -> str:
    from app.core.config import settings

    return settings.SECRET_KEY


def new_security_stamp() -> str:
    """A fresh per-user security stamp. Access and refresh tokens carry the
    stamp current when they were minted (`ss`); rotating it ends every
    outstanding session of that user at once (password change, deactivation,
    status change)."""
    import uuid

    return uuid.uuid4().hex


def audience(domain: str) -> str:
    return f"appbi:{domain}"


def encode(domain: str, claims: Dict[str, Any], *, ttl: timedelta) -> str:
    """Mint a token of ``domain``. ``type``/``iss``/``aud``/``iat``/``exp`` are
    set here and cannot be overridden by ``claims``."""
    now = datetime.now(timezone.utc)
    payload = dict(claims)
    payload.update({
        "type": domain, "iss": ISSUER, "aud": audience(domain),
        "iat": now, "exp": now + ttl,
    })
    return jwt.encode(payload, _key(domain, _root()), algorithm=ALGORITHM)


def decode(token: Optional[str], domain: str) -> Optional[Dict[str, Any]]:
    """Claims of a valid ``domain`` token, else None."""
    if not token or domain not in DOMAINS:
        return None
    try:
        data = jwt.decode(
            token, _key(domain, _root()), algorithms=[ALGORITHM],
            audience=audience(domain), issuer=ISSUER,
        )
    except JWTError:
        return None
    if data.get("type") != domain:
        return None
    return data
