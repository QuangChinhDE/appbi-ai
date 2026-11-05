"""AI Vibe / Report-as-Code reports (Report Studio) through AppBI's own API.

Nothing here decides what a report is: AppBI's Report Studio validates the code,
runs the AI, binds governed data and keeps the revision history. The MCP adds the
same Plan -> Preview -> Approve -> Execute -> Verify discipline it uses for
Datasets and Dashboards:

* every change is a plan the user approves in the browser (never from model text);
* every change lands as a NEW DRAFT REVISION: the published revision readers see is
  untouched until a separately approved publish;
* the approval page shows the real before/after source diff and links to the real
  Report Studio renderer (with data) for each revision; AI runs are named on the
  approval page because each one spends the user's AppBI AI quota;
* every write quotes the revision it was planned against: AppBI's `base_number`
  check refuses a save over a concurrent edit (409 -> `conflict`), and the MCP
  re-checks the draft before AI edits / restores / publishes (`stale_plan`).
"""

import asyncio
import difflib
import time
from typing import Annotated, Any, Literal

from pydantic import Field

from ..appbi_client import AppbiError
from ..oauth import scopes as sc
from ..operations import OperationError, Run
from .runtime import Env, tool

MAX_SOURCE_CHARS = {"html": 400_000, "css": 200_000, "js": 200_000}
MAX_DIFF_LINES = 400
JOB_WAIT_SECONDS = 240


def _ts(value: Any) -> float | None:
    from datetime import datetime, timezone

    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def studio_link(env: Env, report_id: int, number: int | None = None) -> str:
    """The real Report Studio renderer (real data, the user's own rights)."""
    base = env.link(f"/dashboards/code/{report_id}")
    return f"{base}?revision={number}" if number else base


def proposal_link(env: Env, report_id: int, proposal_id: str) -> str:
    """The proposed (unsaved) code rendered by the real Studio renderer with real data."""
    return env.link(f"/dashboards/code/{report_id}?proposal={proposal_id}")


