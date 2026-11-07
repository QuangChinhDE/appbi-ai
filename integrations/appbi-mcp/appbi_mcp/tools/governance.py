"""Sensitive actions: sharing, and editing a SHARED chart. Each has its own approval.

* Sharing grants another person or team access through AppBI's share API (owner or
  admin only, decided by AppBI). The approval page names the grantee, the level and
  what that level does NOT include (a dashboard share is not a share of its data).
  Revoking is equally approved; nothing else is ever deleted.
* A saved chart is a library object: saving it changes every report that shows it,
  live. The approval page lists those reports (AppBI's usage answer) and the new
  chart's real numbers (AppBI's dry-run). To change one report only, use
  plan_dashboard_edit(edit_chart), which forks the chart in a draft.
"""

from typing import Annotated, Any, Literal

from pydantic import Field

from ..appbi_client import AppbiError
from ..oauth import scopes as sc
from ..operations import OperationError, Run
from .dashboard import ChartType
from .runtime import Env, tool

ShareType = Literal["dashboard", "chart", "dataset", "datasource", "workboard"]

NOT_INCLUDED = {
    "dashboard": "It does not share the dataset behind it: people without access to that data see the dashboard's charts refused.",
    "dataset": "Sharing a dataset lets them read its data in charts and Explore under their own rights.",
    "chart": "It does not share the dataset behind it.",
    "datasource": "A source share lets them build datasets from it; its credentials are never shown.",
    "workboard": "Workspace delivery and workboard data follow the workboard's own rules.",
}


@tool(scope=sc.READ, title="List shares", read_only=True)
async def list_shares(env: Env, resource_type: ShareType, resource_id: int) -> dict[str, Any]:
    """Who a resource is shared with (only its owner or an admin may list)."""
    rows = await env.appbi.get(f"/shares/{resource_type}/{resource_id}")
    return {"status": "ok", "shares": [{k: r.get(k) for k in ("id", "target_type", "user_id", "team_id", "permission", "user", "team")}
                                       for r in rows or []]}


@tool(scope=sc.READ, title="Plan sharing a resource", read_only=True)
async def plan_share(
    env: Env,
    resource_type: ShareType,
    resource_id: int,
    permission: Literal["view", "edit", "full"] = "view",
    email: Annotated[str | None, Field(max_length=254)] = None,
    team_id: Annotated[str | None, Field(max_length=64)] = None,
) -> dict[str, Any]:
    """Plan granting a person (email) or team access. Shares nothing; returns an approval link."""
    if (email is None) == (team_id is None):
        return {"status": "invalid", "message": "Give exactly one of email or team_id."}
    try:
        current = await env.appbi.get(f"/shares/{resource_type}/{resource_id}")
    except AppbiError as exc:
        if exc.status in (403, 404):
            return {"status": "forbidden", "message": "Only the owner (or an admin) can share this in AppBI."}
        raise
    grantee = email or f"team {team_id}"
    summary = {
        "sections": [
            {"title": "Share", "items": [{"resource": f"{resource_type} #{resource_id}", "with": grantee, "level": permission,
                                          "already shared with": len(current or [])}]},
            {"title": "What this grants", "items": [
                {"view": "They can open and read it.", "edit": "They can change it (not delete or share it).",
                 "full": "They can change, share and delete it."}[permission],
                NOT_INCLUDED[resource_type],
                "AppBI notifies them and records the share in its audit log. You can revoke it later (also approved).",
            ]},
        ],
        "warnings": ["Full access lets them share it further and delete it."] if permission == "full" else [],
    }
    body = {"resource_type": resource_type, "resource_id": resource_id, "permission": permission,
            **({"email": email} if email else {"team_id": team_id})}
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="share", body=body,
                            summary=summary, fingerprint={"count": len(current or [])})
    return {"status": "awaiting_approval", "plan_id": plan.id, "approval_url": env.approval_url(plan.id),
            "warnings": summary["warnings"], "next": "Ask the user to approve in the browser, then call execute_plan(plan_id)."}


@tool(scope=sc.READ, title="Plan revoking a share", read_only=True)
async def plan_unshare(env: Env, resource_type: ShareType, resource_id: int, share_id: int) -> dict[str, Any]:
    """Plan removing one share entry (from list_shares). Removes nothing yet."""
    rows = await env.appbi.get(f"/shares/{resource_type}/{resource_id}")
    entry = next((r for r in rows or [] if r.get("id") == share_id), None)
    if entry is None:
        return {"status": "not_found", "message": "No such share on this resource."}
    who = (entry.get("user") or {}).get("email") or (entry.get("team") or {}).get("name") or entry.get("user_id") or entry.get("team_id")
    summary = {"sections": [
        {"title": "Revoke access", "items": [{"resource": f"{resource_type} #{resource_id}", "from": who, "level now": entry.get("permission")}]},
        {"title": "What happens", "items": ["They lose this share's access at once (other shares or team membership may still grant access)."]},
    ], "warnings": []}
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="unshare",
                            body={"resource_type": resource_type, "resource_id": resource_id, "share_id": share_id},
                            summary=summary, fingerprint={"permission": entry.get("permission")})
    return {"status": "awaiting_approval", "plan_id": plan.id, "approval_url": env.approval_url(plan.id),
            "next": "Ask the user to approve in the browser, then call execute_plan(plan_id)."}


