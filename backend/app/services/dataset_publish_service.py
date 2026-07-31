"""
Dataset publish lifecycle (Phase 1 — Import-mode: design on source →
Sync & Publish → Dashboards read ONLY the published snapshot generation).

States: draft | ready | syncing | published | changes_pending | sync_failed | disabled
A dataset with publish_state=NULL is LEGACY (pre-Phase-1) and keeps the old
live/opt-in-snapshot behaviour — this module + the planner only impose
published-only semantics on datasets explicitly taken through Sync & Publish.

Sync & Publish (the ONLY way a design reaches Dashboards):
  1. LOCK the design → capture design_fingerprint of tables/schema/relationships/
     measures/transforms.
  2. SYNC → build one complete snapshot GENERATION (reuses
     snapshot_service.refresh_all_for_dataset — it already stamps a generation,
     runs delayed GC, and records host identity).
  3. VALIDATE gate → every materializable table has a ready snapshot in that
     generation + the semantic model resolves.
  4. PUBLISH only on success → pin published_generation + published_at +
     published_design_fingerprint. On FAILURE: publish_state=sync_failed,
     published_generation UNCHANGED (Dashboards keep the prior published data;
     NEVER auto-switch to a half-built generation or fall back to live).

Changes Pending: after publish, any design edit changes the live
design_fingerprint; `refresh_publish_state` flips published → changes_pending so
the UI shows "unsynced changes" while Dashboards keep serving published_generation.
"""
from __future__ import annotations

import hashlib
import logging
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.dataset import Dataset, DatasetTable, DatasetRefreshRun
from app.services import query_cache as _qc

logger = logging.getLogger(__name__)

LIFECYCLE_STATES = {
    "draft", "ready", "syncing", "published", "changes_pending", "sync_failed", "disabled",
}
_PUBLISH_LEASE_SECONDS = 3600  # a publish/sync owns the dataset for up to 1h
_REFRESH_RUN_KEEP = 50  # rolling history depth per dataset


# ── Refresh-run history log ──────────────────────────────────────────────────
# One row per Sync & Publish / scheduled refresh, opened at start and flipped to
# a terminal status at EVERY exit (incl. the background crash handler). Powers
# the "Refresh history" modal. Best-effort throughout — history logging must
# NEVER break or roll back the actual sync.

def _refresh_run_start(
    db: Session,
    dataset_id: int,
    trigger: str,
    triggered_by_id: Optional[str] = None,
    timezone: Optional[str] = None,
) -> Optional[int]:
    try:
        run = DatasetRefreshRun(
            dataset_id=dataset_id,
            status="running",
            trigger=(trigger or "manual"),
            triggered_by_id=triggered_by_id,
            timezone=(str(timezone).strip() or None) if timezone else None,
            started_at=datetime.utcnow(),
            created_at=datetime.utcnow(),
        )
        db.add(run)
        db.commit()
        run_id = run.id
        _prune_refresh_runs(db, dataset_id)
        return run_id
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("[publish] refresh-run start-log failed dataset=%s", dataset_id, exc_info=True)
        return None


def _refresh_run_finish(
    db: Session,
    run_id: Optional[int],
    status: str,
    *,
    error: Optional[str] = None,
    generation: Optional[int] = None,
    tables_built: Optional[int] = None,
    rows_total: Optional[int] = None,
    tables: Optional[list] = None,
) -> None:
    """Flip a run to a terminal status. Idempotent — only updates a still-running
    row, so a crash-handler call after a normal terminal finalize is a no-op."""
    if run_id is None:
        return
    try:
        run = db.query(DatasetRefreshRun).filter(DatasetRefreshRun.id == run_id).first()
        if run is None or run.status != "running":
            return
        run.status = status
        run.finished_at = datetime.utcnow()
        if run.started_at is not None:
            run.duration_ms = int((run.finished_at - run.started_at).total_seconds() * 1000)
        if error is not None:
            run.error = str(error)[:4000]
        if generation is not None:
            run.generation = generation
        if tables_built is not None:
            run.tables_built = tables_built
        if rows_total is not None:
            run.rows_total = rows_total
        if tables is not None:
            run.tables = tables
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("[publish] refresh-run finish-log failed run=%s", run_id, exc_info=True)