def _apply_summary(env: Env, d: dict[str, Any], report_id: int, proposal_id: str, diff: dict[str, Any], origin: str,
                   extra: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    draft = d.get("draft") or {}
    return {
        "sections": [
            {"title": "Report", "items": [{"name": d.get("name"), "id": report_id, "current draft": f"revision {draft.get('number')}",
                                           "published": d.get("published_number") or "never", "proposed by": origin}]},
            *(extra or []),
            {"title": "Preview BEFORE anything is saved (real Report Studio renderer, real data)",
             "links": [proposal_link(env, report_id, proposal_id), studio_link(env, report_id, draft.get("number"))]},
            *_diff_section("Proposed change vs current draft", diff),
            {"title": "What happens if you approve", "items": [
                "AppBI saves exactly the previewed code as a NEW draft revision; earlier revisions stay restorable.",
                "Readers keep seeing the published revision until you approve a separate publish.",
                "If the draft changed after this preview, AppBI refuses and nothing is overwritten.",
            ]},
        ],
        "warnings": [],
    }


def source_diff(before: dict[str, Any] | None, after: dict[str, Any], *, limit: int = MAX_DIFF_LINES) -> dict[str, Any]:
    """A unified diff per part (html/css/js) plus binding/filter changes. Text only."""
    before = before or {}
    out: dict[str, Any] = {"parts": {}, "changed": []}
    for part in ("html", "css", "js"):
        a = str(before.get(part) or "").splitlines()
        b = str(after.get(part) or "").splitlines()
        if a == b:
            continue
        lines = list(difflib.unified_diff(a, b, f"{part} (before)", f"{part} (after)", lineterm="", n=2))
        added = sum(1 for x in lines if x.startswith("+") and not x.startswith("+++"))
        removed = sum(1 for x in lines if x.startswith("-") and not x.startswith("---"))
        out["changed"].append(part)
        out["parts"][part] = {"added": added, "removed": removed, "diff": lines[:limit], "truncated": len(lines) > limit}

    def keyed(items: Any, key: str) -> dict[str, Any]:
        return {str(x.get(key)): x for x in items or [] if isinstance(x, dict)}

    for name, key in (("bindings", "id"), ("filters", "key")):
        if name not in after:
            continue
        a, b = keyed(before.get(name), key), keyed(after.get(name), key)
        delta = {"added": sorted(set(b) - set(a)), "removed": sorted(set(a) - set(b)),
                 "changed": sorted(k for k in set(a) & set(b) if a[k] != b[k])}
        if any(delta.values()):
            out[name] = delta
            out["changed"].append(name)
    return out


def _diff_section(title: str, diff: dict[str, Any]) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    if not diff["changed"]:
        return [{"title": title, "text": "No difference."}]
    for part, d in diff["parts"].items():
        sections.append({"title": f"{title}: {part.upper()} (+{d['added']} / -{d['removed']})", "diff": d["diff"],
                         "truncated": d["truncated"]})
    for name in ("bindings", "filters"):
        if name in diff:
            sections.append({"title": f"{title}: data {name}", "items": [diff[name]]})
    return sections


async def _report(env: Env, report_id: int) -> dict[str, Any]:
    return await env.appbi.get(f"/report-artifacts/{report_id}")


async def _revision(env: Env, report_id: int, number: int) -> dict[str, Any]:
    return await env.appbi.get(f"/report-artifacts/{report_id}/revisions/{number}")


def _report_summary(d: dict[str, Any], env: Env) -> dict[str, Any]:
    return {
        "id": d.get("id"), "name": d.get("name"), "dataset_id": d.get("dataset_id"),
        "draft_number": d.get("draft_number"), "published_number": d.get("published_number"),
        "has_unpublished_changes": d.get("has_unpublished_changes"), "your_permission": d.get("user_permission"),
        "public_link_count": d.get("public_link_count"), "job": (d.get("job") or {}).get("state"),
        "url": studio_link(env, int(d["id"])) if d.get("id") is not None else None,
    }


def _fingerprint(d: dict[str, Any]) -> dict[str, Any]:
    draft = d.get("draft") or {}
    return {"draft_number": d.get("draft_number"), "draft_hash": draft.get("content_hash"),
            "published_number": d.get("published_number")}


def _editable(d: dict[str, Any]) -> dict[str, Any] | None:
    if d.get("user_permission") not in ("edit", "full"):
        return {"status": "forbidden", "message": "Your AppBI account can view this report but not edit it."}
    if (d.get("job") or {}).get("state") == "running":
        return {"status": "busy", "message": "An AI job is already running on this report; wait for it to finish."}
    return None


def _plan_out(env: Env, plan: Any, summary: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"status": "awaiting_approval", "plan_id": plan.id, "plan_hash": plan.plan_hash,
            "approval_url": env.approval_url(plan.id), "warnings": summary.get("warnings", []),
            "next": "Ask the user to review the preview and approve in the browser, then call execute_plan(plan_id).",
            **extra}


# ── reads ───────────────────────────────────────────────────────────────────────


@tool(scope=sc.READ, title="List AI Vibe reports", read_only=True)
async def list_vibe_reports(env: Env, limit: Annotated[int, Field(ge=1, le=200)] = 100) -> dict[str, Any]:
    """AI Vibe (Report-as-Code) reports this account can see, with draft/published revision numbers."""
    rows = await env.appbi.get("/report-artifacts")
    rows = rows if isinstance(rows, list) else []
    return {"status": "ok", "count": len(rows), "reports": [_report_summary(r, env) for r in rows[:limit]]}


@tool(scope=sc.READ, title="Inspect an AI Vibe report", read_only=True)
async def get_vibe_report(env: Env, report_id: int) -> dict[str, Any]:
    """One Vibe report: its revisions, its draft's regions/bindings/filters, and Studio preview links.

    The draft source is not returned here (use get_vibe_revision for code).
    """
    d = await _report(env, report_id)
    revs = await env.appbi.get(f"/report-artifacts/{report_id}/revisions")
    draft = d.get("draft") or {}
    return {
        "status": "ok", **_report_summary(d, env), "dataset_name": d.get("dataset_name"),
        "draft": {k: draft.get(k) for k in ("number", "source", "note", "regions", "bindings", "filters")} if draft else None,
        "warnings": d.get("warnings") or [],
        "revisions": [{k: r.get(k) for k in ("number", "source", "note", "created_at", "is_draft", "is_published")}
                      for r in (revs or [])[:50]],
        "preview": {"draft": studio_link(env, report_id, d.get("draft_number")),
                    "published": studio_link(env, report_id, d.get("published_number")) if d.get("published_number") else None},
    }


@tool(scope=sc.READ, title="Read a Vibe report revision", read_only=True)
async def get_vibe_revision(env: Env, report_id: int, number: int) -> dict[str, Any]:
    """The HTML/CSS/JS, regions, data bindings and filters of one revision (as saved in AppBI)."""
    r = await _revision(env, report_id, number)
    return {"status": "ok", "report_id": report_id,
            **{k: r.get(k) for k in ("number", "source", "note", "html", "css", "js", "regions", "bindings", "filters",
                                     "is_draft", "is_published")},
            "preview_url": studio_link(env, report_id, number)}


@tool(scope=sc.READ, title="Compare two Vibe revisions", read_only=True)
async def compare_vibe_revisions(env: Env, report_id: int, from_number: int, to_number: int) -> dict[str, Any]:
    """Source and data-binding differences between two saved revisions, with a Studio link for each."""
    a = await _revision(env, report_id, from_number)
    b = await _revision(env, report_id, to_number)
    return {"status": "ok", "report_id": report_id, "from": from_number, "to": to_number, "diff": source_diff(a, b),
            "preview": {"from": studio_link(env, report_id, from_number), "to": studio_link(env, report_id, to_number)}}


# ── plans ───────────────────────────────────────────────────────────────────────


@tool(scope=sc.READ, title="Plan a new AI Vibe report", read_only=True)
async def plan_vibe_report(
    env: Env,
    dataset_id: int,
    name: Annotated[str, Field(min_length=1, max_length=200)],
    mode: Literal["ai", "blank"] = "ai",
    prompt: Annotated[str, Field(max_length=4000)] = "",
) -> dict[str, Any]:
    """Plan a new draft Vibe report on a dataset. Creates nothing; returns an approval link.

    mode="ai": AppBI's Report Studio AI designs the report from `prompt` (one AI run on
    the user's AppBI AI quota). mode="blank": a code-first starter page, no AI.
    """
    if mode == "ai" and len(prompt.strip()) < 4:
        return {"status": "invalid", "message": "An AI report needs a prompt describing what to show."}
    ds = await env.appbi.get(f"/datasets/{dataset_id}")
    summary = {
        "sections": [
            {"title": "New draft report", "items": [{"name": name, "dataset": ds.get("name"), "dataset id": dataset_id,
                                                     "how": "AI design (Report Studio)" if mode == "ai" else "Blank code-first page"}]},
            *([{"title": "Prompt sent to AppBI's AI", "text": prompt}] if mode == "ai" else []),
            {"title": "What happens", "items": [
                "AppBI creates a DRAFT report you own; nobody else sees it until you publish it separately.",
                *(["AppBI runs its Report Studio AI once (it uses your AppBI AI quota). Numbers come only from governed charts on this dataset."]
                  if mode == "ai" else []),
                "After it is built you get a link to preview it in Report Studio with real data before any publish.",
            ]},
        ],
        "warnings": [],
    }
    body = {"dataset_id": dataset_id, "name": name.strip(), "mode": mode, "prompt": prompt.strip()}
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="vibe_create",
                            body=body, summary=summary, fingerprint={})
    return _plan_out(env, plan, summary)


