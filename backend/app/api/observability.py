"""
Observability API — the dataset-health module surface beyond Data Quality.

Endpoints (all dataset-access scoped):
  GET    /observability/overview                       cross-dataset scorecard + needs-attention
  GET    /observability/status                         scanner / delivery health (is monitoring itself OK?)
  GET    /observability/me                             what the caller may do module-wide
  GET    /observability/incidents                      paginated unified incident feed
  GET    /observability/incidents/{id}                 one incident (deep link)
  PATCH  /observability/incidents/{id}                 acknowledge | resolve | reopen | accept_baseline
  GET    /observability/datasets/{id}/monitors         freshness / volume / schema monitors + setup options
  PUT    /observability/datasets/{id}/monitors         create / update one monitor
  DELETE /observability/monitors/{id}                  remove a monitor
  POST   /observability/datasets/{id}/scan             run one dataset's checks now
  POST   /observability/scan                           tenant-wide scan (admin)
  GET    /observability/semantic-lineage               column/measure impact graph
  GET    /observability/usage                          per-dataset health + footprint
  GET/POST/PATCH/DELETE /observability/alert-channels  email|slack|webhook dispatch

Authority (one table, enforced here - the UI only mirrors it through the
``capabilities`` each payload carries):
  read anything            observability:view + dataset view
  change an incident /     observability:edit + dataset EDIT (a view share
  monitors / dataset scan  can look, not act)
  global scan / channels   observability:full (module administrator)
"""
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.services.audit_service import audit
from app.models.audit_log import AuditAction
from app.core import get_db
from app.core.dependencies import (
    get_current_user,
    get_effective_permission,
    require_edit_access,
    require_permission,
)
from app.core.permissions import _owned_or_shared, module_at_least
from app.models.resource_share import ResourceType
from app.models.dataset import Dataset
from app.models.user import User
from app.models.observability import (
    ObservabilityIncident, ObservabilityMonitor, ObservabilityScanRun,
    ObservabilityAlertChannel, ALERT_CHANNEL_KINDS,
)
from app.services.observability_service import ObservabilityService

# ── Module floor for the ENTIRE router ────────────────────────────────────────
# Reads → observability:view, writes → observability:edit, one gate for the
# whole router so no endpoint can drift. The per-dataset checks below still
# apply; the two layers answer different questions.
_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_OBS_VIEW = require_permission("observability", "view")
_OBS_EDIT = require_permission("observability", "edit")


async def observability_module_gate(
    request: Request, user: User = Depends(get_current_user)
) -> User:
    checker = _OBS_VIEW if request.method in _READ_METHODS else _OBS_EDIT
    return await checker(user=user)


router = APIRouter(
    prefix="/observability",
    tags=["observability"],
    dependencies=[Depends(observability_module_gate)],
)


# ── access scoping ────────────────────────────────────────────────────────────

def _accessible_dataset_ids(db: Session, user: User) -> List[int]:
    return [d.id for d in _owned_or_shared(db, Dataset, ResourceType.DATASET, user).all()]


def _require_dataset_access(db: Session, user: User, dataset_id: int) -> Dataset:
    if dataset_id not in _accessible_dataset_ids(db, user):
        raise HTTPException(status_code=404, detail="Dataset not found or no access")
    return db.query(Dataset).filter(Dataset.id == dataset_id).first()


def _can_edit_dataset(db: Session, user: User, ds: Optional[Dataset]) -> bool:
    if ds is None or not module_at_least(user, "observability", "edit"):
        return False
    return get_effective_permission(db, user, ds, "datasets") in ("edit", "full")


def _require_dataset_edit(db: Session, user: User, dataset_id: int) -> Dataset:
    ds = _require_dataset_access(db, user, dataset_id)
    if not _can_edit_dataset(db, user, ds):
        raise HTTPException(status_code=403, detail="Changing this dataset's monitoring needs edit access to the dataset.")
    return ds


def _is_obs_admin(user: User) -> bool:
    """The Observability module administrator (module level `full`). Global
    concepts - the tenant-wide scan, global alert channels - are theirs."""
    from app.core.permissions import is_module_admin

    return is_module_admin(user, "observability")


def _editable_dataset_ids(db: Session, user: User, ids) -> set:
    if not module_at_least(user, "observability", "edit"):
        return set()
    out = set()
    for ds in db.query(Dataset).filter(Dataset.id.in_(list(ids))).all() if ids else []:
        if get_effective_permission(db, user, ds, "datasets") in ("edit", "full"):
            out.add(ds.id)
    return out


