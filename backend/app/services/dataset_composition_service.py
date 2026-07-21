"""Dataset-on-Dataset composition (Phase-2).

A child DatasetTable with source_kind == "dataset" references ONE published
table of a parent dataset. It carries no data of its own: at read time the
planner points its view at the parent's PINNED published snapshot, so the
semantic layer treats it as an ordinary snapshot-backed leaf view (the
calculation engine is source_kind-agnostic — this module never touches it).

This module owns ONLY the plumbing + governance around that reference:
  - discovery of parent-ref tables and the lineage graph,
  - cycle / depth / same-host guards enforced BEFORE an edge or publish,
  - pinning each parent's published generation into dataset_dependencies
    (principle #2: never auto-read latest),
  - cascading children to changes_pending when a parent re-publishes,
  - resolving the parent's pinned snapshot ref for the planner override.

The 6 governance principles (see DatasetGrant / DatasetDependency docstrings)
are enforced across this module + dataset_publish_service + execution_plan.
"""
from __future__ import annotations

import copy
import logging
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.dataset import Dataset, DatasetTable, DatasetDependency

logger = logging.getLogger(__name__)

MAX_COMPOSITION_DEPTH = 5  # child -> parent -> ... chain length cap


# ── edge creation ─────────────────────────────────────────────────────────────
def add_parent_ref_table(
    db: Session,
    child_dataset_id: int,
    parent_dataset_id: int,
    parent_dataset_table_id: int,
    display_name: str,
) -> DatasetTable:
    """Add a source_kind='dataset' table to the child that references ONE table
    of a parent dataset. Runs the cycle/depth/same-host guards, MIRRORS the
    parent table's published columns into the child (so the child's SemanticView
    has the right dimensions/measures), and records the lineage edge (the
    generation pin is filled when the child publishes)."""
    assert_composable(db, child_dataset_id, parent_dataset_id)
    # Semantic-audit 2026-07 (#6) — composition is a PUBLISH-LIFECYCLE feature:
    # a LEGACY child (publish_state IS NULL) never routes through
    # _plan_published, so its parent-ref view would read the parent's CURRENT
    # published generation UNPINNED (violates principle #2 — a parent
    # re-publish silently flips the child's numbers). Require the child to be
    # under the lifecycle before it may reference a parent.
    child = db.query(Dataset).filter(Dataset.id == child_dataset_id).first()
    if child is None:
        raise ValueError(f"Dataset con (id={child_dataset_id}) không tồn tại.")
    if getattr(child, "publish_state", None) is None:
        raise ValueError(
            "Dataset này chưa dùng vòng đời Sync & Publish nên không thể tham chiếu "
            "Dataset khác (tham chiếu cần ghim generation của cha khi publish). "
            "Bấm Sync & Publish cho Dataset này trước, rồi thêm tham chiếu."
        )
    parent = db.query(Dataset).filter(Dataset.id == parent_dataset_id).first()
    if parent is None:
        raise ValueError(f"Dataset cha (id={parent_dataset_id}) không tồn tại.")
    ptable = (
        db.query(DatasetTable)
        .filter(DatasetTable.id == parent_dataset_table_id,
                DatasetTable.dataset_id == parent_dataset_id)
        .first()
    )
    if ptable is None:
        raise ValueError("Bảng cha không tồn tại trong Dataset cha.")

    t = DatasetTable(
        dataset_id=child_dataset_id,
        datasource_id=None,
        source_kind="dataset",
        parent_dataset_id=parent_dataset_id,
        parent_dataset_table_id=parent_dataset_table_id,
        display_name=display_name,
        enabled=True,
        transformations=[],
        query_mode="synced",
        # Mirror the parent table's published columns so the child's semantic
        # view is column-identical to what the parent snapshot exposes.
        columns_cache=copy.deepcopy(ptable.columns_cache) if ptable.columns_cache else None,
        type_overrides=copy.deepcopy(ptable.type_overrides) if ptable.type_overrides else None,
    )
    db.add(t)
    db.flush()

    exists = (
        db.query(DatasetDependency)
        .filter(DatasetDependency.child_dataset_id == child_dataset_id,
                DatasetDependency.parent_dataset_id == parent_dataset_id)
        .first()
    )
    if exists is None:
        db.add(DatasetDependency(child_dataset_id=child_dataset_id,
                                 parent_dataset_id=parent_dataset_id))
    db.commit()
    db.refresh(t)
    return t