@tool(scope=sc.READ, title="Plan a Vibe code change", read_only=True)
async def plan_vibe_source_edit(
    env: Env,
    report_id: int,
    html: Annotated[str, Field(max_length=MAX_SOURCE_CHARS["html"])],
    css: Annotated[str, Field(max_length=MAX_SOURCE_CHARS["css"])] = "",
    js: Annotated[str, Field(max_length=MAX_SOURCE_CHARS["js"])] = "",
    note: Annotated[str, Field(max_length=200)] = "",
) -> dict[str, Any]:
    """Plan replacing the draft's HTML/CSS/JS (bindings and filters are kept). Saves no revision.

    Send the COMPLETE new source (read the draft with get_vibe_revision first). AppBI
    validates it and holds it as a proposal; the approval page shows the exact diff and
    a link that renders the proposal in Report Studio with real data before approval.
    """
    d = await _report(env, report_id)
    refusal = _editable(d)
    if refusal:
        return refusal
    draft = d.get("draft") or {}
    after = {"html": html, "css": css, "js": js}
    diff = source_diff(draft, after)
    if not diff["changed"]:
        return {"status": "nothing_to_change", "message": "The proposed source is identical to the current draft."}
    # Stage the code in AppBI as a PROPOSAL (validated, never a revision) so the approval
    # page can link the real renderer to exactly what would be saved.
    staged = await env.appbi.post(f"/report-artifacts/{report_id}/proposal",
                                  {"html": html, "css": css, "js": js, "base_number": draft.get("number"), "note": note.strip() or None})
    summary = _apply_summary(env, d, report_id, staged["proposal_id"], diff, "Claude (code)")
    summary["warnings"] = [str(w) for w in staged.get("warnings") or []]
    stored = await env.appbi.get(f"/report-artifacts/{report_id}/proposal")  # AppBI's validated form of the code
    body = {"report_id": report_id, "base_number": draft.get("number"), "proposal_id": staged["proposal_id"],
            "content": source_hash(stored)}
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="vibe_source",
                            body=body, summary=summary, fingerprint=_fingerprint(d))
    return _plan_out(env, plan, summary, preview_url=proposal_link(env, report_id, staged["proposal_id"]),
                     diff_stats={p: {k: v[k] for k in ("added", "removed")} for p, v in diff["parts"].items()})


