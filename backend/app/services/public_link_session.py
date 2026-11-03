"""Password sessions for public links — one implementation for every kind of link.

A session is bound to ONE link of ONE resource kind at ONE security generation:

- `sub` is the link token, so a session can never be replayed on another link;
- `lid` is the link row id and `av` its `auth_version`: changing or clearing the
  password, disabling / re-enabling the link or changing its expiry bumps
  `auth_version`, and every session minted before stops verifying at once;
- `k` names the resource kind. Dashboard sessions carry no `k` (the format they had
  before this module existed, so live sessions keep working); every other kind must
  carry its own, and a session of one kind never verifies on a link of another — a
  dashboard link and a report link with the same row id cannot share a session.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any, Optional

PUBLIC_SESSION_SECONDS = 7200
DASHBOARD = "dashboard"


def create_session(link: Any, kind: str = DASHBOARD) -> str:
    from app.core import tokens

    claims = {"sub": link.token, "lid": link.id, "av": int(link.auth_version or 0)}
    if kind != DASHBOARD:
        claims["k"] = kind
    return tokens.encode(tokens.PUBLIC_SESSION, claims, ttl=timedelta(seconds=PUBLIC_SESSION_SECONDS))


def verify_session(session_token: Optional[str], link: Any, kind: str = DASHBOARD) -> bool:
    from app.core import tokens

    if not session_token:
        return False
    data = tokens.decode(session_token, tokens.PUBLIC_SESSION)
    if data is None:
        return False
    if data.get("k", DASHBOARD) != kind:
        return False
    return (
        data.get("sub") == link.token
        and data.get("lid") == link.id
        and data.get("av") == int(link.auth_version or 0)
    )
