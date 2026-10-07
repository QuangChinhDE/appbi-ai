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

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
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
from app.core.permissions import LEVEL_ORDER, _owned_or_shared, get_user_module_permission
from app.models.resource_share import ResourceType
from app.models.dataset import Dataset, DatasetTable
from app.models.user import User
from app.models.observability import (
    ObservabilityIncident,
    ObservabilityAlertChannel, ALERT_CHANNEL_KINDS,
)
from app.services.observability_service import ObservabilityService

# ── Module floor for the ENTIRE router ────────────────────────────────────────
# The `observability` key existed in the admin matrix and in the frontend sidebar,
# but NOTHING here consulted it: reads scoped by `datasets` (via _owned_or_shared)
# and writes asked for `datasets: edit`. So `observability: none` still answered
# every read for anyone holding `datasets: view`, and `observability: full` with
# `datasets: none` showed nothing — a switch in the matrix that controlled nothing,
# while the sidebar told the user it did.
#
# Same shape as the /catalog gate: reads → view, writes → edit, one gate for the
# whole router so no endpoint can drift. The per-dataset scoping below is unchanged
# and still applies; the two layers answer different questions.
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
        # A schema change a person resolves is ACCEPTED as the new schema — the
        # scanner never accepts one on its own (ObservabilityService._check_schema).
        ObservabilityService.accept_schema_baseline(db, inc)
    elif payload.action == "reopen":
        inc.status = "open"
        inc.resolved_at = None
    else:
        raise HTTPException(status_code=422, detail="action must be acknowledge|resolve|reopen")
    db.commit()
    db.refresh(inc)
    if payload.action in ("acknowledge", "resolve") and inc.dedup_key:
        # PagerDuty-style ack suppression: handling it here in Observability
        # means the bell icon shouldn't keep nagging about the same thing.
        from app.models.user_notification import UserNotification
        db.query(UserNotification).filter(
            UserNotification.dedup_key == inc.dedup_key,
            UserNotification.read == False,  # noqa: E712
        ).update({"read": True})
        db.commit()
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

def _is_obs_admin(user: User) -> bool:
    """The Observability module administrator (module level `full`). Global
    concepts - the tenant-wide scan, global alert channels - are theirs."""
    from app.core.permissions import is_module_admin

    return is_module_admin(user, "observability")


@router.post("/scan")
def scan(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Run EVERY monitor on EVERY dataset, fold incidents tenant-wide and notify
    every channel. That is a global operation: it used to be open to anyone with
    `datasets: edit`, who could repeatedly spend warehouse quota on other teams'
    datasets and push alerts to their channels. Observability admins only."""
    if not _is_obs_admin(user):
        raise HTTPException(status_code=403, detail="A tenant-wide scan is an Observability administrator action.")
    audit(db, AuditAction.OBSERVABILITY_GLOBAL_SCAN, request=request, user_id=user.id,
          resource_type="observability", resource_id="global")
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
    # slack / webhook: keep the host so an admin can still tell channels apart
    without_scheme = raw.split("://", 1)[-1]
    host = without_scheme.split("/", 1)[0]
    return f"{host}/•••" if host else "•••"


def _channel_dict(
    c: ObservabilityAlertChannel, *, reveal_target: bool = False, can_manage: bool = False
) -> Dict[str, Any]:
    return {
        "id": c.id, "kind": c.kind, "name": c.name,
        "scope": c.scope or ("global" if c.dataset_id is None else "dataset"),
        "target": c.target if reveal_target else _mask_target(c.kind, c.target),
        "targetMasked": not reveal_target,
        "minSeverity": c.min_severity, "isActive": c.is_active, "datasetId": c.dataset_id,
        "lastSentAt": c.last_sent_at.isoformat() if c.last_sent_at else None,
        "lastError": c.last_error,
        "capabilities": {"manage": can_manage, "test": can_manage, "reveal_target": reveal_target},
    }


def _may_manage_channel(db: Session, user: User, ch: ObservabilityAlertChannel) -> bool:
    """Global channels: Observability admin. Dataset channels: admin, or the
    channel's owner while they can still edit its dataset. A view share on the
    dataset is not enough to repoint, test or delete someone's channel."""
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
        if "@" not in (target or "") or any(ch in target for ch in "\r\n,;"):
            raise HTTPException(status_code=400, detail="Target must be one email address.")


@router.get("/alert-channels")
def list_alert_channels(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    ids = set(_accessible_dataset_ids(db, user))
    rows = db.query(ObservabilityAlertChannel).order_by(ObservabilityAlertChannel.id.desc()).all()
    # A target (webhook / Slack URL) is a credential: shown only to whoever may
    # manage that channel. Holding `observability: edit` used to reveal every one.
    out = []
    for c in rows:
        if not (c.dataset_id is None or c.dataset_id in ids):
            continue
        manage = _may_manage_channel(db, user, c)
        out.append(_channel_dict(c, reveal_target=manage, can_manage=manage))
    return out


@router.post("/alert-channels", status_code=201)
def create_alert_channel(
    payload: AlertChannelCreate,
    request: Request,
    db: Session = Depends(get_db),
    # Router gate already required observability:edit. Alert channels belong to
    # THIS module, so they are granted by its own key rather than by `datasets`;
    # the per-dataset check below still bounds a dataset-scoped channel.
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    if payload.kind not in ALERT_CHANNEL_KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {ALERT_CHANNEL_KINDS}")
    if payload.dataset_id is None:
        if not _is_obs_admin(user):
            raise HTTPException(status_code=403, detail="Global alert channels are an Observability administrator action.")
        scope = "global"
    else:
        ds = db.query(Dataset).filter(Dataset.id == payload.dataset_id).first()
        if ds is None:
            raise HTTPException(status_code=404, detail="Dataset not found")
        require_edit_access(db, user, ds, "datasets")
        scope = "dataset"
    _validate_target(payload.kind, payload.target)
    ch = ObservabilityAlertChannel(
        kind=payload.kind, name=payload.name, target=payload.target,
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
    channel_id: int, payload: AlertChannelUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    ch = _load_channel_for_manage(db, user, channel_id)
    if payload.name is not None:
        ch.name = payload.name
    if payload.target is not None:
        _validate_target(ch.kind, payload.target)
        ch.target = payload.target
    if payload.min_severity is not None:
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
    channel_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ch = _load_channel_for_manage(db, user, channel_id)
    details = {"kind": ch.kind, "scope": getattr(ch, "scope", None), "dataset_id": ch.dataset_id}
    db.delete(ch)
    db.commit()
    audit(db, AuditAction.ALERT_CHANNEL_DELETED, request=request, user_id=user.id,
          resource_type="alert_channel", resource_id=str(channel_id), details=details)


@router.post("/alert-channels/{channel_id}/test")
def test_alert_channel(
    channel_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    ch = _load_channel_for_manage(db, user, channel_id)
    from app.services.observability_notifier import test_channel
    ok, err = test_channel(db, ch)
    audit(db, AuditAction.ALERT_CHANNEL_TESTED, request=request, user_id=user.id,
          resource_type="alert_channel", resource_id=str(ch.id), details={"ok": bool(ok)})
    return {"ok": ok, "error": err, "channel": _channel_dict(ch, reveal_target=True, can_manage=True)}
