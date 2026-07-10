"""
Observability API — the dataset-health module surface beyond Data Quality.

Monitors (freshness/volume/schema) run automatically via the daily scan and the
manual /scan endpoint; there is no monitor-CRUD surface — checks are configured
as Quality rules and their breaches fold into the unified incident feed.

Endpoints (all dataset-access scoped):
  GET    /observability/overview                cross-dataset health scorecard
  GET    /observability/incidents               unified incident feed
  PATCH  /observability/incidents/{id}          lifecycle: acknowledge|resolve|reopen
  GET    /observability/semantic-lineage        column/measure impact graph
  GET    /observability/usage                   usage + resource footprint
  POST   /observability/scan                    manual full scan (monitors + fold)
  GET/POST/PATCH/DELETE /observability/alert-channels   email|slack|webhook dispatch
"""
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core import get_db
from app.core.dependencies import get_current_user, require_permission
from app.core.permissions import _owned_or_shared
from app.models.resource_share import ResourceType
from app.models.dataset import Dataset, DatasetTable
from app.models.user import User
from app.models.observability import (
    ObservabilityIncident,
    ObservabilityAlertChannel, ALERT_CHANNEL_KINDS,
)
from app.services.observability_service import ObservabilityService

router = APIRouter(prefix="/observability", tags=["observability"])


# ── access scoping ────────────────────────────────────────────────────────────

def _accessible_dataset_ids(db: Session, user: User) -> List[int]:
    return [d.id for d in _owned_or_shared(db, Dataset, ResourceType.DATASET, user).all()]


def _require_dataset_access(db: Session, user: User, dataset_id: int) -> None:
    if dataset_id not in _accessible_dataset_ids(db, user):
        raise HTTPException(status_code=404, detail="Dataset not found or no access")


# ── schemas ─────────────────────────────────────────────────────────────────

class IncidentUpdate(BaseModel):
    action: str                    # acknowledge | resolve | reopen


# ── overview ──────────────────────────────────────────────────────────────────

