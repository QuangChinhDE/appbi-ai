"""
ObservabilityNotifier — delivers incidents to alert channels through a ledger.

Channels (ObservabilityAlertChannel):
  • email   — reuses the existing SMTP service (quality_email_service)
  • slack   — POST {"text": ...} to a Slack incoming-webhook URL
  • webhook — POST the incident JSON to any URL (egress-checked)

Delivery contract (observability_alert_deliveries, one row per incident×channel):
  • when an incident OPENS, every matching active channel gets a ``pending`` row,
    written in the same transaction as the incident itself;
  • ``dispatch_due`` sends pending rows and failed rows whose backoff elapsed;
    each send commits its own row, so a crash re-sends at most the message in
    flight — AT-LEAST-ONCE per (incident, channel), never "every open incident
    again". Webhooks carry ``idempotency_key`` so a receiver can de-duplicate;
    email / Slack cannot, so a duplicate after a crash is possible there;
  • a failed send backs off 5 min × 2^n; after MAX_ATTEMPTS it is ``dead`` and
    shown as such - it is never silently dropped;
  • a row whose incident resolved, or whose channel was paused / deleted / no
    longer matches, is ``cancelled`` instead of sent.
"""
import html
import json
import logging
from datetime import datetime, timedelta
from typing import List

from sqlalchemy.orm import Session

from app.models.observability import (
    ObservabilityAlertChannel, ObservabilityAlertDelivery, ObservabilityIncident,
)
from app.core import egress as _egress

logger = logging.getLogger(__name__)

_SEV_RANK = {"info": 1, "warning": 2, "critical": 3}
MAX_ATTEMPTS = 6
BASE_BACKOFF = timedelta(minutes=5)
DISPATCH_BATCH = 200


def _passes_gate(channel: ObservabilityAlertChannel, incident: ObservabilityIncident) -> bool:
    if not channel.is_active:
        return False
    if channel.dataset_id is not None and channel.dataset_id != incident.dataset_id:
        return False
    return _SEV_RANK.get(incident.severity, 2) >= _SEV_RANK.get(channel.min_severity, 2)


def _incident_link(incident: ObservabilityIncident) -> str:
    return f"/observability?incident={incident.id}"


def _incident_text(incident: ObservabilityIncident) -> str:
    return (
        f"[{incident.severity.upper()}] {incident.title}\n"
        f"Trụ cột: {incident.pillar} · Nguồn: {incident.source} · "
        f"Dataset #{incident.dataset_id}\n"
        f"Phát hiện: {incident.first_seen_at.isoformat() if incident.first_seen_at else '—'}\n"
        f"Mở: {_incident_link(incident)}"
    )


class DeliveryFailed(RuntimeError):
    """A delivery attempt that failed, with a message safe to show a user."""


def _raise_for_delivery(r) -> None:
    # Redirects are never followed (a 3xx could point anywhere), so a 3xx is a
    # failed delivery just like a 4xx/5xx.
    if r.status_code >= 300:
        raise DeliveryFailed(f"target answered HTTP {r.status_code}")


def safe_delivery_error(exc: Exception) -> str:
    """What a user may see about a failed send: never the exception text of the
    HTTP client (it can carry internal addresses, response bodies or the URL
    itself, which is the credential)."""
    if isinstance(exc, _egress.EgressDenied):
        return "Target not allowed by the outbound network policy."
    if isinstance(exc, DeliveryFailed):
        return str(exc)
    if exc.__class__.__name__ in ("ConnectTimeout", "ReadTimeout", "TimeoutException", "WriteTimeout", "PoolTimeout"):
        return "Delivery timed out."
    if exc.__class__.__name__ in ("ConnectError",):
        return "Could not connect to the target."
    if isinstance(exc, RuntimeError) and "SMTP" in str(exc):
        return "Email delivery failed or SMTP is not configured."
    return "Delivery failed."


def _send_one(channel: ObservabilityAlertChannel, incident: ObservabilityIncident) -> None:
    """Raises on failure."""
    if channel.kind == "email":
        from app.services.quality_email_service import send_quality_report
        esc = html.escape
        detail = json.dumps(incident.detail, ensure_ascii=False, default=str, indent=1)
        ok = send_quality_report(
            subject=f"[Observability] {incident.severity.upper()}: {incident.title}",
            # Every value is data from a detector (titles carry column / rule
            # names a user typed): escaped, never markup.
            html_body=(
                f"<h3>{esc(incident.title)}</h3>"
                f"<p><b>Mức độ:</b> {esc(incident.severity)} · <b>Trụ cột:</b> {esc(incident.pillar)} · "
                f"<b>Nguồn:</b> {esc(incident.source)}</p>"
                f"<p><b>Dataset:</b> #{int(incident.dataset_id)}</p>"
                f"<pre>{esc(detail)}</pre>"
                f"<p>{esc(_incident_link(incident))}</p>"
            ),
            text_body=_incident_text(incident),
            primary_recipient=channel.target,
        )
        if not ok:
            raise RuntimeError("SMTP gửi thất bại hoặc chưa cấu hình (SMTP_HOST trống)")
    elif channel.kind == "slack":
        r = _egress.http_post(channel.target, json={"text": f":rotating_light: {_incident_text(incident)}"}, timeout=10)
        _raise_for_delivery(r)
    elif channel.kind == "webhook":
        payload = {
            "idempotency_key": f"appbi-incident-{incident.id}",
            "id": incident.id, "title": incident.title, "severity": incident.severity,
            "pillar": incident.pillar, "source": incident.source, "status": incident.status,
            "datasetId": incident.dataset_id, "datasetTableId": incident.dataset_table_id,
            "detail": incident.detail, "link": _incident_link(incident),
            "firstSeenAt": incident.first_seen_at.isoformat() if incident.first_seen_at else None,
        }
        r = _egress.http_post(channel.target, json=payload, timeout=10)
        _raise_for_delivery(r)
    else:
        raise ValueError(f"unknown channel kind {channel.kind}")


