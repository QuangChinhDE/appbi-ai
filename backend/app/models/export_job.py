"""Dashboard PDF export jobs (server-side render engine).

Why a job table at all: exporting used to run entirely in the viewer's browser —
it took minutes, died if the tab was closed, could not be scheduled or audited,
and produced a hand-drawn PDF. The server engine turns an export into a durable
unit of work: a row here is created by the API, claimed by the ``pdf-worker``
container (``SELECT … FOR UPDATE SKIP LOCKED`` so several workers never take the
same job), rendered with headless Chromium, and stored on disk with a signed,
expiring download URL.

The row is also the progress feed the browser polls, the audit record of who
exported what slice of data, and the retention handle (``expires_at``) the
cleanup pass uses to delete the file.
"""
from __future__ import annotations

import enum
import uuid

from sqlalchemy import (
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.core.database import Base


class ExportJobStatus(str, enum.Enum):
    """Lifecycle. ``queued`` → ``running`` → ``succeeded`` | ``failed`` | ``cancelled``.

    ``partial`` is a SUCCESS with holes: the PDF exists and is downloadable, but
    at least one chart could not be rendered. Surfaced distinctly so a viewer is
    never handed an incomplete report that looks complete.
    """

    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    partial = "partial"
    failed = "failed"
    cancelled = "cancelled"


class DashboardExportJob(Base):
    __tablename__ = "dashboard_export_jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dashboard_id = Column(
        Integer, ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Public-link token when the export came from /d/<token> or /embed/<token>;
    # NULL for an authed export from the builder. The worker renders through the
    # same surface the requester used, so row-level scoping is identical.
    link_token = Column(String(128), nullable=True, index=True)
    # Who asked. NULL = anonymous public viewer (link_token then carries the
    # identity of the share itself).
    requested_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    requester_ip = Column(String(64), nullable=True)

    status = Column(
        Enum(ExportJobStatus, name="export_job_status", native_enum=False, length=16),
        nullable=False,
        server_default=ExportJobStatus.queued.value,
        index=True,
    )
    # Render request: pages, orientation, format, layout, viewer filters, locale.
    # Stored verbatim so a re-run reproduces the exact same document.
    params = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    # 0..100 plus a Vietnamese message, written by the worker as it goes.
    progress = Column(Integer, nullable=False, server_default=text("0"))
    progress_message = Column(String(255), nullable=True)
    # Charts/pages the worker could not render — same shape as the client
    # engine's PdfExportWarning list.
    warnings = Column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))

    file_path = Column(Text, nullable=True)
    file_size = Column(Integer, nullable=True)
    page_count = Column(Integer, nullable=True)
    # Random secret embedded in the download URL. Knowing a job id is not enough
    # to fetch the bytes.
    download_secret = Column(String(64), nullable=True)

    error = Column(Text, nullable=True)
    attempts = Column(Integer, nullable=False, server_default=text("0"))

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    # Heartbeat from the worker; a running job whose lease went stale is requeued.
    heartbeat_at = Column(DateTime(timezone=True), nullable=True)
    # When the stored file may be deleted (retention).
    expires_at = Column(DateTime(timezone=True), nullable=True, index=True)

    __table_args__ = (
        # The claim query: oldest queued job first.
        Index("ix_export_jobs_status_created", "status", "created_at"),
        # Quota counting: "how many exports did this link/user start recently".
        Index("ix_export_jobs_link_created", "link_token", "created_at"),
        Index("ix_export_jobs_requested_by_created", "requested_by", "created_at"),
    )
