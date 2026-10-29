"""Small, dependency-free safety helpers shared across the service."""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from typing import Any
from urllib.parse import urlparse

import httpx2

REDACTED = "[redacted]"

# Keys whose values are never shown to a model or written to a log. AppBI already
# masks data-source secrets; this is the second fence, not the first.
_SECRET_KEY = re.compile(
    r"(password|passwd|secret|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|"
    r"credential|client[_-]?secret|authorization|^token$|_token$|^pat$|service[_-]?account)",
    re.IGNORECASE,
)
_SECRET_VALUE = re.compile(r"(appbi_pat_[A-Za-z0-9._-]+|amcp_(?:at|rt)_[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)")


def redact(value: Any, *, _depth: int = 0) -> Any:
    if _depth > 40:
        return REDACTED
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if isinstance(k, str) and _SECRET_KEY.search(k) and v not in (None, "", [], {}):
                out[k] = REDACTED
            else:
                out[k] = redact(v, _depth=_depth + 1)
        return out
    if isinstance(value, list):
        return [redact(v, _depth=_depth + 1) for v in value]
    if isinstance(value, str) and _SECRET_VALUE.search(value):
        return _SECRET_VALUE.sub(REDACTED, value)
    return value


def clamp_rows(rows: Any, limit: int) -> tuple[Any, bool]:
    """Return (rows[:limit], truncated)."""
    if isinstance(rows, list) and len(rows) > limit:
        return rows[:limit], True
    return rows, False


# ── CIMD fetch (SSRF-guarded) ──────────────────────────────────────────────────


class UnsafeUrlError(ValueError):
    pass


def _ip_is_public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    return addr.is_global and not (addr.is_multicast or addr.is_reserved)


async def _resolve_public(host: str, port: int) -> None:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not infos:
        raise UnsafeUrlError(f"{host} does not resolve")
    for info in infos:
        ip = info[4][0]
        if not _ip_is_public(ip):
            raise UnsafeUrlError(f"{host} resolves to a non-public address")


async def fetch_client_metadata_document(url: str, allowed_hosts: list[str], *, max_bytes: int = 65536) -> dict[str, Any]:
    """Fetch an OAuth Client ID Metadata Document.

    The host allowlist is the primary control; the public-address check and the
    no-redirect rule stop the fetch from being turned against internal services.
    """
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise UnsafeUrlError("client_id metadata URL must be https")
    host = parsed.hostname.lower()
    if host not in {h.lower() for h in allowed_hosts}:
        raise UnsafeUrlError(f"client_id host {host} is not allowed")
    if parsed.port not in (None, 443):
        raise UnsafeUrlError("client_id metadata URL must use port 443")
    if parsed.fragment or parsed.username or parsed.password:
        raise UnsafeUrlError("client_id metadata URL must not carry credentials or a fragment")
    await _resolve_public(host, 443)

    async with httpx2.AsyncClient(timeout=5.0, follow_redirects=False) as client:
        async with client.stream("GET", url, headers={"Accept": "application/json"}) as resp:
            if resp.status_code != 200:
                raise UnsafeUrlError(f"client_id metadata fetch returned {resp.status_code}")
            body = bytearray()
            async for chunk in resp.aiter_bytes():
                body.extend(chunk)
                if len(body) > max_bytes:
                    raise UnsafeUrlError("client_id metadata document too large")
    import json

    doc = json.loads(bytes(body))
    if not isinstance(doc, dict):
        raise UnsafeUrlError("client_id metadata document must be a JSON object")
    if doc.get("client_id") != url:
        raise UnsafeUrlError("client_id in the metadata document does not match its URL")
    return doc
