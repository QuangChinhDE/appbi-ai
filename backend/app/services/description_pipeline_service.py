"""
DescriptionPipelineService - orchestrate AI description generation for tables and charts.

This layer owns:
- queueing + processing state
- stale detection
- failure visibility
- running background work with a dedicated session in production

AutoTaggingService focuses only on LLM generation; this service decides when it
should run and how UI-facing status fields should be updated.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Callable, Iterator

from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.services.auto_tagging_service import AutoTaggingService
from app.services.embedding_service import EmbeddingService
from app.services.table_stats_service import TableStatsService

logger = logging.getLogger(__name__)

GEN_STATUS_IDLE = "idle"
GEN_STATUS_QUEUED = "queued"
GEN_STATUS_PROCESSING = "processing"
GEN_STATUS_SUCCEEDED = "succeeded"
GEN_STATUS_FAILED = "failed"
GEN_STATUS_STALE = "stale"


def _is_fake_session(candidate: Any) -> bool:
    cls = candidate.__class__
    return cls.__name__ == "FakeSession" or cls.__module__.startswith("tests.")


def resolve_session_factory(db: Session | Any) -> Callable[[], Any]:
    """
    Use a dedicated SQLAlchemy session in production, but keep tests working by
    reusing FakeSession objects that live entirely in memory.
    """
    if _is_fake_session(db):
        return lambda: db
    return SessionLocal


@contextmanager
def _managed_session(session_factory: Callable[[], Any]) -> Iterator[Any]:
    session = session_factory()
    try:
        yield session
    finally:
        close = getattr(session, "close", None)
        if callable(close) and not _is_fake_session(session):
            close()


def _utcnow() -> datetime:
    return datetime.utcnow()


def _table_stale_reason(trigger: str, schema_changed: bool) -> str:
    if schema_changed:
        return "Cau truc bang da thay doi sau khi ban chinh AI description. Hay review hoac regenerate."
    if trigger == "manual_regenerate":
        return "AI description dang duoc giu theo noi dung ban sua tay. Bam regenerate de ghi de neu can."
    return "Bang da thay doi sau khi ban chinh AI description. Hay review hoac regenerate."


def _chart_stale_reason(trigger: str) -> str:
    if trigger == "manual_regenerate":
        return "AI description dang duoc giu theo noi dung ban sua tay. Bam regenerate de ghi de neu can."
    return "Bieu do da thay doi sau khi ban chinh AI description. Hay review hoac regenerate."


class DescriptionPipelineService:

    @staticmethod
    def _queue_table_state(table, *, force: bool) -> None:
        table.generation_status = GEN_STATUS_QUEUED
        table.generation_error = None
        table.generation_requested_at = _utcnow()
        table.generation_finished_at = None
        if force:
            table.stale_reason = None
            table.schema_change_pending = False

    @staticmethod
    def _queue_chart_state(meta, *, force: bool) -> None:
        meta.generation_status = GEN_STATUS_QUEUED
        meta.generation_error = None
        meta.generation_requested_at = _utcnow()
        meta.generation_finished_at = None
        if force:
            meta.stale_reason = None

    @staticmethod
    def _ensure_chart_meta(db: Session, chart_id: int):
        from app.models.models import ChartMetadata

        meta = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
        if not meta:
            meta = ChartMetadata(chart_id=chart_id)
            db.add(meta)
            db.flush()
        return meta

    @staticmethod
    def enqueue_table_pipeline(
        background_tasks,
        db: Session,
        table_id: int,
        *,
        trigger: str = "auto",
        force: bool = False,
    ) -> None:
        from app.models.dataset import DatasetTable

        table = db.query(DatasetTable).filter(
            DatasetTable.id == table_id
        ).first()
        if not table:
            return

        DescriptionPipelineService._queue_table_state(table, force=force)
        db.commit()
        background_tasks.add_task(
            DescriptionPipelineService.run_table_pipeline,
            table_id,
            trigger,
            force,
            resolve_session_factory(db),
        )

    @staticmethod
    def enqueue_chart_pipeline(
        background_tasks,
        db: Session,
        chart_id: int,
        *,
        trigger: str = "auto",
        force: bool = False,
    ) -> None:
        meta = DescriptionPipelineService._ensure_chart_meta(db, chart_id)
        DescriptionPipelineService._queue_chart_state(meta, force=force)
        db.commit()
        background_tasks.add_task(
            DescriptionPipelineService.run_chart_pipeline,
            chart_id,
            trigger,
            force,
            resolve_session_factory(db),
        )

    @staticmethod
    def run_table_pipeline(
        table_id: int,
        trigger: str = "auto",
        force: bool = False,
        session_factory: Callable[[], Any] = SessionLocal,
    ) -> None:
        from app.models.dataset import DatasetTable

        with _managed_session(session_factory) as db:
            table = db.query(DatasetTable).filter(
                DatasetTable.id == table_id
            ).first()
            if not table:
                return

            table.generation_status = GEN_STATUS_PROCESSING
            table.generation_error = None
            table.generation_finished_at = None
            db.commit()

            stats_result = TableStatsService.update_table_stats(db, table_id)
            table = db.query(DatasetTable).filter(
                DatasetTable.id == table_id
            ).first()
            if not table:
                return

            schema_changed = bool(stats_result.get("changed"))
            manual_description_locked = (table.description_source == "user" and not force)

            if manual_description_locked:
                table.generation_status = GEN_STATUS_STALE
                table.generation_error = None
                table.generation_finished_at = _utcnow()
                table.stale_reason = _table_stale_reason(trigger, schema_changed)
                table.schema_change_pending = schema_changed
                db.commit()
                EmbeddingService.embed_table(db, table_id)
                return

            ok, error = AutoTaggingService.describe_table_detailed(db, table_id)
            table = db.query(DatasetTable).filter(
                DatasetTable.id == table_id
            ).first()
            if not table:
                return

            if not ok:
                table.generation_status = GEN_STATUS_FAILED
                table.generation_error = error or "AI description generation failed"
                table.generation_finished_at = _utcnow()
                table.stale_reason = None
                db.commit()
                return

            EmbeddingService.embed_table(db, table_id)
            table = db.query(DatasetTable).filter(
                DatasetTable.id == table_id
            ).first()
            if not table:
                return

            table.generation_status = GEN_STATUS_SUCCEEDED
            table.generation_error = None
            table.generation_finished_at = _utcnow()
            table.stale_reason = None
            table.schema_change_pending = False
            db.commit()

    @staticmethod
    def run_chart_pipeline(
        chart_id: int,
        trigger: str = "auto",
        force: bool = False,
        session_factory: Callable[[], Any] = SessionLocal,
    ) -> None:
        from app.models.models import Chart

        with _managed_session(session_factory) as db:
            chart = db.query(Chart).filter(Chart.id == chart_id).first()
            if not chart:
                return

            meta = DescriptionPipelineService._ensure_chart_meta(db, chart_id)
            meta.generation_status = GEN_STATUS_PROCESSING
            meta.generation_error = None
            meta.generation_finished_at = None
            db.commit()

            manual_description_locked = (meta.description_source == "user" and not force)
            if manual_description_locked:
                meta.generation_status = GEN_STATUS_STALE
                meta.generation_error = None
                meta.generation_finished_at = _utcnow()
                meta.stale_reason = _chart_stale_reason(trigger)
                db.commit()
                EmbeddingService.embed_chart(db, chart_id)
                return

            ok, error = AutoTaggingService.tag_chart_detailed(db, chart_id)
            meta = DescriptionPipelineService._ensure_chart_meta(db, chart_id)
            if not ok:
                meta.generation_status = GEN_STATUS_FAILED
                meta.generation_error = error or "AI description generation failed"
                meta.generation_finished_at = _utcnow()
                meta.stale_reason = None
                db.commit()
                return

            EmbeddingService.embed_chart(db, chart_id)
            meta = DescriptionPipelineService._ensure_chart_meta(db, chart_id)
            meta.generation_status = GEN_STATUS_SUCCEEDED
            meta.generation_error = None
            meta.generation_finished_at = _utcnow()
            meta.stale_reason = None
            db.commit()

    @staticmethod
    def run_table_embedding(
        table_id: int,
        session_factory: Callable[[], Any] = SessionLocal,
    ) -> None:
        with _managed_session(session_factory) as db:
            EmbeddingService.embed_table(db, table_id)

    @staticmethod
    def run_chart_embedding(
        chart_id: int,
        session_factory: Callable[[], Any] = SessionLocal,
    ) -> None:
        with _managed_session(session_factory) as db:
            EmbeddingService.embed_chart(db, chart_id)
