"""Configuration of the Public Read MCP process (its own key and state, never the author's)."""

from __future__ import annotations

import os
from dataclasses import dataclass, fields

from cryptography.fernet import Fernet

from ..config import ConfigError, Settings, _int, load_settings

PUBLIC_SCOPE = "appbi.public.read"


@dataclass(frozen=True)
class PublicSettings(Settings):
    pair_ttl: int = 600
    session_ttl: int = 8 * 3600
    viewer_ack_timeout: float = 10.0
    runtime_urls: tuple = ()
    runtime_secret: str = ""

    @property
    def resource_url(self) -> str:
        return f"{self.public_url}/public-mcp"

    @property
    def issuer(self) -> str:
        return f"{self.public_url}/public-mcp-oauth"

    @property
    def resource_metadata_url(self) -> str:
        return f"{self.public_url}/.well-known/oauth-protected-resource/public-mcp"


def load_public_settings() -> PublicSettings:
    key = os.environ.get("PUBLIC_MCP_STATE_KEY", "").strip()
    if not key:
        raise ConfigError("PUBLIC_MCP_STATE_KEY is required (its own Fernet key, never the author MCP's)")
    try:
        Fernet(key.encode())
    except Exception as exc:  # noqa: BLE001
        raise ConfigError("PUBLIC_MCP_STATE_KEY must be a Fernet key") from exc
    if key == os.environ.get("MCP_STATE_KEY", "").strip():
        raise ConfigError("PUBLIC_MCP_STATE_KEY must differ from MCP_STATE_KEY: the two services do not share state")
    os.environ["MCP_STATE_KEY"] = key  # load_settings validates the shared fields with it
    base = load_settings()
    values = {f.name: getattr(base, f.name) for f in fields(Settings)}
    values.update(
        state_dir=os.environ.get("PUBLIC_MCP_STATE_DIR", "/data").strip() or "/data",
        state_key=key.encode(),
        # A viewer session lives at most as long as AppBI's grant (8 h); tokens are short.
        access_token_ttl=_int("PUBLIC_MCP_ACCESS_TOKEN_TTL", 3600, 300, 8 * 3600),
        refresh_token_ttl=8 * 3600,
        grant_max_ttl=8 * 3600,
        rate_limit_per_minute=_int("PUBLIC_MCP_RATE_LIMIT_PER_MINUTE", 60, 1, 600),
    )
    from .runtimes import parse_runtime_urls

    values["runtime_urls"] = tuple(parse_runtime_urls(os.environ.get("PUBLIC_MCP_RUNTIMES", "")))
    values["runtime_secret"] = os.environ.get("PUBLIC_MCP_RUNTIME_SECRET", "").strip()
    return PublicSettings(**values)