def enqueue_deliveries(db: Session, incidents: List[ObservabilityIncident]) -> int:
    """One pending row per (new incident, matching active channel). Idempotent:
    an existing row for the pair is left as it is."""
    incidents = [i for i in incidents if i is not None and i.id is not None]
    if not incidents:
        return 0
    channels = db.query(ObservabilityAlertChannel).filter(
        ObservabilityAlertChannel.is_active == True  # noqa: E712
    ).all()
    if not channels:
        return 0
    existing = {
        (d.incident_id, d.channel_id)
        for d in db.query(ObservabilityAlertDelivery.incident_id, ObservabilityAlertDelivery.channel_id)
        .filter(ObservabilityAlertDelivery.incident_id.in_([i.id for i in incidents])).all()
    }
    n = 0
    now = datetime.utcnow()
    for inc in incidents:
        for ch in channels:
            if (inc.id, ch.id) in existing or not _passes_gate(ch, inc):
                continue
            db.add(ObservabilityAlertDelivery(incident_id=inc.id, channel_id=ch.id, status="pending",
                                              attempts=0, next_attempt_at=now))
            existing.add((inc.id, ch.id))
            n += 1
    db.flush()
    return n


def _backoff(attempts: int) -> timedelta:
    return BASE_BACKOFF * (2 ** max(0, attempts - 1))


def dispatch_due(db: Session, *, now: datetime | None = None) -> int:
    """Send every delivery that is due. Returns the number sent."""
    now = now or datetime.utcnow()
    due = (
        db.query(ObservabilityAlertDelivery)
        .filter(ObservabilityAlertDelivery.status.in_(("pending", "failed")))
        .filter((ObservabilityAlertDelivery.next_attempt_at.is_(None))
                | (ObservabilityAlertDelivery.next_attempt_at <= now))
        .order_by(ObservabilityAlertDelivery.id)
        .limit(DISPATCH_BATCH)
        .all()
    )
    sent = 0
    for d in due:
        inc = db.get(ObservabilityIncident, d.incident_id)
        ch = db.get(ObservabilityAlertChannel, d.channel_id)
        if inc is None or ch is None or inc.status == "resolved" or not _passes_gate(ch, inc):
            d.status = "cancelled"
            d.last_error = ("incident resolved before delivery" if inc is not None and inc.status == "resolved"
                            else "channel paused or no longer matches")
            db.commit()
            continue
        d.attempts = (d.attempts or 0) + 1
        try:
            _send_one(ch, inc)
        except Exception as exc:  # noqa: BLE001 — recorded on the row and the channel
            msg = safe_delivery_error(exc)
            logger.warning("[obs_notify] delivery %s (incident %s → channel %s) failed: %s",
                           d.id, inc.id, ch.id, exc)
            d.last_error = msg
            if d.attempts >= MAX_ATTEMPTS:
                d.status, d.next_attempt_at = "dead", None
            else:
                d.status, d.next_attempt_at = "failed", now + _backoff(d.attempts)
            ch.last_error = msg
            db.commit()
            continue
        d.status, d.sent_at, d.last_error, d.next_attempt_at = "sent", datetime.utcnow(), None, None
        ch.last_sent_at, ch.last_error = d.sent_at, None
        db.commit()
        sent += 1
    return sent


def notify_new_incidents(db: Session, incidents: List[ObservabilityIncident]) -> int:
    """Enqueue (idempotently) and dispatch what is due."""
    enqueue_deliveries(db, incidents)
    db.commit()
    return dispatch_due(db)


def delivery_health(db: Session) -> dict:
    from sqlalchemy import func

    rows = dict(
        db.query(ObservabilityAlertDelivery.status, func.count())
        .group_by(ObservabilityAlertDelivery.status).all()
    )
    return {k: int(rows.get(k, 0)) for k in ("pending", "failed", "dead", "sent", "cancelled")}


def channel_delivery_counts(db: Session) -> dict:
    """{channel_id: {pending, failed, dead}} for the channel list."""
    from sqlalchemy import func

    out: dict = {}
    for cid, st, n in (db.query(ObservabilityAlertDelivery.channel_id, ObservabilityAlertDelivery.status, func.count())
                       .filter(ObservabilityAlertDelivery.status.in_(("pending", "failed", "dead")))
                       .group_by(ObservabilityAlertDelivery.channel_id, ObservabilityAlertDelivery.status).all()):
        out.setdefault(cid, {"pending": 0, "failed": 0, "dead": 0})[st] = int(n)
    return out


def test_channel(db: Session, channel: ObservabilityAlertChannel) -> tuple:
    """Send a synthetic test alert. Returns (ok, error_or_none)."""
    fake = ObservabilityIncident(
        id=0, dataset_id=channel.dataset_id or 0, source="freshness", pillar="freshness",
        dedup_key="test", title="[TEST — không phải cảnh báo thật] Kiểm tra kênh AppBI Observability",
        detail={"note": "Đây là thông báo thử nghiệm, không phản ánh sự cố thật."}, severity="warning",
        status="open", first_seen_at=datetime.utcnow(), last_seen_at=datetime.utcnow(),
    )
    try:
        _send_one(channel, fake)
        channel.last_sent_at = datetime.utcnow()
        channel.last_error = None
        db.commit()
        return True, None
    except Exception as exc:
        msg = safe_delivery_error(exc)
        channel.last_error = msg
        db.commit()
        return False, msg
