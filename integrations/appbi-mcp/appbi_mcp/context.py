"""Process-wide objects, built once by `server.create_app`."""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx2

from .appbi_client import AppbiClient
from .config import Settings
from .oauth.provider import AppbiOAuthProvider
from .ratelimit import RateLimiter
from .state import StateStore


@dataclass
class Principal:
    """The verified caller of one MCP request."""

    user_id: str
    email: str
    grant_id: str
    client_id: str
    scopes: list[str]
    request_id: str


@dataclass
class AppContext:
    settings: Settings
    store: StateStore
    provider: AppbiOAuthProvider
    # Tests inject an ASGI transport pointing at a fake or real AppBI app.
    appbi_transport: httpx2.AsyncBaseTransport | None = None
    tool_limiter: RateLimiter = field(init=False)
    auth_limiter: RateLimiter = field(init=False)

    def __post_init__(self) -> None:
        self.tool_limiter = RateLimiter(self.settings.rate_limit_per_minute, burst=max(10, self.settings.rate_limit_per_minute // 3))
        self.auth_limiter = RateLimiter(30, burst=15)

    def appbi(self, pat: str, request_id: str) -> AppbiClient:
        return AppbiClient(
            base_url=self.settings.appbi_api_url,
            pat=pat,
            request_id=request_id,
            timeout=self.settings.appbi_timeout_seconds,
            user_agent=f"appbi-mcp/{self.settings.build_sha}",
            transport=self.appbi_transport,
        )

    def appbi_for(self, principal: Principal) -> AppbiClient | None:
        pat = self.provider.grant_pat(principal.grant_id)
        return self.appbi(pat, principal.request_id) if pat else None
