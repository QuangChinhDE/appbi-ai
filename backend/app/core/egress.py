"""Central outbound-network policy (SSRF / credential-exfiltration guard).

Every connection whose DESTINATION a user can influence goes through here:

* HTTP to a user-configured URL (observability webhooks / Slack channels,
  workboard webhook sync) - ``http_post``;
* database connections to a datasource's configured host - ``pg_connect`` /
  ``mysql_connect`` (same keyword arguments as psycopg2 / pymysql).

Destinations whose host is fixed in code or set only by the operator's
environment (AI providers, embeddings, web search, SMTP, geocoding) are not
user-controlled and do not pass through here.

THE RULE
* The hostname is resolved ONCE; every resolved address must be allowed; the
  connection then goes to that pinned address (no DNS-rebinding window).
* Always refused: loopback, link-local (incl. cloud metadata 169.254.169.254,
  fd00:ec2::254), unspecified, multicast, reserved, and the IPv4-mapped /
  NAT64 / 6to4 forms of any of those. Numeric oddities (``2130706433``,
  ``0x7f.1``, ``017700000001``) are parsed by the resolver and land on the same
  check.
* Private (RFC 1918 / ULA / CGNAT) addresses are refused unless allow-listed:
  ``EGRESS_HTTP_ALLOW_CIDRS`` for HTTP, ``DATASOURCE_ALLOW_PRIVATE_CIDRS`` or
  ``DATASOURCE_ALLOW_HOSTS`` (exact hostnames, e.g. the bundled ``db``) for
  databases. Production default: nothing private is allowed.
* HTTP: only http/https, no redirects (a 3xx is returned as-is, never
  followed), no userinfo in the URL.
"""
from __future__ import annotations

import ipaddress
import os
import socket
from typing import Iterable
from urllib.parse import urlsplit, urlunsplit

_METADATA = (
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("fd00:ec2::254/128"),
    ipaddress.ip_network("100.100.100.200/32"),  # Alibaba metadata
)
_PRIVATE_EXTRA = (ipaddress.ip_network("100.64.0.0/10"),)  # CGNAT


class EgressDenied(PermissionError):
    """The destination is not an allowed outbound target."""


def _cidrs(env_name: str) -> list:
    raw = os.environ.get(env_name, "") or ""
    out = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            out.append(ipaddress.ip_network(part, strict=False))
    return out


def _hosts(env_name: str) -> set[str]:
    return {h.strip().lower() for h in (os.environ.get(env_name, "") or "").split(",") if h.strip()}


def _unwrap(ip):
    """IPv4 address hidden inside an IPv6 form (mapped, NAT64, 6to4)."""
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return ip.ipv4_mapped
        if ip.sixtofour is not None:
            return ip.sixtofour
        if ip in ipaddress.ip_network("64:ff9b::/96"):
            return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return ip


def classify(ip) -> str:
    """'public', 'private', or 'forbidden'."""
    ip = _unwrap(ipaddress.ip_address(ip))
    if any(ip in n for n in _METADATA if n.version == ip.version):
        return "forbidden"
    if (ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast
            or ip.is_reserved):
        return "forbidden"
    if ip.is_private or any(ip in n for n in _PRIVATE_EXTRA if n.version == ip.version):
        return "private"
    if not ip.is_global:
        return "forbidden"
    return "public"


def _resolve(host: str, port: int | None) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, port or 0, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise EgressDenied(f"cannot resolve {host!r}") from exc
    addrs = []
    for info in infos:
        a = info[4][0].split("%", 1)[0]
        if a not in addrs:
            addrs.append(a)
    if not addrs:
        raise EgressDenied(f"cannot resolve {host!r}")
    return addrs


