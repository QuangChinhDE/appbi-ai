"""Live acceptance harness: a real MCP client, a real browser, a real AppBI rig.

* MCP client: the official SDK `Client` over Streamable HTTP, authenticated with the
  SDK's own `OAuthClientProvider` (protected-resource discovery → AS metadata →
  dynamic client registration → PKCE authorize → token → refresh).
* Browser: Playwright Chromium per user. It signs in to AppBI on the real login page,
  clicks Allow on the real `/connect/mcp/<txn>` page, and later approves plans on the
  MCP approval page — with that user's own browser session, as a person would.
* Loopback callback: like Claude Code, the client registers
  `http://localhost:<port>/callback`; a tiny HTTP server captures the redirect.

Configuration (env):
  APPBI_RIG_URL    public origin of the rig (default http://localhost:18180)
  APPBI_RIG_STATE  path to the rig state.json (users + passwords + datasource id)
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx2
from mcp import Client
from mcp.client.auth import OAuthClientProvider, TokenStorage
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import AuthorizationCodeResult, OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

RIG_URL = os.environ.get("APPBI_RIG_URL", "http://localhost:18180").rstrip("/")
MCP_URL = f"{RIG_URL}/mcp"
API_URL = f"{RIG_URL}/api/v1"


def rig_state() -> dict[str, Any]:
    path = os.environ.get("APPBI_RIG_STATE")
    if not path or not Path(path).exists():
        raise RuntimeError("APPBI_RIG_STATE must point at the rig's state.json")
    return json.loads(Path(path).read_text())


class MemoryStorage(TokenStorage):
    def __init__(self) -> None:
        self.tokens: OAuthToken | None = None
        self.client_info: OAuthClientInformationFull | None = None

    async def get_tokens(self) -> OAuthToken | None:
        return self.tokens

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self.tokens = tokens

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        return self.client_info

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        self.client_info = client_info


class LoopbackCallback:
    """Captures `GET /callback?code=…&state=…&iss=…` on 127.0.0.1:<random port>."""

    def __init__(self) -> None:
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()
        self.result: asyncio.Future[dict[str, str]] | None = None
        self._server: asyncio.base_events.Server | None = None

    @property
    def redirect_uri(self) -> str:
        return f"http://localhost:{self.port}/callback"

    async def start(self) -> None:
        self.result = asyncio.get_running_loop().create_future()

        async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            line = (await reader.readline()).decode("latin-1")
            while (await reader.readline()) not in (b"\r\n", b"\n", b""):
                pass
            target = line.split(" ")[1] if " " in line else "/"
            q = {k: v[0] for k, v in parse_qs(urlparse(target).query).items()}
            if self.result and not self.result.done() and urlparse(target).path == "/callback":
                self.result.set_result(q)
            body = b"<html><body>You can close this window.</body></html>"
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
            await writer.drain()
            writer.close()

        self._server = await asyncio.start_server(handle, "127.0.0.1", self.port)

    async def wait(self, timeout: float = 90) -> dict[str, str]:
        assert self.result is not None
        return await asyncio.wait_for(self.result, timeout)

    async def stop(self) -> None:
        if self._server:
            self._server.close()


@dataclass
class Person:
    """One AppBI user with a browser and an MCP connection."""

    key: str
    email: str
    password: str
    browser_context: Any = None
    storage: MemoryStorage = field(default_factory=MemoryStorage)
    consent_choice: str = "allow"   # allow | deny | read_only
    events: list[str] = field(default_factory=list)

    async def login(self, page: Any) -> None:
        """Sign in on AppBI's real login page.

        AppBI limits logins to 5/min per IP; a suite signs in a few users from one
        machine, so a 429 is waited out once instead of failing the journey.
        """
        for attempt in range(2):
            await page.fill("#email", self.email)
            await page.fill("#password", self.password)
            async with page.expect_response(lambda r: "/auth/login" in r.url) as resp_info:
                await page.click("button[type=submit]")
            resp = await resp_info.value
            if resp.status != 429 or attempt:
                return
            await page.wait_for_timeout(62_000)

    async def authorize(self, authorization_url: str) -> None:
        """The redirect handler: what a user does in the browser Claude opens."""
        page = await self.browser_context.new_page()
        await page.goto(authorization_url)
        await page.wait_for_load_state("networkidle")
        if "/login" in page.url:
            await self.login(page)
        await page.wait_for_url("**/connect/mcp/**", timeout=30_000)
        await page.get_by_role("button", name="Allow").wait_for(timeout=30_000)
        self.events.append(f"consent page: {page.url}")
        if self.consent_choice == "read_only" and await page.get_by_role("checkbox").count():
            # A view-only user gets no checkbox: the page itself forces read-only.
            await page.get_by_role("checkbox").check()
        if self.consent_choice == "deny":
            await page.get_by_role("button", name="Deny").click()
        else:
            await page.get_by_role("button", name="Allow").click()
        # The MCP answers with a page that meta-refreshes to the loopback callback.
        try:
            await page.wait_for_url("http://localhost:*/callback*", timeout=30_000)
        except Exception:
            self.events.append(f"after consent: {page.url} :: {(await page.content())[:300]}")
            raise
        await page.close()

    async def approve(self, approval_url: str, decision: str = "Approve") -> str:
        page = await self.browser_context.new_page()
        await page.goto(approval_url)
        await page.get_by_role("button", name=decision).click()
        await page.wait_for_load_state("domcontentloaded")
        heading = await page.locator("h1").first.inner_text()
        await page.close()
        return heading


_SIGNED_IN: dict[str, Any] = {}


async def signed_in_context(b: Any, key: str, email: str, password: str) -> Any:
    """A browser context already signed in to AppBI as this user (one login per run)."""
    if key in _SIGNED_IN:
        return await b.new_context(storage_state=_SIGNED_IN[key])
    ctx = await b.new_context()
    page = await ctx.new_page()
    await page.goto(f"{RIG_URL}/login")
    await Person(key, email, password).login(page)
    await page.wait_for_url(lambda url: "/login" not in url, timeout=30_000)
    _SIGNED_IN[key] = await ctx.storage_state()
    await page.close()
    return ctx


@asynccontextmanager
async def browser(headless: bool = True):
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        b = await p.chromium.launch(headless=headless)
        try:
            yield b
        finally:
            await b.close()


@asynccontextmanager
async def mcp_session(person: Person, *, scope: str | None = None):
    """An MCP client session authenticated as `person` through the real OAuth flow."""
    callback = LoopbackCallback()
    await callback.start()

    async def redirect_handler(url: str) -> None:
        person.events.append("redirect to authorize")
        await person.authorize(url)

    async def callback_handler() -> AuthorizationCodeResult:
        q = await callback.wait()
        if "error" in q:
            raise PermissionError(f"authorization failed: {q.get('error')}")
        return AuthorizationCodeResult(code=q["code"], state=q.get("state"), iss=q.get("iss"))

    provider = OAuthClientProvider(
        server_url=MCP_URL,
        client_metadata=OAuthClientMetadata(
            client_name=f"acceptance-{person.key}",
            redirect_uris=[callback.redirect_uri],
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
            token_endpoint_auth_method="none",
            **({"scope": scope} if scope else {}),
        ),
        storage=person.storage,
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
    )
    http = httpx2.AsyncClient(auth=provider, timeout=httpx2.Timeout(180.0, connect=10.0))
    try:
        async with Client(streamable_http_client(MCP_URL, http_client=http)) as client:
            yield client
    finally:
        await http.aclose()
        await callback.stop()


def tool_json(result: Any) -> dict[str, Any]:
    """The JSON body a tool returned (unstructured text content)."""
    if getattr(result, "is_error", False) or getattr(result, "isError", False):
        texts = [getattr(c, "text", "") for c in result.content]
        return {"status": "tool_error", "message": " ".join(texts)}
    for c in result.content:
        text = getattr(c, "text", None)
        if text:
            try:
                return json.loads(text)
            except ValueError:
                return {"status": "text", "text": text}
    return {}


async def raw_mcp_post(token: str | None, body: dict[str, Any], *, url: str = MCP_URL) -> httpx2.Response:
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with httpx2.AsyncClient(timeout=30) as c:
        return await c.post(url, json=body, headers=headers)


async def appbi_session_token(email: str, password: str) -> str:
    async with httpx2.AsyncClient(timeout=30) as c:
        r = await c.post(f"{API_URL}/auth/login", json={"email": email, "password": password})
        r.raise_for_status()
        return r.json()["access_token"]
