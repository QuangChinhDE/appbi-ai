"""Tell the dataset owner when a refresh / Sync & Publish fails.

A failed run used to land only in Refresh History: the owner learned about it
when a dashboard looked stale. Every terminal run passes through
``dataset_publish_service._refresh_run_finish``, which calls in here:

* ``failed``  → an in-app notification for the owner (always) and, when the
  dataset's ``snapshot_config.notify.email_on_failure`` is on (the default), ONE
  email per failure streak — a scheduled refresh failing every hour does not
  send an email every hour.
* ``success`` → the streak is over: the notification is cleared, so the next
  failure notifies (and emails) again.

Best-effort throughout: an alert can never change a run's outcome.
"""
from __future__ import annotations

import html
import logging
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

TRIGGER_LABELS = {
    "manual": "Sync & Publish thủ công",
    "manual_refresh": "Làm mới dữ liệu",
    "scheduled": "Refresh theo lịch",
    "source_change": "Nguồn thay đổi",
    "ttl": "Làm mới nền",
}


def _dedup_key(dataset_id: int) -> str:
    return f"dataset_sync_failed:{dataset_id}"


def _dataset_link(dataset_id: int) -> str:
    from app.core.config import settings

    base = (getattr(settings, "PUBLIC_BASE_URL", "") or "").rstrip("/")
    return f"{base}/datasets/{dataset_id}" if base else f"/datasets/{dataset_id}"


def notify_sync_failed(db: Session, run) -> None:
    """In-app notification for the owner + (if enabled) one email per streak."""
    try:
        from app.models.dataset import Dataset
        from app.models.user import User
        from app.models.user_notification import UserNotification
        from app.services import dataset_snapshot_config as sc
        from app.services.user_notification_service import notify_user

        ds = db.query(Dataset).filter(Dataset.id == run.dataset_id).first()
        if ds is None or ds.owner_id is None:
            return
        key = _dedup_key(ds.id)
        # A notification for this dataset still on record ⇒ this failure belongs
        # to a streak the owner was already told about (by email too).
        streak_open = db.query(UserNotification.id).filter(
            UserNotification.dedup_key == key, UserNotification.user_id == ds.owner_id).first() is not None
        reason = (str(run.error or "").strip().splitlines() or ["Không rõ nguyên nhân"])[0][:500]
        trigger = TRIGGER_LABELS.get(str(run.trigger or ""), str(run.trigger or ""))
        notify_user(
            db, ds.owner_id, level="error",
            title=f"Đồng bộ dataset lỗi: {ds.name}",
            description=f"{trigger}: {reason}",
            link=f"/datasets/{ds.id}", source="dataset_sync", dedup_key=key,
        )
        if streak_open or not sc.email_on_failure_enabled(ds):
            return
        owner = db.query(User).filter(User.id == ds.owner_id).first()
        if owner is None or not getattr(owner, "email", None):
            return
        _send_failure_email(owner.email, ds, run, trigger, reason)
    except Exception:  # noqa: BLE001 — an alert never breaks the run that triggered it
        db.rollback()
        logger.warning("[sync-alert] failure alert for run=%s not delivered", getattr(run, "id", None),
                       exc_info=True)


def clear_sync_failure(db: Session, dataset_id: int) -> None:
    """A successful run ends the streak: drop the open failure notification."""
    try:
        from app.models.user_notification import UserNotification

        n = db.query(UserNotification).filter(
            UserNotification.dedup_key == _dedup_key(dataset_id)).delete(synchronize_session=False)
        if n:
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("[sync-alert] could not clear failure alert dataset=%s", dataset_id, exc_info=True)


def _send_failure_email(to: str, ds, run, trigger: str, reason: str) -> bool:
    from app.services.quality_email_service import send_quality_report

    link = _dataset_link(ds.id)
    published = getattr(ds, "published_generation", None)
    keeps = ("Dashboard vẫn dùng dữ liệu đã publish trước đó." if published is not None
             else "Dataset chưa có dữ liệu đã publish.")
    when = run.finished_at.strftime("%Y-%m-%d %H:%M UTC") if getattr(run, "finished_at", None) else ""
    subject = f"[AppBI] Đồng bộ dataset lỗi: {ds.name}"
    text = (f"Dataset \"{ds.name}\" đồng bộ thất bại.\n\n"
            f"Kiểu chạy: {trigger}\nThời điểm: {when}\nNguyên nhân: {reason}\n\n"
            f"{keeps}\nXem chi tiết (Lịch sử refresh): {link}\n\n"
            "Bạn nhận email này vì là owner của dataset. Tắt trong Sync & Publish → Thông báo.")
    e = html.escape
    body = (f"<p>Dataset <b>{e(ds.name)}</b> đồng bộ thất bại.</p>"
            f"<table cellpadding='4'><tr><td>Kiểu chạy</td><td>{e(trigger)}</td></tr>"
            f"<tr><td>Thời điểm</td><td>{e(when)}</td></tr>"
            f"<tr><td>Nguyên nhân</td><td>{e(reason)}</td></tr></table>"
            f"<p>{e(keeps)}</p><p><a href='{e(link)}'>Mở dataset (Lịch sử refresh)</a></p>"
            "<p style='color:#888'>Bạn nhận email này vì là owner của dataset. "
            "Tắt trong Sync &amp; Publish → Thông báo.</p>")
    sent = send_quality_report(subject=subject, html_body=body, text_body=text, primary_recipient=to)
    logger.info("[sync-alert] failure email dataset=%s run=%s sent=%s", ds.id, run.id, sent)
    return sent


def on_run_finished(db: Session, run, status: str) -> None:
    if status == "failed":
        notify_sync_failed(db, run)
    elif status == "success":
        clear_sync_failure(db, run.dataset_id)
