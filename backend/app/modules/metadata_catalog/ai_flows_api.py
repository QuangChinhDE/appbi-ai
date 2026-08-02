"""API: /api/v1/catalog/ai/*  — the Flow Studio backend.

Everything a person needs to build an AI analysis flow without touching code:
browse the palette, edit agents and graphs, validate as they type, run a draft
against a real report, publish behind an approval, bind it to a chatbot, and
read the trace of what actually happened.

Mounted on the existing /catalog router, so it inherits that router's
module-permission gate (reads → view, writes → edit). Publishing additionally
requires ai_flows:full — it changes AI behaviour on a live, published report,
which is the same blast radius as a deploy.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission
from app.models.user import User
from app.services.intelligence import tools_catalog
from app.services.intelligence.registry import lifecycle as lc
from app.services.intelligence.registry import portability as port
from app.services.intelligence.registry import service as reg

logger = logging.getLogger("app.metadata_catalog.ai_flows")

router = APIRouter(prefix="/ai", tags=["ai-flows"])

require_full = require_permission("ai_flows", "full")


def _run(fn):
    try:
        return fn()
    except reg.RegistryError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)


def _actor(user: User) -> str:
    return getattr(user, "email", None) or str(getattr(user, "id", "unknown"))


# ═══ Palette ═════════════════════════════════════════════════════════════════
@router.get("/palette")
def get_palette(_: User = Depends(get_current_user)) -> dict[str, Any]:
    """Everything the builder can place, in one request.

    Derived from code, not a hand-kept list — a tool registered in Python shows
    up here (and therefore in the UI) with no frontend change.
    """
    return tools_catalog.palette()


@router.get("/tools")
def get_tools(_: User = Depends(get_current_user)) -> dict[str, Any]:
    """Just the tool list — the palette's Tools tab, without the rest."""
    return {
        "tools": [t.to_dict() for t in tools_catalog.TOOLS.values()],
        "handlers": [h.to_dict() for h in tools_catalog.HANDLERS.values()],
    }


# ═══ Agents ══════════════════════════════════════════════════════════════════
class AgentWrite(BaseModel):
    agent_key: str
    version: int | None = None
    display_name: str
    model_policy: str = "deep_reason"
    prompt_template: str = ""
    tool_allowlist: list[str] = Field(default_factory=list)
    writable_state_fields: list[str] = Field(default_factory=list)
    runtime_config: dict = Field(default_factory=dict)
    input_schema: dict = Field(default_factory=dict)
    output_schema: dict = Field(default_factory=dict)


@router.get("/agents")
def list_agents(db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"agents": reg.list_agents(db)}


@router.put("/agents")
def save_agent(body: AgentWrite, db: Session = Depends(get_db),
               user: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: reg.save_agent(db, body.model_dump(), user=_actor(user)))


@router.post("/agents/{agent_key}/{version}/publish")
def publish_agent(agent_key: str, version: int, db: Session = Depends(get_db),
                  user: User = Depends(require_full)) -> dict[str, Any]:
    return _run(lambda: reg.publish_agent(db, agent_key, version, user=_actor(user)))


