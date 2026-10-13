"""Application assembly: OAuth endpoints + approval pages + the gated MCP endpoint."""

from __future__ import annotations

import contextlib
import json
import logging
import sys
from collections.abc import AsyncIterator
from urllib.parse import urlparse

import httpx2
from mcp.server import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import __version__
from .appbi_client import AppbiError
from .approvals import build_approval_routes
from .config import Settings, load_settings
from .context import AppContext
from .oauth.bearer import McpAuthGate
from .oauth.provider import AppbiOAuthProvider
from .oauth.routes import build_oauth_routes
from .state import StateStore, new_id
from .tools import register_tools

INSTRUCTIONS = """\
AppBI is a governed BI platform. These tools let you build AppBI Datasets and
Dashboards for the signed-in user, through AppBI's own APIs and permissions.

How to work:
1. Discover first: list_data_sources / inspect_data_source / inspect_source_table,
   list_datasets / get_dataset, list_dashboards / get_dashboard.
2. Plan before writing: plan_dataset or plan_dashboard. AppBI validates the plan
   (chart configs through AppBI's chart dry-run). Nothing is written yet.
3. The user approves in the browser: give them the approval_url from the plan and
   wait. You cannot approve on their behalf, and an approval only covers that exact
   plan.
4. execute_plan(plan_id) builds the approved plan as DRAFTS the user owns. Report
   the returned status and links honestly: draft_ready, blocked, conflict,
   partially_failed or stale_plan. Calling it again resumes; it never duplicates.
5. Publishing is separate: request_publish → user approves → publish → for datasets,
   get_publish_status until it is terminal (published / sync_failed).
Never describe something as published or correct unless the tool result says so.
"""


def _configure_logging(level: str) -> None:
    class JsonFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            payload = {
                "ts": round(record.created, 3),
                "level": record.levelname,
                "logger": record.name,
                "msg": record.getMessage(),
            }
            if record.exc_info:
                payload["exc"] = self.formatException(record.exc_info)
            return json.dumps(payload, ensure_ascii=False)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    # Never let an HTTP client log request URLs/headers at INFO.
    for noisy in ("httpx", "httpx2", "httpcore", "httpcore2"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def create_app(settings: Settings | None = None, *, appbi_transport: httpx2.AsyncBaseTransport | None = None) -> Starlette:
    settings = settings or load_settings()
    store = StateStore(settings.state_dir, settings.state_key)
    provider = AppbiOAuthProvider(settings, store)
    ctx = AppContext(settings=settings, store=store, provider=provider, appbi_transport=appbi_transport)

    mcp = MCPServer(name="AppBI", title="AppBI", instructions=INSTRUCTIONS, version=__version__)
    tool_scopes = register_tools(mcp, ctx)

    # nginx forwards `$host`, which drops a default or explicit port; accept both forms.
    public_hostname = urlparse(settings.public_url).hostname or settings.public_host
    allowed_hosts = [settings.public_host, public_hostname, "localhost:*", "127.0.0.1:*", *settings.extra_allowed_hosts]
    mcp_http = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=allowed_hosts,
            allowed_origins=[settings.public_url, settings.appbi_public_url, "https://claude.ai", "https://claude.com"],
        ),
    )
    gated = McpAuthGate(mcp_http, ctx, tool_scopes)

    async def healthz(_: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "version": __version__, "build_sha": settings.build_sha})

    async def readyz(_: Request) -> JSONResponse:
        checks: dict[str, str] = {"state": "ok" if store.healthy() else "fail"}
        try:
            # /health needs no credential; it answers whether AppBI is reachable.
            await ctx.appbi("", new_id("req")).get("/health")
            checks["appbi"] = "ok"
        except AppbiError as exc:
            checks["appbi"] = f"{exc.kind}:{exc.status}"
        except Exception as exc:  # noqa: BLE001 - readiness reports, never raises
            checks["appbi"] = f"unreachable:{type(exc).__name__}"
        ok = all(v == "ok" for v in checks.values())
        return JSONResponse({"status": "ready" if ok else "not_ready", "checks": checks}, status_code=200 if ok else 503)

    @contextlib.asynccontextmanager
    async def lifespan(_: Starlette) -> AsyncIterator[None]:
        store.purge_expired()
        async with mcp.session_manager.run():
            yield
        store.close()

    routes = [
        Route("/mcp-oauth/healthz", healthz, methods=["GET"]),
        Route("/mcp-oauth/readyz", readyz, methods=["GET"]),
        *build_oauth_routes(ctx),
        *build_approval_routes(ctx),
        Route("/mcp", endpoint=gated, methods=["GET", "POST", "DELETE"]),
    ]
    app = Starlette(routes=routes, lifespan=lifespan)
    app.state.ctx = ctx
    return app


def main() -> None:
    import uvicorn

    settings = load_settings()
    _configure_logging(settings.log_level)
    logging.getLogger("appbi_mcp").info("starting appbi-mcp %s (build %s)", __version__, settings.build_sha)
    uvicorn.run(
        create_app(settings),
        host="0.0.0.0",
        port=8090,
        proxy_headers=False,
        server_header=False,
        log_config=None,
        access_log=False,
        timeout_graceful_shutdown=20,
    )

