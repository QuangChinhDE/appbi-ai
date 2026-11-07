"""Workboards: discovery and the publish lifecycle, through AppBI's own API.

Reads are bounded summaries. Publish / unpublish change what a workboard's users see,
so each is its own browser approval and re-checks the workboard's state before it
runs. Records, app users, webhooks, public links, media and deletes are not
reachable from here (allowlist).
"""

from typing import Annotated, Any, Literal

from pydantic import Field

from ..appbi_client import AppbiError
from ..oauth import scopes as sc
from ..operations import OperationError, Run
from .runtime import Env, tool


def _summary(w: dict[str, Any], env: Env) -> dict[str, Any]:
    return {k: w.get(k) for k in ("id", "name", "description", "status", "dataset_id", "user_permission", "updated_at",
                                  "published_at", "has_unpublished_changes")} | {"url": env.link(f"/workboards/{w.get('id')}")}


def _state(w: dict[str, Any]) -> dict[str, Any]:
    return {k: w.get(k) for k in ("status", "updated_at", "published_at", "published_version", "draft_version")}


@tool(scope=sc.READ, title="List workboards", read_only=True)
async def list_workboards(env: Env, limit: Annotated[int, Field(ge=1, le=200)] = 100) -> dict[str, Any]:
    """Workboards this account can see."""
    rows = await env.appbi.get("/workboards/")
    rows = rows.get("items", rows) if isinstance(rows, dict) else rows
    return {"status": "ok", "workboards": [_summary(w, env) for w in (rows or [])[:limit]]}


@tool(scope=sc.READ, title="Inspect a workboard", read_only=True)
async def get_workboard(env: Env, workboard_id: int) -> dict[str, Any]:
    """One workboard: its state, screens and the dataset it is bound to (no records)."""
    w = await env.appbi.get(f"/workboards/{workboard_id}")
    screens = [{k: s.get(k) for k in ("id", "name", "kind", "table_id")} for s in (w.get("screens") or [])[:60]]
    return {"status": "ok", **_summary(w, env), "screens": screens}


@tool(scope=sc.READ, title="Request a workboard publish or unpublish", read_only=True)
async def request_workboard_lifecycle(env: Env, workboard_id: int, action: Literal["publish", "unpublish"]) -> dict[str, Any]:
    """Prepare publishing (or unpublishing) a workboard; returns a browser approval link. Changes nothing."""
    w = await env.appbi.get(f"/workboards/{workboard_id}")
    if w.get("user_permission") not in ("full", "owner"):
        return {"status": "forbidden", "message": "Publishing a workboard needs full access to it in AppBI."}
    summary = {"sections": [
        {"title": "Workboard", "items": [{"name": w.get("name"), "id": workboard_id, "now": w.get("status"), "action": action}]},
        {"title": "Open it in AppBI first", "links": [env.link(f"/workboards/{workboard_id}")]},
        {"title": "What happens", "items": [
            "Its users see the current draft from now on." if action == "publish" else "Its users can no longer open it until it is published again.",
            "AppBI re-checks your access and the dataset binding when it runs.",
        ]},
    ], "warnings": []}
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="workboard_lifecycle",
                            body={"workboard_id": workboard_id, "action": action}, summary=summary, fingerprint=_state(w))
    return {"status": "awaiting_approval", "plan_id": plan.id, "approval_url": env.approval_url(plan.id),
            "next": "Ask the user to approve in the browser, then call execute_plan(plan_id)."}


async def run_workboard_lifecycle(env: Env, run: Run) -> dict[str, Any]:
    b = run.plan.body
    wid = int(b["workboard_id"])
    if env.plans.step(run.plan.id, b["action"]) is None:
        w = await env.appbi.get(f"/workboards/{wid}")
        if _state(w) != run.plan.fingerprint:
            raise OperationError("stale_plan", "The workboard changed after the approval was requested. Request it again.", step="check")
    try:
        await run.write(b["action"], lambda: env.appbi.post(f"/workboards/{wid}/{b['action']}"))
    except AppbiError as exc:
        raise OperationError("blocked", f"AppBI refused: {exc.message}", step=b["action"], detail=exc.detail) from exc
    after = await env.appbi.get(f"/workboards/{wid}")
    run.resources.append({"type": "workboard", "id": wid, "status": after.get("status")})
    return {"status": "done", "workboard_id": wid, "now": after.get("status"), "url": env.link(f"/workboards/{wid}")}
