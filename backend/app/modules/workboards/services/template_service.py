"""Workboard export / import — for template libraries.

Two flows:

* **Export**: snapshot a workboard's layout + every dataset table it
  references into a self-contained JSON bundle. The snapshot embeds
  source_table_name + column metadata so the import target can rebuild
  the foreign-key graph even if it lives on a different AppBI instance.

* **Import**: read a bundle, walk every ``table_id`` in the layout, and
  rewrite each one to the matching table on the target dataset (matched
  by ``source_table_name``). Tables that don't have a match are left as
  ``null`` — the workboard is created in a "needs config" state that the
  builder UI surfaces with a status dot, instead of failing the import.

The bundle format is intentionally permissive (``extra="ignore"``) so older
exports keep working as we add fields.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models.dataset import Dataset, DatasetTable
from app.modules.workboards.models import Workboard

logger = get_logger(__name__)

BUNDLE_VERSION = 1


def _columns_from_cache(cache: Any) -> List[Dict[str, Any]]:
    """Normalise the polymorphic ``DatasetTable.columns_cache`` field.

    The metadata service stores either a flat ``[{name, type, nullable}, ...]``
    list (older datasets) or a dict ``{"columns": [...], "source_columns": [...],
    "source_signature": {...}}`` (newer ones with refresh tracking). Always
    return the column list so callers don't have to branch.
    """
    if not cache:
        return []
    if isinstance(cache, list):
        return cache
    if isinstance(cache, dict):
        cols = cache.get("columns")
        if isinstance(cols, list):
            return cols
    return []


# ── Export ────────────────────────────────────────────────────────────────


def _collect_table_ids_from_layout(layout: Dict[str, Any]) -> set[int]:
    """Walk the layout JSON and return every dataset_table id referenced."""
    out: set[int] = set()

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "table_id" and isinstance(v, int):
                    out.add(v)
                elif k == "source" and isinstance(v, str) and v.startswith("lookup:"):
                    try:
                        out.add(int(v.split(":", 1)[1]))
                    except ValueError:
                        pass
                else:
                    _walk(v)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(layout or {})
    return out


def export_workboard(db: Session, workboard: Workboard) -> Dict[str, Any]:
    """Build the export bundle dict for a workboard."""
    layout = workboard.layout_json or {}

    # Collect table ids that appear in the layout, plus the workboard's own
    # primary_table_id (it doesn't always show up in screens[]).
    table_ids = _collect_table_ids_from_layout(layout)
    if workboard.primary_table_id:
        table_ids.add(workboard.primary_table_id)

    tables_meta: Dict[str, Dict[str, Any]] = {}
    if table_ids:
        rows = (
            db.query(DatasetTable, Dataset)
            .join(Dataset, Dataset.id == DatasetTable.dataset_id)
            .filter(DatasetTable.id.in_(list(table_ids)))
            .all()
        )
        for t, ds in rows:
            tables_meta[str(t.id)] = {
                "dataset_name": ds.name,
                "source_table_name": t.source_table_name,
                "display_name": t.display_name,
                "source_kind": t.source_kind,
                "columns": [
                    {"name": c.get("name"), "type": c.get("type")}
                    for c in _columns_from_cache(t.columns_cache)
                    if isinstance(c, dict) and c.get("name")
                ],
            }

    dataset = (
        db.query(Dataset).filter(Dataset.id == workboard.dataset_id).first()
        if workboard.dataset_id
        else None
    )

    return {
        "bundle_version": BUNDLE_VERSION,
        "kind": "workboard_template",
        "exported_at_iso": _now_iso(),
        "workboard": {
            "name": workboard.name,
            "slug": workboard.slug,
            "description": workboard.description,
            "icon": workboard.icon,
            "primary_key_columns": list(workboard.primary_key_columns or []),
            "is_published": False,  # template starts as draft on import
            "version": workboard.version,
            "settings": workboard.settings,
        },
        "dataset": {
            "name": dataset.name if dataset else None,
            "description": dataset.description if dataset else None,
        },
        "primary_table_id": workboard.primary_table_id,
        "tables_meta": tables_meta,
        "layout_json": layout,
    }


# ── Import ────────────────────────────────────────────────────────────────


class ImportReport:
    """Aggregated state about what survived import and what didn't."""

    def __init__(self) -> None:
        self.matched_tables: List[Dict[str, Any]] = []
        self.missing_tables: List[Dict[str, Any]] = []
        # Columns referenced in form fields / list columns / doc tables that
        # don't exist in the resolved table; surfaced as warnings (not errors).
        self.missing_columns: List[Dict[str, Any]] = []

    def to_dict(self) -> Dict[str, Any]:
        return {
            "matched_tables": self.matched_tables,
            "missing_tables": self.missing_tables,
            "missing_columns": self.missing_columns,
        }


