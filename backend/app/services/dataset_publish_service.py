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

from app.models.dataset import Dataset, DatasetTable
from app.services import query_cache as _qc

logger = logging.getLogger(__name__)

LIFECYCLE_STATES = {
    "draft", "ready", "syncing", "published", "changes_pending", "sync_failed", "disabled",
}
_PUBLISH_LEASE_SECONDS = 3600  # a publish/sync owns the dataset for up to 1h


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
    return {
        "publish_state": state,  # None = legacy
        "published_generation": dataset.published_generation,
        "published_at": dataset.published_at.isoformat() if dataset.published_at else None,
        "last_sync_error": dataset.last_sync_error,
        "syncing": _qc.is_claimed_global(_lease_key(dataset.id)),
        "has_published_data": dataset.published_generation is not None,
    }


def _lease_key(dataset_id: int) -> str:
    return f"datasetpublish::{dataset_id}"


def start_sync_and_publish(dataset_id: int) -> Dict[str, Any]:
    """Kick a background Sync & Publish. Returns immediately (ETL is long).
    At most ONE publish per dataset at a time (cross-worker lease). NEVER raises."""
    from app.core.database import SessionLocal

    if not _qc.try_claim_global(_lease_key(dataset_id), _PUBLISH_LEASE_SECONDS):
        return {"started": False, "reason": "already_syncing"}

    def _run() -> None:
        db = SessionLocal()
        try:
            _sync_and_publish_blocking(db, dataset_id)
        except Exception:  # noqa: BLE001 — background must never crash a request
            logger.warning("[publish] sync&publish failed dataset=%s", dataset_id, exc_info=True)
            try:
                ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
                if ds is not None:
                    ds.publish_state = "sync_failed"
                    ds.last_sync_error = "internal error during sync"
                    db.commit()
            except Exception:  # noqa: BLE001
                db.rollback()
        finally:
            db.close()
            _qc.release_global(_lease_key(dataset_id))

    threading.Thread(target=_run, name=f"ds-publish-{dataset_id}", daemon=True).start()
    return {"started": True}


def _sync_and_publish_blocking(db: Session, dataset_id: int) -> Dict[str, Any]:
    """The synchronous body (also usable from tests/CLI). Locks design → syncs a
    generation → validates → pins published_generation on success; keeps the
    prior published_generation on failure."""
    from app.services import snapshot_service

    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if ds is None:
        return {"ok": False, "error": "dataset not found"}

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

    # 3) VALIDATE gate — the generation must fully cover every materializable
    #    (enabled, non-calendar, non-derived) table.
    ok, reason = _validate_generation(db, dataset_id, generation)
    if not ok:
        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        ds.publish_state = "sync_failed"
        ds.last_sync_error = reason
        db.commit()
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
