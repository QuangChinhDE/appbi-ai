"""Execute approved plans, request and perform publishes, report real status."""

import asyncio
import logging
import time
from typing import Annotated, Any, Literal

from pydantic import Field

from ..appbi_client import AppbiError
from ..oauth import scopes as sc
from ..operations import OperationError, Plan, Run, outcome_for_appbi_error
from ..state import canonical_json, sha256_hex
from .dashboard import run_dashboard_plan
from .dataset import run_dataset_plan
from .discovery import model_digest
from .runtime import Env, tool

log = logging.getLogger("appbi_mcp.tools.publish")

RUNNERS = {"dataset": run_dataset_plan, "dashboard": run_dashboard_plan}
PUBLISH_TERMINAL = {"published", "sync_failed"}


def _not_found() -> dict[str, Any]:
    return {"status": "not_found", "message": "No such plan for this user."}


async def _run(env: Env, plan: Plan, body_fn: Any) -> dict[str, Any]:
    """Claim the runner, execute, persist the result. One runner per plan."""
    if not env.plans.claim_runner(plan.id, env.principal.request_id, env.app.settings.operation_budget_seconds):
        return {"status": "running", "plan_id": plan.id, "message": "This plan is already running; check get_operation_status."}
    run = Run(plans=env.plans, plan=plan, deadline=time.time() + env.app.settings.operation_budget_seconds)
    try:
        result = await body_fn(env, run)
        status = result.get("status", "draft_ready")
    except OperationError as exc:
        status = exc.status
        result = {"status": status, "message": exc.message, "failed_step": exc.step}
        if exc.detail is not None:
            result["detail"] = exc.detail
    except AppbiError as exc:
        status = outcome_for_appbi_error(exc)
        result = {"status": status, "message": exc.message, "appbi_error": exc.as_dict()}
    except Exception as exc:  # noqa: BLE001 - never leave an operation "running"
        log.exception("operation %s crashed", plan.id)
        status = "partially_failed"
        result = {"status": status, "message": f"Unexpected error ({type(exc).__name__}); call execute_plan again to resume."}
    result["plan_id"] = plan.id
    result["resources"] = run.resources
    if run.notes:
        result["notes"] = run.notes
    result["steps"] = env.plans.steps(plan.id)
    if status in ("partially_failed", "conflict"):
        result["next"] = "Call the same tool again to resume; finished steps are not repeated."
    elif status == "blocked":
        result["next"] = "AppBI refused a step. Resources listed under 'resources' already exist as drafts; fix the plan and plan again, or continue in AppBI."
    env.plans.finish_operation(plan.id, env.principal.request_id, status, result)
    return result


@tool(scope=sc.AUTHOR, title="Execute an approved plan", read_only=False, destructive=False, idempotent=True)
async def execute_plan(env: Env, plan_id: str) -> dict[str, Any]:
    """Build an approved Dataset or Dashboard plan as drafts the user owns.

    Requires that the user approved this exact plan in the browser. Calling it
    again resumes from where it stopped and never creates anything twice.
    """
    plan = env.plans.get(plan_id, env.principal.user_id)
    if plan is None:
        return _not_found()
    if plan.kind not in RUNNERS:
        return {"status": "error", "message": "This is a publish request; use publish(plan_id)."}
    if not env.plans.verify_hash(plan):
        return {"status": "error", "message": "Plan integrity check failed; plan again."}
    op = env.plans.operation(plan.id)
    if op is None:
        state = env.plans.approval_state(plan)
        if state != "approved":
            return {"status": "awaiting_approval", "approval_state": state, "approval_url": env.approval_url(plan.id),
                    "message": "The user has not approved this plan in the browser yet."}
        if env.plans.active_operations(env.principal.user_id) >= env.app.settings.max_concurrent_operations:
            return {"status": "busy", "message": "Too many operations are running for this user; try again shortly."}
        if not env.plans.consume_approval(plan):
            return {"status": "awaiting_approval", "approval_url": env.approval_url(plan.id)}
        env.plans.start_operation(plan)
    elif op["status"] == "draft_ready":
        return {**op["result"], "status": "draft_ready", "already_done": True}
    return await _run(env, plan, RUNNERS[plan.kind])