@tool(scope=sc.READ, title="Plan an AI edit of a Vibe report", read_only=True)
async def plan_vibe_ai_edit(
    env: Env,
    report_id: int,
    instruction: Annotated[str, Field(min_length=2, max_length=4000)],
    region: Annotated[str | None, Field(max_length=80, description="Limit the edit to one data-rac-region")] = None,
) -> dict[str, Any]:
    """Plan asking AppBI's Report Studio AI to edit the draft. Runs nothing; returns an approval link.

    Two approvals: (1) running the AI once, which yields a PROPOSAL and saves nothing;
    (2) after the user previews that proposal in Report Studio with real data, applying it.
    The AI cannot add new data here (that creates charts); bind data in Report Studio.
    """
    d = await _report(env, report_id)
    refusal = _editable(d)
    if refusal:
        return refusal
    draft = d.get("draft") or {}
    # AppBI lists regions as {id, tag, label} (document.list_regions).
    region_ids = [r.get("id") if isinstance(r, dict) else r for r in draft.get("regions") or []]
    if region and region not in region_ids:
        return {"status": "invalid", "message": f"No region '{region}' in the draft.", "regions": region_ids}
    summary = {
        "sections": [
            {"title": "Report", "items": [{"name": d.get("name"), "id": report_id, "edits draft": f"revision {draft.get('number')}",
                                           "region": region or "whole report"}]},
            {"title": "Instruction sent to AppBI's AI", "text": instruction},
            {"title": "Current draft (live preview with data)", "links": [studio_link(env, report_id, draft.get("number"))]},
            {"title": "What happens", "items": [
                "AppBI runs its Report Studio AI once (it uses your AppBI AI quota).",
                "The result is only a PROPOSAL: nothing in the report changes.",
                "You then get a second approval page with the diff and a real preview of the proposal; only that approval saves it.",
            ]},
        ],
        "warnings": [],
    }
    body = {"report_id": report_id, "base_number": draft.get("number"), "instruction": instruction.strip(),
            "region": region}
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="vibe_ai_edit",
                            body=body, summary=summary, fingerprint=_fingerprint(d))
    return _plan_out(env, plan, summary)