@tool(scope=sc.READ, title="Plan editing a shared chart", read_only=True)
async def plan_chart_edit(
    env: Env,
    chart_id: int,
    config: dict[str, Any],
    chart_type: ChartType | None = None,
    name: Annotated[str | None, Field(max_length=200)] = None,
) -> dict[str, Any]:
    """Plan changing a SAVED chart everywhere it is shown. Saves nothing; returns an approval link.

    The approval page lists every report that shows it and the new numbers AppBI computes.
    """
    chart = await env.appbi.get(f"/charts/{chart_id}")
    if chart.get("user_permission") not in (None, "edit", "full", "owner"):
        return {"status": "forbidden", "message": "Your AppBI account cannot edit this chart."}
    usage = await env.appbi.get(f"/charts/{chart_id}/usage")
    ctype = chart_type or chart.get("chart_type")
    dry = await env.appbi.post("/charts/dry-run-create", {"name": name or chart.get("name"), "chart_type": ctype,
                                                          "dataset_table_id": chart.get("dataset_table_id"), "config": {**config, "chartType": ctype}})
    if not dry.get("ok"):
        return {"status": "invalid", "validation_errors": dry.get("validation_errors"), "runtime_errors": dry.get("runtime_errors")}
    reports = usage.get("reports") or []
    summary = {
        "sections": [
            {"title": "Chart", "items": [{"name": chart.get("name"), "id": chart_id, "type": f"{chart.get('chart_type')} → {ctype}",
                                          "rename": name or "—"}]},
            {"title": "Reports that change LIVE when this is saved", "items": [
                {"dashboard": r.get("name") or r.get("dashboard_name"), "id": r.get("id") or r.get("dashboard_id")} for r in reports]
             or ["None that you can see"]},
            {"title": "New numbers (AppBI dry-run on real data)", "items": (dry.get("runtime_preview_sample") or [])[:8] or ["(no rows)"]},
            {"title": "Open the chart in AppBI", "links": [env.link(f"/explore/{chart_id}")]},
            {"title": "What happens", "items": [
                "AppBI saves the chart; every report above shows the new version immediately (including published views).",
                "To change one report only, ask for a per-report edit instead (it stays a draft until published).",
            ]},
        ],
        "warnings": [f"{usage.get('hidden_count')} more report(s) you cannot see also show this chart."] if usage.get("hidden_count") else [],
    }
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="chart_edit",
                            body={"chart_id": chart_id, "body": {"name": name or chart.get("name"), "chart_type": ctype,
                                                                 "dataset_table_id": chart.get("dataset_table_id"), "config": dry["normalized_config"]}},
                            summary=summary, fingerprint={"updated_at": chart.get("updated_at"), "config": chart.get("config")})
    return {"status": "awaiting_approval", "plan_id": plan.id, "approval_url": env.approval_url(plan.id),
            "affected_reports": len(reports) + int(usage.get("hidden_count") or 0), "preview": (dry.get("runtime_preview_sample") or [])[:5],
            "next": "Ask the user to approve in the browser, then call execute_plan(plan_id)."}


async def run_governance(env: Env, run: Run) -> dict[str, Any]:
    b, kind = run.plan.body, run.plan.kind
    if kind == "share":
        payload = {"permission": b["permission"], **({"email": b["email"]} if b.get("email") else {"team_id": b["team_id"]})}

        async def find(_since: float) -> dict[str, Any] | None:
            for r in await env.appbi.get(f"/shares/{b['resource_type']}/{b['resource_id']}") or []:
                who = (r.get("user") or {}).get("email") if b.get("email") else str(r.get("team_id"))
                if who and who.lower() == str(b.get("email") or b.get("team_id")).lower():
                    return {"id": r.get("id"), "permission": r.get("permission")}
            return None

        try:
            res = await run.write("share", lambda: env.appbi.post(f"/shares/{b['resource_type']}/{b['resource_id']}", payload), reconcile=find)
        except AppbiError as exc:
            raise OperationError("blocked", f"AppBI refused the share: {exc.message}", step="share") from exc
        run.resources.append({"type": "share", "id": res.get("id")})
        return {"status": "done", "share": {"id": res.get("id"), "permission": res.get("permission")}}
    if kind == "unshare":
        rows = await env.appbi.get(f"/shares/{b['resource_type']}/{b['resource_id']}")
        entry = next((r for r in rows or [] if r.get("id") == b["share_id"]), None)
        if entry is None and env.plans.step(run.plan.id, "unshare") is None:
            return {"status": "done", "note": "The share was already gone."}
        if entry is not None and entry.get("permission") != run.plan.fingerprint.get("permission"):
            raise OperationError("stale_plan", "The share changed after the plan was approved.", step="unshare")
        await run.write("unshare", lambda: env.appbi.request("DELETE", f"/shares/{b['resource_type']}/{b['resource_id']}/entries/{b['share_id']}"))
        return {"status": "done", "revoked": b["share_id"]}
    if kind == "chart_edit":
        chart = await env.appbi.get(f"/charts/{b['chart_id']}")
        if {"updated_at": chart.get("updated_at"), "config": chart.get("config")} != run.plan.fingerprint and env.plans.step(run.plan.id, "save") is None:
            raise OperationError("stale_plan", "The chart changed after the plan was approved. Plan again.", step="check")
        try:
            await run.write("save", lambda: env.appbi.put(f"/charts/{b['chart_id']}", b["body"]))
        except AppbiError as exc:
            raise OperationError("blocked", f"AppBI refused the chart: {exc.message}", step="save", detail=exc.detail) from exc
        data = await env.appbi.get(f"/charts/{b['chart_id']}/data")
        run.resources.append({"type": "chart", "id": b["chart_id"]})
        return {"status": "done", "chart_id": b["chart_id"], "rows": len(data.get("data") or []), "sample": (data.get("data") or [])[:3],
                "url": env.link(f"/explore/{b['chart_id']}")}
    raise OperationError("blocked", f"unknown kind {kind}")


GOVERNANCE_KINDS = ("share", "unshare", "chart_edit")