@router.get("/overview")
def overview(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return ObservabilityService.get_overview(db, _accessible_dataset_ids(db, user))


# ── incidents ─────────────────────────────────────────────────────────────────

@router.get("/incidents")
def list_incidents(
    status: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    pillar: Optional[str] = Query(None),
    dataset_id: Optional[int] = Query(None),
    limit: int = 200,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    ids = _accessible_dataset_ids(db, user)
    if not ids:
        return []
    q = db.query(ObservabilityIncident).filter(ObservabilityIncident.dataset_id.in_(ids))
    if status == "open":          # "open" means not resolved (open + acknowledged)
        q = q.filter(ObservabilityIncident.status != "resolved")
    elif status:
        q = q.filter(ObservabilityIncident.status == status)
    if severity:
        q = q.filter(ObservabilityIncident.severity == severity)
    if pillar:
        q = q.filter(ObservabilityIncident.pillar == pillar)
    if dataset_id is not None:
        q = q.filter(ObservabilityIncident.dataset_id == dataset_id)
    rows = q.order_by(ObservabilityIncident.last_seen_at.desc()).limit(min(limit, 500)).all()
    ds_names = {d.id: d.name for d in db.query(Dataset).filter(
        Dataset.id.in_({r.dataset_id for r in rows})).all()}
    return [ObservabilityService.incident_dict(i, ds_names.get(i.dataset_id)) for i in rows]


@router.patch("/incidents/{incident_id}")
def update_incident(
    incident_id: int, payload: IncidentUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    inc = db.query(ObservabilityIncident).filter(ObservabilityIncident.id == incident_id).first()
    if not inc:
        raise HTTPException(status_code=404, detail="Incident not found")
    _require_dataset_access(db, user, inc.dataset_id)
    now = datetime.utcnow()
    if payload.action == "acknowledge":
        inc.status = "acknowledged"
        inc.acknowledged_at = now
        inc.owner_id = user.id
    elif payload.action == "resolve":
        inc.status = "resolved"
        inc.resolved_at = now
    elif payload.action == "reopen":
        inc.status = "open"
        inc.resolved_at = None
    else:
        raise HTTPException(status_code=422, detail="action must be acknowledge|resolve|reopen")
    db.commit()
    db.refresh(inc)
    ds = db.query(Dataset).filter(Dataset.id == inc.dataset_id).first()
    return ObservabilityService.incident_dict(inc, ds.name if ds else None)


# ── lineage + usage ───────────────────────────────────────────────────────────

@router.get("/semantic-lineage")
def semantic_lineage(
    dataset_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Column- + measure-level lineage from the semantic model (joins, measure
    deps, rule/incident coverage per column) for impact analysis."""
    _require_dataset_access(db, user, dataset_id)
    return ObservabilityService.build_semantic_lineage(db, dataset_id)


@router.get("/usage")
def usage(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    return ObservabilityService.get_usage(db, _accessible_dataset_ids(db, user))


# ── manual scan ───────────────────────────────────────────────────────────────

@router.post("/scan")
def scan(
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("datasets", "edit")),
) -> Dict[str, Any]:
    return ObservabilityService.scan_all(db)


# ── alert channels (P2 dispatch) ──────────────────────────────────────────────

class AlertChannelCreate(BaseModel):
    kind: str                       # email | slack | webhook
    name: str
    target: str
    min_severity: str = "warning"
    dataset_id: Optional[int] = None


class AlertChannelUpdate(BaseModel):
    name: Optional[str] = None
    target: Optional[str] = None
    min_severity: Optional[str] = None
    is_active: Optional[bool] = None


def _channel_dict(c: ObservabilityAlertChannel) -> Dict[str, Any]:
    return {
        "id": c.id, "kind": c.kind, "name": c.name, "target": c.target,
        "minSeverity": c.min_severity, "isActive": c.is_active, "datasetId": c.dataset_id,
        "lastSentAt": c.last_sent_at.isoformat() if c.last_sent_at else None,
        "lastError": c.last_error,
    }


@router.get("/alert-channels")
def list_alert_channels(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    ids = set(_accessible_dataset_ids(db, user))
    rows = db.query(ObservabilityAlertChannel).order_by(ObservabilityAlertChannel.id.desc()).all()
    # global channels (dataset_id=None) + channels scoped to an accessible dataset
    return [_channel_dict(c) for c in rows if c.dataset_id is None or c.dataset_id in ids]


@router.post("/alert-channels", status_code=201)
def create_alert_channel(
    payload: AlertChannelCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("datasets", "edit")),
) -> Dict[str, Any]:
    if payload.kind not in ALERT_CHANNEL_KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {ALERT_CHANNEL_KINDS}")
    if payload.dataset_id is not None:
        _require_dataset_access(db, user, payload.dataset_id)
    ch = ObservabilityAlertChannel(
        kind=payload.kind, name=payload.name, target=payload.target,
        min_severity=payload.min_severity, dataset_id=payload.dataset_id, owner_id=user.id,
    )
    db.add(ch)
    db.commit()
    db.refresh(ch)
    return _channel_dict(ch)


@router.patch("/alert-channels/{channel_id}")
def update_alert_channel(
    channel_id: int, payload: AlertChannelUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("datasets", "edit")),
) -> Dict[str, Any]:
    ch = db.query(ObservabilityAlertChannel).filter(ObservabilityAlertChannel.id == channel_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    if ch.dataset_id is not None:
        _require_dataset_access(db, user, ch.dataset_id)
    if payload.name is not None:
        ch.name = payload.name
    if payload.target is not None:
        ch.target = payload.target
    if payload.min_severity is not None:
        ch.min_severity = payload.min_severity
    if payload.is_active is not None:
        ch.is_active = payload.is_active
    db.commit()
    db.refresh(ch)
    return _channel_dict(ch)


@router.delete("/alert-channels/{channel_id}", status_code=204)
def delete_alert_channel(
    channel_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("datasets", "edit")),
):
    ch = db.query(ObservabilityAlertChannel).filter(ObservabilityAlertChannel.id == channel_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    if ch.dataset_id is not None:
        _require_dataset_access(db, user, ch.dataset_id)
    db.delete(ch)
    db.commit()


@router.post("/alert-channels/{channel_id}/test")
def test_alert_channel(
    channel_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("datasets", "edit")),
) -> Dict[str, Any]:
    ch = db.query(ObservabilityAlertChannel).filter(ObservabilityAlertChannel.id == channel_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    if ch.dataset_id is not None:
        _require_dataset_access(db, user, ch.dataset_id)
    from app.services.observability_notifier import test_channel
    ok, err = test_channel(db, ch)
    return {"ok": ok, "error": err, "channel": _channel_dict(ch)}
