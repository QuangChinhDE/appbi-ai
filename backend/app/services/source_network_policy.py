"""Outbound network policy for database sources (PostgreSQL / MySQL).

A saved data source makes the backend open a TCP connection to a host chosen by a
user. Without a policy that is a server-side request forgery primitive: point a
"PostgreSQL" source at 169.254.169.254, at the backend's own loopback, or at an
internal service, and the connection test becomes a port scanner and the error
message an oracle.

Rules (spec: docs/features/source-core-hardening/spec.md):

* Every A/AAAA candidate of the host is resolved and checked. ANY disallowed
  candidate refuses the destination (a name that resolves to one public and one
  private address is refused, not "tried until one works").
* Hard deny, never allowlisted: link-local (incl. the cloud metadata address
  169.254.169.254 and fd00:ec2::254, plus the name metadata.google.internal),
  unspecified, multicast, reserved.
* Loopback is refused unless an operator lists a loopback range EXPLICITLY in
  ``ALLOWED_PRIVATE_SOURCE_CIDRS`` (local test databases); the blanket
  ``SOURCE_ALLOW_PRIVATE_NETWORK`` switch never opens loopback.
* Any other non-global address (RFC1918, ULA, CGNAT, ...) is refused unless it is
  inside ``ALLOWED_PRIVATE_SOURCE_CIDRS`` or ``SOURCE_ALLOW_PRIVATE_NETWORK`` is true.
* The checked IP is returned; callers connect to THAT address (``hostaddr`` for
  libpq, the IP itself for pymysql) so a second DNS answer cannot rebind the
  connection to an address that was never checked.
"""
from __future__ import annotations

import ipaddress
import socket
from typing import List, Optional, Union

IPAddress = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]

_METADATA_IPS = {
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("fd00:ec2::254"),
    ipaddress.ip_address("100.100.100.200"),  # Alibaba Cloud metadata
}
_METADATA_HOSTNAMES = {"metadata.google.internal", "metadata", "metadata.goog"}

# Not flagged non-global by every Python version, but never a database host.
_ALWAYS_PRIVATE = [
    ipaddress.ip_network("100.64.0.0/10"),   # CGNAT
    ipaddress.ip_network("0.0.0.0/8"),
]


class SourceNetworkPolicyError(ValueError):
    """The destination host is not allowed by the outbound source policy."""


def _settings():
    from app.core.config import settings
    return settings


def _allowed_networks() -> List[Union[ipaddress.IPv4Network, ipaddress.IPv6Network]]:
    raw = str(getattr(_settings(), "ALLOWED_PRIVATE_SOURCE_CIDRS", "") or "")
    nets = []
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            nets.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            # A malformed entry allows nothing; it must not widen the policy.
            continue
    return nets


def _unwrap(ip: IPAddress) -> IPAddress:
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return ip.ipv4_mapped
        if ip.sixtofour is not None:
            return ip.sixtofour
        if ip.teredo is not None:
            return ip.teredo[1]
    return ip


def check_ip(ip: IPAddress) -> None:
    """Raise SourceNetworkPolicyError when *ip* is not an allowed destination."""
    ip = _unwrap(ip)
    if ip in _METADATA_IPS:
        raise SourceNetworkPolicyError("Destination is a cloud metadata address and is not allowed.")
    if ip.is_unspecified or ip.is_multicast or ip.is_link_local:
        raise SourceNetworkPolicyError("Destination address is not routable for a data source.")

    allowed = _allowed_networks()
    in_allowlist = any(ip.version == net.version and ip in net for net in allowed)

    # Loopback is classified BEFORE "reserved": IPv6 ::1 sits inside ::/8, which
    # Python flags is_reserved, so checking reserved first refused ::1 even when
    # ::1/128 was explicitly allowlisted (localhost -> [127.0.0.1, ::1]).
    if ip.is_loopback:
        if in_allowlist:
            return
        raise SourceNetworkPolicyError("Destination is a loopback address and is not allowed.")

    if ip.is_reserved:
        raise SourceNetworkPolicyError("Destination address is not routable for a data source.")

    private = (not ip.is_global) or any(ip.version == n.version and ip in n for n in _ALWAYS_PRIVATE)
    if not private:
        return
    if in_allowlist or bool(getattr(_settings(), "SOURCE_ALLOW_PRIVATE_NETWORK", False)):
        return
    raise SourceNetworkPolicyError(
        "Destination is a private network address. An administrator must allow it "
        "(ALLOWED_PRIVATE_SOURCE_CIDRS) before a data source can connect to it."
    )


def resolve_and_check(host: Optional[str], port: Optional[int] = None) -> str:
    """Resolve *host*, check every candidate, and return the address to connect to."""
    name = str(host or "").strip()
    if not name:
        raise SourceNetworkPolicyError("Host is required.")
    if name.startswith("[") and name.endswith("]"):
        name = name[1:-1]
    if "/" in name or any(c.isspace() for c in name) or "\x00" in name:
        raise SourceNetworkPolicyError("Host is not a valid hostname or IP address.")
    if name.lower().rstrip(".") in _METADATA_HOSTNAMES:
        raise SourceNetworkPolicyError("Destination is a cloud metadata address and is not allowed.")

    try:
        literal = ipaddress.ip_address(name.split("%", 1)[0])
    except ValueError:
        literal = None
    if literal is not None:
        check_ip(literal)
        return str(_unwrap(literal))

    try:
        infos = socket.getaddrinfo(name, int(port) if port else None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, ValueError) as exc:
        raise SourceNetworkPolicyError(f"Could not resolve host {name!r}.") from exc

    candidates: List[IPAddress] = []
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(str(addr).split("%", 1)[0])
        except ValueError:
            raise SourceNetworkPolicyError(f"Host {name!r} resolved to an unparseable address.")
        if ip not in candidates:
            candidates.append(ip)
    if not candidates:
        raise SourceNetworkPolicyError(f"Could not resolve host {name!r}.")
    for ip in candidates:
        check_ip(ip)
    # Prefer IPv4 for driver compatibility; every candidate passed the check.
    candidates.sort(key=lambda a: a.version)
    return str(candidates[0])
