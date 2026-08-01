"""Dashboard PDF export jobs — queue, storage, signed download, retention.

This is the server half of the export engine. The browser used to build the PDF
itself; that made every export as slow and as fragile as the viewer's laptop, and
it ruled out scheduling, auditing and quotas. Here the API only records INTENT
(a ``DashboardExportJob`` row) and the ``pdf-worker`` container does the render.

Design notes
------------
* **Queue = Postgres.** ``SELECT … FOR UPDATE SKIP LOCKED`` is the whole broker:
  no Redis/Celery to deploy, and it is exactly the pattern the rest of the stack
  already uses for cross-worker leases. Several workers can run side by side.
* **Crash safety.** A claimed job writes a heartbeat. A ``running`` row whose
  heartbeat went stale is requeued (up to ``PDF_JOB_MAX_ATTEMPTS``), so a killed
  container never strands a viewer on a spinner.
* **Download authorisation.** The file lives outside the web root and is served
  by an endpoint that requires ``job_id`` + a random ``download_secret`` + a
  non-expired job. Guessing a UUID is not enough.
* **Retention.** Every job carries ``expires_at``; ``cleanup_expired`` deletes
  the bytes and clears the pointer. Nothing accumulates forever in the volume.
"""
from __future__ import annotations

import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.export_job import DashboardExportJob, ExportJobStatus

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def export_dir() -> Path:
    """Directory holding rendered PDFs (inside the persistent data volume)."""
    path = settings.data_dir_path / "exports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def engine_available() -> bool:
    """True when the deployment actually has a worker to run jobs.

    The frontend asks this before offering server-side export; when False it
    keeps using the in-browser exporter instead of queueing work nobody will
    pick up.
    """
    return bool(settings.PDF_EXPORT_ENABLED)


# ── Quota ────────────────────────────────────────────────────────────────────


class ExportQuotaExceeded(Exception):
    """Raised when a link/user has started too many exports in the last hour."""

    def __init__(self, scope: str, limit: int):
        self.scope = scope
        self.limit = limit
        super().__init__(f"export quota exceeded for {scope} (limit {limit}/hour)")


def _count_recent(db: Session, *, link_token: Optional[str], user_id: Optional[uuid.UUID]) -> int:
    since = _now() - timedelta(hours=1)
    query = db.query(func.count(DashboardExportJob.id)).filter(
        DashboardExportJob.created_at >= since
    )
    if user_id is not None:
        query = query.filter(DashboardExportJob.requested_by == user_id)
    else:
        query = query.filter(DashboardExportJob.link_token == link_token)
    return int(query.scalar() or 0)


def check_quota(db: Session, *, link_token: Optional[str], user_id: Optional[uuid.UUID]) -> None:
    """Raise ExportQuotaExceeded when the requester is over their hourly budget.

    A public link is the unit for anonymous viewers (one shared report can't be
    turned into a render farm by a single reader), a user id for authed exports.
    """
    if user_id is not None:
        limit = settings.PDF_QUOTA_PER_USER_HOUR
        scope = "user"
    else:
        limit = settings.PDF_QUOTA_PER_LINK_HOUR
        scope = "link"
    if limit <= 0:
        return
    if _count_recent(db, link_token=link_token, user_id=user_id) >= limit:
        raise ExportQuotaExceeded(scope, limit)


# ── Job lifecycle (API side) ─────────────────────────────────────────────────