@tool(scope=sc.READ, title="Plan restoring a Vibe revision", read_only=True)
async def plan_vibe_restore(env: Env, report_id: int, number: int) -> dict[str, Any]:
    """Plan making an earlier revision the new draft (history is kept). Changes nothing yet."""
    d = await _report(env, report_id)
    refusal = _editable(d)
    if refusal:
        return refusal
    draft = d.get("draft") or {}
    if number == draft.get("number"):
        return {"status": "nothing_to_change", "message": "That revision is already the draft."}
    src = await _revision(env, report_id, number)
    diff = source_diff(draft, src)
    summary = {
        "sections": [
            {"title": "Report", "items": [{"name": d.get("name"), "id": report_id, "current draft": f"revision {draft.get('number')}",
                                           "restore": f"revision {number}"}]},
            {"title": "Previews (real data)", "links": [studio_link(env, report_id, draft.get("number")), studio_link(env, report_id, number)]},
            *_diff_section("Draft after restore vs now", diff),
            {"title": "What happens", "items": [
                f"AppBI copies revision {number} into a NEW draft revision. No revision is deleted.",
                "Readers keep seeing the published revision until a separate publish.",
            ]},
        ],
        "warnings": [],
    }
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="vibe_restore",
                            body={"report_id": report_id, "base_number": draft.get("number"), "number": number},
                            summary=summary, fingerprint=_fingerprint(d))
    return _plan_out(env, plan, summary)


# ── execution ───────────────────────────────────────────────────────────────────


async def _check_fresh(env: Env, run: Run) -> dict[str, Any]:
    d = await _report(env, run.plan.body["report_id"])
    if _fingerprint(d) != run.plan.fingerprint:
        raise OperationError("stale_plan", "The report's draft changed after this plan was approved. Plan the change again.",
                             step="check")
    if (d.get("job") or {}).get("state") == "running":
        raise OperationError("conflict", "An AI job is running on this report; try again when it finishes.", step="check")
    return d


async def _wait_job(env: Env, report_id: int, base_number: int | None, seconds: int = JOB_WAIT_SECONDS) -> dict[str, Any]:
    deadline = time.time() + seconds
    delay = 2.0
    while True:
        st = await env.appbi.get(f"/report-artifacts/{report_id}/job")
        job = st.get("job") or {}
        if job.get("state") in ("done", "failed") or time.time() >= deadline:
            return {"job": job, "draft_number": st.get("draft_number")}
        await asyncio.sleep(delay)
        delay = min(delay * 1.5, 8.0)


async def _verified(env: Env, run: Run, report_id: int, before_number: int | None, label: str) -> dict[str, Any]:
    """Read back what AppBI saved; the result carries the diff and both preview links."""
    d = await _report(env, report_id)
    after_number = d.get("draft_number")
    if before_number is not None and (after_number is None or after_number <= before_number):
        raise OperationError("partially_failed", f"{label}: AppBI did not record a new draft revision.", step="verify")
    run.resources.append({"type": "vibe_report", "id": report_id, "revision": after_number, "url": studio_link(env, report_id, after_number)})
    out: dict[str, Any] = {"status": "draft_ready", "report_id": report_id, "draft_number": after_number,
                           "published_number": d.get("published_number"), "warnings": d.get("warnings") or [],
                           "preview_url": studio_link(env, report_id, after_number)}
    if before_number:
        before = await _revision(env, report_id, before_number)
        out["diff"] = source_diff(before, d.get("draft") or {}, limit=120)
        out["previous_preview_url"] = studio_link(env, report_id, before_number)
    out["next"] = ("Show the user the preview link. To make it live, call request_publish(resource_type='vibe_report', "
                   "resource_id=...) for a separate approval; to undo, plan_vibe_restore.")
    return out