# ── discovery ────────────────────────────────────────────────────────────────
def parent_ref_tables(db: Session, dataset_id: int) -> List[DatasetTable]:
    """The child's own tables that reference a parent dataset."""
    return (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == dataset_id,
            DatasetTable.source_kind == "dataset",
            DatasetTable.parent_dataset_id.isnot(None),
        )
        .all()
    )


def parent_dataset_ids(db: Session, dataset_id: int) -> List[int]:
    return sorted({t.parent_dataset_id for t in parent_ref_tables(db, dataset_id) if t.parent_dataset_id})


def child_dataset_ids_of(db: Session, parent_dataset_id: int) -> List[int]:
    """Datasets that reference `parent_dataset_id` as a parent (via edges)."""
    rows = (
        db.query(DatasetDependency.child_dataset_id)
        .filter(DatasetDependency.parent_dataset_id == parent_dataset_id)
        .distinct()
        .all()
    )
    return sorted({r[0] for r in rows})


# ── guards ───────────────────────────────────────────────────────────────────
def would_create_cycle(db: Session, child_id: int, parent_id: int) -> bool:
    """True if adding edge child->parent would create a cycle, i.e. `child` is
    already an ancestor of `parent` (parent can reach child by walking parents)."""
    if child_id == parent_id:
        return True
    seen: set[int] = set()
    stack = [parent_id]
    while stack:
        cur = stack.pop()
        if cur == child_id:
            return True
        if cur in seen:
            continue
        seen.add(cur)
        # parents of `cur`: both persisted edges AND declared parent-ref tables
        for pid in _direct_parents(db, cur):
            stack.append(pid)
    return False


def _direct_parents(db: Session, dataset_id: int) -> List[int]:
    ids = set(parent_dataset_ids(db, dataset_id))
    for r in db.query(DatasetDependency.parent_dataset_id).filter(
        DatasetDependency.child_dataset_id == dataset_id
    ).all():
        if r[0]:
            ids.add(r[0])
    return sorted(ids)


def dependency_depth(db: Session, dataset_id: int, _seen: Optional[set] = None) -> int:
    """Longest parent chain from this dataset. 0 = no parents."""
    _seen = _seen or set()
    if dataset_id in _seen:
        return 0  # defensive: cycle already blocked elsewhere
    _seen = _seen | {dataset_id}
    parents = _direct_parents(db, dataset_id)
    if not parents:
        return 0
    return 1 + max(dependency_depth(db, p, _seen) for p in parents)


def _direct_children(db: Session, dataset_id: int) -> List[int]:
    """Datasets that reference `dataset_id` as a parent — union of persisted
    dependency edges and declared parent-ref tables (mirror of _direct_parents)."""
    ids = set(child_dataset_ids_of(db, dataset_id))
    for r in (
        db.query(DatasetTable.dataset_id)
        .filter(DatasetTable.source_kind == "dataset",
                DatasetTable.parent_dataset_id == dataset_id)
        .distinct()
        .all()
    ):
        if r[0]:
            ids.add(r[0])
    return sorted(ids)


def descendant_depth(db: Session, dataset_id: int, _seen: Optional[set] = None) -> int:
    """Longest CHILD chain below this dataset. 0 = no children.

    Semantic-audit 2026-07 (#8) — the depth cap used to look UP only
    (dependency_depth of the new parent), so growing the chain top-down
    (always adding a fresh topmost parent: A→B, then B→C, then C→D …) saw
    depth 0 every time and sailed past MAX_COMPOSITION_DEPTH. The realized
    chain is ancestors-of-parent + the new edge + descendants-of-child —
    assert_composable now bounds that full length."""
    _seen = _seen or set()
    if dataset_id in _seen:
        return 0  # defensive: cycle already blocked elsewhere
    _seen = _seen | {dataset_id}
    children = _direct_children(db, dataset_id)
    if not children:
        return 0
    return 1 + max(descendant_depth(db, c, _seen) for c in children)