# ── schemas ─────────────────────────────────────────────────────────────────

INCIDENT_ACTIONS = ("acknowledge", "resolve", "reopen", "accept_baseline")


class IncidentUpdate(BaseModel):
    action: str


class MonitorSave(BaseModel):
    table_id: int
    kind: str
    config: Dict[str, Any] = {}
    severity: str = "warning"
    is_active: bool = True


# ── module-level capabilities ────────────────────────────────────────────────

@router.get("/me")
def my_capabilities(user: User = Depends(get_current_user)) -> Dict[str, Any]:
    admin = _is_obs_admin(user)
    return {"admin": admin, "canScanAll": admin, "canManageGlobalChannels": admin,
            "canEdit": module_at_least(user, "observability", "edit")}


# ── overview + status ─────────────────────────────────────────────────────────

@router.get("/overview")
def overview(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    ids = _accessible_dataset_ids(db, user)
    out = ObservabilityService.get_overview(db, ids)
    editable = _editable_dataset_ids(db, user, {i["datasetId"] for i in out.get("recentIncidents", [])})
    for i in out.get("recentIncidents", []):
        i["capabilities"] = {"act": i["datasetId"] in editable}
    return out


@router.get("/status")
def scanner_status(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Is the monitoring itself working? The last scans, whether the last good
    one is too old, and the alert delivery backlog."""
    from datetime import timedelta
    from app.services.observability_notifier import delivery_health

    def run_dict(r: Optional[ObservabilityScanRun]):
        if r is None:
            return None
        return {"id": r.id, "scope": r.scope, "datasetId": r.dataset_id, "trigger": r.trigger,
                "status": r.status, "startedAt": ObservabilityService._utc_iso(r.started_at),
                "finishedAt": ObservabilityService._utc_iso(r.finished_at),
                "counts": r.counts or {}, "errors": (r.errors or [])[:10] if _is_obs_admin(user) else
                (["Some checks could not run."] if r.errors else [])}

    last = (db.query(ObservabilityScanRun).filter(ObservabilityScanRun.scope == "global")
            .order_by(ObservabilityScanRun.id.desc()).first())
    last_ok = (db.query(ObservabilityScanRun).filter(ObservabilityScanRun.scope == "global")
               .filter(ObservabilityScanRun.status.in_(("succeeded", "partial")))
               .order_by(ObservabilityScanRun.id.desc()).first())
    stale_after = timedelta(hours=26)
    running = last is not None and last.status == "running"
    stale = last_ok is None or (datetime.utcnow() - (last_ok.finished_at or last_ok.started_at)) > stale_after
    try:
        from app.services.anomaly_scheduler import next_run_time
        nxt = next_run_time()
    except Exception:  # noqa: BLE001
        nxt = None
    return {
        "lastScan": run_dict(last), "lastSuccessfulScan": run_dict(last_ok),
        "running": running, "stale": stale, "staleAfterHours": 26,
        "nextScheduledScan": ObservabilityService._utc_iso(nxt) if nxt else None,
        "deliveries": delivery_health(db),
    }


# ── incidents ─────────────────────────────────────────────────────────────────

def _incident_out(db: Session, user: User, rows: List[ObservabilityIncident]) -> List[Dict[str, Any]]:
    ds_ids = {r.dataset_id for r in rows}
    names = {d.id: d.name for d in db.query(Dataset).filter(Dataset.id.in_(ds_ids)).all()} if ds_ids else {}
    editable = _editable_dataset_ids(db, user, ds_ids)
    out = []
    for i in rows:
        d = ObservabilityService.incident_dict(i, names.get(i.dataset_id))
        act = i.dataset_id in editable
        d["capabilities"] = {
            "act": act,
            "acceptBaseline": act and i.source in ("schema", "volume") and i.status != "resolved",
        }
        out.append(d)
    return out


@router.get("/incidents")
def list_incidents(
    status: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    pillar: Optional[str] = Query(None),
    dataset_id: Optional[int] = Query(None),
    q: Optional[str] = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """{items, total, limit, offset} - every matching incident is reachable by
    paging; ``total`` counts the same filter the items come from."""
    ids = _accessible_dataset_ids(db, user)
    if not ids or (dataset_id is not None and dataset_id not in ids):
        return {"items": [], "total": 0, "limit": limit, "offset": offset}
    qry = db.query(ObservabilityIncident).filter(ObservabilityIncident.dataset_id.in_(ids))
    if status == "open":          # "open" means not resolved (open + acknowledged)
        qry = qry.filter(ObservabilityIncident.status != "resolved")
    elif status:
        qry = qry.filter(ObservabilityIncident.status == status)
    if severity:
        qry = qry.filter(ObservabilityIncident.severity == severity)
    if pillar:
        qry = qry.filter(ObservabilityIncident.pillar == pillar)
    if dataset_id is not None:
        qry = qry.filter(ObservabilityIncident.dataset_id == dataset_id)
    if q and q.strip():
        like = f"%{q.strip().replace('%', '').replace('_', '')}%"
        ds_match = [d for (d,) in db.query(Dataset.id).filter(Dataset.id.in_(ids), Dataset.name.ilike(like)).all()]
        qry = qry.filter(or_(ObservabilityIncident.title.ilike(like),
                             ObservabilityIncident.dataset_id.in_(ds_match or [-1])))
    total = qry.count()
    from sqlalchemy import case

    sev_order = case({"critical": 3, "warning": 2, "info": 1}, value=ObservabilityIncident.severity, else_=0)
    unresolved_first = case((ObservabilityIncident.status == "resolved", 0), else_=1)
    rows = (qry.order_by(unresolved_first.desc(), sev_order.desc(),
                         ObservabilityIncident.last_seen_at.desc(), ObservabilityIncident.id.desc())
            .offset(offset).limit(limit).all())
    return {"items": _incident_out(db, user, rows), "total": total, "limit": limit, "offset": offset}


def _load_incident(db: Session, user: User, incident_id: int) -> ObservabilityIncident:
    inc = db.query(ObservabilityIncident).filter(ObservabilityIncident.id == incident_id).first()
    # One answer for "missing" and "not yours": an id is not an oracle.
    if not inc or inc.dataset_id not in _accessible_dataset_ids(db, user):
        raise HTTPException(status_code=404, detail="Incident not found")
    return inc


@router.get("/incidents/{incident_id}")
def get_incident(incident_id: int, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return _incident_out(db, user, [_load_incident(db, user, incident_id)])[0]


@router.patch("/incidents/{incident_id}")
def update_incident(
    incident_id: int, payload: IncidentUpdate, request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    if payload.action not in INCIDENT_ACTIONS:
        raise HTTPException(status_code=422, detail=f"action must be one of {INCIDENT_ACTIONS}")
    inc = _load_incident(db, user, incident_id)
    _require_dataset_edit(db, user, inc.dataset_id)
    now = datetime.utcnow()
    action = payload.action
    if action == "acknowledge":
        if inc.status != "open":
            raise HTTPException(status_code=409, detail="Only an open incident can be acknowledged.")
        inc.status, inc.acknowledged_at, inc.owner_id = "acknowledged", now, user.id
    elif action == "resolve":
        if inc.status == "resolved":
            raise HTTPException(status_code=409, detail="The incident is already resolved.")
        # "Fixed". It never changes what is monitored: a schema / volume change
        # still there is raised again by the next scan.
        inc.status, inc.resolved_at = "resolved", now
    elif action == "accept_baseline":
        if inc.status == "resolved" or inc.source not in ("schema", "volume"):
            raise HTTPException(status_code=409, detail="Only an unresolved schema or volume incident has a baseline to accept.")
        ok = (ObservabilityService.accept_schema_baseline(db, inc) if inc.source == "schema"
              else ObservabilityService.accept_volume_baseline(db, inc))
        if not ok:
            raise HTTPException(status_code=409, detail="The current state could not be read, so nothing was accepted. Run the checks and try again.")
        inc.status, inc.resolved_at = "resolved", now
    elif action == "reopen":
        if inc.status != "resolved":
            raise HTTPException(status_code=409, detail="Only a resolved incident can be reopened.")
        other = (db.query(ObservabilityIncident.id).filter(ObservabilityIncident.dedup_key == inc.dedup_key)
                 .filter(ObservabilityIncident.status != "resolved").first())
        if other is not None:
            raise HTTPException(status_code=409, detail=f"A newer incident #{other[0]} is already open for this check.")
        inc.status, inc.resolved_at = "open", None
    ObservabilityService.record_action(inc, action, user.id)
    db.commit()
    db.refresh(inc)
    audit(db, AuditAction.OBSERVABILITY_BASELINE_ACCEPTED if action == "accept_baseline"
          else AuditAction.OBSERVABILITY_INCIDENT_ACTION,
          request=request, user_id=user.id, resource_type="observability_incident", resource_id=str(inc.id),
          details={"action": action, "dataset_id": inc.dataset_id, "source": inc.source})
    if action in ("acknowledge", "resolve", "accept_baseline") and inc.dedup_key:
        # Handling it here means the bell shouldn't keep nagging about it.
        from app.models.user_notification import UserNotification
        db.query(UserNotification).filter(
            UserNotification.dedup_key == inc.dedup_key,
            UserNotification.read == False,  # noqa: E712
        ).update({"read": True})
        db.commit()
    return _incident_out(db, user, [inc])[0]


# ── monitors ──────────────────────────────────────────────────────────────────

@router.get("/datasets/{dataset_id}/monitors")
def list_monitors(dataset_id: int, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)) -> Dict[str, Any]:
    ds = _require_dataset_access(db, user, dataset_id)
    out = ObservabilityService.list_monitors(db, dataset_id)
    out["capabilities"] = {"configure": _can_edit_dataset(db, user, ds), "scan": _can_edit_dataset(db, user, ds)}
    return out


@router.put("/datasets/{dataset_id}/monitors")
def save_monitor(dataset_id: int, payload: MonitorSave, request: Request,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    _require_dataset_edit(db, user, dataset_id)
    try:
        m = ObservabilityService.save_monitor(db, dataset_id, payload.model_dump(), user.id)
    except ObservabilityService.MonitorConfigError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    db.commit()
    db.refresh(m)
    audit(db, AuditAction.OBSERVABILITY_MONITOR_CHANGED, request=request, user_id=user.id,
          resource_type="observability_monitor", resource_id=str(m.id),
          details={"dataset_id": dataset_id, "kind": m.kind, "active": m.is_active})
    return ObservabilityService.monitor_dict(m)


@router.delete("/monitors/{monitor_id}", status_code=204)
def delete_monitor(monitor_id: int, request: Request, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)) -> Response:
    m = db.query(ObservabilityMonitor).filter(ObservabilityMonitor.id == monitor_id).first()
    if m is None or m.dataset_id not in _accessible_dataset_ids(db, user):
        raise HTTPException(status_code=404, detail="Monitor not found")
    _require_dataset_edit(db, user, m.dataset_id)
    details = {"dataset_id": m.dataset_id, "kind": m.kind, "deleted": True}
    ObservabilityService.delete_monitor(db, m)
    db.commit()
    audit(db, AuditAction.OBSERVABILITY_MONITOR_CHANGED, request=request, user_id=user.id,
          resource_type="observability_monitor", resource_id=str(monitor_id), details=details)
    return Response(status_code=204)


# ── scans ─────────────────────────────────────────────────────────────────────

def _run(fn, *args, **kw) -> Dict[str, Any]:
    try:
        return fn(*args, **kw)
    except ObservabilityService.ScanBusy as exc:
        raise HTTPException(status_code=409, detail="A scan is already running. Try again when it finishes.") from exc
    except ObservabilityService.ScanFailed as exc:
        raise HTTPException(status_code=500, detail={"message": str(exc), "run_id": exc.run_id}) from exc


@router.post("/datasets/{dataset_id}/scan")
def scan_dataset(dataset_id: int, request: Request, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """This dataset's checks, now - for whoever can edit the dataset. Bounded to
    the dataset's own monitors and folds; alerts go only to channels that
    already match its incidents."""
    _require_dataset_edit(db, user, dataset_id)
    audit(db, AuditAction.OBSERVABILITY_DATASET_SCAN, request=request, user_id=user.id,
          resource_type="dataset", resource_id=str(dataset_id))
    return _run(ObservabilityService.run_scan, db, dataset_id=dataset_id, trigger="manual", user_id=user.id)


@router.post("/scan")
def scan(request: Request, db: Session = Depends(get_db),
         user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Run EVERY monitor on EVERY dataset, fold incidents tenant-wide and notify
    every channel: Observability administrators only."""
    if not _is_obs_admin(user):
        raise HTTPException(status_code=403, detail="A tenant-wide scan is an Observability administrator action.")
    audit(db, AuditAction.OBSERVABILITY_GLOBAL_SCAN, request=request, user_id=user.id,
          resource_type="observability", resource_id="global")
    # Who ran it is in the audit row above.
    return _run(ObservabilityService.scan_all, db)


# ── lineage + usage ───────────────────────────────────────────────────────────

@router.get("/semantic-lineage")
def semantic_lineage(dataset_id: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Column- + measure-level lineage. Charts / dashboards the caller cannot
    open are counted but not named."""
    _require_dataset_access(db, user, dataset_id)
    return ObservabilityService.build_semantic_lineage(db, dataset_id, user)


@router.get("/usage")
def usage(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    rows = ObservabilityService.get_usage(db, _accessible_dataset_ids(db, user))
    editable = _editable_dataset_ids(db, user, {r["datasetId"] for r in rows})
    for r in rows:
        r["capabilities"] = {"configure": r["datasetId"] in editable}
    return rows


# ── alert channels ────────────────────────────────────────────────────────────

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


def _mask_target(kind: str, target: str | None) -> str:
    """A display form of a channel target that is not the secret itself.

    A webhook / Slack URL IS the credential — anyone holding it can post into the
    channel. Emails are shown domain-only for the same reason a directory is not
    handed out for free.
    """
    raw = (target or "").strip()
    if not raw:
        return ""
    if kind == "email":
        _, _, domain = raw.partition("@")
        return f"•••@{domain}" if domain else "•••"
    without_scheme = raw.split("://", 1)[-1]
    host = without_scheme.split("/", 1)[0]
    return f"{host}/•••" if host else "•••"


def _channel_dict(
    c: ObservabilityAlertChannel, *, reveal_target: bool = False, can_manage: bool = False,
    deliveries: Optional[Dict[str, int]] = None, dataset_name: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "id": c.id, "kind": c.kind, "name": c.name,
        "scope": c.scope or ("global" if c.dataset_id is None else "dataset"),
        "target": c.target if reveal_target else _mask_target(c.kind, c.target),
        "targetMasked": not reveal_target,
        "minSeverity": c.min_severity, "isActive": c.is_active, "datasetId": c.dataset_id,
        "dataset": dataset_name,
        "lastSentAt": ObservabilityService._utc_iso(c.last_sent_at),
        "lastError": c.last_error,
        "deliveries": deliveries or {"pending": 0, "failed": 0, "dead": 0},
        "capabilities": {"manage": can_manage, "test": can_manage, "reveal_target": reveal_target},
    }


def _may_manage_channel(db: Session, user: User, ch: ObservabilityAlertChannel) -> bool:
    """Global channels: Observability admin. Dataset channels: admin, or the
    channel's owner while they can still edit its dataset."""
    if _is_obs_admin(user):
        return True
    if (ch.scope or "") == "global" or ch.dataset_id is None:
        return False
    if ch.owner_id is None or ch.owner_id != user.id:
        return False
    ds = db.query(Dataset).filter(Dataset.id == ch.dataset_id).first()
    return ds is not None and get_effective_permission(db, user, ds, "datasets") in ("edit", "full")


def _load_channel_for_manage(db: Session, user: User, channel_id: int) -> ObservabilityAlertChannel:
    ch = db.query(ObservabilityAlertChannel).filter(ObservabilityAlertChannel.id == channel_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    visible = ch.dataset_id is None or ch.dataset_id in set(_accessible_dataset_ids(db, user))
    if not visible:
        raise HTTPException(status_code=404, detail="Channel not found")
    if not _may_manage_channel(db, user, ch):
        raise HTTPException(status_code=403, detail="You cannot manage this alert channel.")
    return ch


_SEVERITIES = ("info", "warning", "critical")


def _validate_target(kind: str, target: str) -> None:
    """Webhook/Slack targets are outbound destinations: they must pass the
    central egress policy when SAVED (and again on every send)."""
    if kind in ("slack", "webhook"):
        from app.core.egress import EgressDenied, validate_http_url

        try:
            validate_http_url(target)
        except EgressDenied as exc:
            raise HTTPException(status_code=400, detail=f"Target not allowed: {exc}") from exc
    elif kind == "email":
        import re

        if not re.fullmatch(r"[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+", (target or "").strip()):
            raise HTTPException(status_code=400, detail="Target must be one email address.")


@router.get("/alert-channels")
def list_alert_channels(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    from app.services.observability_notifier import channel_delivery_counts

    ids = set(_accessible_dataset_ids(db, user))
    rows = db.query(ObservabilityAlertChannel).order_by(ObservabilityAlertChannel.id.desc()).all()
    counts = channel_delivery_counts(db)
    names = {d.id: d.name for d in db.query(Dataset).filter(Dataset.id.in_(ids)).all()} if ids else {}
    out = []
    for c in rows:
        if not (c.dataset_id is None or c.dataset_id in ids):
            continue
        manage = _may_manage_channel(db, user, c)
        out.append(_channel_dict(c, reveal_target=manage, can_manage=manage,
                                 deliveries=counts.get(c.id), dataset_name=names.get(c.dataset_id)))
    return out


@router.post("/alert-channels", status_code=201)
def create_alert_channel(
    payload: AlertChannelCreate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    if payload.kind not in ALERT_CHANNEL_KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {ALERT_CHANNEL_KINDS}")
    if payload.min_severity not in _SEVERITIES:
        raise HTTPException(status_code=422, detail="min_severity must be info, warning or critical")
    if not (payload.name or "").strip():
        raise HTTPException(status_code=422, detail="name is required")
    if payload.dataset_id is None:
        if not _is_obs_admin(user):
            raise HTTPException(status_code=403, detail="Global alert channels are an Observability administrator action.")
        scope = "global"
    else:
        ds = db.query(Dataset).filter(Dataset.id == payload.dataset_id).first()
        if ds is None or ds.id not in _accessible_dataset_ids(db, user):
            raise HTTPException(status_code=404, detail="Dataset not found")
        require_edit_access(db, user, ds, "datasets")
        scope = "dataset"
    _validate_target(payload.kind, payload.target)
    ch = ObservabilityAlertChannel(
        kind=payload.kind, name=payload.name.strip()[:255], target=payload.target.strip(),
        min_severity=payload.min_severity, dataset_id=payload.dataset_id, owner_id=user.id,
        scope=scope,
    )
    db.add(ch)
    db.commit()
    db.refresh(ch)
    audit(db, AuditAction.ALERT_CHANNEL_CREATED, request=request, user_id=user.id,
          resource_type="alert_channel", resource_id=str(ch.id),
          details={"kind": ch.kind, "scope": scope, "dataset_id": ch.dataset_id})
    return _channel_dict(ch, reveal_target=True, can_manage=True)


@router.patch("/alert-channels/{channel_id}")
def update_alert_channel(
    channel_id: int, payload: AlertChannelUpdate, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    ch = _load_channel_for_manage(db, user, channel_id)
    if payload.name is not None:
        if not payload.name.strip():
            raise HTTPException(status_code=422, detail="name is required")
        ch.name = payload.name.strip()[:255]
    if payload.target is not None:
        _validate_target(ch.kind, payload.target)
        ch.target = payload.target.strip()
    if payload.min_severity is not None:
        if payload.min_severity not in _SEVERITIES:
            raise HTTPException(status_code=422, detail="min_severity must be info, warning or critical")
        ch.min_severity = payload.min_severity
    if payload.is_active is not None:
        ch.is_active = payload.is_active
    db.commit()
    db.refresh(ch)
    audit(db, AuditAction.ALERT_CHANNEL_UPDATED, request=request, user_id=user.id,
          resource_type="alert_channel", resource_id=str(ch.id),
          details={"changed": sorted(payload.model_dump(exclude_unset=True)),
                   "target_changed": payload.target is not None})
    return _channel_dict(ch, reveal_target=True, can_manage=True)


@router.delete("/alert-channels/{channel_id}", status_code=204)
def delete_alert_channel(
    channel_id: int, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    ch = _load_channel_for_manage(db, user, channel_id)
    details = {"kind": ch.kind, "scope": getattr(ch, "scope", None), "dataset_id": ch.dataset_id}
    db.delete(ch)
    db.commit()
    audit(db, AuditAction.ALERT_CHANNEL_DELETED, request=request, user_id=user.id,
          resource_type="alert_channel", resource_id=str(channel_id), details=details)


@router.post("/alert-channels/{channel_id}/test")
def test_alert_channel(
    channel_id: int, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    ch = _load_channel_for_manage(db, user, channel_id)
    from app.services.observability_notifier import test_channel
    ok, err = test_channel(db, ch)
    audit(db, AuditAction.ALERT_CHANNEL_TESTED, request=request, user_id=user.id,
          resource_type="alert_channel", resource_id=str(ch.id), details={"ok": bool(ok)})
    return {"ok": ok, "error": err, "channel": _channel_dict(ch, reveal_target=True, can_manage=True)}