def create_job(
    db: Session,
    *,
    dashboard_id: int,
    params: dict[str, Any],
    link_token: Optional[str] = None,
    requested_by: Optional[uuid.UUID] = None,
    requester_ip: Optional[str] = None,
) -> DashboardExportJob:
    """Queue an export. Caller must have already authorised access to the report."""
    check_quota(db, link_token=link_token, user_id=requested_by)
    job = DashboardExportJob(
        id=uuid.uuid4(),
        dashboard_id=dashboard_id,
        link_token=link_token,
        requested_by=requested_by,
        requester_ip=requester_ip,
        status=ExportJobStatus.queued.value,
        params=params,
        progress=0,
        progress_message="Đã xếp hàng chờ xử lý…",
        warnings=[],
        download_secret=secrets.token_urlsafe(24),
        expires_at=_now() + timedelta(hours=settings.PDF_FILE_TTL_HOURS),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    logger.info(
        "[pdf_export] queued job=%s dashboard=%s link=%s pages=%s",
        job.id, dashboard_id, link_token, len((params or {}).get("pages") or []),
    )
    return job


def get_job(db: Session, job_id: uuid.UUID) -> Optional[DashboardExportJob]:
    return db.query(DashboardExportJob).filter(DashboardExportJob.id == job_id).first()


def cancel_job(db: Session, job: DashboardExportJob) -> DashboardExportJob:
    """Viewer closed the dialog / pressed Stop. A queued job is dropped outright;
    a running one is marked cancelled and the worker stops at its next
    checkpoint (cooperative, same pattern as the dataset-sync popup)."""
    if job.status in (ExportJobStatus.queued.value, ExportJobStatus.running.value):
        job.status = ExportJobStatus.cancelled.value
        job.finished_at = _now()
        job.progress_message = "Đã hủy theo yêu cầu."
        db.commit()
        db.refresh(job)
    return job


def is_cancelled(db: Session, job_id: uuid.UUID) -> bool:
    row = (
        db.query(DashboardExportJob.status)
        .filter(DashboardExportJob.id == job_id)
        .first()
    )
    return bool(row and row[0] == ExportJobStatus.cancelled.value)


def list_jobs(
    db: Session,
    *,
    dashboard_id: Optional[int] = None,
    link_token: Optional[str] = None,
    user_id: Optional[uuid.UUID] = None,
    limit: int = 25,
) -> list[DashboardExportJob]:
    """Export history — the builder's "recent exports" list and the audit view."""
    query = db.query(DashboardExportJob)
    if dashboard_id is not None:
        query = query.filter(DashboardExportJob.dashboard_id == dashboard_id)
    if link_token is not None:
        query = query.filter(DashboardExportJob.link_token == link_token)
    if user_id is not None:
        query = query.filter(DashboardExportJob.requested_by == user_id)
    return (
        query.order_by(DashboardExportJob.created_at.desc())
        .limit(max(1, min(int(limit), 200)))
        .all()
    )


def download_ready(job: DashboardExportJob) -> bool:
    """A job whose bytes can still be served."""
    if job.status not in (ExportJobStatus.succeeded.value, ExportJobStatus.partial.value):
        return False
    if not job.file_path or not os.path.exists(job.file_path):
        return False
    if job.expires_at and job.expires_at <= _now():
        return False
    return True


def verify_download_secret(job: DashboardExportJob, secret: str) -> bool:
    """Constant-time check of the URL secret."""
    if not job.download_secret or not secret:
        return False
    return secrets.compare_digest(str(job.download_secret), str(secret))


# ── Worker side ──────────────────────────────────────────────────────────────


def claim_next_job(db: Session) -> Optional[DashboardExportJob]:
    """Atomically take the oldest runnable job.

    ``FOR UPDATE SKIP LOCKED`` means two workers polling at the same moment take
    two different rows instead of fighting over one. Also picks up ``running``
    rows whose lease expired — those belonged to a worker that died mid-render.
    """
    lease_cutoff = _now() - timedelta(seconds=settings.PDF_JOB_LEASE_SECONDS)
    job = (
        db.query(DashboardExportJob)
        .filter(
            or_(
                DashboardExportJob.status == ExportJobStatus.queued.value,
                and_(
                    DashboardExportJob.status == ExportJobStatus.running.value,
                    or_(
                        DashboardExportJob.heartbeat_at.is_(None),
                        DashboardExportJob.heartbeat_at < lease_cutoff,
                    ),
                ),
            ),
            DashboardExportJob.attempts < settings.PDF_JOB_MAX_ATTEMPTS,
        )
        .order_by(DashboardExportJob.created_at.asc())
        .with_for_update(skip_locked=True)
        .first()
    )
    if job is None:
        return None
    job.status = ExportJobStatus.running.value
    job.attempts = int(job.attempts or 0) + 1
    job.started_at = job.started_at or _now()
    job.heartbeat_at = _now()
    job.progress_message = "Đang khởi tạo trình dựng báo cáo…"
    db.commit()
    db.refresh(job)
    return job


def heartbeat(db: Session, job_id: uuid.UUID, *, progress: int | None = None, message: str | None = None) -> None:
    """Keep the lease alive and feed the browser's progress bar."""
    values: dict[str, Any] = {"heartbeat_at": _now()}
    if progress is not None:
        values["progress"] = max(0, min(100, int(progress)))
    if message is not None:
        values["progress_message"] = message[:255]
    db.query(DashboardExportJob).filter(DashboardExportJob.id == job_id).update(values)
    db.commit()


def complete_job(
    db: Session,
    job_id: uuid.UUID,
    *,
    file_path: str,
    page_count: int,
    warnings: list[dict[str, Any]] | None = None,
) -> None:
    warn = warnings or []
    # 'partial' must mean "content is MISSING", because that is what the viewer is
    # warned about and what makes them re-run the export. Advisory notes (e.g. "the
    # page was scaled to 31% to fit one sheet") are still carried in `warnings` so
    # they reach the report, but they do not degrade the status — otherwise every
    # snapshot of a tall dashboard would report itself as broken.
    blocking = [w for w in warn if str((w or {}).get("severity") or "warn") != "info"]
    size = 0
    try:
        size = os.path.getsize(file_path)
    except OSError:
        pass
    db.query(DashboardExportJob).filter(DashboardExportJob.id == job_id).update(
        {
            # A file with holes is still delivered — but it is labelled, so the
            # reader never mistakes a missing chart for a zero.
            "status": ExportJobStatus.partial.value if blocking else ExportJobStatus.succeeded.value,
            "file_path": file_path,
            "file_size": size,
            "page_count": page_count,
            "warnings": warn,
            "progress": 100,
            "progress_message": (
                f"Hoàn tất — thiếu {len(blocking)} biểu đồ." if blocking else "Hoàn tất."
            ),
            "finished_at": _now(),
            "heartbeat_at": _now(),
            "expires_at": _now() + timedelta(hours=settings.PDF_FILE_TTL_HOURS),
        }
    )
    db.commit()


def fail_job(db: Session, job_id: uuid.UUID, error: str, *, retryable: bool = True) -> None:
    """Mark a job failed. When retryable and attempts remain, it goes back to the
    queue so a transient warehouse/browser hiccup doesn't lose the request."""
    job = get_job(db, job_id)
    if job is None:
        return
    attempts_left = retryable and int(job.attempts or 0) < settings.PDF_JOB_MAX_ATTEMPTS
    job.error = (error or "")[:4000]
    if attempts_left:
        job.status = ExportJobStatus.queued.value
        job.heartbeat_at = None
        job.progress_message = "Gặp lỗi, sẽ thử lại…"
    else:
        job.status = ExportJobStatus.failed.value
        job.finished_at = _now()
        job.progress_message = "Xuất PDF thất bại."
    db.commit()


def cleanup_expired(db: Session, *, batch: int = 200) -> int:
    """Delete rendered files past their TTL. Returns how many were removed."""
    rows = (
        db.query(DashboardExportJob)
        .filter(
            DashboardExportJob.file_path.isnot(None),
            DashboardExportJob.expires_at.isnot(None),
            DashboardExportJob.expires_at < _now(),
        )
        .limit(batch)
        .all()
    )
    removed = 0
    for job in rows:
        try:
            if job.file_path and os.path.exists(job.file_path):
                os.remove(job.file_path)
        except OSError as exc:  # noqa: BLE001
            logger.warning("[pdf_export] could not delete %s: %s", job.file_path, exc)
        job.file_path = None
        job.download_secret = None
        removed += 1
    if removed:
        db.commit()
    return removed


def job_to_dict(job: DashboardExportJob, *, include_download: bool = True) -> dict[str, Any]:
    """Wire shape for the status/polling endpoint."""
    data: dict[str, Any] = {
        "id": str(job.id),
        "status": job.status,
        "progress": int(job.progress or 0),
        "message": job.progress_message,
        "warnings": job.warnings or [],
        "page_count": job.page_count,
        "file_size": job.file_size,
        "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "expires_at": job.expires_at.isoformat() if job.expires_at else None,
    }
    if include_download and download_ready(job):
        data["download_token"] = job.download_secret
    return data