def _host_key(db: Session, dataset_id: int) -> Optional[Tuple[str, str]]:
    """(project, location) of the dataset's BigQuery snapshot host, or None."""
    from app.services import snapshot_service
    host = snapshot_service.resolve_host(db, dataset_id)
    if host is None:
        return None
    cfg = host.config or {}
    proj = str(cfg.get("project_id") or "")
    loc = (snapshot_service._source_location(host) or "").lower()
    return (proj, loc)


def assert_composable(db: Session, child_id: int, parent_id: int) -> None:
    """Raise ValueError if the proposed child->parent composition is illegal:
    self/cycle, depth cap, or a different BigQuery host/location (principle #6 —
    both must live in the same snapshot fabric so the child query can read the
    parent's snapshot by a plain FROM)."""
    if child_id == parent_id:
        raise ValueError("Một Dataset không thể tham chiếu chính nó.")
    if would_create_cycle(db, child_id, parent_id):
        raise ValueError("Tham chiếu này tạo vòng lặp phụ thuộc (cycle) giữa các Dataset.")
    # Depth of the REALIZED chain as if the edge already exists:
    # ancestors-of-parent + the new edge + descendants-of-child. The old
    # parent-only check was bypassable by growing the chain top-down (#8).
    if dependency_depth(db, parent_id) + 1 + descendant_depth(db, child_id) > MAX_COMPOSITION_DEPTH:
        raise ValueError(
            f"Chuỗi phụ thuộc Dataset vượt quá độ sâu tối đa ({MAX_COMPOSITION_DEPTH})."
        )
    ck, pk = _host_key(db, child_id), _host_key(db, parent_id)
    if pk is None:
        raise ValueError("Dataset cha chưa xác định được host BigQuery — không thể compose.")
    if ck is not None and ck != pk:
        raise ValueError(
            "Dataset con và cha phải cùng host/location BigQuery (cùng snapshot fabric). "
            f"con={ck} cha={pk}."
        )


# ── pinning + cascade (publish-time) ──────────────────────────────────────────
def validate_parents_publishable(db: Session, dataset_id: int) -> None:
    """Publish gate: every parent referenced must itself be Published with data,
    same host, and the referenced parent table must resolve at that generation.
    Raises ValueError otherwise (publish → sync_failed with the message)."""
    from app.services import snapshot_service
    for t in parent_ref_tables(db, dataset_id):
        parent = db.query(Dataset).filter(Dataset.id == t.parent_dataset_id).first()
        if parent is None:
            raise ValueError(f"Dataset cha (id={t.parent_dataset_id}) không tồn tại.")
        if parent.publish_state != "published" or parent.published_generation is None:
            raise ValueError(
                f"Dataset cha '{parent.name}' chưa được Publish — publish cha trước khi publish con."
            )
        assert_composable(db, dataset_id, parent.id)
        refs, _fp, _as_of = snapshot_service.resolve_specific_generation_refs(
            db, [t.parent_dataset_table_id], parent.published_generation
        )
        if not refs.get(t.parent_dataset_table_id):
            raise ValueError(
                f"Bảng '{t.display_name}' tham chiếu bảng cha không còn snapshot ở generation đã publish "
                f"của '{parent.name}' — publish lại cha."
            )