@router.get("/agents/{agent_key}/versions")
def agent_versions(agent_key: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Every version of one specialist — the version picker + diff source."""
    rows = [a for a in reg.list_agents(db) if a["agent_key"] == agent_key]
    return {"versions": rows}


@router.delete("/agents/{agent_key}/{version}")
def delete_agent(agent_key: str, version: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    _run(lambda: reg.delete_agent(db, agent_key, version))
    return {"ok": True}


# ═══ Flows ═══════════════════════════════════════════════════════════════════
class FlowWrite(BaseModel):
    flow_key: str
    version: int | None = None
    display_name: str
    graph: dict
    description: str | None = None
    owner: str | None = None
    tags: list[str] | None = None
    eval_suite: str | None = None


class StatusWrite(BaseModel):
    status: str


class GraphOnly(BaseModel):
    graph: dict


class CloneWrite(BaseModel):
    new_key: str
    display_name: str = ""


@router.get("/flows")
def list_flows(db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"flows": reg.list_flows(db)}


# NOTE ON ORDER: `/flows/{flow_key}/versions` and `/flows/{flow_key}/impact` are
# the same SHAPE as `/flows/{flow_key}/{version}`. Starlette matches in
# registration order and does not fall through on a validation failure, so if
# the parameterised route were declared first, `/flows/x/versions` would be
# parsed as version="versions" and answered with a 422 forever. Literal
# segments must be registered before the parameterised sibling.
@router.get("/flows/{flow_key}/versions")
def flow_versions(flow_key: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"versions": lc.flow_versions(db, flow_key)}


@router.get("/flows/{flow_key}/impact")
def flow_impact(flow_key: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Blast radius: which assistants and surfaces this flow serves."""
    return lc.flow_impact(db, flow_key)


@router.get("/flows/{flow_key}/{version}")
def get_flow(flow_key: str, version: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    flow = _run(lambda: reg.get_flow(db, flow_key, version))
    flow["validation"] = reg.validate_graph(db, flow.get("graph") or {})
    return flow


@router.post("/flows/validate")
def validate_flow(body: GraphOnly, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Called on every canvas edit — cheap, no writes, errors carry node_key so
    the UI can paint them on the offending node."""
    return reg.validate_graph(db, body.graph)


@router.put("/flows")
def save_flow(body: FlowWrite, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: reg.save_flow(db, body.model_dump(), user=_actor(user)))


@router.post("/flows/{flow_key}/{version}/clone")
def clone_flow(flow_key: str, version: int, body: CloneWrite,
               db: Session = Depends(get_db),
               user: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: reg.clone_flow(
        db, flow_key, version,
        new_key=body.new_key, display_name=body.display_name, user=_actor(user),
    ))


@router.post("/flows/{flow_key}/{version}/publish")
def publish_flow(flow_key: str, version: int, db: Session = Depends(get_db),
                 user: User = Depends(require_full)) -> dict[str, Any]:
    return _run(lambda: reg.publish_flow(db, flow_key, version, user=_actor(user)))


@router.post("/flows/{flow_key}/rollback")
def rollback_flow(flow_key: str, db: Session = Depends(get_db),
                  user: User = Depends(require_full)) -> dict[str, Any]:
    return _run(lambda: reg.rollback_flow(db, flow_key, user=_actor(user)))


@router.get("/flows/{flow_key}/{version}/diff")
def flow_diff(flow_key: str, version: int, against: int | None = None,
              db: Session = Depends(get_db)) -> dict[str, Any]:
    """What changes if this version ships — the reviewer's view."""
    return _run(lambda: lc.flow_diff(db, flow_key, version, against))


@router.post("/flows/{flow_key}/{version}/eval")
def flow_eval(flow_key: str, version: int, db: Session = Depends(get_db),
              _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: lc.run_flow_eval(db, flow_key, version))


@router.post("/flows/{flow_key}/{version}/status")
def flow_status(flow_key: str, version: int, body: StatusWrite,
                db: Session = Depends(get_db),
                user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Draft → Ready → In review. Publishing stays a separate, full-only action."""
    return _run(lambda: lc.set_flow_status(
        db, flow_key, version, body.status, user=_actor(user),
    ))


@router.delete("/flows/{flow_key}/{version}")
def delete_flow(flow_key: str, version: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    _run(lambda: reg.delete_flow(db, flow_key, version))
    return {"ok": True}


# ═══ Assistants + bindings ═══════════════════════════════════════════════════
class AssistantWrite(BaseModel):
    key: str
    display_name: str = ""
    status: str = "draft"
    routing: list[dict] = Field(default_factory=list)
    credential_ref: str | None = None
    budget: dict = Field(default_factory=dict)
    knowledge_scope: dict = Field(default_factory=dict)
    locale: str = "vi-VN"
    eval_suite: str | None = None


class BindingsWrite(BaseModel):
    bindings: list[dict] = Field(default_factory=list)


@router.get("/assistants")
def list_assistants(db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"assistants": reg.list_assistants(db)}


@router.put("/assistants")
def save_assistant(body: AssistantWrite, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: reg.save_assistant(db, body.model_dump(), user=_actor(user)))


@router.put("/assistants/{key}/bindings")
def set_bindings(key: str, body: BindingsWrite,
                 db: Session = Depends(get_db),
                 _: User = Depends(require_full)) -> dict[str, Any]:
    """Binding a chatbot to a live report is a production change — full only."""
    return _run(lambda: reg.set_bindings(db, key, body.bindings))


@router.delete("/assistants/{key}")
def delete_assistant(key: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    _run(lambda: reg.delete_assistant(db, key))
    return {"ok": True}


@router.get("/assistants/{key}/effective")
def assistant_effective(key: str, token: str | None = None,
                        dashboard_id: int | None = None,
                        intent: str | None = None,
                        db: Session = Depends(get_db)) -> dict[str, Any]:
    """Which flow would ACTUALLY answer, for a given surface and intent.

    Binding inheritance (link → dashboard → global → built-in) is easy to get
    wrong in your head; showing the resolved answer removes the guesswork before
    anyone points a chatbot at a live report.
    """
    from app.services.intelligence.registry.resolver import resolve_flow

    resolved = resolve_flow(
        db, link_token=token, dashboard_id=dashboard_id or 0, intent=intent,
    )
    if resolved is None:
        return {
            "resolved": False,
            "reason": "Chưa có luồng nào phục vụ — hệ thống sẽ dùng trợ lý mặc định.",
        }
    return {
        "resolved": True,
        "flow_key": resolved.flow_key,
        "flow_version": resolved.flow_version,
        "assistant_key": resolved.assistant_key,
        "source": resolved.source,
        "matches_this_assistant": resolved.assistant_key == key,
    }


# ═══ Export / import ═════════════════════════════════════════════════════════
class ImportBody(BaseModel):
    bundle: dict
    new_key: str | None = None
    dry_run: bool = False


@router.get("/flows/{flow_key}/{version}/export")
def export_flow(flow_key: str, version: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    return _run(lambda: port.export_flow(db, flow_key, version))


@router.post("/flows/import")
def import_flow(body: ImportBody, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Dry-run reports what is missing; a real import always lands as a Draft."""
    if body.dry_run:
        return port.check_bundle(db, body.bundle)
    return _run(lambda: port.import_bundle(
        db, body.bundle, user=_actor(user), new_key=body.new_key,
    ))


# ═══ Bindable surfaces ═══════════════════════════════════════════════════════
@router.get("/surfaces")
def list_surfaces(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Reports a chatbot can be attached to.

    Only links with the AI bot ENABLED are offered — binding an assistant to a
    link whose bot is off produces a chatbot nobody can reach, and the author
    has no way to tell from the Studio.
    """
    from app.models.models import Dashboard, DashboardPublicLink

    links: list[dict] = []
    rows = (
        db.query(DashboardPublicLink, Dashboard)
        .join(Dashboard, Dashboard.id == DashboardPublicLink.dashboard_id)
        .order_by(DashboardPublicLink.id.desc())
        .limit(200)
        .all()
    )
    for link, dash in rows:
        cfg = link.appearance_config or {}
        if not cfg.get("ai_bot_enabled"):
            continue
        links.append({
            "token": link.token,
            "dashboard_id": dash.id,
            "dashboard_name": dash.name,
            "provider": cfg.get("ai_bot_provider"),
            "model": cfg.get("ai_bot_model"),
        })

    dashboards = [
        {"id": d.id, "name": d.name}
        for d in db.query(Dashboard).order_by(Dashboard.id.desc()).limit(200).all()
    ]
    return {"public_links": links, "dashboards": dashboards}


# ═══ Preview ═════════════════════════════════════════════════════════════════
class PreviewBody(BaseModel):
    flow_key: str
    version: int
    token: str
    question: str


@router.post("/preview")
async def preview_flow(body: PreviewBody, db: Session = Depends(get_db),
                       user: User = Depends(get_current_user)):
    """Run a DRAFT flow once against a real report, streaming the same events
    the viewer would see plus the node trace.

    This is the step that makes the Studio usable by a non-engineer: you see the
    flow work (or fail, and where) before anyone else does. It costs real
    provider tokens, so it is one question, run by an identified user, recorded
    with mode='preview' so it never pollutes production metrics.
    """
    import json as _json

    from fastapi.responses import StreamingResponse

    from app.api.public import _build_public_chart_filters, _get_dashboard_by_token
    from app.services.dashboard_ai_bot.public_link_config import (
        resolve_public_ai_credentials,
        web_search_enabled,
    )
    from app.services.dashboard_ai_bot.tool_context import ToolContext
    from app.services.intelligence.registry.validator import parse_and_validate
    from app.services.intelligence.runtime import run_preview

    flow = _run(lambda: reg.get_flow(db, body.flow_key, body.version))
    graph, errors = parse_and_validate(
        flow.get("graph") or {},
        known_agents=reg.published_agent_refs(db),
        known_tools=tools_catalog.tool_names(),
        known_handlers=tools_catalog.handler_names(),
    )
    if graph is None or errors:
        raise HTTPException(
            status_code=400,
            detail=f"Luồng chưa hợp lệ: {', '.join(e.code for e in errors[:4])}",
        )

    dash, public_filters, _z, appearance = _get_dashboard_by_token(
        body.token, db, session_token=None, track_access=False,
    )
    if not (appearance or {}).get("ai_bot_enabled"):
        raise HTTPException(status_code=400, detail="Link này chưa bật trợ lý AI.")

    key, provider, model = resolve_public_ai_credentials(
        appearance, x_user_ai_key=None, x_user_ai_provider=None, x_user_ai_model=None,
        missing_key_detail="Link này chưa cấu hình khoá AI — không chạy thử được.",
    )
    merged = _build_public_chart_filters(
        dash, public_filters, [], context_for_log=f"ai_preview:{body.token}",
    )
    ctx = ToolContext.from_dashboard(
        db=db, dashboard=dash, public_filters=merged,
        actor_type="user", actor_ref=_actor(user),
    )

    agent_kwargs = {
        "mode": "auto",
        "ctx": ctx,
        "user_messages": [{"role": "user", "content": body.question}],
        "api_key": key,
        "provider": provider,
        "model": model,
        "enable_critique": False,
        "web_search_enabled": web_search_enabled(appearance),
        "report_context_note": "",
        "learned_knowledge_block": "",
    }

    async def _stream():
        async for ev in run_preview(
            graph=graph,
            flow_key=body.flow_key,
            flow_version=body.version,
            dashboard_id=dash.id,
            link_token=body.token,
            question=body.question,
            agent_kwargs=agent_kwargs,
            actor_ref=_actor(user),
        ):
            payload = {"type": ev.type, "text": ev.text, **(ev.extra or {})}
            if ev.tool_name:
                payload["tool"] = ev.tool_name
            yield f"data: {_json.dumps(payload, ensure_ascii=False, default=str)}\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ═══ Runs & trace ════════════════════════════════════════════════════════════
@router.get("/runs")
def list_runs(limit: int = Query(50, ge=1, le=200),
              flow_key: str | None = None,
              db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"runs": reg.list_runs(db, limit=limit, flow_key=flow_key)}


@router.get("/runs/{run_id}/trace")
def get_trace(run_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    return _run(lambda: reg.get_trace(db, run_id))


@router.get("/flow-stats")
def flow_stats(flow_keys: str = Query(..., description="comma-separated flow keys"),
               days: int = Query(7, ge=1, le=90),
               db: Session = Depends(get_db)) -> dict[str, Any]:
    """Aggregates per flow over real traffic — the evidence behind a canary.

    Splitting traffic is worthless without a comparison, and eyeballing a
    50-row run list is not one. `ai_runs` already records flow_key per turn, so
    the arms of a canary are directly comparable with no extra bookkeeping.
    """
    keys = [k.strip() for k in flow_keys.split(",") if k.strip()][:10]
    return {"days": days, "stats": reg.flow_run_stats(db, keys, days=days)}


# ═══ Model policies ══════════════════════════════════════════════════════════
class PolicyPatch(BaseModel):
    model: str | None = None
    enabled: bool | None = None


@router.get("/model-policies")
def list_policies(db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"policies": reg.list_model_policies(db)}


@router.patch("/model-policies/{policy_id}")
def patch_policy(policy_id: int, body: PolicyPatch, db: Session = Depends(get_db),
                 _: User = Depends(require_full)) -> dict[str, Any]:
    return _run(lambda: reg.update_model_policy(
        db, policy_id, body.model_dump(exclude_none=True),
    ))