def _build_table_match_index(
    db: Session, target_dataset_id: Optional[int]
) -> Dict[str, int]:
    """For the target dataset, build {source_table_name: table_id} so the
    importer can map snapshot tables to live ones. Returns empty dict if no
    target dataset (the workboard will land with null table_ids — fine for
    template libraries you'll wire later)."""
    if target_dataset_id is None:
        return {}
    rows = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == target_dataset_id)
        .all()
    )
    return {t.source_table_name: t.id for t in rows if t.source_table_name}


def _rewrite_table_ids(
    layout: Dict[str, Any],
    id_map: Dict[int, Optional[int]],
) -> Dict[str, Any]:
    """Return a deep-copy of ``layout`` with every ``table_id`` rewritten."""
    import copy

    out = copy.deepcopy(layout) if layout else {}

    def _rewrite(node: Any) -> None:
        if isinstance(node, dict):
            for k in list(node.keys()):
                v = node[k]
                if k == "table_id" and isinstance(v, int) and v in id_map:
                    node[k] = id_map[v]
                elif k == "source" and isinstance(v, str) and v.startswith("lookup:"):
                    try:
                        old_id = int(v.split(":", 1)[1])
                        new_id = id_map.get(old_id)
                        node[k] = f"lookup:{new_id}" if new_id else "primary"
                    except ValueError:
                        pass
                else:
                    _rewrite(v)
        elif isinstance(node, list):
            for item in node:
                _rewrite(item)

    _rewrite(out)
    return out


def _check_missing_columns(
    db: Session,
    layout: Dict[str, Any],
    bundle_tables_meta: Dict[str, Dict[str, Any]],
    id_map: Dict[int, Optional[int]],
    report: ImportReport,
) -> None:
    """Walk the resolved layout's screens and flag columns referenced that
    don't exist on the resolved target table. Doesn't mutate the layout."""
    new_table_ids = {v for v in id_map.values() if v}
    if not new_table_ids:
        return
    rows = (
        db.query(DatasetTable).filter(DatasetTable.id.in_(list(new_table_ids))).all()
    )
    cols_by_table: Dict[int, set[str]] = {
        t.id: {
            (c.get("name") or "")
            for c in _columns_from_cache(t.columns_cache)
            if isinstance(c, dict)
        }
        for t in rows
    }

    for screen in (layout.get("screens") or []):
        tid = screen.get("table_id")
        if not tid:
            continue
        existing = cols_by_table.get(tid, set())
        # Form fields
        for f in (((screen.get("form") or {}).get("fields")) or []):
            col = f.get("column")
            if col and col not in existing:
                report.missing_columns.append({
                    "screen": screen.get("id"),
                    "where": "form.fields",
                    "column": col,
                })
        # List columns
        for col in (((screen.get("list") or {}).get("columns")) or []):
            if col and col not in existing:
                report.missing_columns.append({
                    "screen": screen.get("id"),
                    "where": "list.columns",
                    "column": col,
                })


