"""OAuth endpoints for Claude, and the hand-off to AppBI's connect page.

Issuer: <MCP_PUBLIC_URL>/mcp-oauth. Endpoints hang off the issuer so nothing
lands on generic root paths of the shared AppBI host.

Connect flow (spec §2.2):

  /mcp-oauth/authorize            SDK handler → provider.authorize → txn
  /mcp-oauth/connect/start        binds the txn to this browser (httpOnly cookie)
  <APPBI>/connect/mcp?txn=…       AppBI page: normal AppBI login + consent; mints the
                                  user's scoped, expiring PAT with the existing API
  /mcp-oauth/txn/{id}             what the AppBI page shows (client, redirect host, scopes)
  /mcp-oauth/appbi-callback       same-origin POST {txn, pat}; requires the binding
                                  cookie; verifies the PAT with AppBI /auth/me; creates
                                  the grant + code; redirects to the client with iss
"""

from __future__ import annotations

import logging
import time
from html import escape
from typing import Any
from urllib.parse import urlencode, urlparse

from mcp.server.auth.handlers.authorize import AuthorizationHandler
from mcp.server.auth.handlers.register import RegistrationHandler
from mcp.server.auth.handlers.revoke import RevocationHandler
from mcp.server.auth.handlers.token import TokenHandler
from mcp.server.auth.middleware.client_auth import ClientAuthenticator
from mcp.server.auth.provider import construct_redirect_uri
from mcp.server.auth.settings import ClientRegistrationOptions
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.routing import Route, request_response

from ..appbi_client import AppbiError
from ..context import AppContext
from ..pages import message
from ..ratelimit import client_ip
from ..state import canonical_json, new_id, new_secret, sha256_hex
from . import scopes as sc

log = logging.getLogger("appbi_mcp.oauth")

TXN_COOKIE = "appbi_mcp_txn"
SESSION_COOKIE = "appbi_mcp_session"
SESSION_TTL = 30 * 86400
VERIFY_TXN_TTL = 600


# ── metadata ───────────────────────────────────────────────────────────────────


def protected_resource_metadata(ctx: AppContext) -> dict[str, Any]:
    return {
        "resource": ctx.settings.resource_url,
        "authorization_servers": [ctx.settings.issuer],
        "scopes_supported": sc.ALL_SCOPES,
        "bearer_methods_supported": ["header"],
        "resource_name": "AppBI",
    }


def authorization_server_metadata(ctx: AppContext) -> dict[str, Any]:
    iss = ctx.settings.issuer
    return {
        "issuer": iss,
        "authorization_endpoint": f"{iss}/authorize",
        "token_endpoint": f"{iss}/token",
        "registration_endpoint": f"{iss}/register",
        "revocation_endpoint": f"{iss}/revoke",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        # Public clients (Claude via DCR or CIMD) authenticate with `none`; the
        # secret methods serve DCR clients that ask for a secret.
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "revocation_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "client_id_metadata_document_supported": True,
        "authorization_response_iss_parameter_supported": True,
        # offline_access is listed here (AS) and never in the protected-resource
        # metadata: refresh tokens are not a resource requirement.
        "scopes_supported": sc.ALL_SCOPES + ["offline_access"],
    }


def _json(data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status, headers={"Cache-Control": "no-store"})


def _cors(app: Any, methods: list[str]) -> Any:
    return CORSMiddleware(app=app, allow_origins="*", allow_methods=methods, allow_headers=["mcp-protocol-version", "content-type"])


# ── cookies / browser sessions ─────────────────────────────────────────────────


def _cookie_kwargs(ctx: AppContext, max_age: int) -> dict[str, Any]:
    return {
        "max_age": max_age,
        "path": "/mcp-oauth",
        "secure": ctx.settings.cookie_secure,
        "httponly": True,
        "samesite": "lax",
    }


def create_browser_session(ctx: AppContext, response: Response, user_id: str) -> None:
    sid = new_secret()
    now = time.time()
    with ctx.store.transaction() as cur:
        cur.execute(
            "INSERT INTO browser_sessions(id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (sha256_hex(sid), user_id, now, now + SESSION_TTL),
        )
    response.set_cookie(SESSION_COOKIE, sid, **_cookie_kwargs(ctx, SESSION_TTL))