async def run_vibe_plan(env: Env, run: Run) -> dict[str, Any]:
    body, kind = run.plan.body, run.plan.kind
    if kind == "vibe_create":
        async def create() -> dict[str, Any]:
            if body["mode"] == "blank":
                return await env.appbi.post("/report-artifacts/blank", {"dataset_id": body["dataset_id"], "name": body["name"]})
            return await env.appbi.post("/report-artifacts", {"dataset_id": body["dataset_id"], "name": body["name"],
                                                              "prompt": body["prompt"]})

        async def find(since: float) -> dict[str, Any] | None:
            # Adopt only a report created by THIS step: same owner/name/dataset, touched
            # after the step was sent, and not already owned by another plan's step.
            taken = env.plans.claimed_resource_ids("create", "id", exclude_plan=run.plan.id)
            rows = await env.appbi.get("/report-artifacts")
            for r in rows or []:
                if r.get("name") == body["name"] and r.get("dataset_id") == body["dataset_id"] \
                        and str(r.get("owner_id")) == str(env.principal.user_id) and int(r["id"]) not in taken \
                        and (_ts(r.get("updated_at")) or 0) >= since:
                    return {"id": r["id"]}
            return None

        created = await run.write("create", create, reconcile=find)
        report_id = int(created["id"])
        if body["mode"] == "ai":
            st = await _wait_job(env, report_id, None)
            if st["job"].get("state") == "failed":
                raise OperationError("blocked", f"AppBI's AI could not build the report: {st['job'].get('error')}", step="ai",
                                     detail={"report_id": report_id, "url": studio_link(env, report_id)})
            if st["job"].get("state") != "done":
                raise OperationError("partially_failed", "The AI is still building; call execute_plan again to follow it.", step="ai")
        return await _verified(env, run, report_id, None, "create")

    report_id = int(body["report_id"])
    if kind == "vibe_source":
        return await _apply(env, run, report_id, body)

    if kind == "vibe_restore":
        await _check_fresh(env, run)
        await run.write("restore", lambda: env.appbi.post(f"/report-artifacts/{report_id}/revisions/{int(body['number'])}/restore"))
        return await _verified(env, run, report_id, body["base_number"], "restore")

    if kind == "vibe_ai_edit":
        step = env.plans.step(run.plan.id, "ai_edit")
        if not step or step["status"] != "done":
            await _check_fresh(env, run)
        try:
            await run.write("ai_edit", lambda: env.appbi.post(f"/report-artifacts/{report_id}/ai-edit", {
                "instruction": body["instruction"], "region": body.get("region"), "allow_data": False, "propose": True}))
        except AppbiError as exc:
            if exc.status == 409:
                raise OperationError("conflict", f"AppBI refused: {exc.message}", step="ai_edit") from exc
            raise
        st = await _wait_job(env, report_id, body["base_number"])
        if st["job"].get("state") == "failed":
            raise OperationError("blocked", f"AppBI's AI could not apply the edit: {st['job'].get('error')}", step="ai")
        if st["job"].get("state") != "done":
            raise OperationError("partially_failed", "The AI is still working; call execute_plan again to follow it.", step="ai")
        proposal = await env.appbi.get(f"/report-artifacts/{report_id}/proposal")
        if proposal.get("base_number") != body["base_number"]:
            raise OperationError("stale_plan", "The draft changed while the AI worked; plan the edit again.", step="ai")

        async def follow_up() -> dict[str, Any]:
            d = await _report(env, report_id)
            diff = source_diff(d.get("draft") or {}, proposal)
            summary = _apply_summary(env, d, report_id, proposal["proposal_id"], diff, "AppBI Report Studio AI",
                                     extra=[{"title": "Instruction", "text": body["instruction"]},
                                            *([{"title": "AI notes", "items": proposal["notes"][:8]}] if proposal.get("notes") else [])])
            nxt = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="vibe_source",
                                   body={"report_id": report_id, "base_number": body["base_number"],
                                         "proposal_id": proposal["proposal_id"], "content": source_hash(proposal)},
                                   summary=summary, fingerprint=_fingerprint(d))
            return {"plan_id": nxt.id, "changed": diff["changed"],
                    "parts": {p: {k: v[k] for k in ("added", "removed")} for p, v in diff["parts"].items()}}

        nxt = await run.write("apply_plan", follow_up)
        return {"status": "proposal_ready", "report_id": report_id, "base_number": body["base_number"],
                "preview_url": proposal_link(env, report_id, proposal["proposal_id"]),
                "apply_plan_id": nxt["plan_id"], "approval_url": env.approval_url(nxt["plan_id"]),
                "changed": nxt["changed"], "diff_stats": nxt["parts"],
                "next": "Nothing is saved yet. Ask the user to open the preview, then approve or reject on the approval page; "
                        "after approval call execute_plan(apply_plan_id)."}

    raise OperationError("blocked", f"Unknown Vibe plan kind {kind}")


