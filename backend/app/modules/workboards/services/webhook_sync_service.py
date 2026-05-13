"""Outbound webhook execution for workboard doc data_table blocks.

A user on the mini-app clicks a "Sync" button on a doc data_table block.
The button references a ``DataTableSyncTrigger`` which fans out to one or
more ``WorkboardWebhookConfig`` entries stored on the workboard. For each
webhook we:

1. Re-resolve the table data through ``_resolve_doc_data_block`` so RLS
   (per-screen, per-role) is applied — the webhook never sees rows the
   user couldn't see on screen.
2. Slice rows into batches of ``webhook.batch_size``.
3. POST each batch as JSON with a fixed-shape envelope. The receiver
   (n8n / Make / custom integration) handles mapping + auth with the
   destination system.
4. Persist progress in ``workboard_sync_runs`` after every batch so the
   frontend's polling endpoint shows live counters.

Background execution uses ``asyncio.create_task`` against a dedicated
worker function that opens its own DB session per run. A startup janitor
reclaims runs left in ``running`` after a process restart.

Cancellation is cooperative: a separate endpoint flips
``cancel_requested=True`` on the row; the worker checks it between
batches and exits with ``status="cancelled"``.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.modules.workboards.models import (
    Workboard,
    WorkboardAppUser,
    WorkboardSyncRun,
)
from app.modules.workboards.schemas import (
    DataTableBlock,
    DataTableSyncTrigger,
    LayoutJson,
    WorkboardWebhookConfig,
    WorkboardWebhookHeader,
)
from app.modules.workboards.services import screen_runtime
from app.modules.workboards.services.rls_service import CallerIdentity

logger = get_logger(__name__)


# Truncate response body kept on disk to keep the JSONB column light.
_RESPONSE_EXCERPT_BYTES = 2048


class WebhookSyncError(Exception):
    """Raised by the trigger entrypoint when the request is malformed.

    Errors that happen *during* batch execution are recorded on the
    sync_run row, not raised — the worker runs in the background.
    """


# ── ID generation ─────────────────────────────────────────────────────────

def _new_id(prefix: str) -> str:
    # 26-char URL-safe random suffix, prefixed for readability in logs.
    return f"{prefix}_{secrets.token_urlsafe(18)}"[:32]


# ── Config resolution ─────────────────────────────────────────────────────

def list_webhook_configs(workboard: Workboard) -> List[WorkboardWebhookConfig]:
    raw = (workboard.settings or {}).get("webhooks") or []
    out: List[WorkboardWebhookConfig] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            out.append(WorkboardWebhookConfig.model_validate(item))
        except Exception as exc:
            logger.warning("workboard %s has invalid webhook config: %s", workboard.id, exc)
    return out


def get_webhook_config(
    workboard: Workboard, webhook_id: str
) -> Optional[WorkboardWebhookConfig]:
    for cfg in list_webhook_configs(workboard):
        if cfg.id == webhook_id:
            return cfg
    return None


def get_trigger(
    block: DataTableBlock, trigger_id: str
) -> Optional[DataTableSyncTrigger]:
    for trig in block.sync_triggers or []:
        if trig.id == trigger_id:
            return trig
    return None


def _resolve_doc_block(
    db: Session,
    workboard: Workboard,
    screen_id: str,
    block_index: int,
) -> Tuple[Any, Any, DataTableBlock]:
    """Locate the doc screen + data_table block, returning the screen
    along with the block. Raises ``WebhookSyncError`` if not found / wrong
    kind."""
    layout: LayoutJson = screen_runtime.parse_layout(workboard)
    screen = screen_runtime.get_screen(layout, screen_id)
    if screen.kind != "doc" or screen.doc is None:
        raise WebhookSyncError("Screen is not a doc.")
    if block_index < 0 or block_index >= len(screen.doc.blocks):
        raise WebhookSyncError("Block index out of range.")
    block = screen.doc.blocks[block_index]
    if not isinstance(block, DataTableBlock):
        raise WebhookSyncError("Block is not a data_table.")
    return layout, screen, block


# ── Trigger entrypoint ────────────────────────────────────────────────────

def trigger_sync(
    db: Session,
    workboard: Workboard,
    screen_id: str,
    block_index: int,
    trigger_id: str,
    *,
    identity: CallerIdentity,
    app_user_payload: Optional[Dict[str, Any]] = None,
) -> Tuple[str, List[WorkboardSyncRun]]:
    """Create one ``WorkboardSyncRun`` per resolved webhook and schedule
    its background worker. Returns ``(group_id, [runs])``.

    The runs are created in ``pending`` state and committed before this
    function returns so the frontend can immediately poll them. The
    actual HTTP work happens in the asyncio worker."""
    layout, screen, block = _resolve_doc_block(
        db, workboard, screen_id, block_index
    )
    trigger = get_trigger(block, trigger_id)
    if trigger is None:
        raise WebhookSyncError(f"Trigger '{trigger_id}' not found on block.")

    # Visibility check — the trigger may be role-gated.
    if trigger.visible_for_roles and identity.role is not None:
        role_lc = identity.role.lower()
        allowed = {r.lower() for r in trigger.visible_for_roles}
        if role_lc not in allowed:
            raise WebhookSyncError("Trigger not visible to your role.")

    # Resolve every referenced webhook. Skip inactive / missing / wrong-screen
    # ones — webhooks are scoped to a single doc screen (the payload shape is
    # built around that screen), so a webhook bound to a different screen
    # must never run here even if the trigger config still references it.
    runs: List[WorkboardSyncRun] = []
    webhooks: List[WorkboardWebhookConfig] = []
    for wh_id in trigger.webhook_ids:
        cfg = get_webhook_config(workboard, wh_id)
        if cfg is None or not cfg.is_active:
            logger.info(
                "trigger %s on workboard %s skipped webhook %s (missing or inactive)",
                trigger_id, workboard.id, wh_id,
            )
            continue
        if cfg.screen_id and cfg.screen_id != screen_id:
            logger.warning(
                "trigger %s on workboard %s skipped webhook %s (bound to screen '%s', not '%s')",
                trigger_id, workboard.id, wh_id, cfg.screen_id, screen_id,
            )
            continue
        webhooks.append(cfg)
    if not webhooks:
        raise WebhookSyncError("No active webhooks to run.")

    group_id = _new_id("grp")
    triggered_by_app_user_id = None
    triggered_by_user_id = None
    if identity.app_user:
        triggered_by_app_user_id = identity.app_user.get("id")
    elif identity.appbi_user_id:
        triggered_by_user_id = identity.appbi_user_id

    for cfg in webhooks:
        run = WorkboardSyncRun(
            run_id=_new_id("wsr"),
            group_id=group_id,
            workboard_id=workboard.id,
            screen_id=screen_id,
            block_index=block_index,
            trigger_id=trigger_id,
            webhook_id=cfg.id,
            webhook_url=cfg.url,
            webhook_name=cfg.name,
            status="pending",
            triggered_by_app_user_id=triggered_by_app_user_id,
            triggered_by_user_id=triggered_by_user_id,
        )
        db.add(run)
        runs.append(run)
    db.commit()
    for run in runs:
        db.refresh(run)

    _schedule_runs(
        workboard_id=workboard.id,
        screen_id=screen_id,
        block_index=block_index,
        trigger=trigger,
        webhooks=webhooks,
        run_ids=[r.run_id for r in runs],
        app_user_payload=app_user_payload,
        appbi_user_id=identity.appbi_user_id,
    )
    return group_id, runs


def _schedule_runs(
    *,
    workboard_id: int,
    screen_id: str,
    block_index: int,
    trigger: DataTableSyncTrigger,
    webhooks: List[WorkboardWebhookConfig],
    run_ids: List[str],
    app_user_payload: Optional[Dict[str, Any]],
    appbi_user_id: Optional[str],
) -> None:
    """Dispatch background workers based on the trigger's run_mode."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    async def _orchestrator() -> None:
        # Pair webhooks with their corresponding run_ids in declaration order.
        pairs = list(zip(webhooks, run_ids))
        if trigger.run_mode == "parallel":
            await asyncio.gather(
                *[
                    _execute_run(
                        run_id=rid,
                        webhook=wh,
                        workboard_id=workboard_id,
                        screen_id=screen_id,
                        block_index=block_index,
                        app_user_payload=app_user_payload,
                        appbi_user_id=appbi_user_id,
                    )
                    for wh, rid in pairs
                ],
                return_exceptions=True,
            )
        else:
            for wh, rid in pairs:
                terminal_status = await _execute_run(
                    run_id=rid,
                    webhook=wh,
                    workboard_id=workboard_id,
                    screen_id=screen_id,
                    block_index=block_index,
                    app_user_payload=app_user_payload,
                    appbi_user_id=appbi_user_id,
                )
                if (
                    trigger.stop_chain_on_error
                    and terminal_status in {"failed", "partial", "cancelled"}
                ):
                    # Mark all later runs as cancelled so the UI doesn't
                    # leave them dangling forever.
                    later_ids = [r for r, _ in zip(run_ids, pairs)][
                        pairs.index((wh, rid)) + 1 :
                    ]
                    _mark_skipped(later_ids)
                    return

    if loop is not None:
        loop.create_task(_orchestrator())
    else:
        # Not running inside an asyncio loop (e.g. called from sync test
        # harness) — execute inline. Production path always has a loop.
        asyncio.run(_orchestrator())


