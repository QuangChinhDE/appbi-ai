"""Offline test fixtures: the real MCP app in-process, a tiny fake AppBI behind it.

The fake implements only what these tests touch (identity by PAT, health). It is
NOT a model of AppBI's business rules; tests that need real AppBI behaviour live
in tests/live and run against the rig.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx2
import pytest
from cryptography.fernet import Fernet
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from appbi_mcp.config import Settings
from appbi_mcp.server import create_app

PUBLIC = "http://localhost:18999"


@dataclass
class FakeAppbi:
    users: dict[str, dict[str, Any]] = field(default_factory=dict)  # pat -> user
    calls: list[tuple[str, str]] = field(default_factory=list)

    def add_user(self, email: str) -> str:
        pat = "appbi_pat_" + secrets.token_hex(8) + "." + secrets.token_urlsafe(16)
        self.users[pat] = {"id": f"user-{len(self.users) + 1}", "email": email, "full_name": email.split("@")[0], "permissions": {}}
        return pat

    def revoke(self, pat: str) -> None:
        self.users.pop(pat, None)

    def app(self) -> Starlette:
        async def me(request: Request) -> JSONResponse:
            self.calls.append(("GET", "/auth/me"))
            auth = request.headers.get("authorization", "")
            user = self.users.get(auth[7:]) if auth.startswith("Bearer ") else None
            if not user:
                return JSONResponse({"detail": "Invalid or expired token"}, status_code=401)
            return JSONResponse(user)

        async def health(_: Request) -> JSONResponse:
            return JSONResponse({"status": "healthy"})

        async def anything_else(request: Request) -> JSONResponse:
            # Recorded so a test can prove a refused tool never reached AppBI.
            self.calls.append((request.method, request.url.path.removeprefix("/api/v1")))
            return JSONResponse({"detail": "Not Found"}, status_code=404)

        return Starlette(routes=[Route("/api/v1/auth/me", me), Route("/api/v1/health", health),
                                 Route("/api/v1/{rest:path}", anything_else, methods=["GET", "POST", "PUT", "PATCH", "DELETE"])])


def make_settings(tmp_path, **over: Any) -> Settings:
    base = dict(
        public_url=PUBLIC,
        appbi_api_url="http://appbi.test/api/v1",
        appbi_public_url=PUBLIC,
        state_dir=str(tmp_path / "state"),
        state_key=Fernet.generate_key(),
        cookie_secure=False,
        connect_path="/connect/mcp",
        extra_redirect_uris=[],
        allow_loopback_redirects=True,
        cimd_allowed_hosts=["claude.ai"],
        access_token_ttl=3600,
        refresh_token_ttl=86400,
        grant_max_ttl=7 * 86400,
        rate_limit_per_minute=600,
        max_concurrent_operations=2,
        operation_budget_seconds=60,
        appbi_timeout_seconds=10.0,
        log_level="INFO",
        build_sha="test",
    )
    base.update(over)
    return Settings(**base)


@pytest.fixture
def fake_appbi() -> FakeAppbi:
    return FakeAppbi()


@pytest.fixture
def app(tmp_path, fake_appbi):
    settings = make_settings(tmp_path)
    return create_app(settings, appbi_transport=httpx2.ASGITransport(app=fake_appbi.app()))


@pytest.fixture
async def client(app):
    # The lifespan (the SDK session manager's task group) must enter and exit in
    # ONE task; pytest-asyncio tears fixtures down in another, so it gets its own.
    import asyncio

    started, stop = asyncio.Event(), asyncio.Event()

    async def run_lifespan() -> None:
        async with app.router.lifespan_context(app):
            started.set()
            await stop.wait()

    task = asyncio.create_task(run_lifespan())
    await started.wait()
    transport = httpx2.ASGITransport(app=app)
    async with httpx2.AsyncClient(transport=transport, base_url=PUBLIC, follow_redirects=False) as c:
        yield c
    stop.set()
    await task


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


REDIRECT = "http://localhost:43123/callback"


async def register(c: httpx2.AsyncClient, redirect: str = REDIRECT) -> str:
    r = await c.post("/mcp-oauth/register", json={
        "redirect_uris": [redirect], "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "client_name": "test",
    })
    assert r.status_code == 201, r.text
    return r.json()["client_id"]


async def connect(c: httpx2.AsyncClient, pat: str, *, client_id: str | None = None, redirect: str = REDIRECT,
                  granted: str = "full", scope: str | None = "appbi.read appbi.author appbi.publish") -> dict[str, Any]:
    """Drive authorize → connect/start → (AppBI page) callback → token, like the browser does."""
    client_id = client_id or await register(c, redirect)
    verifier, challenge = pkce()
    params = {"client_id": client_id, "response_type": "code", "code_challenge": challenge, "code_challenge_method": "S256",
              "redirect_uri": redirect, "state": "st-1", "resource": f"{PUBLIC}/mcp"}
    if scope:
        params["scope"] = scope
    r = await c.get("/mcp-oauth/authorize", params=params)
    assert r.status_code == 302, r.text
    start = urlparse(r.headers["location"])
    r = await c.get(start.path, params=parse_qs(start.query))
    assert r.status_code == 302
    txn = r.headers["location"].rsplit("/", 1)[-1]
    binding = r.cookies.get("appbi_mcp_txn") or c.cookies.get("appbi_mcp_txn")
    assert binding
    r = await c.post("/mcp-oauth/appbi-callback", data={"txn": txn, "decision": "allow", "pat": pat, "granted": granted})
    assert r.status_code == 200, r.text
    assert "http-equiv=refresh" in r.text
    target = r.text.split("url=", 1)[1].split("'", 1)[0].replace("&amp;", "&")
    q = {k: v[0] for k, v in parse_qs(urlparse(target).query).items()}
    assert q["state"] == "st-1" and q["iss"] == f"{PUBLIC}/mcp-oauth"
    r = await c.post("/mcp-oauth/token", data={"grant_type": "authorization_code", "code": q["code"], "redirect_uri": redirect,
                                                 "client_id": client_id, "code_verifier": verifier, "resource": f"{PUBLIC}/mcp"})
    assert r.status_code == 200, r.text
    out = r.json()
    out.update(client_id=client_id, code=q["code"], verifier=verifier, redirect=redirect, txn=txn)
    return out


def rpc(name: str, args: dict[str, Any] | None = None, method: str = "tools/call") -> dict[str, Any]:
    params: dict[str, Any] = {"name": name, "arguments": args or {}} if method == "tools/call" else {}
    return {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}


MCP_HEADERS = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", "Host": "localhost:18999"}