def browser_session_user(ctx: AppContext, request: Request) -> str | None:
    sid = request.cookies.get(SESSION_COOKIE)
    if not sid:
        return None
    row = ctx.store.query_one(
        "SELECT user_id FROM browser_sessions WHERE id_hash = ? AND expires_at > ?", (sha256_hex(sid), time.time())
    )
    return row["user_id"] if row else None


def start_verify_flow(ctx: AppContext, return_to: str) -> RedirectResponse:
    """Re-establish the browser session for an approval page (no grant is made)."""
    txn_id = new_id("txn")
    binding = new_secret()
    now = time.time()
    with ctx.store.transaction() as cur:
        cur.execute(
            "INSERT INTO auth_txns(id, mode, client_id, params_json, binding_hash, status, created_at, expires_at) "
            "VALUES (?, 'verify', NULL, ?, ?, 'pending', ?, ?)",
            (txn_id, canonical_json({"return_to": return_to}), sha256_hex(binding), now, now + VERIFY_TXN_TTL),
        )
    return RedirectResponse(f"{ctx.settings.issuer}/connect/start?" + urlencode({"txn": txn_id, "b": binding}), status_code=302)


def _return_to_client(url: str, *, ok: bool) -> Response:
    """Leave the AppBI origin for the OAuth client's redirect URI.

    Not a 302: this response answers a FORM POST from the AppBI connect page, and
    browsers enforce that page's CSP `form-action 'self'` on redirects that follow
    a form submission, which would block the hop to claude.ai / localhost. A meta
    refresh is a fresh navigation, so it is not subject to form-action.
    """
    title = "Connected" if ok else "Not connected"
    text = "Returning you to Claude…" if ok else "Nothing was shared. Returning you to Claude…"
    safe = escape(url, quote=True)
    html = (
        "<!doctype html><html lang=en><head><meta charset=utf-8>"
        f"<meta http-equiv=refresh content='0;url={safe}'>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title></head><body style='font:15px system-ui;padding:32px'>"
        f"<h1 style='font-size:20px'>{title}</h1><p>{text}</p>"
        f"<p><a href='{safe}'>Continue</a></p></body></html>"
    )
    from starlette.responses import HTMLResponse

    return HTMLResponse(html, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


# ── routes ─────────────────────────────────────────────────────────────────────


def _load_txn(ctx: AppContext, txn_id: str) -> dict[str, Any] | None:
    row = ctx.store.query_one(
        "SELECT * FROM auth_txns WHERE id = ? AND status = 'pending' AND expires_at > ?", (txn_id, time.time())
    )
    if not row:
        return None
    import json

    out = dict(row)
    out["params"] = json.loads(row["params_json"])
    return out


def build_oauth_routes(ctx: AppContext) -> list[Route]:
    provider = ctx.provider
    settings = ctx.settings
    authenticator = ClientAuthenticator(provider)  # type: ignore[arg-type]
    token_handler = TokenHandler(provider, authenticator)  # type: ignore[arg-type]
    authorize_handler = AuthorizationHandler(provider)  # type: ignore[arg-type]
    register_handler = RegistrationHandler(
        provider,  # type: ignore[arg-type]
        options=ClientRegistrationOptions(enabled=True, valid_scopes=sc.ALL_SCOPES + ["offline_access"], default_scopes=sc.ALL_SCOPES),
    )
    revoke_handler = RevocationHandler(provider, authenticator)  # type: ignore[arg-type]

    def limited(handler: Any, bucket: str) -> Any:
        async def wrapped(request: Request) -> Response:
            ip = client_ip({k.lower(): v for k, v in request.headers.items()}, request.client.host if request.client else None)
            ok, retry = ctx.auth_limiter.allow(f"{bucket}:{ip}")
            if not ok:
                return _json({"error": "temporarily_unavailable", "error_description": "too many requests"}, 429)
            return await handler(request)

        return wrapped

    async def prm(_: Request) -> Response:
        return _json(protected_resource_metadata(ctx))

    async def asm(_: Request) -> Response:
        return _json(authorization_server_metadata(ctx))

    async def connect_start(request: Request) -> Response:
        txn_id = request.query_params.get("txn", "")
        binding = request.query_params.get("b", "")
        txn = _load_txn(ctx, txn_id)
        if not txn or sha256_hex(binding) != txn["binding_hash"]:
            return message("Link expired", "This sign-in link is no longer valid. Start connecting AppBI again from Claude.", status=400, tone="err")
        # The txn id rides in the PATH: AppBI's login redirect keeps only the
        # pathname (`?next=/connect/mcp/<txn>`), so a query would be lost.
        target = f"{settings.appbi_public_url}{settings.connect_path}/{txn_id}"
        resp = RedirectResponse(target, status_code=302, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
        resp.set_cookie(TXN_COOKIE, binding, **_cookie_kwargs(ctx, int(txn["expires_at"] - time.time())))
        return resp

    async def txn_info(request: Request) -> Response:
        txn = _load_txn(ctx, request.path_params["txn_id"])
        if not txn:
            return _json({"error": "not_found", "message": "This connection request has expired."}, 404)
        p = txn["params"]
        if txn["mode"] == "verify":
            return _json({"mode": "verify", "callback_path": "/mcp-oauth/appbi-callback", "pat": {
                "name": "Claude MCP · browser check", "expires_in_days": 1, "scopes": {"datasets": "view"},
            }})
        redirect = urlparse(p["redirect_uri"])
        requested = p["scopes"]
        return _json({
            "mode": "connect",
            "client_name": p.get("client_name") or "An MCP client",
            "client_id_host": urlparse(p["client_id"]).hostname if p["client_id"].startswith("https://") else None,
            "redirect_host": redirect.hostname,
            "redirect_is_loopback": (redirect.hostname or "") in ("localhost", "127.0.0.1", "::1"),
            "requested_scopes": [{"scope": s, "description": sc.SCOPE_DESCRIPTIONS[s]} for s in requested],
            "can_write": bool(set(requested) & {sc.AUTHOR, sc.PUBLISH}),
            "appbi_scopes": {"full": sc.appbi_pat_scopes(requested), "read": sc.appbi_pat_scopes([sc.READ])},
            "default_expires_in_days": 30,
            "max_expires_in_days": 90,
            "callback_path": "/mcp-oauth/appbi-callback",
        })

    async def appbi_callback(request: Request) -> Response:
        origin = request.headers.get("origin")
        allowed_origins = {settings.public_url, settings.appbi_public_url}
        if origin and origin not in allowed_origins:
            return message("Not allowed", "This request did not come from AppBI.", status=403, tone="err")
        form = await request.form()
        txn_id = str(form.get("txn") or "")
        txn = _load_txn(ctx, txn_id)
        cookie = request.cookies.get(TXN_COOKIE, "")
        if not txn or not cookie or sha256_hex(cookie) != txn["binding_hash"]:
            # A txn started in another browser cannot be completed here (login-CSRF).
            return message(
                "Could not finish connecting",
                "Open the connection from Claude in this browser and try again.",
                status=400, tone="err",
            )
        p = txn["params"]

        def finish(cur_status: str) -> None:
            with ctx.store.transaction() as cur:
                cur.execute("UPDATE auth_txns SET status = ? WHERE id = ? AND status = 'pending'", (cur_status, txn_id))

        if str(form.get("decision") or "") != "allow":
            finish("denied")
            if txn["mode"] == "verify":
                return message("Cancelled", "Nothing was approved.")
            resp = _return_to_client(
                construct_redirect_uri(p["redirect_uri"], error="access_denied", state=p.get("state"), iss=settings.issuer), ok=False
            )
            resp.delete_cookie(TXN_COOKIE, path="/mcp-oauth")
            return resp

        pat = str(form.get("pat") or "")
        if not pat.startswith("appbi_pat_"):
            return message("Could not finish connecting", "AppBI did not hand over an access token.", status=400, tone="err")
        try:
            me = await ctx.appbi(pat, new_id("req")).get("/auth/me")
        except AppbiError as exc:
            log.warning("connect: AppBI rejected the new PAT (%s)", exc.status)
            return message("Could not finish connecting", "AppBI did not accept the new access token.", status=400, tone="err")
        user_id = str(me.get("id"))
        email = str(me.get("email") or "")

        if txn["mode"] == "verify":
            finish("completed")
            return_to = p.get("return_to") or "/"
            if not return_to.startswith("/mcp-oauth/"):
                return_to = "/mcp-oauth/healthz"
            resp = RedirectResponse(f"{settings.public_url}{return_to}", status_code=302)
            create_browser_session(ctx, resp, user_id)
            resp.delete_cookie(TXN_COOKIE, path="/mcp-oauth")
            return resp

        requested = p["scopes"]
        level = str(form.get("granted") or "full")
        granted = list(requested) if level == "full" else [sc.READ]
        pat_expires_at: float | None = None
        raw_exp = str(form.get("pat_expires_at") or "")
        if raw_exp:
            from datetime import datetime

            try:
                pat_expires_at = datetime.fromisoformat(raw_exp.replace("Z", "+00:00")).timestamp()
            except ValueError:
                pat_expires_at = None
        grant = provider.create_grant(
            user_id=user_id,
            user_email=email,
            client_id=p["client_id"],
            scopes=granted,
            appbi_scopes=sc.appbi_pat_scopes(granted),
            pat=pat,
            pat_expires_at=pat_expires_at,
        )
        code = provider.issue_code(p, grant["id"], granted)
        finish("completed")
        resp = _return_to_client(construct_redirect_uri(p["redirect_uri"], code=code, state=p.get("state"), iss=settings.issuer), ok=True)
        create_browser_session(ctx, resp, user_id)
        resp.delete_cookie(TXN_COOKIE, path="/mcp-oauth")
        log.info("connect: grant %s created for user %s via %s", grant["id"], user_id, p["client_id"])
        return resp

    iss_path = urlparse(settings.issuer).path  # "/mcp-oauth"
    res_path = urlparse(settings.resource_url).path  # "/mcp"
    meta_routes = [
        Route(f"/.well-known/oauth-protected-resource{res_path}", endpoint=_cors(request_response(prm), ["GET", "OPTIONS"]), methods=["GET", "OPTIONS"]),
        Route("/.well-known/oauth-protected-resource", endpoint=_cors(request_response(prm), ["GET", "OPTIONS"]), methods=["GET", "OPTIONS"]),
        Route(f"/.well-known/oauth-authorization-server{iss_path}", endpoint=_cors(request_response(asm), ["GET", "OPTIONS"]), methods=["GET", "OPTIONS"]),
        Route("/.well-known/oauth-authorization-server", endpoint=_cors(request_response(asm), ["GET", "OPTIONS"]), methods=["GET", "OPTIONS"]),
        Route(f"/.well-known/openid-configuration{iss_path}", endpoint=_cors(request_response(asm), ["GET", "OPTIONS"]), methods=["GET", "OPTIONS"]),
        Route(f"{iss_path}/.well-known/openid-configuration", endpoint=_cors(request_response(asm), ["GET", "OPTIONS"]), methods=["GET", "OPTIONS"]),
    ]
    return meta_routes + [
        Route(f"{iss_path}/authorize", endpoint=limited(authorize_handler.handle, "authorize"), methods=["GET", "POST"]),
        Route(f"{iss_path}/token", endpoint=_cors(request_response(limited(token_handler.handle, "token")), ["POST", "OPTIONS"]), methods=["POST", "OPTIONS"]),
        Route(f"{iss_path}/register", endpoint=_cors(request_response(limited(register_handler.handle, "register")), ["POST", "OPTIONS"]), methods=["POST", "OPTIONS"]),
        Route(f"{iss_path}/revoke", endpoint=_cors(request_response(limited(revoke_handler.handle, "revoke")), ["POST", "OPTIONS"]), methods=["POST", "OPTIONS"]),
        Route(f"{iss_path}/connect/start", endpoint=connect_start, methods=["GET"]),
        Route(f"{iss_path}/txn/{{txn_id}}", endpoint=limited(txn_info, "txn"), methods=["GET"]),
        Route(f"{iss_path}/appbi-callback", endpoint=limited(appbi_callback, "callback"), methods=["POST"]),
    ]