VIBE_KINDS = ("vibe_create", "vibe_source", "vibe_ai_edit", "vibe_restore")


def source_hash(src: dict[str, Any]) -> str:
    import hashlib

    return hashlib.sha256("\x00".join(str(src.get(p) or "") for p in ("html", "css", "js")).encode()).hexdigest()


async def _apply(env: Env, run: Run, report_id: int, body: dict[str, Any]) -> dict[str, Any]:
    """Save the approved proposal - exactly the code that was previewed - as a new draft revision."""
    if (env.plans.step(run.plan.id, "apply") or {}).get("status") != "done":
        await _check_fresh(env, run)

    async def apply() -> dict[str, Any]:
        try:
            current = await env.appbi.get(f"/report-artifacts/{report_id}/proposal")
        except AppbiError as exc:
            if exc.status == 404:
                raise OperationError("stale_plan", "The previewed proposal is gone (replaced or discarded); plan again.", step="apply") from exc
            raise
        if current.get("proposal_id") != body["proposal_id"] or source_hash(current) != body["content"]:
            raise OperationError("stale_plan", "The proposal in AppBI is not the one that was previewed and approved; plan again.", step="apply")
        try:
            return await env.appbi.post(f"/report-artifacts/{report_id}/proposal/apply",
                                        {"proposal_id": body["proposal_id"], "base_number": body["base_number"]})
        except AppbiError as exc:
            if exc.status == 409:
                raise OperationError("conflict", f"AppBI refused: {exc.message}", step="apply") from exc
            if exc.status == 410:
                raise OperationError("stale_plan", f"AppBI: {exc.message}", step="apply") from exc
            raise

    async def find_applied(_since: float) -> dict[str, Any] | None:
        d = await _report(env, report_id)
        draft = d.get("draft") or {}
        if (draft.get("number") or 0) > (body["base_number"] or 0) and source_hash(draft) == body["content"]:
            return {"revision": {"number": draft.get("number")}}
        return None

    saved = await run.write("apply", apply, reconcile=find_applied)
    if saved.get("warnings"):
        run.notes.extend(str(w) for w in saved["warnings"])
    out = await _verified(env, run, report_id, body["base_number"], "apply")
    if source_hash((await _report(env, report_id)).get("draft") or {}) != body["content"]:
        raise OperationError("partially_failed", "The saved draft differs from the approved proposal.", step="verify")
    return out


