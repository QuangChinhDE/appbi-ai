"""Shared machinery for every MCP tool.

`@tool(...)` turns `async def fn(env: Env, <args>) -> dict` into an MCP tool:

* resolves the verified caller (set by `McpAuthGate`) and their AppBI client;
* maps AppBI failures to an honest, structured result (never a fake success);
* an AppBI 401 means the user's delegated PAT was revoked or expired: the grant
  is revoked, so the next request gets an HTTP 401 and Claude re-connects;
* redacts secrets, caps output size, and writes one audit row per call.

Tool modules must NOT use `from __future__ import annotations`: the SDK builds
each tool's JSON schema from real annotation objects on the wrapper signature.
"""

import functools
import inspect
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from mcp.server.mcpserver import Context
from mcp.types import ToolAnnotations

from ..appbi_client import AppbiClient, AppbiError, GuardViolation, RouteNotAllowed
from ..context import AppContext, Principal
from ..oauth import scopes as sc
from ..operations import PlanStore
from ..security import redact
from ..state import sha256_hex, canonical_json

log = logging.getLogger("appbi_mcp.tools")

MAX_OUTPUT_CHARS = 24_000


@dataclass
class Env:
    app: AppContext
    principal: Principal
    appbi: AppbiClient
    plans: PlanStore

    def link(self, path: str) -> str:
        return f"{self.app.settings.appbi_public_url}{path}"

    def approval_url(self, plan_id: str) -> str:
        return f"{self.app.settings.public_url}/mcp-oauth/approve/{plan_id}"


@dataclass
class ToolSpec:
    name: str
    scope: str
    fn: Callable[..., Awaitable[dict[str, Any]]]
    description: str
    read_only: bool
    destructive: bool
    idempotent: bool
    title: str


REGISTRY: list[ToolSpec] = []


def tool(*, scope: str, title: str, read_only: bool, destructive: bool = False, idempotent: bool = True):
    def deco(fn: Callable[..., Awaitable[dict[str, Any]]]) -> Callable[..., Awaitable[dict[str, Any]]]:
        REGISTRY.append(
            ToolSpec(
                name=fn.__name__, scope=scope, fn=fn, description=inspect.cleandoc(fn.__doc__ or ""),
                read_only=read_only, destructive=destructive, idempotent=idempotent, title=title,
            )
        )
        return fn

    return deco