def check_destination(host: str | None, port: int | None, *, private_cidrs: Iterable = (),
                      allowed_hosts: Iterable[str] = ()) -> str:
    """Validate ``host`` and return the single pinned IP to connect to."""
    if not host or not str(host).strip():
        raise EgressDenied("no destination host")
    host = str(host).strip().strip("[]")
    if "/" in host or host.startswith("-"):
        raise EgressDenied("invalid destination host")
    allow_named = host.lower() in {h.lower() for h in allowed_hosts}
    private_cidrs = list(private_cidrs)
    addrs = _resolve(host, port)
    for a in addrs:
        kind = classify(a)
        if kind == "forbidden":
            raise EgressDenied(f"destination {host!r} resolves to a forbidden address")
        if kind == "private" and not allow_named:
            ip = _unwrap(ipaddress.ip_address(a))
            if not any(ip.version == n.version and ip in n for n in private_cidrs):
                raise EgressDenied(f"destination {host!r} resolves to a private address")
    return addrs[0]


# ── HTTP ─────────────────────────────────────────────────────────────────────

def _http_check(url: str):
    parts = urlsplit(str(url or "").strip())
    if parts.scheme not in ("http", "https"):
        raise EgressDenied("only http(s) URLs are allowed")
    if parts.username or parts.password:
        raise EgressDenied("credentials in the URL are not allowed")
    if not parts.hostname:
        raise EgressDenied("URL has no host")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    ip = check_destination(parts.hostname, port, private_cidrs=_cidrs("EGRESS_HTTP_ALLOW_CIDRS"))
    return parts, ip, port


def validate_http_url(url: str) -> None:
    """Raise EgressDenied unless ``url`` is an allowed outbound HTTP target."""
    _http_check(url)


def _pinned(parts, ip: str, port: int):
    host_for_url = f"[{ip}]" if ":" in ip else ip
    netloc = f"{host_for_url}:{port}"
    url = urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
    host_header = parts.hostname + (f":{parts.port}" if parts.port else "")
    ext = {"sni_hostname": parts.hostname} if parts.scheme == "https" else {}
    return url, host_header, ext


def http_post(url: str, *, timeout: float = 10.0, **kwargs):
    """``httpx.post`` to a user-configured URL, through the egress policy:
    resolved once, connected to the pinned address (TLS still verifies the
    original hostname), redirects never followed."""
    import httpx

    parts, ip, port = _http_check(url)
    pinned_url, host_header, ext = _pinned(parts, ip, port)
    headers = dict(kwargs.pop("headers", None) or {})
    headers["Host"] = host_header
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        return client.post(pinned_url, headers=headers, extensions=ext, **kwargs)


async def http_post_async(client, url: str, **kwargs):
    """Async variant for an existing ``httpx.AsyncClient`` (must not follow
    redirects - enforced per request)."""
    parts, ip, port = _http_check(url)
    pinned_url, host_header, ext = _pinned(parts, ip, port)
    headers = dict(kwargs.pop("headers", None) or {})
    headers["Host"] = host_header
    kwargs.pop("follow_redirects", None)
    return await client.post(pinned_url, headers=headers, extensions=ext,
                             follow_redirects=False, **kwargs)


# ── Databases ────────────────────────────────────────────────────────────────

def _db_destination(host, port) -> str:
    return check_destination(
        host, int(port) if port else None,
        private_cidrs=_cidrs("DATASOURCE_ALLOW_PRIVATE_CIDRS"),
        allowed_hosts=_hosts("DATASOURCE_ALLOW_HOSTS"),
    )


def pg_connect(**kwargs):
    """``psycopg2.connect`` through the egress policy. The resolved address is
    pinned with ``hostaddr`` while ``host`` stays for TLS verification."""
    import psycopg2

    if kwargs.get("dsn") or kwargs.get("hostaddr"):
        raise EgressDenied("datasource connections must use host/port, not a DSN")
    kwargs["hostaddr"] = _db_destination(kwargs.get("host"), kwargs.get("port", 5432))
    return psycopg2.connect(**kwargs)


def mysql_connect(**kwargs):
    """``pymysql.connect`` through the egress policy, connected to the pinned
    address."""
    import pymysql

    if kwargs.get("unix_socket"):
        raise EgressDenied("datasource connections must use host/port")
    kwargs["host"] = _db_destination(kwargs.get("host"), kwargs.get("port", 3306))
    return pymysql.connect(**kwargs)