def _mark_skipped(run_ids: List[str]) -> None:
    if not run_ids:
        return
    db = SessionLocal()
    try:
        runs = (
            db.query(WorkboardSyncRun)
            .filter(WorkboardSyncRun.run_id.in_(run_ids))
            .filter(WorkboardSyncRun.status == "pending")
            .all()
        )
        now = datetime.now(timezone.utc)
        for run in runs:
            run.status = "cancelled"
            run.last_error = "Skipped because an earlier webhook in the chain failed."
            run.finished_at = now
        db.commit()
    finally:
        db.close()


# ── Worker ────────────────────────────────────────────────────────────────

async def _execute_run(
    *,
    run_id: str,
    webhook: WorkboardWebhookConfig,
    workboard_id: int,
    screen_id: str,
    block_index: int,
    app_user_payload: Optional[Dict[str, Any]],
    appbi_user_id: Optional[str],
) -> str:
    """Run one webhook end-to-end and return the terminal status."""
    db = SessionLocal()
    try:
        run = (
            db.query(WorkboardSyncRun)
            .filter(WorkboardSyncRun.run_id == run_id)
            .one_or_none()
        )
        if run is None:
            logger.error("sync run %s vanished before worker started", run_id)
            return "failed"
        wb = (
            db.query(Workboard)
            .filter(Workboard.id == workboard_id)
            .one_or_none()
        )
        if wb is None:
            run.status = "failed"
            run.last_error = "Workboard not found"
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
            return "failed"

        # Build identity from the snapshot passed in at trigger time so
        # the RLS view matches what the user saw on screen.
        from app.modules.workboards.services.rls_service import (
            CallerIdentity as _Identity,
        )
        identity = _Identity(
            appbi_user_id=appbi_user_id,
            app_user=app_user_payload,
        )

        # Re-resolve the doc + block from the *current* workboard (the
        # user can't edit between click and dispatch in the public app).
        try:
            layout, screen, block = _resolve_doc_block(
                db, wb, screen_id, block_index
            )
        except WebhookSyncError as exc:
            run.status = "failed"
            run.last_error = str(exc)
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
            return "failed"

        run.status = "running"
        run.started_at = datetime.now(timezone.utc)
        db.commit()
        started_perf = time.perf_counter()

        # Resolve the data through the same path as the on-screen render.
        data = screen_runtime._resolve_doc_data_block(
            db, wb, screen, block, identity=identity
        )
        columns: List[str] = data.get("columns") or []
        column_labels: Dict[str, str] = data.get("column_labels") or {}
        rows: List[Dict[str, Any]] = data.get("rows") or []

        total_rows = len(rows)
        batch_size = max(1, min(webhook.batch_size, 500))
        total_batches = max(1, (total_rows + batch_size - 1) // batch_size) if total_rows else 1
        run.total_rows = total_rows
        run.total_batches = total_batches
        db.commit()

        headers = {h.key: h.value for h in webhook.headers}
        headers.setdefault("Content-Type", "application/json")
        timeout = httpx.Timeout(webhook.timeout_ms / 1000.0, connect=10.0)

        context_block = {
            "app_user": {
                k: app_user_payload.get(k)
                for k in ("id", "username", "full_name", "role")
                if app_user_payload and k in app_user_payload
            } if app_user_payload else None,
            "triggered_at": run.started_at.isoformat() if run.started_at else None,
        }
        workboard_block = {
            "id": wb.id,
            "slug": wb.slug,
            "name": wb.name,
        }
        screen_block = {
            "id": screen.id,
            "title": screen.title,
        }
        block_block = {
            "index": block_index,
            "title": getattr(block, "title", None),
        }

        async with httpx.AsyncClient(timeout=timeout) as client:
            # Walk batches even when there are zero rows (we still POST an
            # empty payload so receivers can mark a "no-data" sync as
            # processed if they want).
            for batch_idx in range(total_batches):
                # Cooperative cancellation check.
                db.refresh(run)
                if run.cancel_requested:
                    run.status = "cancelled"
                    run.finished_at = datetime.now(timezone.utc)
                    run.duration_ms = int(
                        (time.perf_counter() - started_perf) * 1000
                    )
                    db.commit()
                    return "cancelled"

                start = batch_idx * batch_size
                end = start + batch_size
                batch_rows = rows[start:end] if total_rows else []

                payload = {
                    "run_id": run.run_id,
                    "group_id": run.group_id,
                    "batch": {
                        "index": batch_idx,
                        "total": total_batches,
                        "is_last": batch_idx == total_batches - 1,
                    },
                    "workboard": workboard_block,
                    "screen": screen_block,
                    "block": block_block,
                    "table": {
                        "columns": columns,
                        "column_labels": column_labels,
                        "rows": batch_rows,
                    },
                    "context": context_block,
                    "stats": {
                        "total_rows": total_rows,
                        "batch_rows": len(batch_rows),
                    },
                }

                try:
                    resp = await client.post(
                        webhook.url,
                        headers=headers,
                        json=payload,
                    )
                except httpx.HTTPError as exc:
                    run.failed_batches += 1
                    run.last_error = f"HTTP error on batch {batch_idx}: {exc!s}"[:1000]
                    run.last_response_status = None
                    db.commit()
                    if webhook.stop_on_error:
                        run.status = "failed"
                        run.finished_at = datetime.now(timezone.utc)
                        run.duration_ms = int(
                            (time.perf_counter() - started_perf) * 1000
                        )
                        db.commit()
                        return "failed"
                    continue

                run.last_response_status = resp.status_code
                run.response_excerpt = _excerpt_response(resp)
                if 200 <= resp.status_code < 300:
                    run.completed_batches += 1
                else:
                    run.failed_batches += 1
                    run.last_error = (
                        f"Batch {batch_idx} returned HTTP {resp.status_code}"
                    )
                    if webhook.stop_on_error:
                        run.status = "failed"
                        run.finished_at = datetime.now(timezone.utc)
                        run.duration_ms = int(
                            (time.perf_counter() - started_perf) * 1000
                        )
                        db.commit()
                        return "failed"
                db.commit()

                if webhook.delay_between_batches_ms and batch_idx < total_batches - 1:
                    await asyncio.sleep(webhook.delay_between_batches_ms / 1000.0)

        # Wrap up.
        if run.failed_batches and run.completed_batches:
            run.status = "partial"
        elif run.failed_batches and not run.completed_batches:
            run.status = "failed"
        else:
            run.status = "success"
        run.finished_at = datetime.now(timezone.utc)
        run.duration_ms = int((time.perf_counter() - started_perf) * 1000)
        db.commit()
        return run.status
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception("sync run %s crashed: %s", run_id, exc)
        try:
            run = (
                db.query(WorkboardSyncRun)
                .filter(WorkboardSyncRun.run_id == run_id)
                .one_or_none()
            )
            if run and run.status in {"pending", "running"}:
                run.status = "failed"
                run.last_error = f"Worker crashed: {exc!s}"[:1000]
                run.finished_at = datetime.now(timezone.utc)
                db.commit()
        except Exception:
            db.rollback()
        return "failed"
    finally:
        db.close()


def _excerpt_response(resp: httpx.Response) -> Dict[str, Any]:
    """Truncate response body so the audit row stays under a few KB."""
    body_text = ""
    try:
        body_text = resp.text or ""
    except Exception:
        body_text = ""
    if len(body_text) > _RESPONSE_EXCERPT_BYTES:
        body_text = body_text[:_RESPONSE_EXCERPT_BYTES] + "…"
    parsed: Optional[Any] = None
    if body_text:
        try:
            parsed = json.loads(body_text)
        except Exception:
            parsed = None
    return {
        "status": resp.status_code,
        "body_text": body_text,
        "body_json": parsed,
        "content_type": resp.headers.get("content-type"),
    }


# ── Cancellation ──────────────────────────────────────────────────────────

def request_cancel(db: Session, run_id: str) -> Optional[WorkboardSyncRun]:
    run = (
        db.query(WorkboardSyncRun)
        .filter(WorkboardSyncRun.run_id == run_id)
        .one_or_none()
    )
    if run is None:
        return None
    if run.status in {"pending", "running"}:
        run.cancel_requested = True
        db.commit()
        db.refresh(run)
    return run


def request_cancel_group(db: Session, group_id: str) -> List[WorkboardSyncRun]:
    runs = (
        db.query(WorkboardSyncRun)
        .filter(WorkboardSyncRun.group_id == group_id)
        .all()
    )
    changed: List[WorkboardSyncRun] = []
    for run in runs:
        if run.status in {"pending", "running"}:
            run.cancel_requested = True
            changed.append(run)
    if changed:
        db.commit()
    return runs


# ── Janitor for runs stuck across restarts ────────────────────────────────

def reap_stuck_sync_runs() -> int:
    """Mark every ``pending``/``running`` row as ``failed`` with a clear
    error message. Called once on application startup — there are no
    persistent workers, so any row in those states must be leftover from a
    previous process and can never finish on its own."""
    db = SessionLocal()
    try:
        rows = (
            db.query(WorkboardSyncRun)
            .filter(WorkboardSyncRun.status.in_(["pending", "running"]))
            .all()
        )
        if not rows:
            return 0
        now = datetime.now(timezone.utc)
        for row in rows:
            row.status = "failed"
            row.last_error = (
                "Run was interrupted by a server restart and could not be resumed."
            )
            row.finished_at = now
        db.commit()
        logger.warning("reaped %d stuck workboard sync runs on startup", len(rows))
        return len(rows)
    finally:
        db.close()


# ── Test helper used by the admin "Send test" endpoint ────────────────────

async def test_webhook(
    webhook: WorkboardWebhookConfig,
    sample_rows: int = 3,
    sample_columns: Optional[List[str]] = None,
) -> Dict[str, Any]:
    sample_columns = sample_columns or ["col_a", "col_b"]
    rows = [
        {col: f"sample-{r}-{i}" for i, col in enumerate(sample_columns)}
        for r in range(sample_rows)
    ]
    payload = {
        "run_id": "test_run",
        "group_id": "test_grp",
        "batch": {"index": 0, "total": 1, "is_last": True},
        "workboard": {"id": 0, "slug": "test", "name": "Webhook test"},
        "screen": {"id": "test", "title": "Webhook test"},
        "block": {"index": 0, "title": "Sample data"},
        "table": {
            "columns": sample_columns,
            "column_labels": {},
            "rows": rows,
        },
        "context": {"app_user": None, "triggered_at": datetime.now(timezone.utc).isoformat()},
        "stats": {"total_rows": sample_rows, "batch_rows": sample_rows},
        "_test": True,
    }
    headers = {h.key: h.value for h in webhook.headers}
    headers.setdefault("Content-Type", "application/json")
    timeout = httpx.Timeout(webhook.timeout_ms / 1000.0, connect=10.0)
    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(webhook.url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            return {
                "ok": False,
                "status": None,
                "error": str(exc),
                "duration_ms": int((time.perf_counter() - started) * 1000),
            }
    return {
        "ok": 200 <= resp.status_code < 300,
        "status": resp.status_code,
        "duration_ms": int((time.perf_counter() - started) * 1000),
        "response": _excerpt_response(resp),
    }