@tool(scope=sc.READ, title="Operation status", read_only=True)
async def get_operation_status(env: Env, plan_id: str) -> dict[str, Any]:
    """Where a plan stands: approval, execution status, finished steps, created resources."""
    plan = env.plans.get(plan_id, env.principal.user_id)
    if plan is None:
        return _not_found()
    op = env.plans.operation(plan.id)
    return {
        "status": op["status"] if op else "not_started",
        "plan_id": plan.id,
        "kind": plan.kind,
        "approval_state": env.plans.approval_state(plan),
        "approval_url": env.approval_url(plan.id),
        "result": op["result"] if op else None,
        "steps": env.plans.steps(plan.id),
    }


# ── publish ─────────────────────────────────────────────────────────────────────


async def _dataset_fingerprint(env: Env, dataset_id: int) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    ds = await env.appbi.get(f"/datasets/{dataset_id}")
    model = await env.appbi.get(f"/datasets/{dataset_id}/model")
    digest = model_digest(model or {})
    tables = sorted((t.get("id"), t.get("source_table_name"), t.get("updated_at")) for t in ds.get("tables", []) or [])
    fp = {"model": sha256_hex(canonical_json(digest)), "tables": sha256_hex(canonical_json(tables))}
    return ds, digest, fp


async def _dashboard_state(env: Env, dashboard_id: int) -> tuple[dict[str, Any], dict[str, Any]]:
    d = await env.appbi.get(f"/dashboards/{dashboard_id}")
    me = str(env.principal.user_id)
    live_v = {str(t["id"]): int((t.get("layout") or {}).get("_v") or 0) for t in d.get("dashboard_charts", []) or []}
    # Same rule as the Builder (buildTileBaseV): every tile in MY draft layout bucket.
    tile_base_v = {tid: live_v.get(tid, 0) for tid in (d.get("draft_layouts") or {}).keys()}
    mine = [
        {"tile_id": t["id"], "chart": (t.get("chart") or {}).get("name")}
        for t in d.get("dashboard_charts", []) or []
        if (t.get("layout") or {}).get("draftOnly") and str((t.get("layout") or {}).get("draftOwner")) == me
    ]
    shared = d.get("shared_draft") or {}
    return d, {"rev": shared.get("rev"), "tile_base_v": tile_base_v, "my_draft_tiles": mine,
               "shared_has_changes": bool(shared.get("has_changes")), "other_authors": shared.get("other_authors") or []}


