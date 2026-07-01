"""
Observability API — the unified module surface beyond Data Quality.

Endpoints (all dataset-access scoped):
  GET    /observability/overview              cross-dataset 5-pillar scorecard
  GET    /observability/monitors              list freshness/volume/schema monitors
  POST   /observability/monitors              create a monitor
  PATCH  /observability/monitors/{id}         update (config/severity/active)
  DELETE /observability/monitors/{id}         delete
  POST   /observability/monitors/{id}/run     run one monitor now
  GET    /observability/monitors/{id}/checks  snapshot history (sparkline)
  GET    /observability/incidents             unified incident feed
  PATCH  /observability/incidents/{id}        lifecycle: acknowledge|resolve|reopen
  GET    /observability/lineage?dataset_id=   source→table→chart→dashboard graph
  GET    /observability/usage                 usage + resource footprint
  POST   /observability/scan                  manual full scan (monitors + fold)
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
    ObservabilityMonitor, ObservabilityCheck, ObservabilityIncident,
    ObservabilityAlertChannel, MONITOR_KINDS, ALERT_CHANNEL_KINDS,
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

class MonitorCreate(BaseModel):
    dataset_table_id: int
    kind: str                      # freshness | volume | schema
    name: Optional[str] = None
    config: Dict[str, Any] = {}
    severity: str = "warning"


class MonitorUpdate(BaseModel):
    name: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    severity: Optional[str] = None
    is_active: Optional[bool] = None


class IncidentUpdate(BaseModel):
    action: str                    # acknowledge | resolve | reopen


def _monitor_dict(m: ObservabilityMonitor) -> Dict[str, Any]:
    t = m.dataset_table
    return {
        "id": m.id, "datasetId": m.dataset_id, "datasetTableId": m.dataset_table_id,
        "tableName": (t.display_name or t.source_table_name) if t else None,
        "kind": m.kind, "name": m.name, "config": m.config or {}, "severity": m.severity,
        "isActive": m.is_active, "lastStatus": m.last_status, "lastValue": m.last_value,
        "lastDetail": m.last_detail,
        "lastCheckedAt": m.last_checked_at.isoformat() if m.last_checked_at else None,
    }


# ── overview ──────────────────────────────────────────────────────────────────

@router.get("/overview")
def overview(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return ObservabilityService.get_overview(db, _accessible_dataset_ids(db, user))


# ── monitors ────────────────────────────────────────────────────────────────

@router.get("/monitors")
def list_monitors(
    dataset_id: Optional[int] = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    ids = _accessible_dataset_ids(db, user)
    if not ids:
        return []
    q = db.query(ObservabilityMonitor).filter(ObservabilityMonitor.dataset_id.in_(ids))
    if dataset_id is not None:
        q = q.filter(ObservabilityMonitor.dataset_id == dataset_id)
    return [_monitor_dict(m) for m in q.order_by(ObservabilityMonitor.id.desc()).all()]


@router.post("/monitors", status_code=201)
def create_monitor(
    payload: MonitorCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("datasets", "edit")),
) -> Dict[str, Any]:
    if payload.kind not in MONITOR_KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {MONITOR_KINDS}")
    table = db.query(DatasetTable).filter(DatasetTable.id == payload.dataset_table_id).first()
    if not table:
        raise HTTPException(status_code=404, detail="Dataset table not found")
    _require_dataset_access(db, user, table.dataset_id)

    # Sensible defaults per kind if config omitted.
    cfg = dict(payload.config or {})
    if payload.kind == "freshness" and "max_lag_hours" not in cfg:
        cfg["max_lag_hours"] = 24
    if payload.kind == "volume" and "z_threshold" not in cfg:
        cfg["z_threshold"] = 3.0

    name = payload.name or f"{payload.kind.capitalize()} · {table.display_name or table.source_table_name or table.id}"
    monitor = ObservabilityMonitor(
        dataset_id=table.dataset_id, dataset_table_id=table.id, kind=payload.kind,
        name=name, config=cfg, severity=payload.severity, owner_id=user.id,
    )
    db.add(monitor)
    db.commit()
    db.refresh(monitor)
    # First run immediately so the user sees a result (also seeds schema baseline).
    try:
        ObservabilityService.run_monitor(monitor, db)
        db.commit()
        db.refresh(monitor)
    except Exception:
        db.rollback()
    return _monitor_dict(monitor)


@router.patch("/monitors/{monitor_id}")
def update_monitor(
    monitor_id: int, payload: MonitorUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("datasets", "edit")),
) -> Dict[str, Any]:
    monitor = db.query(ObservabilityMonitor).filter(ObservabilityMonitor.id == monitor_id).first()
    if not monitor:
        raise HTTPException(status_code=404, detail="Monitor not found")
    _require_dataset_access(db, user, monitor.dataset_id)
    if payload.name is not None:
        monitor.name = payload.name
    if payload.config is not None:
        monitor.config = payload.config
    if payload.severity is not None:
        monitor.severity = payload.severity
    if payload.is_active is not None:
        monitor.is_active = payload.is_active
    db.commit()
    db.refresh(monitor)
    return _monitor_dict(monitor)


@router.delete("/monitors/{monitor_id}", status_code=204)
def delete_monitor(
    monitor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("datasets", "edit")),
):
    monitor = db.query(ObservabilityMonitor).filter(ObservabilityMonitor.id == monitor_id).first()
    if not monitor:
        raise HTTPException(status_code=404, detail="Monitor not found")
    _require_dataset_access(db, user, monitor.dataset_id)
    # Resolve the monitor's open incidents first so deleting a monitor never
    # leaves orphan incidents that no future scan can auto-resolve.
    ObservabilityService.resolve_incidents(db, f"{monitor.kind}:monitor_{monitor.id}")
    db.delete(monitor)
    db.commit()


@router.post("/monitors/{monitor_id}/run")
def run_monitor_now(
    monitor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("datasets", "edit")),
) -> Dict[str, Any]:
    monitor = db.query(ObservabilityMonitor).filter(ObservabilityMonitor.id == monitor_id).first()
    if not monitor:
        raise HTTPException(status_code=404, detail="Monitor not found")
    _require_dataset_access(db, user, monitor.dataset_id)
    result = ObservabilityService.run_monitor(monitor, db)
    db.commit()
    # A fresh breach on a manual run fires alerts too. Strip the ORM object
    # from the JSON response.
    created = result.pop("created_incident", None)
    if created is not None:
        try:
            from app.services.observability_notifier import notify_new_incidents
            notify_new_incidents(db, [created])
        except Exception:
            pass
    return {"monitor": _monitor_dict(monitor), "result": result}


@router.get("/monitors/{monitor_id}/checks")
def monitor_checks(
    monitor_id: int, limit: int = 60,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    monitor = db.query(ObservabilityMonitor).filter(ObservabilityMonitor.id == monitor_id).first()
    if not monitor:
        raise HTTPException(status_code=404, detail="Monitor not found")
    _require_dataset_access(db, user, monitor.dataset_id)
    checks = (
        db.query(ObservabilityCheck)
        .filter(ObservabilityCheck.monitor_id == monitor_id)
        .order_by(ObservabilityCheck.checked_at.desc())
        .limit(min(limit, 200)).all()
    )
    return [
        {"checkedAt": c.checked_at.isoformat() if c.checked_at else None,
         "value": c.value, "status": c.status}
        for c in reversed(checks)
    ]


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

@router.get("/lineage")
def lineage(
    dataset_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    _require_dataset_access(db, user, dataset_id)
    return ObservabilityService.build_lineage(db, dataset_id)


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