def import_workboard(
    db: Session,
    bundle: Dict[str, Any],
    *,
    target_dataset_id: Optional[int],
    target_name: Optional[str] = None,
    owner_id: Any = None,
) -> Tuple[Workboard, ImportReport]:
    """Create a workboard from an export bundle.

    ``target_dataset_id`` decides which dataset's tables to map snapshot
    references to. When None, the workboard is created with table_ids set
    to ``null`` everywhere — useful for template libraries you'll wire to a
    dataset later.
    """
    if bundle.get("kind") != "workboard_template":
        raise ValueError("Not a workboard template bundle.")

    report = ImportReport()
    bundle_tables_meta = bundle.get("tables_meta") or {}

    # Build the table-id map.
    match_index = _build_table_match_index(db, target_dataset_id)
    id_map: Dict[int, Optional[int]] = {}
    for old_id_str, meta in bundle_tables_meta.items():
        try:
            old_id = int(old_id_str)
        except ValueError:
            continue
        src = meta.get("source_table_name")
        new_id = match_index.get(src) if src else None
        id_map[old_id] = new_id
        record = {
            "old_table_id": old_id,
            "source_table_name": src,
            "display_name": meta.get("display_name"),
            "dataset_name": meta.get("dataset_name"),
            "new_table_id": new_id,
        }
        (report.matched_tables if new_id else report.missing_tables).append(record)

    # Rewrite layout.
    raw_layout = bundle.get("layout_json") or {}
    layout = _rewrite_table_ids(raw_layout, id_map)
    _check_missing_columns(db, layout, bundle_tables_meta, id_map, report)

    # Resolve primary_table_id — bundle's old id -> new id, or first
    # physical table of the target dataset, or None.
    old_pk_table = bundle.get("primary_table_id")
    new_pk_table: Optional[int] = None
    if isinstance(old_pk_table, int) and old_pk_table in id_map:
        new_pk_table = id_map[old_pk_table]
    if new_pk_table is None and target_dataset_id is not None:
        first = (
            db.query(DatasetTable)
            .filter(
                DatasetTable.dataset_id == target_dataset_id,
                DatasetTable.source_kind == "physical_table",
            )
            .order_by(DatasetTable.id.asc())
            .first()
        )
        new_pk_table = first.id if first else None

    wb_meta = bundle.get("workboard") or {}
    raw_name = (target_name or wb_meta.get("name") or "Imported workboard").strip()
    raw_slug = wb_meta.get("slug")

    # Make slug unique if it collides.
    final_slug: Optional[str] = None
    if raw_slug:
        candidate = raw_slug
        suffix = 2
        while db.query(Workboard).filter(Workboard.slug == candidate).first():
            candidate = f"{raw_slug}-{suffix}"
            suffix += 1
            if suffix > 50:
                candidate = None
                break
        final_slug = candidate

    if target_dataset_id is None:
        raise ValueError(
            "Cần chọn target dataset để import. Workboard luôn cần ít nhất một dataset "
            "để gắn các bảng tham chiếu — bạn có thể chỉ chọn dataset rỗng và bổ sung "
            "table sau, nhưng dataset thì bắt buộc."
        )

    if new_pk_table is None:
        raise ValueError(
            "Target dataset chưa có physical table nào. Thêm ít nhất một bảng vào dataset "
            "trước khi import workboard."
        )

    workboard = Workboard(
        name=raw_name,
        slug=final_slug,
        description=wb_meta.get("description"),
        icon=wb_meta.get("icon"),
        dataset_id=target_dataset_id,
        primary_table_id=new_pk_table,
        primary_key_columns=list(wb_meta.get("primary_key_columns") or []),
        lookup_tables=[],
        layout_json=layout,
        write_mode="direct",
        is_published=False,
        version=wb_meta.get("version") or 1,
        settings=wb_meta.get("settings"),
        owner_id=owner_id,
    )
    db.add(workboard)
    db.flush()
    db.commit()
    db.refresh(workboard)
    return workboard, report


# ── Helpers ───────────────────────────────────────────────────────────────


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
