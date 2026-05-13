"""Admin REST endpoints for webhook configs + sync run history.

The endpoints attach to the same ``/workboards/{id}`` namespace as the
core CRUD module. Webhook configs are persisted on
``workboard.settings.webhooks[]`` so they travel with the workboard on
export/import.
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.core import get_db
from app.core.dependencies import (
    get_current_user,
    require_edit_access,
    require_view_access,
)
from app.core.logging import get_logger
from app.models.user import User
from app.modules.workboards.models import Workboard, WorkboardSyncRun
from app.modules.workboards.schemas import (
    SyncRunStatus,
    WorkboardSyncRunDetailResponse,
    WorkboardSyncRunResponse,
    WorkboardWebhookConfig,
    WorkboardWebhookCreate,
    WorkboardWebhookHeader,
    WorkboardWebhookTestRequest,
    WorkboardWebhookUpdate,
)
from app.modules.workboards.services import screen_runtime
from app.modules.workboards.services import webhook_sync_service as svc
from app.modules.workboards.services.crud_service import WorkboardService

logger = get_logger(__name__)
router = APIRouter(prefix="/workboards", tags=["workboards", "webhooks"])


def _get_or_404(db: Session, workboard_id: int) -> Workboard:
    wb = WorkboardService.get_by_id(db, workboard_id)
    if not wb:
        raise HTTPException(status_code=404, detail="Workboard not found")
    return wb


def _settings_dict(wb: Workboard) -> Dict[str, Any]:
    raw = wb.settings or {}
    if not isinstance(raw, dict):
        return {}
    return dict(raw)


def _save_webhooks(db: Session, wb: Workboard, configs: List[WorkboardWebhookConfig]) -> None:
    settings = _settings_dict(wb)
    settings["webhooks"] = [c.model_dump() for c in configs]
    wb.settings = settings
    db.commit()
    db.refresh(wb)


def _validate_doc_screen_id(wb: Workboard, screen_id: str) -> None:
    """Raise 400 if ``screen_id`` is not a doc screen on this workboard."""
    layout = screen_runtime.parse_layout(wb)
    match = next((s for s in layout.screens if s.id == screen_id), None)
    if match is None:
        raise HTTPException(
            status_code=400,
            detail=f"Screen '{screen_id}' not found on this workboard.",
        )
    if match.kind != "doc":
        raise HTTPException(
            status_code=400,
            detail=f"Screen '{screen_id}' is not a doc screen.",
        )


def _slug_id(name: str, existing: List[str]) -> str:
    """Derive a short slug-ish id from a name; ensure uniqueness."""
    import re
    base = re.sub(r"[^a-z0-9]+", "-", (name or "webhook").lower()).strip("-") or "webhook"
    base = base[:48]
    candidate = base
    n = 1
    taken = set(existing)
    while candidate in taken:
        n += 1
        candidate = f"{base}-{n}"
    return candidate


# ── Webhook CRUD ──────────────────────────────────────────────────────────

@router.get(
    "/{workboard_id}/webhooks",
    response_model=List[WorkboardWebhookConfig],
)
def list_webhooks(
    workboard_id: int,
    screen_id: Optional[str] = Query(
        default=None,
        description="Limit results to webhooks bound to this doc screen.",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    configs = svc.list_webhook_configs(wb)
    if screen_id is not None:
        configs = [c for c in configs if (c.screen_id or "") == screen_id]
    return configs


@router.post(
    "/{workboard_id}/webhooks",
    response_model=WorkboardWebhookConfig,
    status_code=status.HTTP_201_CREATED,
)
def create_webhook(
    workboard_id: int,
    payload: WorkboardWebhookCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    _validate_doc_screen_id(wb, payload.screen_id)
    configs = svc.list_webhook_configs(wb)
    new_id = _slug_id(payload.name, [c.id for c in configs])
    cfg = WorkboardWebhookConfig(id=new_id, **payload.model_dump())
    configs.append(cfg)
    _save_webhooks(db, wb, configs)
    return cfg


@router.patch(
    "/{workboard_id}/webhooks/{webhook_id}",
    response_model=WorkboardWebhookConfig,
)
def update_webhook(
    workboard_id: int,
    webhook_id: str,
    payload: WorkboardWebhookUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    updates = payload.model_dump(exclude_unset=True)
    if "screen_id" in updates and updates["screen_id"]:
        _validate_doc_screen_id(wb, updates["screen_id"])
    configs = svc.list_webhook_configs(wb)
    for idx, cfg in enumerate(configs):
        if cfg.id == webhook_id:
            merged = {**cfg.model_dump(), **updates}
            configs[idx] = WorkboardWebhookConfig.model_validate(merged)
            _save_webhooks(db, wb, configs)
            return configs[idx]
    raise HTTPException(status_code=404, detail="Webhook not found")


@router.delete(
    "/{workboard_id}/webhooks/{webhook_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_webhook(
    workboard_id: int,
    webhook_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    configs = svc.list_webhook_configs(wb)
    new_configs = [c for c in configs if c.id != webhook_id]
    if len(new_configs) == len(configs):
        raise HTTPException(status_code=404, detail="Webhook not found")
    _save_webhooks(db, wb, new_configs)


@router.post("/{workboard_id}/webhooks/{webhook_id}/test")
def test_webhook(
    workboard_id: int,
    webhook_id: str,
    payload: Optional[WorkboardWebhookTestRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    cfg = svc.get_webhook_config(wb, webhook_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Webhook not found")
    req = payload or WorkboardWebhookTestRequest()
    try:
        return asyncio.run(svc.test_webhook(cfg, req.sample_rows, req.sample_columns))
    except RuntimeError:
        # Event loop already running (uvicorn worker may keep one alive in
        # certain configs) — run in a fresh loop instead.
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(
                svc.test_webhook(cfg, req.sample_rows, req.sample_columns)
            )
        finally:
            loop.close()


# ── Sync run history ──────────────────────────────────────────────────────

def _run_to_response(run: WorkboardSyncRun) -> WorkboardSyncRunResponse:
    return WorkboardSyncRunResponse(
        run_id=run.run_id,
        status=run.status,  # type: ignore[arg-type]
        workboard_id=run.workboard_id,
        screen_id=run.screen_id,
        block_index=run.block_index,
        trigger_id=run.trigger_id,
        webhook_id=run.webhook_id,
        webhook_name=run.webhook_name,
        total_rows=run.total_rows,
        total_batches=run.total_batches,
        completed_batches=run.completed_batches,
        failed_batches=run.failed_batches,
        last_response_status=run.last_response_status,
        last_error=run.last_error,
        started_at=run.started_at,
        finished_at=run.finished_at,
        duration_ms=run.duration_ms,
        created_at=run.created_at,
    )


@router.get(
    "/{workboard_id}/sync-runs",
    response_model=List[WorkboardSyncRunResponse],
)
def list_sync_runs(
    workboard_id: int,
    webhook_id: Optional[str] = Query(default=None),
    screen_id: Optional[str] = Query(default=None),
    status_filter: Optional[SyncRunStatus] = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    q = db.query(WorkboardSyncRun).filter(WorkboardSyncRun.workboard_id == wb.id)
    if webhook_id:
        q = q.filter(WorkboardSyncRun.webhook_id == webhook_id)
    if screen_id:
        q = q.filter(WorkboardSyncRun.screen_id == screen_id)
    if status_filter:
        q = q.filter(WorkboardSyncRun.status == status_filter)
    rows = q.order_by(WorkboardSyncRun.created_at.desc()).offset(offset).limit(limit).all()
    return [_run_to_response(r) for r in rows]


@router.get(
    "/{workboard_id}/sync-runs/{run_id}",
    response_model=WorkboardSyncRunDetailResponse,
)
def get_sync_run(
    workboard_id: int,
    run_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_view_access(db, current_user, wb, "workboards")
    run = (
        db.query(WorkboardSyncRun)
        .filter(
            WorkboardSyncRun.workboard_id == wb.id,
            WorkboardSyncRun.run_id == run_id,
        )
        .one_or_none()
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Sync run not found")
    base = _run_to_response(run).model_dump()
    return WorkboardSyncRunDetailResponse(
        **base,
        webhook_url=run.webhook_url,
        response_excerpt=run.response_excerpt,
    )


@router.post("/{workboard_id}/sync-runs/{run_id}/cancel")
def cancel_sync_run(
    workboard_id: int,
    run_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wb = _get_or_404(db, workboard_id)
    require_edit_access(db, current_user, wb, "workboards")
    run = svc.request_cancel(db, run_id)
    if run is None or run.workboard_id != wb.id:
        raise HTTPException(status_code=404, detail="Sync run not found")
    return _run_to_response(run)