def _shrink(value: Any, budget: int) -> Any:
    """Trim long lists until the JSON fits the budget; mark what was cut."""
    text = json.dumps(value, ensure_ascii=False, default=str)
    if len(text) <= budget:
        return value
    if isinstance(value, dict):
        out = dict(value)
        # Trim the largest list fields first.
        for _ in range(12):
            lists = sorted(
                ((k, v) for k, v in out.items() if isinstance(v, list) and len(v) > 1),
                key=lambda kv: len(json.dumps(kv[1], default=str)),
                reverse=True,
            )
            if not lists:
                break
            k, v = lists[0]
            out[k] = v[: max(1, len(v) // 2)]
            cut = out.setdefault("_truncated", [])
            if k not in cut:
                cut.append(k)
            if len(json.dumps(out, ensure_ascii=False, default=str)) <= budget:
                return out
        return {"_truncated": True, "note": "Result too large; narrow the request.", "preview": text[: budget // 2]}
    return {"_truncated": True, "preview": text[: budget // 2]}


READ_ONLY_MESSAGE = (
    "This AppBI connection has read-only access. You can inspect and plan, but you cannot create or "
    "publish. Connect with an appropriately authorized account if you need editing."
)
PUBLISH_MISSING_MESSAGE = (
    "This AppBI connection can create drafts but cannot publish. Reconnect AppBI with publish access if you need it."
)


def _audit(app: AppContext, principal: Principal | None, event: str, args: dict[str, Any], outcome: str,
           appbi_status: int | None, resources: list[Any], started: float) -> None:
    try:
        with app.store.transaction() as cur:
            cur.execute(
                "INSERT INTO audit(ts, request_id, user_id, client_id, grant_id, event, args_sha256, outcome, appbi_status, resource_ids, duration_ms) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    time.time(),
                    principal.request_id if principal else None,
                    principal.user_id if principal else None,
                    principal.client_id if principal else None,
                    principal.grant_id if principal else None,
                    event,
                    sha256_hex(canonical_json(args)),
                    outcome,
                    appbi_status,
                    canonical_json(resources) if resources else None,
                    int((time.monotonic() - started) * 1000),
                ),
            )
    except Exception:  # noqa: BLE001 - audit must never break a tool call
        log.exception("audit write failed")
    log.info(
        "tool %s outcome=%s appbi_status=%s user=%s req=%s",
        event, outcome, appbi_status, principal.user_id if principal else None, principal.request_id if principal else None,
    )


def register_all(mcp: Any, app: AppContext) -> dict[str, str]:
    from . import dashboard, dataset, discovery, html_import, publish  # noqa: F401 - registration side effect

    scopes: dict[str, str] = {}
    for spec in REGISTRY:
        _register(mcp, app, spec)
        scopes[spec.name] = spec.scope
    return scopes


def _register(mcp: Any, app: AppContext, spec: ToolSpec) -> None:
    fn = spec.fn
    sig = inspect.signature(fn)
    params = [p for name, p in sig.parameters.items() if name != "env"]
    ctx_param = inspect.Parameter("ctx", inspect.Parameter.KEYWORD_ONLY, annotation=Context)
    new_sig = sig.replace(parameters=[*params, ctx_param], return_annotation=dict[str, Any])

    async def wrapper(*args: Any, **kwargs: Any) -> dict[str, Any]:
        started = time.monotonic()  # durations must not follow wall-clock steps
        ctx: Context = kwargs.pop("ctx")
        request = ctx.request_context.request
        principal: Principal | None = getattr(getattr(request, "state", None), "principal", None) if request is not None else None
        bound = new_sig.bind_partial(*args, **kwargs).arguments
        if principal is None:
            # Unreachable behind McpAuthGate; fail closed if it ever is.
            return {"status": "unauthenticated", "message": "Sign in to AppBI again."}
        if not sc.satisfies(principal.scopes, spec.scope):
            _audit(app, principal, spec.name, bound, "insufficient_scope", None, [], started)
            read_only = not sc.satisfies(principal.scopes, sc.AUTHOR)
            return {"status": "insufficient_scope", "required_scope": spec.scope,
                    "message": READ_ONLY_MESSAGE if read_only else PUBLISH_MISSING_MESSAGE}
        client = app.appbi_for(principal)
        if client is None:
            _audit(app, principal, spec.name, bound, "credential_revoked", None, [], started)
            return {"status": "credential_revoked", "message": "The AppBI connection is no longer active. Reconnect AppBI in Claude."}
        env = Env(app=app, principal=principal, appbi=client, plans=PlanStore(app.store))
        appbi_status: int | None = None
        try:
            result = await fn(env, **kwargs)
            outcome = str(result.get("status", "ok")) if isinstance(result, dict) else "ok"
        except AppbiError as exc:
            appbi_status = exc.status
            if exc.status == 401:
                app.provider.revoke_grant(principal.grant_id, "appbi_401")
                result = {
                    "status": "credential_revoked",
                    "message": "AppBI no longer accepts this connection's token (revoked or expired). Reconnect AppBI in Claude.",
                }
            else:
                result = {
                    "status": {"forbidden": "forbidden", "not_found": "not_found"}.get(exc.kind, "error"),
                    "appbi_error": exc.as_dict(),
                }
            outcome = str(result["status"])
        except (RouteNotAllowed, GuardViolation) as exc:
            # A bug in this service, not a user error: refuse rather than improvise.
            log.error("policy refusal in %s: %s", spec.name, exc)
            result = {"status": "error", "message": f"Refused by the integration's safety policy: {exc}"}
            outcome = "policy_refusal"
        if client.calls:
            appbi_status = appbi_status or client.calls[-1]["status"]
        resources = result.get("resources", []) if isinstance(result, dict) else []
        _audit(app, principal, spec.name, bound, outcome, appbi_status, resources, started)
        safe = redact(result)
        return _shrink(safe, MAX_OUTPUT_CHARS)

    wrapper.__name__ = spec.name
    wrapper.__doc__ = spec.description
    wrapper.__signature__ = new_sig  # type: ignore[attr-defined]
    annotations = {name: p.annotation for name, p in new_sig.parameters.items() if p.annotation is not inspect.Parameter.empty}
    annotations["return"] = dict[str, Any]
    wrapper.__annotations__ = annotations
    wrapper.__module__ = fn.__module__

    mcp.tool(
        name=spec.name,
        title=spec.title,
        description=spec.description,
        annotations=ToolAnnotations(
            title=spec.title,
            read_only_hint=spec.read_only,
            destructive_hint=spec.destructive,
            idempotent_hint=spec.idempotent,
            open_world_hint=False,
        ),
        structured_output=False,
    )(wrapper)