def _prune_refresh_runs(db: Session, dataset_id: int) -> None:
    """Keep only the most recent ``_REFRESH_RUN_KEEP`` runs per dataset."""
    try:
        old = [
            r.id
            for r in db.query(DatasetRefreshRun.id)
            .filter(DatasetRefreshRun.dataset_id == dataset_id)
            .order_by(DatasetRefreshRun.id.desc())
            .offset(_REFRESH_RUN_KEEP)
            .all()
        ]
        if old:
            db.query(DatasetRefreshRun).filter(DatasetRefreshRun.id.in_(old)).delete(
                synchronize_session=False
            )
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


def _refresh_run_rows_total(dataset_id: int) -> Optional[int]:
    """Best-effort rows-synced count for a finished run, from sync progress."""
    try:
        from app.services import sync_progress
        snap = sync_progress.get(dataset_id) or {}
        val = snap.get("rows_done_total")
        return int(val) if val is not None else None
    except Exception:  # noqa: BLE001
        return None


def reconcile_stuck_runs(db: Session, dataset_id: Optional[int] = None, force: bool = False) -> int:
    """Self-heal orphaned refresh-run rows. A run left ``running`` by a process
    crash / restart (its terminal finalize + the background crash handler never
    ran) would otherwise spin forever in history and can't be stopped. A run is a
    GENUINE in-flight sync only while its dataset holds the publish LEASE (a live
    sync claims it at start, releases it at end; a hard crash lets it lapse by
    TTL, and the startup reaper frees it). So any ``running`` row whose dataset
    does NOT hold the lease is stale → flip it to ``failed`` (and un-stick a
    ``syncing`` publish_state the same way). A long real sync keeps its lease, so
    it is never touched. Called lazily on read (GET /refresh-runs → self-heals
    without a restart, once the lease has lapsed) and on startup by
    ``reap_stuck_syncs``. NEVER raises."""
    n = 0
    try:
        q = db.query(DatasetRefreshRun).filter(DatasetRefreshRun.status == "running")
        if dataset_id is not None:
            q = q.filter(DatasetRefreshRun.dataset_id == dataset_id)
        for run in q.all():
            if not force and _qc.is_claimed_global(_lease_key(run.dataset_id)):
                continue  # a live sync holds the lease — genuinely in flight
            if force:
                # Startup: a fresh process runs no sync, so a still-claimed lease
                # is a crash leftover — free it so it can't block the next sync.
                try:
                    _qc.release_global(_lease_key(run.dataset_id))
                except Exception:  # noqa: BLE001
                    pass
            run.status = "failed"
            run.finished_at = run.finished_at or datetime.utcnow()
            if run.started_at is not None and run.duration_ms is None:
                run.duration_ms = int((run.finished_at - run.started_at).total_seconds() * 1000)
            if not run.error:
                run.error = (
                    "Bị gián đoạn (tiến trình dừng / khởi động lại) — refresh không "
                    "hoàn tất. Chạy lại Sync & Publish."
                )
            # Un-stick a publish_state left at 'syncing' by the same crash.
            ds = db.query(Dataset).filter(Dataset.id == run.dataset_id).first()
            if ds is not None and str(getattr(ds, "publish_state", None) or "") == "syncing":
                ds.publish_state = "published" if ds.published_generation is not None else "sync_failed"
                if ds.published_generation is None:
                    ds.last_sync_error = ds.last_sync_error or "Sync bị gián đoạn — chạy lại."
            n += 1
        if n:
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("[publish] reconcile_stuck_runs failed", exc_info=True)
    return n


