"""The HTTP gate in front of /mcp.

Runs before the MCP SDK sees the request, so credential failures are real HTTP
statuses (Claude starts sign-in only on a 401):

* no / unknown / expired / revoked / wrong-resource token  → 401 + WWW-Authenticate
* more calls than the grant's budget                        → 429 + Retry-After
* tokens in the query string are ignored, never accepted.

A tools/call above the grant's scopes is NOT answered here: an HTTP 403
`insufficient_scope` is a step-up challenge, and for a read-only grant (the user
chose read-only, or their AppBI account cannot edit) no step-up can succeed — the
pinned Claude Desktop bridge waited on it until it timed out (pilot finding P8). The
tool layer refuses it instead, before any AppBI call, with a message the user can
act on (`tools/runtime.py`).
"""

from __future__ import annotations

import json
import logging

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ..context import AppContext, Principal
from ..state import new_id
from . import scopes as sc

log = logging.getLogger("appbi_mcp.auth")

MAX_BODY = 4 * 1024 * 1024


class McpAuthGate:
    def __init__(self, app: ASGIApp, ctx: AppContext, tool_scopes: dict[str, str]):
        self.app = app
        self.ctx = ctx
        self.tool_scopes = tool_scopes

    def _challenge(self, status: int, error: str | None, description: str, scope: str | None = None) -> tuple[int, list[tuple[bytes, bytes]], bytes]:
        parts = []
        if error:
            parts.append(f'error="{error}"')
            parts.append(f'error_description="{description}"')
        parts.append(f'resource_metadata="{self.ctx.settings.resource_metadata_url}"')
        # First sign-in asks for everything the connector can do (the user may still
        # choose read-only on the AppBI consent page); a 403 names just what is missing.
        parts.append(f'scope="{scope or " ".join(sc.ALL_SCOPES)}"')
        body = json.dumps({"error": error or "unauthorized", "error_description": description}).encode()
        headers = [
            (b"content-type", b"application/json"),
            (b"www-authenticate", ("Bearer " + ", ".join(parts)).encode()),
            (b"cache-control", b"no-store"),
        ]
        return status, headers, body

    async def _send(self, send: Send, status: int, headers: list[tuple[bytes, bytes]], body: bytes, request_id: str) -> None:
        headers = headers + [(b"content-length", str(len(body)).encode()), (b"x-request-id", request_id.encode())]
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = new_id("req")
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        auth = headers.get("authorization", "")
        if not auth.lower().startswith("bearer ") or not auth[7:].strip():
            await self._send(send, *self._challenge(401, None, "Sign in to AppBI to use this connector"), request_id)
            return
        token = await self.ctx.provider.load_access_token(auth[7:].strip())
        if token is None or not self.ctx.provider.resource_matches(token.resource) or token.resource is None:
            await self._send(send, *self._challenge(401, "invalid_token", "The access token is invalid, expired or revoked"), request_id)
            return

        allowed, retry_after = self.ctx.tool_limiter.allow(f"grant:{token.grant_id}")
        if not allowed:
            body = json.dumps({"error": "rate_limited", "error_description": "Too many requests; slow down."}).encode()
            await self._send(
                send, 429,
                [(b"content-type", b"application/json"), (b"retry-after", str(max(1, int(retry_after))).encode())],
                body, request_id,
            )
            return

        body = b""
        if scope.get("method") == "POST":
            chunks: list[bytes] = []
            size = 0
            more = True
            while more:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                size += len(chunk)
                if size > MAX_BODY:
                    await self._send(send, 413, [(b"content-type", b"application/json")], b'{"error":"request_too_large"}', request_id)
                    return
                chunks.append(chunk)
                more = message.get("more_body", False)
            body = b"".join(chunks)

        principal = Principal(
            user_id=token.subject or "",
            email=str((token.claims or {}).get("email") or ""),
            grant_id=token.grant_id,
            client_id=token.client_id,
            scopes=list(token.scopes),
            request_id=request_id,
        )
        scope.setdefault("state", {})["principal"] = principal

        replayed = False

        async def replay() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                message = dict(message)
                message["headers"] = list(message.get("headers", [])) + [(b"x-request-id", request_id.encode())]
            await send(message)

        await self.app(scope, replay if scope.get("method") == "POST" else receive, send_with_id)
