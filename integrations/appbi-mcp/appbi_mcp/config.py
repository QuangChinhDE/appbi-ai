"""Runtime configuration, read once from the environment.

Everything here is the MCP's own: it never reads AppBI's `.env`, database URL,
`SECRET_KEY` or `DATASOURCE_ENCRYPTION_KEY`. A missing required value stops the
process at start-up rather than surfacing later as a half-working auth flow.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from urllib.parse import urlparse

from cryptography.fernet import Fernet


class ConfigError(RuntimeError):
    pass


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is required")
    return value


def _int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc
    if not lo <= value <= hi:
        raise ConfigError(f"{name} must be between {lo} and {hi}")
    return value


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def _list(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if raw is None:
        return list(default)
    return [part.strip() for part in raw.split(",") if part.strip()]


def _base_url(name: str, value: str, *, allow_http_hosts: tuple[str, ...]) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in ("https", "http") or not parsed.hostname:
        raise ConfigError(f"{name} must be an absolute http(s) URL")
    if parsed.scheme == "http" and parsed.hostname not in allow_http_hosts:
        raise ConfigError(f"{name} must be https (http is only allowed for {', '.join(allow_http_hosts)})")
    if parsed.query or parsed.fragment:
        raise ConfigError(f"{name} must not carry a query or fragment")
    return value.rstrip("/")


# Claude's hosted apps share one callback; claude.com is announced as a future
# alias, so both are accepted. Claude Code uses a loopback redirect on an
# ephemeral port, which `oauth.provider` matches with the port ignored.
DEFAULT_REDIRECT_URIS = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
]

LOCAL_HTTP_HOSTS = ("localhost", "127.0.0.1")


@dataclass(frozen=True)
class Settings:
    public_url: str                # origin Claude reaches, e.g. https://report.example.com
    appbi_api_url: str             # internal AppBI API base, e.g. http://appbi-backend-api:8000/api/v1
    appbi_public_url: str          # AppBI origin users browse, for deep links + the connect page
    state_dir: str
    state_key: bytes
    cookie_secure: bool
    connect_path: str
    extra_redirect_uris: list[str]
    allow_loopback_redirects: bool
    cimd_allowed_hosts: list[str]
    access_token_ttl: int
    refresh_token_ttl: int
    grant_max_ttl: int
    rate_limit_per_minute: int
    max_concurrent_operations: int
    operation_budget_seconds: int
    appbi_timeout_seconds: float
    log_level: str
    build_sha: str
    extra_allowed_hosts: list[str] = field(default_factory=list)

    @property
    def resource_url(self) -> str:
        """Canonical MCP server URI (RFC 8707 resource / RFC 9728 `resource`)."""
        return f"{self.public_url}/mcp"

    @property
    def issuer(self) -> str:
        return f"{self.public_url}/mcp-oauth"

    @property
    def resource_metadata_url(self) -> str:
        return f"{self.public_url}/.well-known/oauth-protected-resource/mcp"

    @property
    def public_host(self) -> str:
        return urlparse(self.public_url).netloc

    @property
    def redirect_uris(self) -> list[str]:
        return DEFAULT_REDIRECT_URIS + self.extra_redirect_uris


def load_settings() -> Settings:
    public_url = _base_url("MCP_PUBLIC_URL", _required("MCP_PUBLIC_URL"), allow_http_hosts=LOCAL_HTTP_HOSTS)
    appbi_public_url = _base_url(
        "APPBI_PUBLIC_URL", os.environ.get("APPBI_PUBLIC_URL", "").strip() or public_url,
        allow_http_hosts=LOCAL_HTTP_HOSTS,
    )
    # The internal API URL is a container-network address, so plain http to a
    # service name is expected; only shape is checked.
    appbi_api_url = _required("APPBI_API_URL").rstrip("/")
    if urlparse(appbi_api_url).scheme not in ("http", "https"):
        raise ConfigError("APPBI_API_URL must be an http(s) URL")

    raw_key = _required("MCP_STATE_KEY").encode()
    try:
        Fernet(raw_key)
    except Exception as exc:  # noqa: BLE001 - any decode failure is a config error
        raise ConfigError("MCP_STATE_KEY must be a Fernet key (Fernet.generate_key())") from exc

    https = public_url.startswith("https://")
    return Settings(
        public_url=public_url,
        appbi_api_url=appbi_api_url,
        appbi_public_url=appbi_public_url,
        state_dir=os.environ.get("MCP_STATE_DIR", "/data").strip() or "/data",
        state_key=raw_key,
        # A local http rig cannot set Secure cookies; production (https) always does.
        cookie_secure=_bool("MCP_COOKIE_SECURE", https),
        connect_path=os.environ.get("MCP_CONNECT_PATH", "/connect/mcp").strip() or "/connect/mcp",
        extra_redirect_uris=_list("MCP_EXTRA_REDIRECT_URIS", []),
        allow_loopback_redirects=_bool("MCP_ALLOW_LOOPBACK_REDIRECTS", True),
        cimd_allowed_hosts=_list("MCP_CIMD_ALLOWED_HOSTS", ["claude.ai"]),
        access_token_ttl=_int("MCP_ACCESS_TOKEN_TTL", 3600, 300, 86400),
        refresh_token_ttl=_int("MCP_REFRESH_TOKEN_TTL", 30 * 86400, 3600, 90 * 86400),
        grant_max_ttl=_int("MCP_GRANT_MAX_TTL", 90 * 86400, 86400, 365 * 86400),
        rate_limit_per_minute=_int("MCP_RATE_LIMIT_PER_MINUTE", 60, 1, 6000),
        max_concurrent_operations=_int("MCP_MAX_CONCURRENT_OPERATIONS", 2, 1, 20),
        operation_budget_seconds=_int("MCP_OPERATION_BUDGET_SECONDS", 600, 30, 3600),
        appbi_timeout_seconds=float(_int("MCP_APPBI_TIMEOUT_SECONDS", 60, 5, 300)),
        log_level=os.environ.get("MCP_LOG_LEVEL", "INFO").strip().upper() or "INFO",
        build_sha=os.environ.get("APPBI_MCP_BUILD_SHA", "unknown").strip() or "unknown",
        extra_allowed_hosts=_list("MCP_EXTRA_ALLOWED_HOSTS", []),
    )
