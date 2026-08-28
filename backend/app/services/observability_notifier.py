"""
ObservabilityNotifier — fans NEW incidents out to configured alert channels.

Channels (ObservabilityAlertChannel):
  • email   — reuses the existing SMTP service (quality_email_service)
  • slack   — POST {"text": ...} to a Slack incoming-webhook URL
  • webhook — POST the full incident JSON to any URL

Severity-gated (info < warning < critical) and optionally dataset-scoped.
Every send is best-effort: a failing channel never breaks the scan, the error
is stored on the channel (last_error) for the UI.
"""
import logging
from datetime import datetime
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.observability import ObservabilityAlertChannel, ObservabilityIncident

logger = logging.getLogger(__name__)

_SEV_RANK = {"info": 1, "warning": 2, "critical": 3}


def _passes_gate(channel: ObservabilityAlertChannel, incident: ObservabilityIncident) -> bool:
    if not channel.is_active:
        return False
    if channel.dataset_id is not None and channel.dataset_id != incident.dataset_id:
        return False
    return _SEV_RANK.get(incident.severity, 2) >= _SEV_RANK.get(channel.min_severity, 2)


def _incident_text(incident: ObservabilityIncident) -> str:
    return (
        f"[{incident.severity.upper()}] {incident.title}\n"
        f"Trụ cột: {incident.pillar} · Nguồn: {incident.source} · "
        f"Dataset #{incident.dataset_id}\n"
        f"Phát hiện: {incident.first_seen_at.isoformat() if incident.first_seen_at else '—'}"
    )


def _send_one(channel: ObservabilityAlertChannel, incident: ObservabilityIncident) -> None:
    """Raises on failure (caller records last_error)."""
    if channel.kind == "email":
        from app.services.quality_email_service import send_quality_report
        ok = send_quality_report(
            subject=f"[Observability] {incident.severity.upper()}: {incident.title}",
            html_body=(
                f"<h3>{incident.title}</h3>"
                f"<p><b>Mức độ:</b> {incident.severity} · <b>Trụ cột:</b> {incident.pillar} · "
                f"<b>Nguồn:</b> {incident.source}</p>"
                f"<p><b>Dataset:</b> #{incident.dataset_id}</p>"
                f"<pre>{incident.detail}</pre>"
            ),
            text_body=_incident_text(incident),
            primary_recipient=channel.target,
        )
        if not ok:
            raise RuntimeError("SMTP gửi thất bại hoặc chưa cấu hình (SMTP_HOST trống)")
    elif channel.kind == "slack":
        import httpx
        r = httpx.post(channel.target, json={"text": f":rotating_light: {_incident_text(incident)}"}, timeout=10)
        r.raise_for_status()
    elif channel.kind == "webhook":
        import httpx
        payload = {
            "id": incident.id, "title": incident.title, "severity": incident.severity,
            "pillar": incident.pillar, "source": incident.source,
            "datasetId": incident.dataset_id, "datasetTableId": incident.dataset_table_id,
            "detail": incident.detail,
            "firstSeenAt": incident.first_seen_at.isoformat() if incident.first_seen_at else None,
        }
        r = httpx.post(channel.target, json=payload, timeout=10)
        r.raise_for_status()
    else:
        raise ValueError(f"unknown channel kind {channel.kind}")


def pending_retry_incidents(db: Session, channels: List[ObservabilityAlertChannel]) -> List[ObservabilityIncident]:
    """Still-open incidents whose channel had an error the last time we tried
    (or was inactive) and has since recovered (`last_error is None` now).
    Before this, a channel outage at the moment an incident opened meant that
    incident was NEVER retried even after the channel came back — the scan
    only ever fanned out brand-new incidents, dropping anything that failed
    to send on the first attempt."""
    if not any(c.is_active and c.last_error is None for c in channels):
        return []
    return (
        db.query(ObservabilityIncident)
        .filter(ObservabilityIncident.status == "open")
        .all()
    )


def notify_new_incidents(db: Session, incidents: List[ObservabilityIncident]) -> int:
    """Dispatch each new (or retry-eligible) incident to every matching channel.
    Returns send count."""
    incidents = [i for i in incidents if i is not None]
    channels = db.query(ObservabilityAlertChannel).filter(
        ObservabilityAlertChannel.is_active == True  # noqa: E712
    ).all()
    if not channels:
        return 0

    retry = pending_retry_incidents(db, channels)
    if retry:
        seen_ids = {i.id for i in incidents}
        incidents = incidents + [i for i in retry if i.id not in seen_ids]
    if not incidents:
        return 0

    sent = 0
    now = datetime.utcnow()
    for incident in incidents:
        for ch in channels:
            if not _passes_gate(ch, incident):
                continue
            try:
                _send_one(ch, incident)
                ch.last_sent_at = now
                ch.last_error = None
                sent += 1
            except Exception as exc:  # best-effort — never break the scan
                ch.last_error = str(exc)[:500]
                logger.warning("[obs_notify] channel %s failed: %s", ch.id, exc)
    try:
        db.commit()
    except Exception:
        db.rollback()
    return sent


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
        channel.last_error = str(exc)[:500]
        db.commit()
        return False, str(exc)
