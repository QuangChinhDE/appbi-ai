"""Application assembly for the Public Read MCP (`python -m appbi_mcp.public`).

  /.well-known/oauth-protected-resource/public-mcp   resource metadata
  /public-mcp-oauth/{authorize,token,register,revoke} OAuth (author provider machinery)
  /public-mcp-oauth/pair                             pairing page: the code the report shows
  /public-mcp/bridge/sessions[...]                   the viewer's tab (browser secret)
  /public-mcp                                        the MCP endpoint (bearer, viewer grant)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator
from html import escape
from typing import Any
from urllib.parse import urlparse

import httpx2
from mcp.server import MCPServer
from mcp.server.auth.handlers.authorize import AuthorizationHandler
from mcp.server.auth.handlers.register import RegistrationHandler
from mcp.server.auth.handlers.revoke import RevocationHandler
from mcp.server.auth.handlers.token import TokenHandler
from mcp.server.auth.middleware.client_auth import ClientAuthenticator
from mcp.server.auth.provider import construct_redirect_uri
from mcp.server.auth.settings import ClientRegistrationOptions
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.routing import Route, request_response

from .. import __version__
from ..context import AppContext
from ..oauth.bearer import McpAuthGate
from ..oauth.routes import _cors, _json, _load_txn, _return_to_client
from ..pages import page
from ..ratelimit import RateLimiter, client_ip
from ..state import sha256_hex
from .bridge import Bridge, Refused
from .runtimes import PoolBusy, RuntimePool
from .provider import PublicOAuthProvider
from .settings import PUBLIC_SCOPE, PublicSettings, load_public_settings
from .store import PublicStore
from .tools import INSTRUCTIONS, register_public_tools

log = logging.getLogger("appbi_mcp.public")

TXN_COOKIE = "appbi_pmcp_txn"


class PublicAuthGate(McpAuthGate):
    def _challenge(self, status: int, error: str | None, description: str, scope: str | None = None):  # type: ignore[override]
        return super()._challenge(status, error, description, scope or PUBLIC_SCOPE)


def _ip(request: Request) -> str:
    return client_ip({k.lower(): v for k, v in request.headers.items()}, request.client.host if request.client else None)


def _pair_page(txn: dict[str, Any], *, error: str = "", status: int = 200) -> Response:
    p = txn["params"]
    client = escape(p.get("client_name") or "Claude")
    redirect = escape(urlparse(p["redirect_uri"]).hostname or "")
    err = f"<p class=err>{escape(error)}</p>" if error else ""
    body = (
        "<h1>Connect Claude to a public report</h1>"
        f"<p><b>{client}</b> (returns to <code>{redirect}</code>) asks to read ONE AppBI report you have open, "
        "and to change what you see on it (filters, page, highlighted chart). It cannot change the report itself.</p>"
        "<p>Type the code shown on the report, under <b>Ask your Claude</b>.</p>"
        f"{err}"
        "<form method=post>"
        f"<input type=hidden name=txn value='{escape(txn['id'], quote=True)}'>"
        "<p><input name=code autocomplete=off autofocus required maxlength=12 placeholder='ABCD-2345' "
        "style='font:600 22px ui-monospace,Consolas,monospace;letter-spacing:3px;padding:8px 12px;width:220px'></p>"
        "<p><button class=primary name=decision value=allow>Connect</button> "
        "<span style='display:inline-block;width:48px'></span>"
        "<button name=decision value=deny>Cancel</button></p></form>"
    )
    return page("Connect Claude", body, status=status)


def create_public_app(settings: PublicSettings | None = None, *, appbi_transport: httpx2.AsyncBaseTransport | None = None,
                      runtime_transport: httpx2.AsyncBaseTransport | None = None) -> Starlette:
    settings = settings or load_public_settings()
    store = PublicStore(settings.state_dir, settings.state_key)
    provider = PublicOAuthProvider(settings, store)
    ctx = AppContext(settings=settings, store=store, provider=provider, appbi_transport=appbi_transport)
    bridge = Bridge(ctx)
    pool = RuntimePool(ctx, list(settings.runtime_urls), settings.runtime_secret, transport=runtime_transport)
    pool.bridge = bridge  # the lease reads the report brief with the session's grant
    bridge.on_end = pool.release_session
    pair_limiter = RateLimiter(10, burst=5)
    bridge_limiter = RateLimiter(20, burst=10)

    mcp = MCPServer(name="AppBI public report", title="AppBI public report", instructions=INSTRUCTIONS, version=__version__)
    register_public_tools(mcp, ctx, bridge)
    public_hostname = urlparse(settings.public_url).hostname or settings.public_host
    mcp_http = mcp.streamable_http_app(
        streamable_http_path="/public-mcp",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[settings.public_host, public_hostname, "localhost:*", "127.0.0.1:*", *settings.extra_allowed_hosts],
            allowed_origins=[settings.public_url, settings.appbi_public_url, "https://claude.ai", "https://claude.com"],
        ),
    )
    gated = PublicAuthGate(mcp_http, ctx, {})

    # ── OAuth ────────────────────────────────────────────────────────────────
    authenticator = ClientAuthenticator(provider)  # type: ignore[arg-type]
    token_handler = TokenHandler(provider, authenticator)  # type: ignore[arg-type]
    authorize_handler = AuthorizationHandler(provider)  # type: ignore[arg-type]
    register_handler = RegistrationHandler(
        provider,  # type: ignore[arg-type]
        options=ClientRegistrationOptions(enabled=True, valid_scopes=[PUBLIC_SCOPE, "offline_access"], default_scopes=[PUBLIC_SCOPE]),
    )
    revoke_handler = RevocationHandler(provider, authenticator)  # type: ignore[arg-type]

    def limited(handler: Any, bucket: str) -> Any:
        async def wrapped(request: Request) -> Response:
            ok, _ = ctx.auth_limiter.allow(f"{bucket}:{_ip(request)}")
            if not ok:
                return _json({"error": "temporarily_unavailable", "error_description": "too many requests"}, 429)
            return await handler(request)

        return wrapped

    def prm_doc() -> dict[str, Any]:
        return {"resource": settings.resource_url, "authorization_servers": [settings.issuer],
                "scopes_supported": [PUBLIC_SCOPE], "bearer_methods_supported": ["header"],
                "resource_name": "AppBI public report"}

    def asm_doc() -> dict[str, Any]:
        iss = settings.issuer
        return {
            "issuer": iss, "authorization_endpoint": f"{iss}/authorize", "token_endpoint": f"{iss}/token",
            "registration_endpoint": f"{iss}/register", "revocation_endpoint": f"{iss}/revoke",
            "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
            "revocation_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
            "client_id_metadata_document_supported": True, "authorization_response_iss_parameter_supported": True,
            "scopes_supported": [PUBLIC_SCOPE, "offline_access"],
        }

    async def prm(_: Request) -> Response:
        return _json(prm_doc())

    async def asm(_: Request) -> Response:
        return _json(asm_doc())

    def cookie_kwargs(max_age: int) -> dict[str, Any]:
        return {"max_age": max_age, "path": "/public-mcp-oauth", "secure": settings.cookie_secure, "httponly": True, "samesite": "lax"}

    async def pair_get(request: Request) -> Response:
        txn = _load_txn(ctx, request.query_params.get("txn", ""))
        binding = request.query_params.get("b", "")
        if not txn or txn["mode"] != "pair":
            return page("Link expired", "<h1 class=err>Link expired</h1><p>Start connecting from Claude again.</p>", status=400)
        if binding:
            if sha256_hex(binding) != txn["binding_hash"]:
                return page("Link expired", "<h1 class=err>Link expired</h1><p>Start connecting from Claude again.</p>", status=400)
            # move the binding into an httpOnly cookie and off the URL
            resp = RedirectResponse(f"{settings.issuer}/pair?txn={txn['id']}", status_code=302, headers={"Cache-Control": "no-store"})
            resp.set_cookie(TXN_COOKIE, binding, **cookie_kwargs(int(txn["expires_at"] - time.time())))
            return resp
        return _pair_page(txn)

    async def pair_post(request: Request) -> Response:
        origin = request.headers.get("origin")
        if origin and origin != settings.public_url:
            return page("Not allowed", "<h1 class=err>Not allowed</h1>", status=403)
        form = await request.form()
        txn = _load_txn(ctx, str(form.get("txn") or ""))
        cookie = request.cookies.get(TXN_COOKIE, "")
        if not txn or txn["mode"] != "pair" or not cookie or sha256_hex(cookie) != txn["binding_hash"]:
            return page("Could not connect", "<h1 class=err>Could not connect</h1><p>Start connecting from Claude in this browser again.</p>", status=400)
        p = txn["params"]

        def finish(st: str) -> None:
            with store.transaction() as cur:
                cur.execute("UPDATE auth_txns SET status = ? WHERE id = ? AND status = 'pending'", (st, txn["id"]))

        if str(form.get("decision") or "") != "allow":
            finish("denied")
            resp = _return_to_client(construct_redirect_uri(p["redirect_uri"], error="access_denied", state=p.get("state"), iss=settings.issuer), ok=False)
            resp.delete_cookie(TXN_COOKIE, path="/public-mcp-oauth")
            return resp
        ok, _ = pair_limiter.allow(f"pair:{_ip(request)}")
        ok_txn, _ = pair_limiter.allow(f"pairtxn:{txn['id']}")
        if not (ok and ok_txn):
            return _pair_page(txn, error="Too many attempts. Wait a minute and try again.", status=429)
        row = bridge.claim(str(form.get("code") or ""))
        if row is None:
            log.info("pair: wrong or expired code (txn %s)", txn["id"])
            return _pair_page(txn, error="That code is not valid or has expired. Get a new code on the report and try again.", status=400)
        grant = provider.create_viewer_grant(session_id=row["id"], client_id=p["client_id"], expires_at=row["expires_at"])
        code = provider.issue_code(p, grant["id"], [PUBLIC_SCOPE])
        finish("completed")
        log.info("pair: session %s bound to client %s (grant %s)", row["id"], p["client_id"], grant["id"])
        resp = _return_to_client(construct_redirect_uri(p["redirect_uri"], code=code, state=p.get("state"), iss=settings.issuer), ok=True)
        resp.delete_cookie(TXN_COOKIE, path="/public-mcp-oauth")
        return resp

    # ── bridge (the viewer's tab) ────────────────────────────────────────────
    def _bridge_json(data: Any, status: int = 200) -> JSONResponse:
        return JSONResponse(data, status_code=status, headers={"Cache-Control": "no-store"})

    def _tab(request: Request) -> dict[str, Any] | None:
        return bridge.browser_session(request.path_params["sid"], request.headers.get("x-bridge-secret", ""))

    async def session_create(request: Request) -> Response:
        ok, _ = bridge_limiter.allow(f"bridge:{_ip(request)}")
        if not ok:
            return _bridge_json({"error": "rate_limited"}, 429)
        try:
            body = await request.json()
            out = await bridge.create_session(str((body or {}).get("grant") or ""))
        except Refused as exc:
            return _bridge_json({"error": exc.code, "message": exc.message}, exc.status if exc.status >= 400 else 400)
        except ValueError:
            return _bridge_json({"error": "bad_request"}, 400)
        return _bridge_json(out, 201)

    async def session_commands(request: Request) -> Response:
        row = _tab(request)
        if row is None:
            return _bridge_json({"error": "session_ended"}, 410)
        try:
            after = int(request.query_params.get("after", "0"))
        except ValueError:
            after = 0
        try:
            wait = min(25.0, max(0.0, float(request.query_params.get("wait", "25"))))
        except ValueError:
            wait = 25.0
        bridge.touch(row["id"])
        cmds = await bridge.poll(row["id"], after, wait)
        fresh = bridge.session(row["id"])
        if fresh is None:
            return _bridge_json({"error": "session_ended"}, 410)
        return _bridge_json({"commands": cmds, "claude_connected": bool(fresh.get("claimed_at")),
                             "pair_pending": bool(fresh.get("pair_hash")),
                             "last_command_id": bridge.last_command_id(row["id"])})

    async def session_state(request: Request) -> Response:
        row = _tab(request)
        if row is None:
            return _bridge_json({"error": "session_ended"}, 410)
        try:
            body = await request.json()
            bridge.report_state(row["id"], (body or {}).get("state"), (body or {}).get("ack"))
        except Refused as exc:
            return _bridge_json({"error": exc.code}, exc.status)
        except ValueError:
            return _bridge_json({"error": "bad_request"}, 400)
        return _bridge_json({"ok": True})

    async def session_code(request: Request) -> Response:
        row = _tab(request)
        if row is None:
            return _bridge_json({"error": "session_ended"}, 410)
        ok, _ = bridge_limiter.allow(f"code:{row['id']}")
        if not ok:
            return _bridge_json({"error": "rate_limited"}, 429)
        return _bridge_json({"pair_code": bridge.new_code(row["id"]), "pair_expires_in": settings.pair_ttl})

    async def session_runtime(request: Request) -> Response:
        """A Claude runtime of the pool for THIS tab's session, its MCP already connected."""
        row = _tab(request)
        if row is None:
            return _bridge_json({"error": "session_ended"}, 410)
        if not pool.enabled:
            return _bridge_json({"error": "runtime_unavailable", "message": "Claude in the report is not enabled here."}, 404)
        ok, _ = bridge_limiter.allow(f"runtime:{row['id']}")
        if not ok:
            return _bridge_json({"error": "rate_limited"}, 429)
        try:
            lease = await pool.lease(row)
        except PoolBusy:
            return _bridge_json({"error": "pool_busy", "message": "All Claude seats are in use. Try again in a few minutes."}, 503)
        except Exception as exc:  # noqa: BLE001
            log.warning("runtime lease failed: %s", type(exc).__name__)
            return _bridge_json({"error": "runtime_failed", "message": "Claude could not be started. Try again."}, 502)
        resp = _bridge_json({"panel_path": lease["panel_path"], "runtime": lease["runtime"]})
        resp.set_cookie(f"appbi_pmcp_rt_{lease['runtime']}", lease["cookie"], path=lease["panel_path"], httponly=True,
                        samesite="strict", secure=settings.cookie_secure, max_age=settings.session_ttl)
        return resp

    async def runtime_auth(request: Request) -> Response:
        """nginx auth_request for /claude-rt/<n>/...: only the browser holding that lease's cookie."""
        import re as _re

        m = _re.match(r"^/claude-rt/(\d+)/", request.headers.get("x-original-uri", ""))
        if not m:
            return Response(status_code=403)
        i = int(m.group(1))
        return Response(status_code=204 if pool.authorize_panel(i, request.cookies.get(f"appbi_pmcp_rt_{i}", "")) else 403)

    async def runtime_pool(request: Request) -> Response:
        import secrets as _s

        if not pool.enabled or not _s.compare_digest(request.headers.get("x-runtime-secret", ""), pool.secret_for(1)):
            return _bridge_json({"error": "not_found"}, 404)
        return _bridge_json({"runtimes": await pool.status()})

    async def runtime_transcript(request: Request) -> Response:
        """A runtime reports one finished Claude turn of its viewer (history). Only that runtime
        (its own secret) and only for the lease it currently holds; kept by AppBI with the
        session's grant, when the publisher keeps history."""
        return await _runtime_relay(request, "/public/mcp/transcript",
                                    lambda body, sess: {"turn": body.get("turn") or {}, "view_state": bridge.view_state(sess)})

    async def runtime_rating(request: Request) -> Response:
        """The viewer's up/down on one of their Claude answers, relayed by their runtime."""
        return await _runtime_relay(request, "/public/mcp/rating",
                                    lambda body, _sess: {"turn": str(body.get("turn") or "")[:64],
                                                         "rating": str(body.get("rating") or "")[:8]})

    async def _runtime_relay(request: Request, path: str, build: Any) -> Response:
        import secrets as _s

        try:
            index = int(request.headers.get("x-runtime-index", "0"))
            body = await request.json()
        except ValueError:
            return _bridge_json({"error": "bad_request"}, 400)
        if (not pool.enabled or index < 1 or index > len(pool.urls)
                or not _s.compare_digest(request.headers.get("x-runtime-secret", ""), pool.secret_for(index))):
            return _bridge_json({"error": "not_found"}, 404)
        lease = pool.store.query_one("SELECT * FROM runtime_leases WHERE runtime = ? AND ended_at IS NULL", (index,))
        if not lease or lease["id"] != str((body or {}).get("lease_id") or ""):
            return _bridge_json({"error": "no_lease"}, 409)
        sess = bridge.session(lease["session_id"])
        grant = bridge.grant_of(sess) if sess else None
        if not grant:
            return _bridge_json({"error": "session_ended"}, 410)
        try:
            out = await bridge.appbi(grant).post(path, build(body or {}, sess))
        except Refused as exc:
            return _bridge_json({"error": exc.code}, exc.status if exc.status >= 400 else 400)
        return _bridge_json(out)

    async def session_end(request: Request) -> Response:
        row = _tab(request)
        if row is not None:
            bridge.end(row["id"], "viewer_disconnected")
        return _bridge_json({"ok": True})

    def bridge_cors(endpoint: Any, methods: list[str]) -> Any:
        return CORSMiddleware(app=request_response(endpoint), allow_origins=[settings.appbi_public_url],
                              allow_methods=methods, allow_headers=["content-type", "x-bridge-secret"], max_age=600)

    async def healthz(_: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "service": "public-mcp", "version": __version__, "build_sha": settings.build_sha})

    @contextlib.asynccontextmanager
    async def lifespan(_: Starlette) -> AsyncIterator[None]:
        store.purge_expired()
        reaper = asyncio.create_task(pool.reaper_loop(bridge)) if pool.enabled else None
        async with mcp.session_manager.run():
            yield
        if reaper:
            reaper.cancel()
        store.close()

    iss_path = urlparse(settings.issuer).path
    res_path = urlparse(settings.resource_url).path
    meta = _cors(request_response(prm), ["GET", "OPTIONS"])
    ameta = _cors(request_response(asm), ["GET", "OPTIONS"])
    routes = [
        Route(f"{res_path}/healthz", healthz, methods=["GET"]),
        Route(f"/.well-known/oauth-protected-resource{res_path}", endpoint=meta, methods=["GET", "OPTIONS"]),
        Route(f"/.well-known/oauth-authorization-server{iss_path}", endpoint=ameta, methods=["GET", "OPTIONS"]),
        Route(f"/.well-known/openid-configuration{iss_path}", endpoint=ameta, methods=["GET", "OPTIONS"]),
        Route(f"{iss_path}/.well-known/openid-configuration", endpoint=ameta, methods=["GET", "OPTIONS"]),
        Route(f"{iss_path}/authorize", endpoint=limited(authorize_handler.handle, "authorize"), methods=["GET", "POST"]),
        Route(f"{iss_path}/token", endpoint=_cors(request_response(limited(token_handler.handle, "token")), ["POST", "OPTIONS"]), methods=["POST", "OPTIONS"]),
        Route(f"{iss_path}/register", endpoint=_cors(request_response(limited(register_handler.handle, "register")), ["POST", "OPTIONS"]), methods=["POST", "OPTIONS"]),
        Route(f"{iss_path}/revoke", endpoint=_cors(request_response(limited(revoke_handler.handle, "revoke")), ["POST", "OPTIONS"]), methods=["POST", "OPTIONS"]),
        Route(f"{iss_path}/pair", endpoint=pair_get, methods=["GET"]),
        Route(f"{iss_path}/pair", endpoint=pair_post, methods=["POST"]),
        Route(f"{res_path}/bridge/sessions", endpoint=bridge_cors(session_create, ["POST"]), methods=["POST", "OPTIONS"]),
        Route(f"{res_path}/bridge/sessions/{{sid}}/commands", endpoint=bridge_cors(session_commands, ["GET"]), methods=["GET", "OPTIONS"]),
        Route(f"{res_path}/bridge/sessions/{{sid}}/state", endpoint=bridge_cors(session_state, ["POST"]), methods=["POST", "OPTIONS"]),
        Route(f"{res_path}/bridge/sessions/{{sid}}/code", endpoint=bridge_cors(session_code, ["POST"]), methods=["POST", "OPTIONS"]),
        Route(f"{res_path}/bridge/sessions/{{sid}}/end", endpoint=bridge_cors(session_end, ["POST"]), methods=["POST", "OPTIONS"]),
        Route(f"{res_path}/bridge/sessions/{{sid}}/runtime", endpoint=bridge_cors(session_runtime, ["POST"]), methods=["POST", "OPTIONS"]),
        Route(f"{res_path}/runtime-auth", endpoint=runtime_auth, methods=["GET"]),
        Route(f"{res_path}/runtime-pool", endpoint=runtime_pool, methods=["GET"]),
        Route(f"{res_path}/runtime-transcript", endpoint=runtime_transcript, methods=["POST"]),
        Route(f"{res_path}/runtime-rating", endpoint=runtime_rating, methods=["POST"]),
        Route(res_path, endpoint=gated, methods=["GET", "POST", "DELETE"]),
    ]
    app = Starlette(routes=routes, lifespan=lifespan)
    app.state.ctx = ctx
    app.state.bridge = bridge
    app.state.pool = pool
    return app


def main() -> None:
    import uvicorn

    from ..server import _configure_logging

    settings = load_public_settings()
    _configure_logging(settings.log_level)
    log.info("starting appbi public mcp %s (build %s)", __version__, settings.build_sha)
    uvicorn.run(create_public_app(settings), host="0.0.0.0", port=8091, proxy_headers=False, server_header=False,
                log_config=None, access_log=False, timeout_graceful_shutdown=10)