@tool(scope=sc.READ, title="Request a publish", read_only=True)
async def request_publish(
    env: Env,
    resource_type: Literal["dataset", "dashboard"],
    resource_id: int,
) -> dict[str, Any]:
    """Prepare publishing a dataset or dashboard and return a browser approval link. Publishes nothing.

    Dataset: Sync & Publish materializes a complete snapshot that dashboards read.
    Dashboard: makes YOUR draft changes live; co-authors' unpublished work is left
    as it is.
    """
    if resource_type == "dataset":
        ds, digest, fp = await _dataset_fingerprint(env, resource_id)
        status = await env.appbi.get(f"/datasets/{resource_id}/publish-status")
        health = await env.appbi.get(f"/datasets/{resource_id}/model/health", execute="true")
        warnings = []
        if health.get("blocking"):
            warnings.append("AppBI reports blocking semantic-health problems; the publish will fail until they are fixed.")
        if str(ds.get("purpose") or "reporting") != "reporting":
            warnings.append("This dataset is Operational; AppBI does not publish it.")
        summary = {
            "sections": [
                {"title": "Dataset", "items": [{"name": ds.get("name"), "id": resource_id, "current state": status.get("publish_state") or "never published",
                                                "last published": status.get("published_at") or "—"}]},
                {"title": "Contents", "items": [{"view": v["view"], "dimensions": len(v["dimensions"]), "measures": ", ".join(m["name"] for m in v["measures"]) or "—"} for v in digest["views"]]},
                {"title": "What happens", "items": [
                    "AppBI copies every table into a new, complete snapshot and validates it.",
                    "Only when it is complete and valid do dashboards switch to it; if it fails, the previous published data keeps serving.",
                    "Everyone who can see dashboards on this dataset sees the new data.",
                ]},
            ],
            "warnings": warnings,
        }
        plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="dataset_publish",
                                body={"dataset_id": resource_id}, summary=summary, fingerprint=fp)
    else:
        d, st = await _dashboard_state(env, resource_id)
        if not st["my_draft_tiles"] and not st["tile_base_v"] and not st["shared_has_changes"]:
            return {"status": "nothing_to_publish", "message": "You have no unpublished changes on this dashboard."}
        keep_shared = bool(st["other_authors"])
        warnings = []
        if keep_shared:
            warnings.append(f"Co-authors ({', '.join(map(str, st['other_authors']))}) have unpublished filter/page changes; "
                            "only YOUR tiles are published and the shared filter draft stays unpublished.")
        summary = {
            "sections": [
                {"title": "Dashboard", "items": [{"name": d.get("name"), "id": resource_id}]},
                {"title": "Your tiles going live", "items": [x["chart"] or f"tile {x['tile_id']}" for x in st["my_draft_tiles"]] or ["None (layout or filter changes only)"]},
                {"title": "Shared filter/page draft", "items": [
                    "Published with this change" if st["shared_has_changes"] and not keep_shared else
                    "Left unpublished (co-authors are editing it)" if keep_shared else "No changes"]},
                {"title": "What happens", "items": [
                    "Your draft becomes what every viewer of this dashboard sees.",
                    "If a co-author published any of the same tiles since now, AppBI refuses and nothing is overwritten.",
                    "No public link is created or changed.",
                ]},
            ],
            "warnings": warnings,
        }
        plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="dashboard_publish",
                                body={"dashboard_id": resource_id, "keep_shared": keep_shared}, summary=summary, fingerprint=st)
    return {
        "status": "awaiting_approval",
        "plan_id": plan.id,
        "approval_url": env.approval_url(plan.id),
        "warnings": summary["warnings"],
        "next": "Ask the user to approve in the browser, then call publish(plan_id).",
    }


async def _dataset_status(env: Env, dataset_id: int) -> dict[str, Any]:
    st = await env.appbi.get(f"/datasets/{dataset_id}/publish-status")
    runs = await env.appbi.get(f"/datasets/{dataset_id}/refresh-runs", limit=3)
    # `GET /refresh-runs` answers {"runs": [...]}.
    items = (runs.get("runs") or runs.get("items") or []) if isinstance(runs, dict) else (runs or [])
    if not isinstance(items, list):
        items = []
    state = st.get("publish_state")
    syncing = bool(st.get("syncing"))
    status = "syncing" if syncing else ("published" if state == "published" else "sync_failed" if state == "sync_failed" else state or "draft")
    return {
        "status": status,
        "dataset_id": dataset_id,
        "publish_state": state,
        "published_generation": st.get("published_generation"),
        "published_at": st.get("published_at"),
        "has_published_data": st.get("has_published_data"),
        "last_sync_error": st.get("last_sync_error"),
        "progress": st.get("progress"),
        "recent_runs": [{"status": r.get("status"), "started_at": r.get("started_at"), "finished_at": r.get("finished_at"), "error": r.get("error")} for r in (items or [])[:3]],
        "url": env.link(f"/datasets/{dataset_id}"),
    }


async def _wait_dataset(env: Env, dataset_id: int, seconds: int) -> dict[str, Any]:
    deadline = time.time() + seconds
    delay = 2.0
    while True:
        st = await _dataset_status(env, dataset_id)
        if st["status"] in PUBLISH_TERMINAL or st["status"] not in ("syncing",) or time.time() >= deadline:
            return st
        await asyncio.sleep(delay)
        delay = min(delay * 1.5, 10.0)


