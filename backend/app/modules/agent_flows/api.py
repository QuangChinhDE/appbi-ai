"""API: /api/v1/agent-flows/*  — flows as a first-class, shareable resource.

Its own router with its own permission key, not a sub-path of the catalog. Publishing
a flow changes what a live report says to viewers, so it must not ride on a
knowledge-authoring grant.

The layer is deliberately thin. Every rule lives below it — the shape in `contract`,
the delegation in `permissions`, versioning in `registry`, the per-link data contract
in `binding`, the run path in `dispatch`. When a rule appears in this file, it has
been written in the wrong place.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import (
    get_current_user,
    get_effective_permission,
    require_edit_access,
    require_full_access,
    require_permission,
    require_view_access,
)
from app.models.user import User
from app.services.agent_flows import binding as binding_service
from app.services.agent_flows import permissions as perms
from app.services.agent_flows import registry as reg
from app.services.agent_flows import runs as runs_service
from app.services.agent_flows.contract import Flow, upgrade_body
from app.services.agent_flows.models_catalogue import catalogue as model_catalogue
from app.services.agent_flows.runtime.nodes import catalogue as node_catalogue
from app.services.agent_flows.tools.registry import catalogue as tool_catalogue

logger = logging.getLogger("app.agent_flows")

router = APIRouter(prefix="/agent-flows", tags=["agent-flows"])

can_view = require_permission("agent_flows", "view")
can_edit = require_permission("agent_flows", "edit")
#: Publishing changes AI behaviour on a live, published report — the same blast
#: radius as a deploy. That risk is real, but pinning it to module-wide `full` was
#: the wrong lever: `full` also means "see and manage every flow in the deployment",
#: so an author could not ship their own flow without being handed everybody else's.
#: The module floor is `edit`; the risk is carried by `_may_manage_flow`, which
#: additionally requires the caller to OWN the flow (or administer the module).
can_publish = require_permission("agent_flows", "edit")
#: Assigning a flow to a link decides what data a bot may read on someone's
#: dashboard. That is a DASHBOARD decision, so it is gated on dashboard rights and
#: additionally on the flow being shared with the assigner.
can_assign = require_permission("dashboards", "edit")


def _actor(user: User) -> str:
    return getattr(user, "email", None) or str(getattr(user, "id", "unknown"))


def _run(fn):
    try:
        return fn()
    except reg.BrainError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)
    except binding_service.BindingError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)


def _brain_row(db: Session, brain_key: str):
    """Newest version row for `brain_key`, or None. Any version identifies the flow;
    ownership and shares live on the flow, not on one revision of it."""
    from app.models.agent_brain import AgentBrainVersion

    return (
        db.query(AgentBrainVersion)
        .filter(AgentBrainVersion.brain_key == brain_key)
        .order_by(AgentBrainVersion.version.desc())
        .first()
    )


def _may_read_flow(db: Session, user: User, brain_key: str):
    """404/403 unless this user may open `brain_key`.

    THE MODULE KEY WAS THE ONLY GATE HERE. `agent_flows: view` let anyone GET any
    brain_key — a flow body carries its author's prompts and the ids of every
    document and dataset it reads — and `agent_flows: edit` let anyone overwrite or
    delete somebody else's flow. Every other module checks the ROW as well as the
    module; this one did not, so a flow was the one first-class resource with no
    object-level boundary at all.

    404 rather than 403 for a flow the caller may not see: "this key exists but is
    not yours" is a directory of everybody else's flows.
    """
    row = _brain_row(db, brain_key)
    if row is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy flow")
    if get_effective_permission(db, user, row, "agent_flows") == "none":
        raise HTTPException(status_code=404, detail="Không tìm thấy flow")
    return row


def _may_edit_flow(db: Session, user: User, brain_key: str):
    """403 unless this user may change `brain_key`. A key that does not exist yet is
    allowed through — that is how a new flow gets created."""
    row = _brain_row(db, brain_key)
    if row is None:
        return None
    if get_effective_permission(db, user, row, "agent_flows") == "none":
        raise HTTPException(status_code=404, detail="Không tìm thấy flow")
    require_edit_access(db, user, row, "agent_flows")
    return row


def _may_manage_flow(db: Session, user: User, brain_key: str):
    """403 unless this user may PUBLISH / roll back / delete `brain_key`.

    Publishing is gated at the ROW (owner, or an agent_flows administrator) instead
    of by demanding module-wide `full`. Module `full` means "see and manage every
    flow in the deployment", so requiring it to publish meant an author could not
    ship their own flow without also being handed everyone else's — the two are
    different powers and only one of them was wanted.
    """
    row = _may_read_flow(db, user, brain_key)
    require_full_access(db, user, row, "agent_flows")
    return row


# ═══ What a flow can be built from ════════════════════════════════════════════
@router.get("/nodes")
def list_nodes(web_enabled: bool = True, _: User = Depends(can_view)) -> dict[str, Any]:
    """The builder's "Thêm bước" library, GENERATED from the executor's registry.

    Not a hand-written list in the frontend. The previous module kept one there and
    it grew node types the executor could not run — a palette entry that publishes a
    flow which then does nothing.
    """
    return {"nodes": node_catalogue(web_enabled=web_enabled)}


@router.get("/tools")
def list_tools(web_enabled: bool = False, _: User = Depends(can_view)) -> dict[str, Any]:
    """The tool picker, grouped by pack. Withheld packs come back flagged rather than
    omitted: an author who cannot find web search should learn the deployment has it
    off, not conclude it never existed."""
    return {"packs": tool_catalogue(web_enabled=web_enabled)}


@router.get("/models")
def list_models(_: User = Depends(can_view)) -> dict[str, Any]:
    return {"providers": model_catalogue()}


@router.get("/authoring-prompt")
def authoring_prompt(
    web_enabled: bool = True, _: User = Depends(can_view)
) -> dict[str, Any]:
    """A brief the author pastes into ChatGPT/Claude to have a flow drafted.

    GENERATED from the same registries the builder's palette reads, per request.
    A hand-written copy would drift into naming node types the executor does not
    have — and unlike a stale palette entry, that drift comes back laundered
    through a competent outside model as confident, well-formed JSON.

    Costs nothing and calls no model: this endpoint only describes the system.
    """
    from app.services.agent_flows.authoring_prompt import build_authoring_prompt

    return build_authoring_prompt(web_enabled=web_enabled)


def _iter_raw_nodes(nodes: Any):
    """Every node dict in a RAW pasted body, including nested bodies.

    Walks the payload before the contract has seen it, because the check it
    feeds is about a field the contract deletes.
    """
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        yield n
        for p in (n.get("paths") or []) + (n.get("cases") or []):
            if isinstance(p, dict):
                yield from _iter_raw_nodes(p.get("body"))
        yield from _iter_raw_nodes(n.get("body"))
        yield from _iter_raw_nodes(n.get("fallback"))


class ImportDraftBody(BaseModel):
    """A flow drafted elsewhere, on its way in."""

    brain_key: str = ""
    name: str = ""
    #: Accepted as TEXT, not as a parsed object. What an author has on their
    #: clipboard is whatever the assistant printed — usually a ```json fence,
    #: sometimes with a sentence before it. Making the UI strip that first would
    #: put a second, quieter parser in the frontend; the paste arrives raw and is
    #: understood in one place.
    raw: str


@router.post("/import-draft")
def import_draft(
    body: ImportDraftBody, _: User = Depends(can_edit)
) -> dict[str, Any]:
    """Parse a pasted draft and report what it is — WITHOUT saving anything.

    Deliberately not "parse and create". A draft written by an outside model is
    the least trusted input this module takes, and the author has not seen what
    it contains yet. So this answers "would this work, and what does it want you
    to attach", and creating remains the existing explicit save.

    Validation is the SAME `Flow` contract the builder uses. A second, more
    forgiving parser for imported drafts would be a way to get a flow into the
    system that the builder itself would have refused.
    """
    import json as _json
    import re as _re

    text = (body.raw or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Chưa dán nội dung nào")

    # A fenced block if there is one, otherwise the outermost {...}. Both shapes
    # are what assistants actually return; neither is worth making a person edit
    # by hand before pasting.
    fence = _re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, _re.S)
    if fence:
        text = fence.group(1)
    else:
        first, last = text.find("{"), text.rfind("}")
        if first >= 0 and last > first:
            text = text[first:last + 1]

    try:
        data = _json.loads(text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail=f"Không đọc được JSON: {type(exc).__name__}. Dán đúng khối "
                   "```json mà trợ lý trả về.",
        )
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Nội dung phải là một object JSON")

    # `todo` is the model's note to the author about what to attach; it is not
    # part of a Flow, so it is lifted out before validation rather than making
    # the contract accept a field it has no use for.
    todo = [str(x) for x in (data.pop("todo", None) or []) if str(x).strip()]
    key = (body.brain_key or data.get("key") or "").strip()
    name = (body.name or data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Bản nháp thiếu 'name'")

    try:
        flow = Flow.model_validate(
            {**upgrade_body(data, key=key or "draft", name=name),
             "key": key or "draft", "name": name}
        )
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "errors": [reg._first_message(exc)],
            "warnings": [],
            "todo": todo,
        }

    # AN OUTSIDE MODEL THAT WIRED THE STEPS TOGETHER.
    #
    # A flow is an ORDERED LIST, not a graph — there is no `next` field, and node
    # models are configured `extra: "ignore"`, so a draft carrying `next` arrays
    # validates perfectly and the wiring is thrown away. Measured, not assumed: a
    # two-step draft whose edges ran b→a was accepted and would have executed
    # a→b, the list order.
    #
    # That is the worst failure shape available here — no error, and the flow
    # runs in an order the author never chose. Every assistant reaches for edges
    # unprompted, so the brief forbids it and this says so out loud when it
    # happens anyway. Checked against the RAW payload, because by the time the
    # contract has parsed it the evidence is already gone.
    wired = sorted({
        str(n.get("key") or "?")
        for n in _iter_raw_nodes(data.get("nodes"))
        if isinstance(n, dict) and n.get("next")
    })
    extra_warnings: list[str] = []
    if wired:
        extra_warnings.append(
            "Bản nháp có trường `next` ở các bước: " + ", ".join(wired)
            + ". Hệ thống KHÔNG dùng `next` — các bước chạy theo đúng thứ tự "
            "trong danh sách. Hãy kiểm tra thứ tự trước khi lưu, hoặc bảo trợ lý "
            "sắp xếp lại danh sách cho đúng ý và bỏ `next`."
        )

    from app.services.agent_flows.binding import estimate_cost

    # WHICH STEPS ARE STILL EMPTY. The brief tells the outside model to leave
    # every id blank, so a valid draft normally arrives incomplete BY DESIGN.
    # Saying which steps are waiting on an attachment is the difference between
    # "here is a flow" and "here is a flow, and these three steps read nothing
    # until you point them at something".
    needs: list[dict[str, Any]] = []
    for node in flow.all_nodes():
        # `knowledge` is the one attachment the contract actually carries, on the
        # two node types that can hold it. A `knowledge` step with nothing
        # attached retrieves from nothing — it will run, and find zero rows,
        # which is the silent half-working state worth naming up front. On an
        # `agent` step the same field is optional, so its absence is not a gap.
        if node.type == "knowledge" and not (getattr(node, "knowledge", None) or []):
            needs.append({
                "key": node.key,
                "name": node.name,
                "missing": ["knowledge"],
                "why": "Bước tra cứu chưa gắn tài liệu nào — sẽ không tìm thấy gì.",
            })

    return {
        "ok": True,
        "errors": [],
        "warnings": extra_warnings + list(flow.warnings()),
        "name": name,
        "description": str(data.get("description") or "").strip(),
        "body": flow.model_dump(mode="json", exclude={"key", "name"}),
        "node_count": len(flow.all_nodes()),
        "answer_node": flow.answering_key(),
        "estimate": estimate_cost(flow),
        "todo": todo,
        "needs_attachment": needs,
    }


@router.get("/attachable")
def list_attachable(
    db: Session = Depends(get_db), user: User = Depends(can_view)
) -> dict[str, Any]:
    """What THIS user may point a node at. Server-side, and the only source the
    picker uses — so the UI is not the thing enforcing the rule."""
    from app.models.dataset import Dataset
    from app.models.governance import GovernKnowledgeDoc, GovernMetric

    doc_ids = perms.attachable_documents(db, user)
    ds_ids = perms.attachable_datasets(db, user)
    docs = (
        db.query(GovernKnowledgeDoc.id, GovernKnowledgeDoc.title)
        .filter(GovernKnowledgeDoc.id.in_(doc_ids or [-1]))
        .all()
    )
    datasets = db.query(Dataset.id, Dataset.name).filter(Dataset.id.in_(ds_ids or [-1])).all()
    # A METRIC FOLLOWS ITS DATASET.
    #
    # Documents and datasets were filtered by what is shared with this author;
    # metrics were not, so the picker offered every metric in the deployment to
    # everyone. A metric carries `dataset_id`, and pointing a step at one is how
    # a run reaches that dataset's numbers — so an unfiltered metric list is a
    # way around the sharing rule the other two obey.
    #
    # A metric with NO dataset is a definition and nothing else: attaching it
    # yields a name, a formula and a unit, with no query behind it. Those stay
    # visible, because withholding a shared vocabulary teaches authors to
    # redefine terms locally, which is the problem the metric catalogue exists
    # to solve.
    metrics = (
        db.query(GovernMetric.name, GovernMetric.display_name,
                 GovernMetric.category, GovernMetric.dataset_id)
        .filter(GovernMetric.status != "Deprecated")
        .filter(
            (GovernMetric.dataset_id.is_(None))
            | (GovernMetric.dataset_id.in_(ds_ids or [-1]))
        )
        .order_by(GovernMetric.display_name)
        .all()
    )
    return {
        "documents": [{"ref": str(i), "name": t} for i, t in docs],
        "datasets": [{"ref": str(i), "name": n} for i, n in datasets],
        "metrics": [
            {"ref": name, "name": display or name, "group": category or "",
             # Stated so the builder can show which metrics carry a query and
             # which are vocabulary only — the author is choosing reach here,
             # and reach they cannot see is reach they cannot judge.
             "reads_data": ds_id is not None}
            for name, display, category, ds_id in metrics
        ],
    }


# ═══ Validate without saving ══════════════════════════════════════════════════
class ValidateBody(BaseModel):
    brain_key: str = "draft"
    name: str = "Draft"
    body: dict = Field(default_factory=dict)


@router.post("/validate")
def validate_flow(body: ValidateBody, _: User = Depends(can_view)) -> dict[str, Any]:
    """Is this flow valid, and what does it give up?

    Exists so the builder's "✓ Flow hợp lệ / ⚠ 2 review notes" badge can update as
    the author types. Without it the only way to see a warning was to SAVE, which
    used to mint a version — so the act of checking changed the thing being checked.
    """
    try:
        flow = Flow.model_validate(
            {**upgrade_body(body.body, key=body.brain_key, name=body.name),
             "key": body.brain_key, "name": body.name}
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "errors": [reg._first_message(exc)], "warnings": []}

    from app.services.agent_flows.binding import estimate_cost

    return {
        "ok": True,
        "errors": [],
        "warnings": flow.warnings(),
        "node_count": len(flow.all_nodes()),
        "answer_node": flow.answering_key(),
        "requirements": flow.requirements.model_dump(mode="json"),
        "estimate": estimate_cost(flow),
        "produced_vars": sorted(flow.produced_vars()),
        "referenced_vars": sorted(flow.referenced_vars()),
    }


# ═══ Flows ════════════════════════════════════════════════════════════════════
class BrainWrite(BaseModel):
    brain_key: str
    name: str
    description: str = ""
    body: dict = Field(default_factory=dict)


@router.get("/brains")
def brains(db: Session = Depends(get_db), user: User = Depends(can_view)) -> dict[str, Any]:
    return {"brains": reg.list_brains(db, user)}


# NOTE ON ORDER: literal segments must be declared BEFORE `/brains/{brain_key}`, or
# Starlette matches `/brains/impact` as a flow named "impact" and answers 404 for
# ever. It matches in registration order and does not fall through on a validation
# failure.
@router.get("/brains/resolve/{flow_id}")
def resolve_flow_id(
    flow_id: int, db: Session = Depends(get_db), user: User = Depends(can_view)
) -> dict[str, Any]:
    """The `brain_key` behind the number in a link.

    The address bar carries a number; everything else here — permissions, runs,
    bindings, shares — is keyed by `brain_key`. One lookup at the edge keeps it
    that way, instead of a second identity threaded through every endpoint.

    Permission-checked like any other read: a number is easy to guess, so
    resolving one must not reveal the existence of a flow the caller may not
    open. `_may_read_flow` raises the same 404 an unknown number gets.
    """
    key = reg.flow_id_to_key(db, flow_id)
    if not key:
        raise HTTPException(status_code=404, detail="Không tìm thấy flow này.")
    _may_read_flow(db, user, key)
    return {"flow_id": flow_id, "brain_key": key}


@router.get("/brains/{brain_key}/impact")
def brain_impact(
    brain_key: str, db: Session = Depends(get_db), user: User = Depends(can_view)
) -> dict[str, Any]:
    """Which live links this flow serves, and whether each is healthy. Read before
    Publish, because one edit changes every link pointing here."""
    _may_read_flow(db, user, brain_key)
    return reg.impact(db, brain_key)


@router.get("/brains/{brain_key}/versions")
def brain_versions(
    brain_key: str, db: Session = Depends(get_db), user: User = Depends(can_view)
) -> dict[str, Any]:
    from app.models.agent_brain import AgentBrainVersion

    _may_read_flow(db, user, brain_key)
    rows = (
        db.query(AgentBrainVersion)
        .filter(AgentBrainVersion.brain_key == brain_key)
        .order_by(AgentBrainVersion.version.desc())
        .all()
    )
    return {
        "versions": [
            {
                "version": r.version, "status": r.status, "name": r.name,
                "created_by": r.created_by,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
                "published_at": r.published_at.isoformat() if r.published_at else None,
            }
            for r in rows
        ]
    }


@router.get("/brains/{brain_key}/activity")
def brain_activity(
    brain_key: str, limit: int = 100,
    db: Session = Depends(get_db), user: User = Depends(can_view),
) -> dict[str, Any]:
    _may_read_flow(db, user, brain_key)
    return reg.activity(db, brain_key, limit=limit)


@router.get("/brains/{brain_key}/runs")
def brain_runs(
    brain_key: str,
    status: str | None = None,
    binding_id: int | None = None,
    since_hours: int = 24,
    search: str = "",
    include_tests: bool = False,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
    user: User = Depends(can_view),
) -> dict[str, Any]:
    _may_read_flow(db, user, brain_key)
    return runs_service.list_runs(
        db, brain_key=brain_key, status=status, binding_id=binding_id,
        since_hours=since_hours, search=search, include_tests=include_tests,
        limit=min(limit, 200), offset=offset,
    )


@router.get("/brains/{brain_key}/runs/stats")
def brain_run_stats(
    brain_key: str, since_hours: int = 24,
    db: Session = Depends(get_db), user: User = Depends(can_view),
) -> dict[str, Any]:
    _may_read_flow(db, user, brain_key)
    out = runs_service.stats(db, brain_key=brain_key, since_hours=since_hours)
    out["links"] = reg.impact(db, brain_key)["count"]
    return out


@router.get("/brains/{brain_key}/runs/coverage")
def brain_branch_coverage(
    brain_key: str, days: int = 30,
    db: Session = Depends(get_db), user: User = Depends(can_view),
) -> dict[str, Any]:
    """How often each node actually ran. Drawn ON the canvas — a branch nobody
    reaches is a branch to delete, and no author finds that by re-reading their own
    diagram."""
    _may_read_flow(db, user, brain_key)
    return runs_service.branch_coverage(db, brain_key=brain_key, days=days)


@router.get("/brains/{brain_key}/runs/{run_id}")
def brain_run_detail(
    brain_key: str, run_id: int,
    db: Session = Depends(get_db), user: User = Depends(can_view),
) -> dict[str, Any]:
    _may_read_flow(db, user, brain_key)
    out = runs_service.run_detail(db, brain_key=brain_key, run_id=run_id)
    if out is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy run")
    return out


@router.get("/brains/{brain_key}")
def brain_detail(
    brain_key: str, version: int | None = None,
    db: Session = Depends(get_db), user: User = Depends(can_view),
) -> dict[str, Any]:
    _may_read_flow(db, user, brain_key)
    return _run(lambda: reg.get_brain(db, brain_key, version))


@router.put("/brains")
def save_brain(
    body: BrainWrite, db: Session = Depends(get_db), user: User = Depends(can_edit)
) -> dict[str, Any]:
    """Write the OPEN DRAFT. Never changes what is currently answering viewers.

    Upserts rather than minting a version per save — twenty prompt edits used to
    leave twenty rows and a version number that moved while the author typed.
    """
    # `brain_key` comes from the request body, so without this an `agent_flows:edit`
    # grant was a licence to overwrite anybody's flow by guessing its key. A key that
    # does not exist yet passes through — that is how a new flow is created.
    _may_edit_flow(db, user, body.brain_key)
    return _run(lambda: reg.save_draft(
        db, user, brain_key=body.brain_key, name=body.name,
        description=body.description, body=body.body, actor_email=_actor(user),
    ))


@router.post("/brains/{brain_key}/{version}/publish")
def publish_brain(
    brain_key: str, version: int,
    db: Session = Depends(get_db), user: User = Depends(can_publish),
) -> dict[str, Any]:
    """Go live. Links this version would break are PINNED to what they run today
    rather than broken, and reported back so the author can fix them."""
    _may_manage_flow(db, user, brain_key)
    return _run(lambda: reg.publish(db, brain_key, version, _actor(user)))


@router.post("/brains/{brain_key}/rollback")
def rollback_brain(
    brain_key: str, db: Session = Depends(get_db), user: User = Depends(can_publish)
) -> dict[str, Any]:
    _may_manage_flow(db, user, brain_key)
    return _run(lambda: reg.rollback(db, brain_key, _actor(user)))


@router.post("/brains/{brain_key}/versions/{version}/restore-to-draft")
def restore_version(
    brain_key: str, version: int,
    db: Session = Depends(get_db), user: User = Depends(can_edit),
) -> dict[str, Any]:
    """Load an old version back onto the canvas. Changes nothing that is live —
    that is `rollback`, and conflating the two is how someone re-publishes a version
    they only meant to look at."""
    _may_edit_flow(db, user, brain_key)
    return _run(lambda: reg.restore_to_draft(db, brain_key, version, _actor(user)))


@router.delete("/brains/{brain_key}/{version}")
def delete_brain_version(
    brain_key: str, version: int,
    db: Session = Depends(get_db), user: User = Depends(can_edit),
) -> dict[str, str]:
    _may_manage_flow(db, user, brain_key)
    _run(lambda: reg.delete_version(db, brain_key, version, _actor(user)))
    return {"status": "deleted"}


# ═══ Bindings — "define the data, then assign" ════════════════════════════════
class BindingWrite(BaseModel):
    link_id: int
    brain_key: str
    data_contract: dict = Field(default_factory=dict)
    pinned_version: int | None = None
    store_question_content: bool = True


def _link_and_dashboard(db: Session, link_id: int, user: User):
    """The link and its report — only if the caller may see that report.

    THE REPORT IS CHECKED, NOT JUST THE MODULE. A link id is an integer chosen
    by the caller, and every endpoint here takes one from the request body.
    Without this, `agent_flows:edit` was enough to run a flow against ANY
    published link: the dashboards module refuses `GET /dashboards/44` to a user
    with no rights on it, and this path walked straight past that refusal to the
    same data. Measured, not theorised — a user holding only `agent_flows:edit`
    reached the flow layer on dashboard 44 and was stopped by a missing binding
    rather than by permission.

    `require_view_access` is the same ownership + share + module check the
    dashboards module itself applies, so a flow can never reach further than the
    person running it.
    """
    from app.models.models import Dashboard, DashboardPublicLink

    link = db.query(DashboardPublicLink).filter(DashboardPublicLink.id == link_id).first()
    if link is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy link")
    dashboard = db.query(Dashboard).filter(Dashboard.id == link.dashboard_id).first()
    if dashboard is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy báo cáo của link")
    require_view_access(db, user, dashboard, "dashboards")
    return link, dashboard


def _usable_flow(db: Session, user: User, brain_key: str) -> Flow:
    """The flow, but only if it is shared with this user.

    Assigning is a different question from authoring: the assigner needs the flow to
    have been shared with them, and gets no say over what it contains.
    """
    keys = {r.brain_key for r in perms.usable_brains(db, user).all()}
    if brain_key not in keys:
        raise HTTPException(status_code=403, detail="Flow này chưa được chia sẻ cho bạn")
    resolved = reg.resolve_published(db, brain_key)
    if resolved is None:
        raise HTTPException(
            status_code=409, detail="Flow này chưa có bản phát hành nào để gán"
        )
    return resolved[1]


@router.get("/bindings/link/{link_id}")
def get_binding(
    link_id: int, db: Session = Depends(get_db), _: User = Depends(can_assign)
) -> dict[str, Any]:
    binding = binding_service.get_for_link(db, link_id)
    if binding is None:
        return {"binding": None}
    return {
        "binding": {
            "id": binding.id,
            "link_id": binding.link_id,
            "brain_key": binding.brain_key,
            "pinned_version": binding.pinned_version,
            "status": binding.status,
            "data_contract": binding.data_contract or {},
            "last_validation": binding.last_validation or {},
            "store_question_content": binding.store_question_content,
            "validated_at": binding.validated_at.isoformat() if binding.validated_at else None,
        }
    }


@router.get("/bindings/link/{link_id}/candidates")
def binding_candidates(
    link_id: int, brain_key: str,
    db: Session = Depends(get_db), user: User = Depends(can_assign),
) -> dict[str, Any]:
    """What the mapping screen offers: this flow's requirements, and the real charts
    and fields on THIS dashboard that could satisfy each of them.

    Server-side so the picker cannot offer a field the dashboard does not have —
    which is the whole failure mode "define before assign" exists to prevent.
    """
    link, dashboard = _link_and_dashboard(db, link_id, user)
    flow = _usable_flow(db, user, brain_key)
    from app.services.dashboard_ai_bot.tool_context import ToolContext

    ctx = ToolContext.from_dashboard(db=db, dashboard=dashboard, public_filters=[])
    from app.services.agent_flows.dispatch import build_report_info

    report = build_report_info(dashboard, ctx)
    return {
        "requirements": flow.requirements.model_dump(mode="json"),
        "charts": [
            {
                "id": c.id, "title": c.title, "chart_type": c.chart_type,
                "measures": [m.model_dump() for m in c.measures],
                "dimensions": [d.model_dump() for d in c.dimensions],
            }
            for c in report.charts
        ],
        "flow_knowledge": [
            {"source": s.source, "ref": s.ref, "description": s.description}
            for s in flow.bound_sources()
        ],
        "flow_capabilities": {"web_search": flow.uses_capability("web_search")},
    }


@router.post("/bindings/preflight")
def preflight_binding(
    body: BindingWrite, db: Session = Depends(get_db), user: User = Depends(can_assign)
) -> dict[str, Any]:
    """Would this assignment work? Errors block the Assign button.

    The estimate is not decoration: this is a public link with an unbounded
    audience, and one Loop multiplies a single question by up to 25 model calls.
    """
    link, dashboard = _link_and_dashboard(db, body.link_id, user)
    flow = _usable_flow(db, user, body.brain_key)
    contract = binding_service.DataContract.model_validate(body.data_contract or {})
    return binding_service.preflight(
        db, flow=flow, contract=contract, dashboard=dashboard, link=link
    )


@router.put("/bindings")
def save_binding(
    body: BindingWrite, db: Session = Depends(get_db), user: User = Depends(can_assign)
) -> dict[str, Any]:
    """Assign. Refused while anything required is unresolved."""
    link, dashboard = _link_and_dashboard(db, body.link_id, user)
    flow = _usable_flow(db, user, body.brain_key)
    contract = binding_service.DataContract.model_validate(body.data_contract or {})

    def _save():
        binding, result = binding_service.save_binding(
            db, link=link, dashboard=dashboard, flow=flow, contract=contract,
            pinned_version=body.pinned_version, actor_email=_actor(user),
            store_question_content=body.store_question_content,
        )
        reg._audit(
            db, "AGENT_FLOW_ASSIGNED", body.brain_key, _actor(user),
            {"link_id": link.id, "link_name": link.name, "binding_id": binding.id},
        )
        return {"binding_id": binding.id, "status": binding.status, **result}

    return _run(_save)


@router.delete("/bindings/link/{link_id}")
def delete_binding(
    link_id: int, db: Session = Depends(get_db), user: User = Depends(can_assign)
) -> dict[str, str]:
    binding = binding_service.get_for_link(db, link_id)
    if binding is None:
        raise HTTPException(status_code=404, detail="Link này chưa gán flow nào")
    brain_key = binding.brain_key
    db.delete(binding)
    link, _dash = _link_and_dashboard(db, link_id, user)
    cfg = dict(link.appearance_config or {})
    cfg.pop("ai_bot_flow_key", None)
    link.appearance_config = cfg
    db.commit()
    reg._audit(db, "AGENT_FLOW_UNASSIGNED", brain_key, _actor(user), {"link_id": link_id})
    return {"status": "deleted"}


# ═══ Test ═════════════════════════════════════════════════════════════════════
class TestBody(BaseModel):
    question: str
    #: WHICH LINK to test against. Not a bare dashboard: "does this flow work" is a
    #: question about a flow ON A LINK, and two links resolve requirements
    #: differently. Testing without one would test something nobody runs.
    link_id: int
    version: int | None = None


@router.post("/brains/{brain_key}/test")
async def test_flow(
    brain_key: str, body: TestBody,
    db: Session = Depends(get_db), user: User = Depends(can_edit),
) -> dict[str, Any]:
    """Run the draft against a real binding, as the author.

    Returns the finished envelope rather than a stream: the Studio's test panel shows
    a completed execution path and answer, and a second streaming protocol would be a
    second thing to keep in step with the first.
    """
    _may_edit_flow(db, user, brain_key)
    link, dashboard = _link_and_dashboard(db, body.link_id, user)
    binding = binding_service.get_for_link(db, link.id)
    if binding is None:
        raise HTTPException(
            status_code=409,
            detail="Link này chưa gán flow — hãy gán và định nghĩa phạm vi dữ liệu trước khi test",
        )

    detail = _run(lambda: reg.get_brain(db, brain_key, body.version))
    from app.models.agent_brain import AgentBrainVersion

    row = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.version == detail["version"],
        )
        .first()
    )
    flow = reg.parse_flow(row) if row else None
    if flow is None:
        raise HTTPException(status_code=422, detail="Flow không hợp lệ, chưa test được")

    from app.services.agent_flows.dispatch import run_preview
    from app.services.dashboard_ai_bot.tool_context import ToolContext

    ctx = ToolContext.from_dashboard(
        db=db, dashboard=dashboard, public_filters=[],
        actor_type="user", actor_ref=_actor(user),
    )
    cfg = link.appearance_config or {}
    api_key, provider, model = _link_credentials(cfg)

    envelope: dict | None = None
    async for ev in run_preview(
        db, flow=flow, version=row.version, binding=binding, link=link,
        dashboard=dashboard, ctx=ctx, question=body.question,
        api_key=api_key, provider=provider, model=model,
    ):
        if ev.type == "result":
            envelope = ev.extra.get("envelope")
    return {"envelope": envelope}


class NodeTestBody(BaseModel):
    link_id: int
    #: Variables to start from, so a node deep in a flow can be exercised without
    #: paying for everything before it.
    vars: dict = Field(default_factory=dict)
    version: int | None = None


@router.post("/brains/{brain_key}/nodes/{node_key}/test")
def test_node(
    brain_key: str, node_key: str, body: NodeTestBody,
    db: Session = Depends(get_db), user: User = Depends(can_edit),
) -> dict[str, Any]:
    """Evaluate ONE node against sample state.

    For IF / Switch / Filter this is pure evaluation: no model, no tools, no cost —
    which is exactly the node an author most often gets wrong and least wants to pay
    to check.
    """
    _may_edit_flow(db, user, brain_key)
    detail = _run(lambda: reg.get_brain(db, brain_key, body.version))
    from app.models.agent_brain import AgentBrainVersion

    row = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.version == detail["version"],
        )
        .first()
    )
    flow = reg.parse_flow(row) if row else None
    if flow is None:
        raise HTTPException(status_code=422, detail="Flow không hợp lệ")
    node = flow.node(node_key)
    if node is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy bước này")

    from app.services.agent_flows.runtime.state import RunState, evaluate, evaluate_all

    state = RunState(vars=dict(body.vars))

    if node.type == "if":
        results = []
        chosen = None
        for path in node.paths:
            if path.kind == "fallback":
                results.append({"path": path.key, "name": path.name, "kind": "fallback",
                                "matched": chosen is None})
                if chosen is None:
                    chosen = path.key
                continue
            hit = path.kind == "always" or evaluate_all(state, path.conditions, path.match)
            results.append({"path": path.key, "name": path.name, "kind": path.kind,
                            "matched": bool(hit and chosen is None)})
            if hit and chosen is None:
                chosen = path.key
        return {"type": "if", "chosen": chosen, "paths": results}

    if node.type == "switch":
        value = state.resolve(node.value)
        cases = [
            {"case": c.key, "label": c.label,
             "matched": evaluate(state, str(value), c.op, c.value)}
            for c in node.cases
        ]
        chosen = next((c["case"] for c in cases if c["matched"]), None)
        return {"type": "switch", "value": value, "cases": cases,
                "chosen": chosen or ("fallback" if node.has_fallback else None)}

    if node.type == "filter":
        return {"type": "filter", "passed": evaluate_all(state, node.conditions, node.match)}

    if node.type == "set_var":
        return {"type": "set_var", "var": node.var, "value": state.resolve(node.value)}

    if node.type == "loop":
        from app.services.agent_flows.runtime.state import as_list

        items = as_list(state.resolve(node.over), limit=node.max_iterations)
        return {"type": "loop", "items": items, "iterations": len(items)}

    # Nodes that cost money or touch data are not run from here. Instead the
    # resolved inputs are shown, which is what an author is checking when they open
    # the Test tab on an agent: "will this prompt say the right thing".
    preview: dict[str, Any] = {"type": node.type}
    if node.type == "agent":
        preview["prompt"] = state.resolve_text(node.prompt)
        preview["tools"] = node.tool_names()
        preview["knowledge"] = [k.ref for k in node.knowledge]
        preview["note"] = "Bước AI chỉ được chạy qua Test toàn Flow — ở đây hiển thị prompt sau khi thay biến."
    elif node.type in {"knowledge", "web"}:
        preview["query"] = state.resolve_text(node.query)
        preview["note"] = "Truy vấn sau khi thay biến."
    return preview


def _link_credentials(cfg: dict) -> tuple[str, str, str]:
    """The link's stored AI credential, decrypted. Never returned to any client."""
    provider = str((cfg or {}).get("ai_bot_provider") or "").strip().lower()
    model = str((cfg or {}).get("ai_bot_model") or "")
    raw = str((cfg or {}).get("ai_bot_key") or "")
    key = raw
    if raw.startswith("_enc:"):
        try:
            from app.core.crypto import decrypt_value

            key = decrypt_value(raw) or ""
        except Exception:  # noqa: BLE001
            logger.warning("[flow] link credential will not decrypt")
            key = ""
    return key, provider, model
