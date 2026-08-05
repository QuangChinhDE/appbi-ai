"""API: /api/v1/agent-flows/*  — brains as a first-class, shareable resource.

Its own router with its own permission key, not a sub-path of the catalog. A brain
is not a knowledge document: publishing one changes what a live report says to
viewers, so it must not ride on a knowledge-authoring grant.

The layer is deliberately thin. Every rule lives below it — the shape in
`contract`, the delegation in `permissions`, versioning in `registry` — so an
endpoint here is a permission check, a call, and a response. When a rule appears in
this file, it has been written in the wrong place.
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
from app.services.agent_flows import permissions as perms
from app.services.agent_flows import registry as reg
from app.services.agent_flows.models_catalogue import catalogue as model_catalogue
from app.services.agent_flows.tools.registry import catalogue as tool_catalogue

logger = logging.getLogger("app.agent_flows")

router = APIRouter(prefix="/agent-flows", tags=["agent-flows"])

can_view = require_permission("agent_flows", "view")
can_edit = require_permission("agent_flows", "edit")
#: Publishing changes AI behaviour on a live, published report — the same blast
#: radius as a deploy, so it needs the top level rather than `edit`.
can_publish = require_permission("agent_flows", "full")


def _actor(user: User) -> str:
    return getattr(user, "email", None) or str(getattr(user, "id", "unknown"))


def _run(fn):
    try:
        return fn()
    except reg.BrainError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)


# ═══ What a step can be built from ═══════════════════════════════════════════
@router.get("/tools")
def list_tools(
    web_enabled: bool = False,
    _: User = Depends(can_view),
) -> dict[str, Any]:
    """The tool picker, grouped by pack.

    Withheld packs come back flagged rather than omitted: an author who cannot find
    web search should learn the deployment has it off, not conclude it never existed.
    """
    return {"packs": tool_catalogue(web_enabled=web_enabled)}


@router.get("/models")
def list_models(_: User = Depends(can_view)) -> dict[str, Any]:
    """Providers and models a step may name. `inherit` is a first-class choice."""
    return {"providers": model_catalogue()}


@router.get("/attachable")
def list_attachable(
    db: Session = Depends(get_db),
    user: User = Depends(can_view),
) -> dict[str, Any]:
    """What THIS user may point a step at.

    Server-side, and the only source the picker uses. The list never contains what
    they may not attach, so the UI is not the thing enforcing the rule.

    All THREE knowledge kinds the contract accepts are listed, metrics included.
    They were missing, so the builder had no choice but to offer a free-text box for
    a metric ref — and a metric ref is matched at run time against
    `govern_metrics.name` / `.display_name`, which means a typo produced a step that
    silently consulted nothing. A ref you can only pick is a ref that cannot be
    mistyped.
    """
    from app.models.dataset import Dataset
    from app.models.governance import GovernKnowledgeDoc, GovernMetric

    doc_ids = perms.attachable_documents(db, user)
    ds_ids = perms.attachable_datasets(db, user)
    docs = (
        db.query(GovernKnowledgeDoc.id, GovernKnowledgeDoc.title)
        .filter(GovernKnowledgeDoc.id.in_(doc_ids or [-1]))
        .all()
    )
    datasets = (
        db.query(Dataset.id, Dataset.name).filter(Dataset.id.in_(ds_ids or [-1])).all()
    )
    # Metrics carry no separate grant — they are readable by anyone who may read the
    # report — so this is the governed catalogue minus what nobody should newly
    # attach. A deprecated definition is still honoured if a stored brain names it;
    # it simply is not offered for a new attachment.
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


# ═══ Brains ══════════════════════════════════════════════════════════════════
class BrainWrite(BaseModel):
    brain_key: str
    name: str
    description: str = ""
    #: The `Brain` contract minus key/name, which come from the fields above so
    #: there is one place each is set.
    body: dict = Field(default_factory=dict)


@router.get("/brains")
def brains(db: Session = Depends(get_db), user: User = Depends(can_view)) -> dict[str, Any]:
    return {"brains": reg.list_brains(db, user)}


# NOTE ON ORDER: the literal segments below must be declared BEFORE
# `/brains/{brain_key}`, or Starlette matches `/brains/impact` as a brain named
# "impact" and answers 404 forever. It matches in registration order and does not
# fall through on a validation failure.
@router.get("/brains/{brain_key}/impact")
def brain_impact(
    brain_key: str,
    db: Session = Depends(get_db),
    _: User = Depends(can_view),
) -> dict[str, Any]:
    """Which live links this brain is the head of. Read before Publish, because one
    edit changes every link pointing here."""
    return reg.impact(db, brain_key)


@router.get("/brains/{brain_key}/versions")
def brain_versions(
    brain_key: str,
    db: Session = Depends(get_db),
    _: User = Depends(can_view),
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
                "version": r.version, "status": r.status,
                "created_by": r.created_by,
                "published_at": r.published_at.isoformat() if r.published_at else None,
            }
            for r in rows
        ]
    }


@router.get("/brains/{brain_key}")
def brain_detail(
    brain_key: str,
    version: int | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(can_view),
) -> dict[str, Any]:
    return _run(lambda: reg.get_brain(db, brain_key, version))


@router.put("/brains")
def save_brain(
    body: BrainWrite,
    db: Session = Depends(get_db),
    user: User = Depends(can_edit),
) -> dict[str, Any]:
    """Write a new DRAFT. Never changes what is currently answering viewers."""
    return _run(lambda: reg.save_draft(
        db, user,
        brain_key=body.brain_key, name=body.name,
        description=body.description, body=body.body,
        actor_email=_actor(user),
    ))


@router.post("/brains/{brain_key}/{version}/publish")
def publish_brain(
    brain_key: str,
    version: int,
    db: Session = Depends(get_db),
    user: User = Depends(can_publish),
) -> dict[str, Any]:
    return _run(lambda: reg.publish(db, brain_key, version, _actor(user)))


@router.post("/brains/{brain_key}/rollback")
def rollback_brain(
    brain_key: str,
    db: Session = Depends(get_db),
    user: User = Depends(can_publish),
) -> dict[str, Any]:
    return _run(lambda: reg.rollback(db, brain_key, _actor(user)))


@router.delete("/brains/{brain_key}/{version}")
def delete_brain_version(
    brain_key: str,
    version: int,
    db: Session = Depends(get_db),
    _: User = Depends(can_edit),
) -> dict[str, str]:
    _run(lambda: reg.delete_version(db, brain_key, version))
    return {"status": "deleted"}