@tool(scope=sc.PUBLISH, title="Publish (approved)", read_only=False, destructive=False, idempotent=True)
async def publish(env: Env, plan_id: str) -> dict[str, Any]:
    """Publish a dataset or dashboard the user approved in the browser (from request_publish)."""
    plan = env.plans.get(plan_id, env.principal.user_id)
    if plan is None:
        return _not_found()
    if plan.kind not in ("dataset_publish", "dashboard_publish"):
        return {"status": "error", "message": "This is a build plan; use execute_plan(plan_id)."}
    op = env.plans.operation(plan.id)
    if op is None:
        state = env.plans.approval_state(plan)
        if state != "approved":
            return {"status": "awaiting_approval", "approval_state": state, "approval_url": env.approval_url(plan.id)}
        # Nothing may have changed since the user looked at the approval page.
        if plan.kind == "dataset_publish":
            _, _, fp = await _dataset_fingerprint(env, plan.body["dataset_id"])
            stale = fp != plan.fingerprint
        else:
            _, st = await _dashboard_state(env, plan.body["dashboard_id"])
            stale = st["rev"] != plan.fingerprint.get("rev") or st["tile_base_v"] != plan.fingerprint.get("tile_base_v")
        if stale:
            return {"status": "stale_plan", "message": "The resource changed after the approval was requested. Request the publish again."}
        if not env.plans.consume_approval(plan):
            return {"status": "awaiting_approval", "approval_url": env.approval_url(plan.id)}
        env.plans.start_operation(plan)
    elif op["status"] == "published":
        return {**op["result"], "already_done": True}
    elif plan.kind == "dataset_publish" and op["status"] == "syncing":
        st = await _wait_dataset(env, plan.body["dataset_id"], 20)
        return {**st, "plan_id": plan.id}

    async def body(env: Env, run: Run) -> dict[str, Any]:
        if plan.kind == "dataset_publish":
            dataset_id = plan.body["dataset_id"]
            res = await run.write("publish", lambda: env.appbi.post(f"/datasets/{dataset_id}/publish", {"timezone": "UTC"}))
            st = await _wait_dataset(env, dataset_id, 45)
            st["started"] = res.get("started")
            if res.get("reason"):
                st["note"] = f"AppBI: {res['reason']} — tracking the run already in progress."
            if st["status"] == "syncing":
                st["next"] = "Still syncing. Call get_publish_status(dataset_id) to follow it to the end."
            return st
        dashboard_id = plan.body["dashboard_id"]
        fp = plan.fingerprint
        payload = {"tile_base_v": fp.get("tile_base_v") or {}, "force": False, "shared_ack_rev": fp.get("rev"),
                   "keep_shared": bool(plan.body.get("keep_shared"))}
        try:
            await run.write("publish", lambda: env.appbi.post(f"/dashboards/{dashboard_id}/publish", payload))
        except AppbiError as exc:
            if exc.status == 409:
                raise OperationError("conflict", f"AppBI refused to publish over a co-author's work: {exc.message}", step="publish", detail=exc.detail) from exc
            raise
        _, after = await _dashboard_state(env, dashboard_id)
        left = after["my_draft_tiles"]
        if left:
            raise OperationError("partially_failed", f"Publish returned OK but {len(left)} of your draft tiles are still drafts.", step="verify", detail=left)
        return {
            "status": "published",
            "dashboard_id": dashboard_id,
            "url": env.link(f"/dashboards/{dashboard_id}"),
            "shared_draft": "left unpublished for co-authors" if plan.body.get("keep_shared") else "published",
        }

    return await _run(env, plan, body)


@tool(scope=sc.READ, title="Dataset publish status", read_only=True)
async def get_publish_status(
    env: Env,
    dataset_id: int,
    wait_seconds: Annotated[int, Field(ge=0, le=120, description="Keep checking up to this long while it is syncing")] = 0,
) -> dict[str, Any]:
    """The real Sync & Publish state of a dataset: syncing, published or sync_failed (with AppBI's error)."""
    return await _wait_dataset(env, dataset_id, wait_seconds)