def stop_refresh_run(db: Session, dataset_id: int, run_id: int) -> Dict[str, Any]:
    """Stop a running refresh from the history modal. If a sync is genuinely in
    flight (lease held), ask it to stop — it settles to 'stopped' between tables.
    Otherwise the row is an orphan (crashed) → reconcile it immediately so the
    user isn't stuck watching a spinner that can never stop. NEVER raises."""
    try:
        run = db.query(DatasetRefreshRun).filter(
            DatasetRefreshRun.id == run_id, DatasetRefreshRun.dataset_id == dataset_id
        ).first()
        if run is None:
            return {"ok": False, "reason": "not_found"}
        if run.status != "running":
            return {"ok": True, "status": run.status}  # already settled
        if _qc.is_claimed_global(_lease_key(dataset_id)):
            # Live sync — cooperative stop (settles between tables); the run's own
            # terminal branch records status='stopped'.
            from app.services import sync_control, sync_progress
            sync_control.request_stop(dataset_id)
            sync_progress.set_phase(dataset_id, "stopping")
            return {"ok": True, "status": "stopping"}
        # Orphan — reconcile this run now.
        reconcile_stuck_runs(db, dataset_id)
        db.refresh(run)
        return {"ok": True, "status": run.status}
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("[publish] stop_refresh_run failed run=%s", run_id, exc_info=True)
        return {"ok": False, "reason": str(exc)[:200]}


def _refresh_run_tables(db: Session, dataset_id: int, built: Optional[list]) -> Optional[list]:
    """Per-table breakdown for the run detail view: enrich the builder's
    ``built:[{table_id,row_count,build_ms}]`` with each table's display name.
    Best-effort — returns None on any error."""
    if not built:
        return None
    try:
        names = {
            t.id: (t.display_name or t.source_table_name or f"table_{t.id}")
            for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()
        }
        out = []
        for b in built:
            if not isinstance(b, dict):
                continue
            tid = b.get("table_id")
            out.append({
                "table_id": tid,
                "name": names.get(tid, f"table_{tid}"),
                "rows": b.get("row_count"),
                "build_ms": b.get("build_ms"),
            })
        return out or None
    except Exception:  # noqa: BLE001
        return None


