"""Log-safe references to bearer secrets.

A public-link token, an `emb_` grant token or a session JWT IS the credential:
anyone holding it can open the report. Application logs travel further than the
database (log shippers, support tickets, screenshots), so a log line names a
token by a short, stable, one-way reference instead — enough to correlate lines
for one link, useless as a credential.
"""
from __future__ import annotations

import hashlib


def token_ref(token: str | None) -> str:
    """`tok:` + the first 12 hex chars of the token's SHA-256 (or `tok:-`)."""
    if not token:
        return "tok:-"
    return "tok:" + hashlib.sha256(str(token).encode("utf-8")).hexdigest()[:12]
