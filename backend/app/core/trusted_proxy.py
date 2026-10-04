"""Which address is the client? Decided here, once, for every rate limit.

THE BUG THIS REPLACES
---------------------
Uvicorn ran with `--proxy-headers --forwarded-allow-ips="*"`. With "*" its
ProxyHeadersMiddleware (0.27) takes the LEFTMOST X-Forwarded-For entry as the
client. nginx appends the address it saw (`$proxy_add_x_forwarded_for`), so the
leftmost entry is whatever the CLIENT sent. Rotating that header gave every
request a fresh identity and defeated every per-IP limit — including the 10/min
password limit on public links.

THE CONTRACT
------------
* Forwarded headers are honoured only when the connecting peer is a proxy we
  run: an address inside ``TRUSTED_PROXY_CIDRS`` (default: loopback and private
  ranges — the backend is published on 127.0.0.1 only, so the peers are host
  nginx through the Docker gateway and sibling containers).
* The client is then ``XFF[-TRUSTED_PROXY_HOPS]``: counting from the RIGHT, the
  address our outermost proxy saw. Entries to its left were written by the
  client and are ignored. Default 1 hop (host nginx). Put a cloud load balancer
  in front of nginx and this becomes 2.
* With fewer entries than hops, or an untrusted peer, the peer itself is the
  client. A request that bypasses nginx cannot pick its identity.
* `X-Forwarded-Proto` is honoured from a trusted peer only (it decides the
  scheme of redirect URLs).

Rate limits keep calling slowapi's `get_remote_address` (request.client.host);
this middleware is what makes that value trustworthy.
"""
from __future__ import annotations

import ipaddress
import os
from typing import Iterable

_DEFAULT_CIDRS = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7"


def _parse_cidrs(raw: str) -> list:
    nets = []
    for part in (raw or "").split(","):
        part = part.strip()
        if part:
            nets.append(ipaddress.ip_network(part, strict=False))
    return nets


def _ip(value: str | None):
    if not value:
        return None
    try:
        return ipaddress.ip_address(value.strip())
    except ValueError:
        return None


class TrustedProxyMiddleware:
    def __init__(self, app, trusted_cidrs: Iterable | str | None = None, hops: int | None = None):
        self.app = app
        if trusted_cidrs is None:
            trusted_cidrs = os.getenv("TRUSTED_PROXY_CIDRS", _DEFAULT_CIDRS)
        self.trusted = _parse_cidrs(trusted_cidrs) if isinstance(trusted_cidrs, str) else list(trusted_cidrs)
        if hops is None:
            hops = int(os.getenv("TRUSTED_PROXY_HOPS", "1") or 1)
        self.hops = max(1, int(hops))

    def _is_trusted(self, host: str | None) -> bool:
        ip = _ip(host)
        return ip is not None and any(ip in net for net in self.trusted)

    def resolve(self, peer: str | None, xff: str | None) -> str | None:
        """The client address for a request from ``peer`` carrying ``xff``."""
        if not self._is_trusted(peer):
            return peer
        entries = [e.strip() for e in (xff or "").split(",") if e.strip()]
        if len(entries) < self.hops:
            return peer
        candidate = entries[-self.hops]
        return candidate if _ip(candidate) is not None else peer

    async def __call__(self, scope, receive, send):
        if scope.get("type") in ("http", "websocket"):
            client = scope.get("client")
            peer = client[0] if client else None
            if self._is_trusted(peer):
                headers = {k.lower(): v for k, v in scope.get("headers") or []}
                xff = headers.get(b"x-forwarded-for")
                resolved = self.resolve(peer, xff.decode("latin1") if xff else None)
                if resolved and resolved != peer:
                    scope = dict(scope)
                    scope["client"] = (resolved, 0)
                proto = headers.get(b"x-forwarded-proto")
                if proto:
                    p = proto.decode("latin1").strip().lower()
                    if p in ("http", "https"):
                        scope = dict(scope)
                        if scope["type"] == "websocket":
                            scope["scheme"] = "wss" if p == "https" else "ws"
                        else:
                            scope["scheme"] = p
        await self.app(scope, receive, send)