def design_fingerprint(db: Session, dataset_id: int) -> str:
    """sha256 of the LOCKED design — tables (source kind/name/query + column
    name:type + transforms + type overrides) and the semantic model
    (view dimensions/measures + explore joins). Stable across ordering. A change
    here after publish ⇒ changes_pending."""
    import app.models.semantic as sem

    parts: List[str] = []
    tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .order_by(DatasetTable.id)
        .all()
    )
    for t in tables:
        cols = []
        cc = t.columns_cache if isinstance(t.columns_cache, dict) else {}
        for c in (cc.get("columns") or []):
            if isinstance(c, dict) and c.get("name"):
                cols.append("%s:%s:%s" % (
                    c.get("name"), c.get("type") or "", c.get("source_type") or ""))
        parts.append("|".join([
            "T", str(t.id), str(getattr(t, "enabled", True)),
            str(t.source_kind), str(t.source_table_name or ""),
            str(t.source_query or ""),
            _stable(t.transformations), _stable(t.type_overrides),
            ",".join(sorted(cols)),
        ]))
    # Composition: fold each parent's CURRENT published generation into the
    # fingerprint. A parent re-publish changes only the parent's generation (not
    # the child's own design), so without this refresh_publish_state would flip
    # the cascade's changes_pending back to published on the next read. With it,
    # the drift is detected lazily and the child stays changes_pending until it
    # re-validates + re-publishes against the new parent generation (principle #2).
    for t in tables:
        if getattr(t, "source_kind", None) == "dataset":
            parent = db.query(Dataset).filter(Dataset.id == t.parent_dataset_id).first()
            gen = getattr(parent, "published_generation", None) if parent else None
            parts.append("P|%s|%s|%s" % (t.id, t.parent_dataset_id, gen))
    model = db.query(sem.SemanticModel).filter(sem.SemanticModel.dataset_id == dataset_id).first()
    if model is not None:
        views = (
            db.query(sem.SemanticView)
            .filter(sem.SemanticView.dataset_table_id.in_([t.id for t in tables]))
            .order_by(sem.SemanticView.id)
            .all()
        )
        for v in views:
            parts.append("V|%s|%s|%s" % (v.name, _stable(v.dimensions), _stable(v.measures)))
        explores = (
            db.query(sem.SemanticExplore)
            .filter(sem.SemanticExplore.model_id == model.id)
            .order_by(sem.SemanticExplore.id)
            .all()
        )
        for e in explores:
            parts.append("E|%s|%s" % (e.base_view_name, _stable(e.joins)))
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def _stable(v: Any) -> str:
    import json
    try:
        return json.dumps(v, sort_keys=True, default=str, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        return str(v)


def refresh_publish_state(db: Session, dataset: Dataset, *, commit: bool = True) -> Optional[str]:
    """Recompute the state that depends on live design (published → changes_pending
    when the design drifted from what was published). Idempotent; NEVER raises.
    Returns the (possibly updated) state, or None for a legacy dataset."""
    state = dataset.publish_state
    if state is None:
        return None  # legacy — untouched
    try:
        if state in ("published", "changes_pending") and dataset.published_design_fingerprint:
            current = design_fingerprint(db, dataset.id)
            new_state = "published" if current == dataset.published_design_fingerprint else "changes_pending"
            if new_state != state:
                dataset.publish_state = new_state
                if commit:
                    db.commit()
                return new_state
    except Exception:  # noqa: BLE001 — never break a read
        db.rollback()
    return dataset.publish_state


def get_publish_info(db: Session, dataset: Dataset) -> Dict[str, Any]:
    """UI payload: current state (+ live changes-pending recompute), pinned
    generation, timestamps, and whether a sync is in flight."""
    state = refresh_publish_state(db, dataset)
    from app.services import sync_progress
    from app.models.dataset import DatasetTableSnapshot

    syncing = _qc.is_claimed_global(_lease_key(dataset.id))
    # has_prior_complete = at least one COMPLETE generation already exists (pinned
    # published gen, or a current-ready builder snapshot). Drives the FE decision:
    # serve-stale (correct last-complete) vs FIRST-sync (show partial + warn).
    has_prior_complete = dataset.published_generation is not None
    if not has_prior_complete:
        has_prior_complete = (
            db.query(DatasetTableSnapshot.id)
            .filter(
                DatasetTableSnapshot.dataset_id == dataset.id,
                DatasetTableSnapshot.is_current.is_(True),
                DatasetTableSnapshot.status == "ready",
            )
            .first()
            is not None
        )
    return {
        "publish_state": state,  # None = legacy
        "published_generation": dataset.published_generation,
        "published_at": dataset.published_at.isoformat() if dataset.published_at else None,
        "last_sync_error": dataset.last_sync_error,
        "syncing": syncing,
        "stoppable": syncing,  # a stop can be requested only while a sync is live
        "has_published_data": dataset.published_generation is not None,
        "has_prior_complete": has_prior_complete,
        # Live progress for the manual Sync & Publish waiting UI (None when idle).
        "progress": sync_progress.get(dataset.id),
    }


def _lease_key(dataset_id: int) -> str:
    return f"datasetpublish::{dataset_id}"


def start_sync_and_publish(
    dataset_id: int,
    trigger: str = "manual",
    triggered_by_id: Optional[str] = None,
    timezone: Optional[str] = None,
) -> Dict[str, Any]:
    """Kick a background Sync & Publish. Returns immediately (ETL is long).
    At most ONE publish per dataset at a time (cross-worker lease). NEVER raises.
    `trigger` ('manual'|'scheduled') is surfaced in the progress payload so the UI
    shows the waiting overlay only for the manual sync the user just started, and
    recorded on the refresh-run history row."""
    from app.core.database import SessionLocal
    from app.services import sync_progress

    if not _qc.try_claim_global(_lease_key(dataset_id), _PUBLISH_LEASE_SECONDS):
        return {"started": False, "reason": "already_syncing"}

    sync_progress.start(dataset_id, total=0, trigger=trigger)

    def _run() -> None:
        db = SessionLocal()
        # Open the history row HERE (before the blocking body) so the crash
        # handler below can finalize it even if the body raises before its own
        # terminal-branch finalize runs.
        run_id = _refresh_run_start(db, dataset_id, trigger, triggered_by_id, timezone)
        try:
            _sync_and_publish_blocking(
                db, dataset_id, trigger=trigger, triggered_by_id=triggered_by_id,
                run_id=run_id, timezone=timezone,
            )
        except Exception:  # noqa: BLE001 — background must never crash a request
            logger.warning("[publish] sync&publish failed dataset=%s", dataset_id, exc_info=True)
            try:
                ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
                if ds is not None:
                    ds.publish_state = "sync_failed"
                    ds.last_sync_error = "internal error during sync"
                    db.commit()
                sync_progress.set_phase(dataset_id, "failed")
            except Exception:  # noqa: BLE001
                db.rollback()
            # Idempotent: no-op if a terminal branch already finalized the row.
            _refresh_run_finish(db, run_id, "failed", error="internal error during sync")
        finally:
            db.close()
            _qc.release_global(_lease_key(dataset_id))
            from app.services import sync_control
            sync_control.clear_stop(dataset_id)

    threading.Thread(target=_run, name=f"ds-publish-{dataset_id}", daemon=True).start()
    return {"started": True}


def reap_stuck_syncs() -> int:
    """Startup reaper: a fresh process means NO sync is actually running, so any
    dataset left in 'syncing' is a crash/restart casualty — it would otherwise
    show "Syncing…" forever and block new syncs until the 1h lease TTL expires
    (the lease lives in shared sqlite and survives a restart). Release the stale
    publish lease + reset the state to its safe prior value. Mirrors the workboard
    stuck-run reaper. NEVER raises."""
    from app.core.database import SessionLocal
    db = SessionLocal()
    n = 0
    try:
        stuck = db.query(Dataset).filter(Dataset.publish_state == "syncing").all()
        for ds in stuck:
            _qc.release_global(_lease_key(ds.id))
            if ds.published_generation is not None:
                ds.publish_state = "published"  # keep serving the pinned gen
            else:
                ds.publish_state = "sync_failed"
                ds.last_sync_error = "Sync bị gián đoạn (server restart) — bấm Sync & Publish để chạy lại."
            n += 1
        if n:
            db.commit()
            logger.info("[publish] reaped %d stuck 'syncing' dataset(s) on startup", n)
        # Also reconcile any refresh-run rows left 'running' by the crash/restart
        # (a fresh process runs no sync → force) so history never shows a spinner
        # that can't be stopped.
        r = reconcile_stuck_runs(db, force=True)
        if r:
            logger.info("[publish] reconciled %d stuck 'running' refresh-run(s) on startup", r)
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("[publish] reap_stuck_syncs failed", exc_info=True)
    finally:
        db.close()
    return n


def _sync_and_publish_blocking(
    db: Session,
    dataset_id: int,
    trigger: str = "manual",
    triggered_by_id: Optional[str] = None,
    run_id: Optional[int] = None,
    timezone: Optional[str] = None,
) -> Dict[str, Any]:
    """The synchronous body (also usable from tests/CLI). Locks design → syncs a
    generation → validates → pins published_generation on success; keeps the
    prior published_generation on failure.

    Records a refresh-run history row (opened by the caller and threaded in via
    ``run_id``, or opened here for direct/test callers) and flips it to a
    terminal status at every exit."""
    from app.services import snapshot_service

    # Direct/test callers don't pre-open a run row — do it here so history is
    # recorded regardless of entry point.
    if run_id is None:
        run_id = _refresh_run_start(db, dataset_id, trigger, triggered_by_id, timezone)

    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if ds is None:
        _refresh_run_finish(db, run_id, "failed", error="dataset not found")
        return {"ok": False, "error": "dataset not found"}

    # Fresh run — drop any stale Stop flag so a prior cancel can't kill this sync.
    from app.services import sync_control
    sync_control.clear_stop(dataset_id)

    ds.publish_state = "syncing"
    ds.last_sync_error = None
    if ds.security_scope is None:
        ds.security_scope = "shared"  # Phase 1: all authorized viewers see same rows
    db.commit()

    # 0) COMPOSITION pre-flight — every referenced parent must be Published, on
    #    the same BQ host, resolvable at its pinned generation, and the edge must
    #    not form a cycle / exceed depth. Fail LOUD (sync_failed) rather than
    #    publish a child pointing at a missing/unpublished parent (principles #2/#6).
    try:
        from app.services import dataset_composition_service as _comp
        _comp.validate_parents_publishable(db, dataset_id)
    except ValueError as exc:
        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        ds.publish_state = "sync_failed"
        ds.last_sync_error = str(exc)
        db.commit()
        from app.services import sync_progress as _spf
        _spf.set_phase(dataset_id, "failed")
        _refresh_run_finish(db, run_id, "failed", error=str(exc))
        logger.warning("[publish] composition pre-flight FAILED dataset=%s: %s", dataset_id, exc)
        return {"ok": False, "error": str(exc)}

    # 1) LOCK the design fingerprint NOW (before ETL) so a mid-sync edit doesn't
    #    silently publish a different design than was validated.
    locked_fp = design_fingerprint(db, dataset_id)

    # 2) SYNC — build one complete generation (reuses the proven builder).
    result = snapshot_service.refresh_all_for_dataset(db, dataset_id, force=True)
    generation = result.get("generation")
    built = result.get("built") or []
    skipped = result.get("skipped") or []

    # Stop requested mid-sync → do NOT validate/publish. The interrupted
    # generation is incomplete; keep the prior published generation pinned
    # (readers serve-stale, correct numbers) and revert the transient state.
    if result.get("stopped"):
        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if ds is not None:
            ds.publish_state = "published" if ds.published_generation is not None else "draft"
            ds.last_sync_error = None
            db.commit()
        from app.services import sync_progress as _spstop
        _spstop.set_phase(dataset_id, "stopped")
        _refresh_run_finish(
            db, run_id, "stopped", generation=generation,
            tables_built=len(built), rows_total=_refresh_run_rows_total(dataset_id),
            tables=_refresh_run_tables(db, dataset_id, built),
        )
        logger.info("[publish] sync STOPPED by user dataset=%s (kept generation=%s)",
                    dataset_id, ds.published_generation if ds is not None else None)
        return {"ok": False, "stopped": True, "generation": generation,
                "built": built, "skipped": skipped}

    # 3) VALIDATE gate — the generation must fully cover every materializable
    #    (enabled, non-calendar, non-derived) table.
    from app.services import sync_progress
    sync_progress.set_phase(dataset_id, "validating")
    ok, reason = _validate_generation(db, dataset_id, generation)
    if not ok:
        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        ds.publish_state = "sync_failed"
        ds.last_sync_error = reason
        db.commit()
        sync_progress.set_phase(dataset_id, "failed")
        _refresh_run_finish(
            db, run_id, "failed", error=reason, generation=generation,
            tables_built=len(built), rows_total=_refresh_run_rows_total(dataset_id),
            tables=_refresh_run_tables(db, dataset_id, built),
        )
        logger.warning("[publish] validate FAILED dataset=%s gen=%s: %s", dataset_id, generation, reason)
        return {"ok": False, "error": reason, "generation": generation,
                "built": built, "skipped": skipped}

    # 4) PUBLISH — pin the new generation. Bust cached results so Dashboards
    #    pick up the new published generation immediately.
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    ds.published_generation = generation
    ds.published_at = datetime.utcnow()
    ds.published_design_fingerprint = locked_fp
    ds.publish_state = "published"
    ds.last_sync_error = None
    db.commit()
    try:
        for dsid in {t.datasource_id for t in db.query(DatasetTable).filter(
                DatasetTable.dataset_id == dataset_id).all() if t.datasource_id}:
            _qc.invalidate_datasource(dsid)
    except Exception:  # noqa: BLE001
        pass
    # 5) COMPOSITION — pin each parent's CURRENT published generation into
    #    dataset_dependencies (principle #2: the child reads this pin forever,
    #    never "latest"), then flip any downstream children of THIS dataset to
    #    changes_pending (they keep serving their OLD pin until they re-publish).
    try:
        from app.services import dataset_composition_service as _comp
        _comp.pin_parent_generations(db, dataset_id)
        affected = _comp.cascade_children_to_pending(db, dataset_id)
        db.commit()
        if affected:
            logger.info("[publish] cascade: children %s -> changes_pending (parent %s re-published)",
                        affected, dataset_id)
    except Exception:  # noqa: BLE001 — pin/cascade must never corrupt a good publish
        logger.warning("[publish] composition pin/cascade failed for %s", dataset_id, exc_info=True)
        db.rollback()

    sync_progress.set_phase(dataset_id, "done")
    _refresh_run_finish(
        db, run_id, "success", generation=generation,
        tables_built=len(built), rows_total=_refresh_run_rows_total(dataset_id),
        tables=_refresh_run_tables(db, dataset_id, built),
    )
    logger.info("[publish] PUBLISHED dataset=%s generation=%s (%d tables)", dataset_id, generation, len(built))
    return {"ok": True, "generation": generation, "built": built, "skipped": skipped}


def _validate_generation(db: Session, dataset_id: int, generation: Optional[int]) -> tuple[bool, Optional[str]]:
    """The publish gate: the built generation must exist AND cover every
    materializable table; the semantic model must resolve."""
    from app.services import snapshot_service
    from app.services.dataset_calendar_service import is_generated_calendar_table

    if not generation:
        return False, "Sync không tạo được generation nào (không có bảng để đồng bộ hoặc build lỗi)."
    tables = db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()
    # The calendar is materialized best-effort (its snapshot is used when present,
    # else the engine falls back to inline calendar SQL), so it is NOT part of the
    # mandatory coverage gate — a calendar-build hiccup must not fail a publish.
    want = [
        t.id for t in tables
        if not is_generated_calendar_table(t)
        and snapshot_service.is_federated_materializable(t)
        and getattr(t, "enabled", True) is not False
    ]
    if not want:
        # A pure-composition dataset (all data from parent datasets) has no own
        # materializable tables — valid as long as it references at least one parent.
        from app.services import dataset_composition_service as _comp
        if _comp.parent_ref_tables(db, dataset_id):
            import app.models.semantic as sem
            if db.query(sem.SemanticModel).filter(sem.SemanticModel.dataset_id == dataset_id).first() is None:
                return False, "Dataset chưa có semantic model — chạy Generate Model trước khi publish."
            return True, None
        return False, "Dataset không có bảng nào materialize được để publish."
    refs, _fps, _asof = snapshot_service.resolve_specific_generation_refs(db, want, generation)
    if not refs:
        missing = [tid for tid in want]  # resolve returns empty if ANY missing
        return False, f"Generation {generation} chưa phủ đủ {len(missing)} bảng — build có bảng lỗi."
    # semantic model must exist + resolve views for the base tables
    import app.models.semantic as sem
    model = db.query(sem.SemanticModel).filter(sem.SemanticModel.dataset_id == dataset_id).first()
    if model is None:
        return False, "Dataset chưa có semantic model — chạy Generate Model trước khi publish."
    return True, None
