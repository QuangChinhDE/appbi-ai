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
from app.core.dependencies import get_current_user, require_permission
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
#: radius as a deploy, so it needs the top level rather than `edit`.
can_publish = require_permission("agent_flows", "full")
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
    metrics = (
        db.query(GovernMetric.name, GovernMetric.display_name, GovernMetric.category)
        .filter(GovernMetric.status != "Deprecated")
        .order_by(GovernMetric.display_name)
        .all()
    )
    return {
        "documents": [{"ref": str(i), "name": t} for i, t in docs],
        "datasets": [{"ref": str(i), "name": n} for i, n in datasets],
        "metrics": [
            {"ref": name, "name": display or name, "group": category or ""}
            for name, display, category in metrics
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
@router.get("/brains/{brain_key}/impact")
def brain_impact(
    brain_key: str, db: Session = Depends(get_db), _: User = Depends(can_view)
) -> dict[str, Any]:
    """Which live links this flow serves, and whether each is healthy. Read before
    Publish, because one edit changes every link pointing here."""
    return reg.impact(db, brain_key)


@router.get("/brains/{brain_key}/versions")
def brain_versions(
    brain_key: str, db: Session = Depends(get_db), _: User = Depends(can_view)
) -> dict[str, Any]:
    from app.models.agent_brain import AgentBrainVersion

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
    db: Session = Depends(get_db), _: User = Depends(can_view),
) -> dict[str, Any]:
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
    _: User = Depends(can_view),
) -> dict[str, Any]:
    return runs_service.list_runs(
        db, brain_key=brain_key, status=status, binding_id=binding_id,
        since_hours=since_hours, search=search, include_tests=include_tests,
        limit=min(limit, 200), offset=offset,
    )


@router.get("/brains/{brain_key}/runs/stats")
def brain_run_stats(
    brain_key: str, since_hours: int = 24,
    db: Session = Depends(get_db), _: User = Depends(can_view),
) -> dict[str, Any]:
    out = runs_service.stats(db, brain_key=brain_key, since_hours=since_hours)
    out["links"] = reg.impact(db, brain_key)["count"]
    return out


@router.get("/brains/{brain_key}/runs/coverage")
def brain_branch_coverage(
    brain_key: str, days: int = 30,
    db: Session = Depends(get_db), _: User = Depends(can_view),
) -> dict[str, Any]:
    """How often each node actually ran. Drawn ON the canvas — a branch nobody
    reaches is a branch to delete, and no author finds that by re-reading their own
    diagram."""
    return runs_service.branch_coverage(db, brain_key=brain_key, days=days)


@router.get("/brains/{brain_key}/runs/{run_id}")
def brain_run_detail(
    brain_key: str, run_id: int,
    db: Session = Depends(get_db), _: User = Depends(can_view),
) -> dict[str, Any]:
    out = runs_service.run_detail(db, brain_key=brain_key, run_id=run_id)
    if out is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy run")
    return out


@router.get("/brains/{brain_key}")
def brain_detail(
    brain_key: str, version: int | None = None,
    db: Session = Depends(get_db), _: User = Depends(can_view),
) -> dict[str, Any]:
    return _run(lambda: reg.get_brain(db, brain_key, version))


@router.put("/brains")
def save_brain(
    body: BrainWrite, db: Session = Depends(get_db), user: User = Depends(can_edit)
) -> dict[str, Any]:
    """Write the OPEN DRAFT. Never changes what is currently answering viewers.

    Upserts rather than minting a version per save — twenty prompt edits used to
    leave twenty rows and a version number that moved while the author typed.
    """
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
    return _run(lambda: reg.publish(db, brain_key, version, _actor(user)))


@router.post("/brains/{brain_key}/rollback")
def rollback_brain(
    brain_key: str, db: Session = Depends(get_db), user: User = Depends(can_publish)
) -> dict[str, Any]:
    return _run(lambda: reg.rollback(db, brain_key, _actor(user)))


@router.post("/brains/{brain_key}/versions/{version}/restore-to-draft")
def restore_version(
    brain_key: str, version: int,
    db: Session = Depends(get_db), user: User = Depends(can_edit),
) -> dict[str, Any]:
    """Load an old version back onto the canvas. Changes nothing that is live —
    that is `rollback`, and conflating the two is how someone re-publishes a version
    they only meant to look at."""
    return _run(lambda: reg.restore_to_draft(db, brain_key, version, _actor(user)))


@router.delete("/brains/{brain_key}/{version}")
def delete_brain_version(
    brain_key: str, version: int,
    db: Session = Depends(get_db), user: User = Depends(can_edit),
) -> dict[str, str]:
    _run(lambda: reg.delete_version(db, brain_key, version, _actor(user)))
    return {"status": "deleted"}


# ═══ Bindings — "define the data, then assign" ════════════════════════════════
class BindingWrite(BaseModel):
    link_id: int
    brain_key: str
    data_contract: dict = Field(default_factory=dict)
    pinned_version: int | None = None
    store_question_content: bool = True


def _link_and_dashboard(db: Session, link_id: int):
    from app.models.models import Dashboard
    from app.models.models import DashboardPublicLink

    link = db.query(DashboardPublicLink).filter(DashboardPublicLink.id == link_id).first()
    if link is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy link")
    dashboard = db.query(Dashboard).filter(Dashboard.id == link.dashboard_id).first()
    if dashboard is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy báo cáo của link")
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
    link, dashboard = _link_and_dashboard(db, link_id)
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
    link, dashboard = _link_and_dashboard(db, body.link_id)
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
    link, dashboard = _link_and_dashboard(db, body.link_id)
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
    link, _dash = _link_and_dashboard(db, link_id)
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
    link, dashboard = _link_and_dashboard(db, body.link_id)
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