# ── publish (approved separately) ───────────────────────────────────────────────


async def vibe_publish_request(env: Env, report_id: int, number: int | None, allow_samples: bool) -> dict[str, Any]:
    d = await _report(env, report_id)
    if d.get("user_permission") != "full":
        return {"status": "forbidden", "message": "Publishing this report needs full access to it in AppBI."}
    target_number = number or d.get("draft_number")
    if not target_number:
        return {"status": "nothing_to_publish", "message": "The report has no revision yet."}
    if target_number == d.get("published_number"):
        return {"status": "nothing_to_publish", "message": f"Revision {target_number} is already published."}
    target = await _revision(env, report_id, target_number)
    current = await _revision(env, report_id, d["published_number"]) if d.get("published_number") else None
    diff = source_diff(current, target)
    rollback = target_number != d.get("draft_number")
    warnings = list(d.get("warnings") or []) if not rollback else []
    if allow_samples:
        warnings.append("Sample numbers from the design may remain; readers will see them labelled \"số mẫu\".")
    if d.get("public_link_count"):
        warnings.append(f"{d['public_link_count']} active public link(s) will show this revision.")
    summary = {
        "sections": [
            {"title": "Report", "items": [{"name": d.get("name"), "id": report_id, "goes live": f"revision {target_number}",
                                           "replaces": f"revision {d.get('published_number')}" if d.get("published_number") else "nothing (first publish)",
                                           "kind": "roll back to an earlier revision" if rollback else "publish the draft"}]},
            {"title": "Before / after (real Report Studio renderer with data)",
             "links": [x for x in (studio_link(env, report_id, d.get("published_number")) if d.get("published_number") else None,
                                   studio_link(env, report_id, target_number)) if x]},
            *_diff_section("Published now -> after publish", diff),
            {"title": "What happens", "items": [
                f"Every reader of this report (and its public links) sees revision {target_number}.",
                "AppBI checks again that you can read every chart the report shows.",
                "Earlier revisions stay available to roll back to.",
            ]},
        ],
        "warnings": warnings,
    }
    fp = {**_fingerprint(d), "target_hash": target.get("content_hash"), "target_id": target.get("id")}
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="vibe_publish",
                            body={"report_id": report_id, "number": target_number, "revision_id": target.get("id"),
                                  "allow_samples": bool(allow_samples)},
                            summary=summary, fingerprint=fp)
    return {"status": "awaiting_approval", "plan_id": plan.id, "approval_url": env.approval_url(plan.id),
            "warnings": warnings, "next": "Ask the user to approve in the browser, then call publish(plan_id)."}


async def vibe_publish_is_stale(env: Env, plan: Any) -> bool:
    d = await _report(env, plan.body["report_id"])
    target = await _revision(env, plan.body["report_id"], plan.body["number"])
    fp = {**_fingerprint(d), "target_hash": target.get("content_hash"), "target_id": target.get("id")}
    return fp != plan.fingerprint


async def run_vibe_publish(env: Env, run: Run) -> dict[str, Any]:
    body = run.plan.body
    report_id = int(body["report_id"])
    try:
        await run.write("publish", lambda: env.appbi.post(f"/report-artifacts/{report_id}/publish", {
            "revision_id": body["revision_id"], "allow_samples": body["allow_samples"]}))
    except AppbiError as exc:
        if exc.status == 409:
            raise OperationError("blocked", f"AppBI refused to publish: {exc.message}", step="publish", detail=exc.detail) from exc
        raise
    d = await _report(env, report_id)
    if d.get("published_number") != body["number"]:
        raise OperationError("partially_failed", "Publish returned OK but AppBI does not show the revision as published.", step="verify")
    run.resources.append({"type": "vibe_report", "id": report_id, "published_revision": body["number"]})
    return {"status": "published", "report_id": report_id, "published_number": body["number"],
            "url": studio_link(env, report_id, body["number"])}
