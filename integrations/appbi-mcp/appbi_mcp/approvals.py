"""Browser approval pages (spec §3).

GET  /mcp-oauth/approve/{plan_id}   shows the stored plan summary (never model text)
POST /mcp-oauth/approve/{plan_id}   approves or rejects; CSRF token + same-origin

The page requires the `appbi_mcp_session` cookie of the plan's owner. That cookie
is set only in the browser that completed the AppBI connect flow (or a later
"confirm it is you" re-check through AppBI). A model with a web-fetch tool has no
such cookie, and a GET never approves anything.
"""

from __future__ import annotations

import hashlib
import hmac
from html import escape
from typing import Any

from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from .context import AppContext
from .oauth.routes import SESSION_COOKIE, browser_session_user, start_verify_flow
from .operations import PlanStore
from .pages import message, page

KIND_TITLES = {
    "dataset": "Create a draft Dataset",
    "dashboard": "Create a draft Dashboard",
    "dashboard_html": "Create a draft Dashboard from an HTML report",
    "dataset_publish": "Publish a Dataset",
    "dashboard_publish": "Publish a Dashboard",
}


def _csrf(ctx: AppContext, plan_id: str, session: str) -> str:
    return hmac.new(ctx.settings.state_key, f"approve:{plan_id}:{session}".encode(), hashlib.sha256).hexdigest()


def _render_value(value: Any) -> str:
    if isinstance(value, list):
        if value and all(isinstance(v, dict) for v in value):
            keys: list[str] = []
            for v in value:
                for k in v:
                    if k not in keys:
                        keys.append(k)
            head = "".join(f"<th>{escape(str(k))}</th>" for k in keys)
            rows = "".join(
                "<tr>" + "".join(f"<td>{escape(_plain(v.get(k)))}</td>" for k in keys) + "</tr>" for v in value
            )
            return f"<table><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table>"
        return "<ul>" + "".join(f"<li>{escape(_plain(v))}</li>" for v in value) + "</ul>"
    return f"<p>{escape(_plain(value))}</p>"


def _plain(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, (list, tuple)):
        return ", ".join(_plain(v) for v in value)
    if isinstance(value, dict):
        return ", ".join(f"{k}: {_plain(v)}" for k, v in value.items())
    return str(value)


def render_summary(summary: dict[str, Any]) -> str:
    parts = []
    for section in summary.get("sections", []):
        parts.append(f"<h2>{escape(str(section.get('title', '')))}</h2>")
        parts.append(_render_value(section.get("items") if "items" in section else section.get("text")))
    warnings = summary.get("warnings") or []
    if warnings:
        parts.append("<h2>Please check</h2>")
        parts.append("<ul>" + "".join(f"<li class=err>{escape(str(w))}</li>" for w in warnings) + "</ul>")
    return "".join(parts)


def build_approval_routes(ctx: AppContext) -> list[Route]:
    plans = PlanStore(ctx.store)

    async def approve(request: Request) -> Response:
        from .ratelimit import client_ip

        ip = client_ip({k.lower(): v for k, v in request.headers.items()}, request.client.host if request.client else None)
        allowed, _ = ctx.auth_limiter.allow(f"approve:{ip}")
        if not allowed:
            return message("Too many requests", "Wait a minute and try again.", status=429, tone="err")
        plan_id = request.path_params["plan_id"]
        session = request.cookies.get(SESSION_COOKIE, "")
        user_id = browser_session_user(ctx, request)
        if not user_id:
            if request.method == "GET":
                return start_verify_flow(ctx, f"/mcp-oauth/approve/{plan_id}")
            return message("Session expired", "Open the approval link again.", status=401, tone="err")
        plan = plans.get(plan_id, user_id)
        if plan is None:
            # Also the answer when the plan belongs to someone else.
            return message("Not found", "This approval link does not exist or is not yours.", status=404, tone="err")
        import time

        if plan.expires_at < time.time():
            return message("Plan expired", "Ask Claude to plan this again.", status=410, tone="err")

        title = KIND_TITLES.get(plan.kind, "Approve a change")
        state = plans.approval_state(plan)

        if request.method == "POST":
            origin = request.headers.get("origin")
            if origin and origin not in (ctx.settings.public_url, ctx.settings.appbi_public_url):
                return message("Not allowed", "This approval did not come from this page.", status=403, tone="err")
            form = await request.form()
            if not hmac.compare_digest(str(form.get("csrf") or ""), _csrf(ctx, plan_id, session)):
                return message("Not allowed", "This approval form is no longer valid. Reload the page.", status=403, tone="err")
            if str(form.get("plan_hash") or "") != plan.plan_hash or not plans.verify_hash(plan):
                return message("Plan changed", "The plan changed after this page was opened. Reload it.", status=409, tone="err")
            if state == "consumed":
                return message("Already used", "This plan was already approved and has started.", tone="ok")
            if state == "rejected":
                return message("Rejected", "You rejected this plan. Ask Claude to plan the change again.")
            if str(form.get("decision") or "") != "approve":
                plans.reject(plan, user_id)
                return message("Rejected", "Nothing will be changed, and this plan can no longer be approved. "
                                           "You can tell Claude what to change.")
            plans.approve(plan, user_id)
            return message(
                "Approved",
                "Go back to Claude and ask it to continue. This approval is valid for 30 minutes and covers only this plan.",
                tone="ok",
            )

        status_line = {
            "approved": "<p class=ok>You already approved this plan. Claude can continue.</p>",
            "consumed": "<p class=ok>This plan was approved and has started.</p>",
            "rejected": "<p>You rejected this plan. Ask Claude to plan the change again.</p>",
        }.get(state, "")
        form = ""
        if state not in ("consumed", "rejected"):
            form = (
                "<form method=post>"
                f"<input type=hidden name=csrf value='{_csrf(ctx, plan_id, session)}'>"
                f"<input type=hidden name=plan_hash value='{escape(plan.plan_hash, quote=True)}'>"
                "<div class=actions>"
                "<button class=primary type=submit name=decision value=approve>Approve</button>"
                "<button type=submit name=decision value=reject>Reject</button>"
                "</div></form>"
            )
        body = (
            f"<h1>{escape(title)}</h1>"
            f"<p class=muted>Requested through Claude for your AppBI account. Plan <code>{escape(plan.id)}</code>.</p>"
            f"{status_line}{render_summary(plan.summary)}{form}"
        )
        return page(title, body)

    return [Route("/mcp-oauth/approve/{plan_id}", approve, methods=["GET", "POST"])]