def pin_parent_generations(db: Session, dataset_id: int) -> None:
    """After the child publishes successfully, pin each parent's CURRENT
    published generation into dataset_dependencies (principle #2). Upsert one
    edge per (child, parent).

    Semantic-audit 2026-07 (#7) — pinning also RE-MIRRORS each parent-ref
    table's columns from the parent table it points at. The mirror used to be
    frozen at add-time: after the parent renamed/dropped a column and the
    child re-published against the NEW pinned generation, the child's
    SemanticView still exposed the OLD columns → `SELECT old_col FROM
    <new_parent_snapshot>` → BigQuery 400 "Unrecognized name"; new parent
    columns stayed invisible. Re-mirroring at the pin moment keeps the child
    column-identical to the exact generation it is pinned to; the model
    structure resync below folds the fresh columns into the child's view."""
    remirrored = False
    for pid in parent_dataset_ids(db, dataset_id):
        parent = db.query(Dataset).filter(Dataset.id == pid).first()
        if parent is None or parent.published_generation is None:
            continue
        edge = (
            db.query(DatasetDependency)
            .filter(
                DatasetDependency.child_dataset_id == dataset_id,
                DatasetDependency.parent_dataset_id == pid,
            )
            .first()
        )
        if edge is None:
            edge = DatasetDependency(child_dataset_id=dataset_id, parent_dataset_id=pid)
            db.add(edge)
        edge.parent_generation = parent.published_generation
        edge.materialized = False  # we read the parent snapshot in place, no re-extract

    for t in parent_ref_tables(db, dataset_id):
        ptable = (
            db.query(DatasetTable)
            .filter(DatasetTable.id == t.parent_dataset_table_id)
            .first()
        )
        if ptable is None or not ptable.columns_cache:
            continue
        fresh_cols = copy.deepcopy(ptable.columns_cache)
        fresh_ovr = copy.deepcopy(ptable.type_overrides) if ptable.type_overrides else None
        if t.columns_cache != fresh_cols or t.type_overrides != fresh_ovr:
            t.columns_cache = fresh_cols
            t.type_overrides = fresh_ovr
            remirrored = True
    db.flush()

    if remirrored:
        # Fold the fresh columns into the child's SemanticViews (structure-only,
        # non-destructive: measures merged, manual joins untouched). Best-effort —
        # a resync hiccup must not fail the publish; the drift self-heal
        # (schedule_model_drift_check) converges it on the next chart read.
        try:
            from app.services.dataset_model_service import sync_dataset_model_structure

            sync_dataset_model_structure(db, dataset_id, create_model=False)
        except Exception:  # noqa: BLE001
            logger.warning(
                "[composition] column re-mirror model resync failed dataset=%s",
                dataset_id, exc_info=True,
            )


def cascade_children_to_pending(db: Session, parent_dataset_id: int) -> List[int]:
    """After a parent re-publishes (new pinned generation), flip dependent
    children that were Published/Changes-Pending to changes_pending — the child
    keeps serving its OLD pinned parent generation until it re-validates +
    re-publishes (principle #2). Returns the affected child ids."""
    affected: List[int] = []
    for cid in child_dataset_ids_of(db, parent_dataset_id):
        child = db.query(Dataset).filter(Dataset.id == cid).first()
        if child is None:
            continue
        if child.publish_state in ("published", "changes_pending"):
            if child.publish_state != "changes_pending":
                child.publish_state = "changes_pending"
                affected.append(cid)
    if affected:
        db.flush()
    return affected


# ── read-time resolution (planner override) ──────────────────────────────────
def parent_snapshot_overrides(db: Session, dataset_id: int) -> Tuple[Dict[int, str], Optional[str]]:
    """For the planner: {child_table_id -> parent's PINNED snapshot physical_ref}
    plus a blocking message if any parent ref cannot be resolved. The child table
    points straight at the parent's existing snapshot — no re-materialization.

    Returns (overrides, block_message). block_message is None when all resolve."""
    from app.services import snapshot_service
    overrides: Dict[int, str] = {}
    for t in parent_ref_tables(db, dataset_id):
        edge = (
            db.query(DatasetDependency)
            .filter(
                DatasetDependency.child_dataset_id == dataset_id,
                DatasetDependency.parent_dataset_id == t.parent_dataset_id,
            )
            .first()
        )
        pinned = edge.parent_generation if edge else None
        if pinned is None:
            return {}, (
                f"Bảng '{t.display_name}' chưa ghim generation của Dataset cha — Sync & Publish lại Dataset này."
            )
        refs, _fp, _as_of = snapshot_service.resolve_specific_generation_refs(
            db, [t.parent_dataset_table_id], pinned
        )
        ref = refs.get(t.parent_dataset_table_id)
        if not ref:
            return {}, (
                f"Snapshot đã ghim của Dataset cha cho bảng '{t.display_name}' không còn khả dụng "
                f"— Sync & Publish lại Dataset này."
            )
        overrides[t.id] = ref
    return overrides, None


def pinned_parent_generations(db: Session, parent_dataset_id: int) -> List[int]:
    """Generations of `parent_dataset_id` that are pinned by at least one child —
    GC must never retire these out from under a child (principle #2)."""
    rows = (
        db.query(DatasetDependency.parent_generation)
        .filter(
            DatasetDependency.parent_dataset_id == parent_dataset_id,
            DatasetDependency.parent_generation.isnot(None),
        )
        .distinct()
        .all()
    )
    return sorted({int(r[0]) for r in rows if r[0] is not None})
