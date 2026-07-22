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

import re
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models.dataset import Dataset, DatasetTable
from app.modules.workboards.models import Workboard, WorkboardAppUser
from app.modules.workboards.services.crud_service import _normalize_layout

logger = get_logger(__name__)


def _slugify_workboard(value: str | None) -> str:
    """Turn a workboard name into a valid slug (pattern ``^[a-z0-9][a-z0-9-_]*$``).

    Diacritics/punctuation collapse to ``-``; leading/trailing separators are
    trimmed. Falls back to ``imported-workboard`` when nothing usable remains.
    A slug is REQUIRED for a workboard to appear in a public Cổng (the menu is
    keyed by ``workboard_slug``), so an imported workboard must always get one.
    """
    text = re.sub(r"[^a-zA-Z0-9]+", "-", str(value or "").strip()).strip("-").lower()
    return text or "imported-workboard"

# v1 = referenced-tables-only snapshot (needs an existing target dataset on import).
# v2 = full dataset snapshot (all tables + datasource identity + semantic model:
#      views/dimensions/measures/pk + explores/joins) so import can AUTO-CREATE the
#      dataset on a chosen Source. v2 bundles still carry the v1 fields
#      (tables_meta / dataset.name) so the legacy "pick existing dataset" import path
#      keeps working unchanged.
BUNDLE_VERSION = 2


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
                if k.endswith("table_id") and isinstance(v, int):
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


def _export_full_dataset(db: Session, dataset_id: Optional[int]) -> Dict[str, Any]:
    """Snapshot the WHOLE dataset (every table + datasource identity + semantic
    model) so import can rebuild it on a freshly-chosen Source.

    Returns ``{datasources, dataset_tables, semantic}``:

    * ``datasources`` — distinct sources the dataset's tables sit on, identified
      by ``{ref, name, type}`` ONLY (no ``config``/credentials — those never
      travel; the importer picks a live Source per ``ref``).
    * ``dataset_tables`` — every ``DatasetTable`` with enough to recreate it
      (source_kind/table_name/query/transform/type_overrides/formats/columns).
      ``old_table_id`` is the stable key the rest of the bundle references.
    * ``semantic`` — the SemanticModel's views (dimensions/measures/primary_key)
      + explores (joins/default_filters) so relationships replay faithfully
      (NOT re-derived by auto-join, which mis-guesses non-``id`` PKs).
    """
    from app.models.models import DataSource
    from app.models.semantic import SemanticModel, SemanticView, SemanticExplore

    empty = {"datasources": [], "dataset_tables": [], "semantic": None}
    if not dataset_id:
        return empty

    tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .order_by(DatasetTable.id.asc())
        .all()
    )

    # Distinct datasources (by id) → {ref, name, type}. ref = str(datasource_id).
    ds_ids = sorted({t.datasource_id for t in tables if t.datasource_id})
    ds_rows = (
        db.query(DataSource).filter(DataSource.id.in_(ds_ids)).all() if ds_ids else []
    )
    ds_by_id = {d.id: d for d in ds_rows}
    datasources = [
        {
            "ref": str(d.id),
            "name": d.name,
            "type": d.type.value if hasattr(d.type, "value") else str(d.type),
        }
        for d in ds_rows
    ]

    dataset_tables: List[Dict[str, Any]] = []
    for t in tables:
        dataset_tables.append(
            {
                "old_table_id": t.id,
                "datasource_ref": str(t.datasource_id) if t.datasource_id else None,
                "datasource_name": ds_by_id[t.datasource_id].name
                if t.datasource_id in ds_by_id
                else None,
                "source_kind": t.source_kind,
                "source_table_name": t.source_table_name,
                "source_query": t.source_query,
                "query_mode": getattr(t, "query_mode", None),
                "display_name": t.display_name,
                "enabled": bool(t.enabled),
                "miniapp_share": bool(getattr(t, "miniapp_share", False)),
                "transformations": t.transformations or [],
                "type_overrides": t.type_overrides or {},
                "column_formats": t.column_formats or {},
                "columns": [
                    {"name": c.get("name"), "type": c.get("type")}
                    for c in _columns_from_cache(t.columns_cache)
                    if isinstance(c, dict) and c.get("name")
                ],
            }
        )

    # Semantic model (views + explores). Map each view to its table via
    # dataset_table_id so import can relink after table-ids change.
    semantic: Optional[Dict[str, Any]] = None
    model = (
        db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    )
    if model:
        views = (
            db.query(SemanticView)
            .filter(SemanticView.dataset_table_id.in_([t.id for t in tables] or [0]))
            .all()
        )
        view_name_by_id = {v.id: v.name for v in views}
        explores = (
            db.query(SemanticExplore)
            .filter(SemanticExplore.model_id == model.id)
            .all()
        )
        # Map base_view_id → its dataset_table_id so import can relink the
        # explore to the rebuilt base view even though ids change.
        view_table_by_id = {v.id: v.dataset_table_id for v in views}
        semantic = {
            "model_name": model.name,
            "model_settings": model.settings,
            "views": [
                {
                    "old_table_id": v.dataset_table_id,
                    "name": v.name,
                    "sql_table_name": v.sql_table_name,
                    "description": v.description,
                    "dimensions": v.dimensions or [],
                    "measures": v.measures or [],
                    "primary_key": v.primary_key,
                }
                for v in views
            ],
            "explores": [
                {
                    "name": e.name,
                    "base_view_name": e.base_view_name,
                    "base_view_old_table_id": view_table_by_id.get(e.base_view_id),
                    "joins": e.joins or [],
                    "default_filters": e.default_filters or {},
                    "description": e.description,
                }
                for e in explores
            ],
        }

    return {
        "datasources": datasources,
        "dataset_tables": dataset_tables,
        "semantic": semantic,
    }


def export_workboard(
    db: Session,
    workboard: Workboard,
    *,
    include_credentials: bool = False,
) -> Dict[str, Any]:
    """Build the export bundle dict for a workboard.

    ``include_credentials`` controls whether bcrypt hashes for app users
    travel with the bundle. Default is False so a bundle accidentally
    shared (Slack, email, public template gallery) cannot be used to
    impersonate the workboard's users — admins set fresh PINs after
    import. Demo / disposable templates can opt in.
    """
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

    # v2 — full dataset snapshot so import can auto-create the dataset on a
    # freshly-picked Source (vs v1 which needed an existing target dataset).
    full = _export_full_dataset(db, workboard.dataset_id)

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
            # v2: enough to recreate the dataset shell faithfully.
            "settings": dataset.settings if dataset else None,
            "dictionary": dataset.dictionary if dataset else None,
        },
        # v2 full-dataset payload (datasources/dataset_tables/semantic).
        "datasources": full["datasources"],
        "dataset_tables": full["dataset_tables"],
        "semantic": full["semantic"],
        "primary_table_id": workboard.primary_table_id,
        "tables_meta": tables_meta,
        "layout_json": layout,
        "app_users": _export_app_users(
            db, workboard, include_credentials=include_credentials
        ),
        # Echo the choice so the import side knows whether the bundle's
        # ``app_users`` carry usable PINs or just the user list metadata.
        "app_users_include_credentials": bool(include_credentials),
    }


def _export_app_users(
    db: Session,
    workboard: Workboard,
    *,
    include_credentials: bool,
) -> List[Dict[str, Any]]:
    """Snapshot every WorkboardAppUser row for the bundle."""
    rows = (
        db.query(WorkboardAppUser)
        .filter(WorkboardAppUser.workboard_id == workboard.id)
        .order_by(WorkboardAppUser.username.asc())
        .all()
    )
    out: List[Dict[str, Any]] = []
    for r in rows:
        item: Dict[str, Any] = {
            "username": r.username,
            "full_name": r.full_name,
            "role": r.role,
            "active": bool(r.active),
            "context": r.context or {},
        }
        if include_credentials:
            item["pin_hash"] = r.pin_hash
        out.append(item)
    return out


# ── Import ────────────────────────────────────────────────────────────────


class ImportReport:
    """Aggregated state about what survived import and what didn't."""

    def __init__(self) -> None:
        self.matched_tables: List[Dict[str, Any]] = []
        self.missing_tables: List[Dict[str, Any]] = []
        # Columns referenced in form fields / list columns / doc tables that
        # don't exist in the resolved table; surfaced as warnings (not errors).
        self.missing_columns: List[Dict[str, Any]] = []
        # App-user import bookkeeping (set by ``_import_app_users``):
        self.app_users_imported: int = 0
        self.app_users_needing_pin: List[str] = []
        # v2: dataset auto-rebuild outcome (set by ``import_from_source``); None
        # for the legacy "reuse existing dataset" path.
        self.dataset_rebuild: Optional[Dict[str, Any]] = None
        # Layout feature-configs the current schema can't accept (e.g. a map /
        # geocode feature built by a newer build) that were dropped so the
        # import degrades gracefully instead of hard-failing.
        self.stripped_features: List[Dict[str, Any]] = []
        # Layout ``*table_id`` refs that couldn't be mapped to a target table
        # (dangling / cross-dataset). Nulled on import so they never resolve to
        # an unrelated dataset's table (cross-dataset leak).
        self.unmapped_table_refs: List[Dict[str, Any]] = []

    def to_dict(self) -> Dict[str, Any]:
        return {
            "matched_tables": self.matched_tables,
            "missing_tables": self.missing_tables,
            "missing_columns": self.missing_columns,
            "app_users_imported": self.app_users_imported,
            "app_users_needing_pin": self.app_users_needing_pin,
            "dataset_rebuild": self.dataset_rebuild,
            "stripped_features": self.stripped_features,
            "unmapped_table_refs": self.unmapped_table_refs,
        }


def _target_dataset_tables(
    db: Session, target_dataset_id: Optional[int]
) -> List[DatasetTable]:
    if target_dataset_id is None:
        return []
    return (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == target_dataset_id)
        .all()
    )


def _build_table_match_index(
    db: Session, target_dataset_id: Optional[int]
) -> Dict[str, int]:
    """For the target dataset, build {source_table_name: table_id} so the
    importer can map snapshot tables to live ones. Returns empty dict if no
    target dataset (the workboard will land with null table_ids — fine for
    template libraries you'll wire later)."""
    rows = _target_dataset_tables(db, target_dataset_id)
    return {t.source_table_name: t.id for t in rows if t.source_table_name}


def _normalise_name(value: Any) -> str:
    import re

    text = str(value or "").strip().lower()
    text = re.sub(r"[`\"\[\]]", "", text)
    text = text.rsplit(".", 1)[-1]
    return re.sub(r"[^a-z0-9]+", "", text)


def _table_name_candidates(
    *,
    source_table_name: Any,
    display_name: Any,
) -> List[str]:
    out: List[str] = []
    for value in (source_table_name, display_name):
        text = str(value or "").strip()
        if text and text not in out:
            out.append(text)
        if "." in text:
            base = text.rsplit(".", 1)[-1]
            if base and base not in out:
                out.append(base)
    return out


def _build_table_match_indexes(
    rows: List[DatasetTable],
) -> Tuple[Dict[str, int], Dict[str, int]]:
    """Build exact and normalized table-name indexes for import mapping."""
    exact: Dict[str, int] = {}
    normalized_candidates: Dict[str, set[int]] = {}
    for table in rows:
        for candidate in _table_name_candidates(
            source_table_name=table.source_table_name,
            display_name=table.display_name,
        ):
            exact.setdefault(candidate, table.id)
            normalized = _normalise_name(candidate)
            if normalized:
                normalized_candidates.setdefault(normalized, set()).add(table.id)
    normalized = {
        name: next(iter(table_ids))
        for name, table_ids in normalized_candidates.items()
        if len(table_ids) == 1
    }
    return exact, normalized


def _infer_target_table_id(
    meta: Dict[str, Any],
    exact_index: Dict[str, int],
    normalized_index: Dict[str, int],
) -> Optional[int]:
    candidates = _table_name_candidates(
        source_table_name=meta.get("source_table_name"),
        display_name=meta.get("display_name"),
    )
    for candidate in candidates:
        if candidate in exact_index:
            return exact_index[candidate]
    for candidate in candidates:
        normalized = _normalise_name(candidate)
        if normalized and normalized in normalized_index:
            return normalized_index[normalized]
    return None


def _coerce_table_mapping(
    raw: Optional[Dict[Any, Any]],
    valid_target_table_ids: set[int],
) -> Dict[int, Optional[int]]:
    """Normalise explicit table mapping from API payload.

    Keys are old bundle table ids. Values are live ``dataset_tables.id`` in the
    target dataset. Empty values mean "leave unresolved".
    """
    out: Dict[int, Optional[int]] = {}
    for raw_key, raw_value in (raw or {}).items():
        try:
            old_id = int(raw_key)
        except (TypeError, ValueError):
            continue
        if raw_value in (None, "", 0):
            out[old_id] = None
            continue
        try:
            new_id = int(raw_value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Invalid target table id for bundle table {old_id}") from exc
        if new_id not in valid_target_table_ids:
            raise ValueError(
                f"Mapped target table {new_id} is not in the selected dataset."
            )
        out[old_id] = new_id
    return out


def _coerce_column_mapping(
    raw: Optional[Dict[Any, Any]],
) -> Dict[int, Dict[str, str]]:
    """Normalise explicit per-table column mapping from API payload."""
    out: Dict[int, Dict[str, str]] = {}
    for raw_table_id, mapping in (raw or {}).items():
        try:
            old_table_id = int(raw_table_id)
        except (TypeError, ValueError):
            continue
        if not isinstance(mapping, dict):
            continue
        col_map: Dict[str, str] = {}
        for old_col, new_col in mapping.items():
            old_name = str(old_col or "").strip()
            new_name = str(new_col or "").strip()
            if old_name and new_name:
                col_map[old_name] = new_name
        if col_map:
            out[old_table_id] = col_map
    return out


# ``*table_id`` keys whose empty sentinel is 0 (schema ``int``, ge=0) rather
# than None (the Optional keys). Used when nulling an unmappable ref so the
# rewritten layout still validates.
_ZERO_SENTINEL_TABLE_KEYS = {"from_table_id", "catalog_table_id"}


def _delete_at_loc(root: Any, loc: Tuple[Any, ...]) -> bool:
    """Delete the dict key at the end of a pydantic error ``loc`` path.

    Only deletes when the terminal element addresses a dict key (that is what
    ``extra_forbidden`` / ``literal_error`` point at). Returns True on success.
    List indices along the path are followed but never deleted (deleting a key
    can't shift a sibling list index, so a batch of deletes in one pass is safe).
    """
    if not loc:
        return False
    node = root
    for part in loc[:-1]:
        if isinstance(node, dict) and part in node:
            node = node[part]
        elif isinstance(node, list) and isinstance(part, int) and 0 <= part < len(node):
            node = node[part]
        else:
            return False
    last = loc[-1]
    if isinstance(node, dict) and last in node:
        del node[last]
        return True
    return False


def _sanitize_layout_for_import(raw_layout: Any) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Drop layout keys the current ``LayoutJson`` schema can't accept so an
    import degrades gracefully instead of a hard 400.

    A bundle built by a newer/other build can carry feature configs this
    engine doesn't implement yet (e.g. a map display-mode or a geocode block).
    Rather than reject the whole workboard, iteratively validate and strip the
    exact offending keys — ``extra_forbidden`` (unknown feature key) and
    ``literal_error`` / ``enum`` (unknown enum value, dropped so it defaults) —
    recording each in ``stripped``. Genuine structural errors we cannot heal
    are re-raised. Deleting a key only ever removes an unsupported feature; the
    rest of the screen imports intact.
    """
    import copy
    from pydantic import ValidationError
    from app.modules.workboards.schemas import LayoutJson

    layout = copy.deepcopy(raw_layout) if raw_layout else {}
    stripped: List[Dict[str, Any]] = []
    if not isinstance(layout, dict):
        return {}, stripped
    _HEALABLE = {"extra_forbidden", "literal_error", "enum"}
    for _ in range(500):  # bounded; each pass removes ≥1 offending key
        try:
            LayoutJson.model_validate(layout)
            return layout, stripped
        except ValidationError as exc:
            progressed = False
            # Deepest locs first: doesn't matter for dict-key deletes but keeps
            # behaviour stable if a parent and child both error in one pass.
            for err in sorted(exc.errors(), key=lambda e: len(e.get("loc") or ()), reverse=True):
                if (err.get("type") or "") not in _HEALABLE:
                    continue
                loc = tuple(err.get("loc") or ())
                if _delete_at_loc(layout, loc):
                    stripped.append({"path": ".".join(str(p) for p in loc), "type": err.get("type")})
                    progressed = True
            if not progressed:
                raise
    return layout, stripped


def _rewrite_table_ids(
    layout: Dict[str, Any],
    id_map: Dict[int, Optional[int]],
    unmapped_out: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Return a deep-copy of ``layout`` with every ``table_id`` rewritten.

    Any ``*table_id`` int that isn't in ``id_map`` (a dangling or cross-dataset
    ref) is nulled to its schema-valid empty sentinel and recorded in
    ``unmapped_out`` — NEVER left as the raw id, which in the target DB would
    resolve to whatever unrelated dataset owns that id (cross-dataset leak).
    """
    import copy

    out = copy.deepcopy(layout) if layout else {}

    def _empty_for(key: str) -> Optional[int]:
        return 0 if key in _ZERO_SENTINEL_TABLE_KEYS else None

    def _rewrite(node: Any) -> None:
        if isinstance(node, dict):
            for k in list(node.keys()):
                v = node[k]
                if k.endswith("table_id") and isinstance(v, int):
                    # Covers table_id AND from_table_id (table.lookup_columns),
                    # primary_table_id, dataset_table_id — every int key that
                    # names a source table must be remapped OLD→NEW.
                    if v in id_map:
                        node[k] = id_map[v]
                    else:
                        if unmapped_out is not None:
                            unmapped_out.append({"key": k, "old_id": v})
                        node[k] = _empty_for(k)
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


def _rename_col(value: Any, old_table_id: Optional[int], column_map: Dict[int, Dict[str, str]]) -> Any:
    if old_table_id is None or not isinstance(value, str):
        return value
    return column_map.get(old_table_id, {}).get(value, value)


def _rename_col_list(
    values: Any,
    old_table_id: Optional[int],
    column_map: Dict[int, Dict[str, str]],
) -> Any:
    if not isinstance(values, list):
        return values
    return [_rename_col(item, old_table_id, column_map) for item in values]


def _rename_col_dict_keys(
    values: Any,
    old_table_id: Optional[int],
    column_map: Dict[int, Dict[str, str]],
) -> Any:
    if old_table_id is None or not isinstance(values, dict):
        return values
    mapping = column_map.get(old_table_id, {})
    if not mapping:
        return values
    return {
        mapping.get(str(key), str(key)): value
        for key, value in values.items()
    }


def _rename_sort_columns(
    sort_items: Any,
    old_table_id: Optional[int],
    column_map: Dict[int, Dict[str, str]],
) -> Any:
    if not isinstance(sort_items, list):
        return sort_items
    for item in sort_items:
        if isinstance(item, dict) and "column" in item:
            item["column"] = _rename_col(item.get("column"), old_table_id, column_map)
    return sort_items


def _rename_rls_rule_columns(
    rule: Any,
    old_table_id: Optional[int],
    column_map: Dict[int, Dict[str, str]],
) -> None:
    if not isinstance(rule, dict):
        return
    if "filter_column" in rule:
        rule["filter_column"] = _rename_col(rule.get("filter_column"), old_table_id, column_map)
    for key in ("writable_columns", "readonly_columns"):
        if key in rule:
            rule[key] = _rename_col_list(rule.get(key), old_table_id, column_map)


def _table_id_from_doc_source(source: Any, primary_old_table_id: Optional[int]) -> Optional[int]:
    if source in (None, "", "primary"):
        return primary_old_table_id
    if isinstance(source, str) and source.startswith("lookup:"):
        try:
            return int(source.split(":", 1)[1])
        except ValueError:
            return None
    return None


def _rename_doc_columns(
    doc: Any,
    *,
    primary_old_table_id: Optional[int],
    column_map: Dict[int, Dict[str, str]],
) -> None:
    if not isinstance(doc, dict):
        return
    for block in doc.get("blocks") or []:
        if not isinstance(block, dict) or block.get("type") != "data_table":
            continue
        old_table_id = _table_id_from_doc_source(block.get("source"), primary_old_table_id)
        for key in ("columns", "totals", "group_by"):
            if key in block:
                block[key] = _rename_col_list(block.get(key), old_table_id, column_map)
        if isinstance(block.get("column_metadata"), dict):
            block["column_metadata"] = _rename_col_dict_keys(
                block.get("column_metadata"), old_table_id, column_map
            )
        if isinstance(block.get("column_groups"), list):
            for group in block["column_groups"]:
                if isinstance(group, dict) and "columns" in group:
                    group["columns"] = _rename_col_list(
                        group.get("columns"), old_table_id, column_map
                    )
        transform = block.get("transform")
        if isinstance(transform, dict):
            t_kind = transform.get("kind")
            if t_kind == "unpivot":
                for key in ("id_columns", "value_columns"):
                    if key in transform:
                        transform[key] = _rename_col_list(
                            transform.get(key), old_table_id, column_map
                        )
            elif t_kind == "pivot":
                if "index" in transform:
                    transform["index"] = _rename_col_list(
                        transform.get("index"), old_table_id, column_map
                    )
                for key in ("columns", "values"):
                    if isinstance(transform.get(key), str):
                        transform[key] = _rename_col(
                            transform.get(key), old_table_id, column_map
                        )


def _rewrite_expr(
    text: Any,
    old_table_id: Optional[int],
    column_map: Dict[int, Dict[str, str]],
) -> Any:
    """Rewrite column references inside a wb-expr string.

    Handles both grammars used across the schema: bracket refs ``[col]``
    (formula / valid_if / show_if / required_if / readonly_if /
    qr_value_template) and ``{{row.col}}`` refs (format_rules.when). Only
    whole-token matches are replaced so ``[date]`` never touches
    ``[date_created]``. Placeholders like ``{{app_user.x}}`` / ``{{today}}`` /
    ``{{shared.x}}`` are left untouched — they are not table columns.
    """
    if not isinstance(text, str) or old_table_id is None:
        return text
    mapping = column_map.get(old_table_id) or {}
    if not mapping:
        return text
    out = text
    for old, new in mapping.items():
        if not old or old == new:
            continue
        esc = re.escape(old)
        out = re.sub(r"\[\s*" + esc + r"\s*\]", "[" + new + "]", out)
        out = re.sub(r"\{\{\s*row\." + esc + r"\s*\}\}", "{{row." + new + "}}", out)
    return out


def _rename_lookup_columns(
    lookup: Any,
    column_map: Dict[int, Dict[str, str]],
    own_table_id: Optional[int] = None,
) -> None:
    if not isinstance(lookup, dict):
        return
    # filter_by_field (cascading select parent) is a column on the field's OWN
    # screen table, not the lookup's remote table.
    if own_table_id is not None and "filter_by_field" in lookup:
        lookup["filter_by_field"] = _rename_col(lookup.get("filter_by_field"), own_table_id, column_map)
    lookup_table_id = lookup.get("table_id")
    if isinstance(lookup_table_id, int):
        # value/label + map-widget geometry + cascading remote match column all
        # live on the lookup's remote table.
        for key in (
            "value_column", "label_column", "filter_column",
            "geometry_column", "lat_column", "lng_column",
        ):
            if key in lookup:
                lookup[key] = _rename_col(lookup.get(key), lookup_table_id, column_map)
    for hop in lookup.get("relationship_path") or []:
        if not isinstance(hop, dict):
            continue
        hop_table_id = hop.get("table_id")
        if not isinstance(hop_table_id, int):
            continue
        for key in ("value_column", "label_column"):
            if key in hop:
                hop[key] = _rename_col(hop.get(key), hop_table_id, column_map)


def _rewrite_column_references(
    layout: Dict[str, Any],
    *,
    primary_old_table_id: Optional[int],
    column_map: Dict[int, Dict[str, str]],
) -> Dict[str, Any]:
    """Return a deep-copy of ``layout`` with referenced column names renamed.

    Table-id rewriting happens separately. This pass deliberately works on the
    source layout so every screen/doc block can still infer which old table a
    column belonged to.
    """
    import copy

    out = copy.deepcopy(layout) if layout else {}
    if not column_map:
        return out

    # Screen id -> old table id. Needed for barcode ``scan_carry_as``, which
    # names a column on the DESTINATION screen's table, not the scanning one.
    screen_table: Dict[str, Optional[int]] = {}
    for screen in out.get("screens") or []:
        if isinstance(screen, dict) and screen.get("id") is not None:
            tid = screen.get("table_id")
            screen_table[str(screen["id"])] = tid if isinstance(tid, int) else primary_old_table_id

    # Workboard-level audit convention columns live on the primary table.
    audit = out.get("audit")
    if isinstance(audit, dict):
        for key in ("created_by_column", "created_at_column",
                    "updated_by_column", "updated_at_column"):
            if key in audit:
                audit[key] = _rename_col(audit.get(key), primary_old_table_id, column_map)

    # Mini-app screens.
    for screen in out.get("screens") or []:
        if not isinstance(screen, dict):
            continue
        old_table_id = screen.get("table_id") if isinstance(screen.get("table_id"), int) else primary_old_table_id
        if "primary_key_columns" in screen:
            screen["primary_key_columns"] = _rename_col_list(
                screen.get("primary_key_columns"), old_table_id, column_map
            )
        if isinstance(screen.get("column_labels"), dict):
            screen["column_labels"] = _rename_col_dict_keys(
                screen.get("column_labels"), old_table_id, column_map
            )

        # ── Form screens ─────────────────────────────────────────────────
        form_cfg = screen.get("form") if isinstance(screen.get("form"), dict) else None
        if form_cfg:
            for field in form_cfg.get("fields") or []:
                if not isinstance(field, dict):
                    continue
                if "column" in field:
                    field["column"] = _rename_col(field.get("column"), old_table_id, column_map)
                if "computed_from_dataset" in field:
                    field["computed_from_dataset"] = _rename_col(
                        field.get("computed_from_dataset"), old_table_id, column_map
                    )
                if "qr_source_column" in field:
                    field["qr_source_column"] = _rename_col(
                        field.get("qr_source_column"), old_table_id, column_map
                    )
                # Expression-bearing fields ([col] / {{row.col}} refs).
                for ek in ("show_if", "required_if", "readonly_if", "valid_if",
                           "formula", "qr_value_template"):
                    if field.get(ek):
                        field[ek] = _rewrite_expr(field.get(ek), old_table_id, column_map)
                # scan_carry_as names a column on the DESTINATION screen's table.
                if field.get("scan_carry_as") and field.get("scan_go_to_screen"):
                    dest_tid = screen_table.get(str(field.get("scan_go_to_screen")))
                    field["scan_carry_as"] = _rename_col(field.get("scan_carry_as"), dest_tid, column_map)
                _rename_lookup_columns(field.get("lookup"), column_map, own_table_id=old_table_id)
            if "initial_values" in form_cfg:
                form_cfg["initial_values"] = _rename_col_dict_keys(
                    form_cfg.get("initial_values"), old_table_id, column_map
                )
            if form_cfg.get("geo_stamp_column"):
                form_cfg["geo_stamp_column"] = _rename_col(
                    form_cfg.get("geo_stamp_column"), old_table_id, column_map
                )
            after = form_cfg.get("after_submit")
            if isinstance(after, dict) and "carry" in after:
                after["carry"] = _rename_col_list(after.get("carry"), old_table_id, column_map)

        # ── Table screens ────────────────────────────────────────────────
        table_screen = screen.get("table") if isinstance(screen.get("table"), dict) else None
        if table_screen:
            for lk in ("columns", "editable_columns", "required_columns", "group_by"):
                if lk in table_screen:
                    table_screen[lk] = _rename_col_list(table_screen.get(lk), old_table_id, column_map)
            if "default_sort_column" in table_screen:
                table_screen["default_sort_column"] = _rename_col(
                    table_screen.get("default_sort_column"), old_table_id, column_map
                )
            # Column-keyed dicts.
            for dk in ("default_values", "totals", "column_metadata"):
                if isinstance(table_screen.get(dk), dict):
                    table_screen[dk] = _rename_col_dict_keys(table_screen.get(dk), old_table_id, column_map)
            for item in table_screen.get("filters") or []:
                if isinstance(item, dict) and "column" in item:
                    item["column"] = _rename_col(item.get("column"), old_table_id, column_map)
            for group in table_screen.get("column_groups") or []:
                if isinstance(group, dict) and "columns" in group:
                    group["columns"] = _rename_col_list(group.get("columns"), old_table_id, column_map)
            for tile in table_screen.get("stat_tiles") or []:
                if isinstance(tile, dict) and "column" in tile:
                    tile["column"] = _rename_col(tile.get("column"), old_table_id, column_map)
            for rule in table_screen.get("format_rules") or []:
                if isinstance(rule, dict):
                    if rule.get("when"):
                        rule["when"] = _rewrite_expr(rule.get("when"), old_table_id, column_map)
                    if "columns" in rule:
                        rule["columns"] = _rename_col_list(rule.get("columns"), old_table_id, column_map)
            for cc in table_screen.get("computed_columns") or []:
                if isinstance(cc, dict) and cc.get("formula"):
                    cc["formula"] = _rewrite_expr(cc.get("formula"), old_table_id, column_map)
            # lookup / rollup columns: local match on THIS table, remote refs on
            # the joined ``from_table_id`` table.
            for lc in table_screen.get("lookup_columns") or []:
                if not isinstance(lc, dict):
                    continue
                if "match_column_local" in lc:
                    lc["match_column_local"] = _rename_col(lc.get("match_column_local"), old_table_id, column_map)
                remote = lc.get("from_table_id") if isinstance(lc.get("from_table_id"), int) else None
                for rk in ("match_column_remote", "return_column"):
                    if rk in lc:
                        lc[rk] = _rename_col(lc.get(rk), remote, column_map)
            for rc in table_screen.get("rollup_columns") or []:
                if not isinstance(rc, dict):
                    continue
                if "match_column_local" in rc:
                    rc["match_column_local"] = _rename_col(rc.get("match_column_local"), old_table_id, column_map)
                remote = rc.get("from_table_id") if isinstance(rc.get("from_table_id"), int) else None
                for rk in ("match_column_remote", "value_column"):
                    if rk in rc:
                        rc[rk] = _rename_col(rc.get(rk), remote, column_map)
            gcfg = table_screen.get("gallery_config")
            if isinstance(gcfg, dict):
                for gk in ("image_column", "title_column", "subtitle_column", "group_by_column"):
                    if gk in gcfg:
                        gcfg[gk] = _rename_col(gcfg.get(gk), old_table_id, column_map)
            ccfg = table_screen.get("calendar_config")
            if isinstance(ccfg, dict):
                for ck in ("date_column", "title_column", "color_column"):
                    if ck in ccfg:
                        ccfg[ck] = _rename_col(ccfg.get(ck), old_table_id, column_map)
            dp = table_screen.get("detail_panel")
            if isinstance(dp, dict):
                for dk in ("columns", "editable_columns"):
                    if dk in dp:
                        dp[dk] = _rename_col_list(dp.get(dk), old_table_id, column_map)
                if isinstance(dp.get("sections"), dict):
                    dp["sections"] = {
                        label: _rename_col_list(cols, old_table_id, column_map)
                        for label, cols in dp["sections"].items()
                    }
            for act in table_screen.get("row_actions") or []:
                if isinstance(act, dict) and "carry" in act:
                    act["carry"] = _rename_col_list(act.get("carry"), old_table_id, column_map)

        _rename_doc_columns(screen.get("doc"), primary_old_table_id=old_table_id, column_map=column_map)
        for rule in screen.get("rls") or []:
            _rename_rls_rule_columns(rule, old_table_id, column_map)
        _rename_rls_rule_columns(screen.get("rls_default"), old_table_id, column_map)

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
        # A column is "known" if it's a physical source column OR a column the
        # screen itself synthesises — computed (JS/formula) + lookup columns +
        # dataset-computed form fields. Without this, every computed/lookup
        # column reads as "missing" (it isn't in the raw source) and falsely
        # alarms the import report.
        known = set(cols_by_table.get(tid, set()))
        table_cfg = screen.get("table") or {}
        for cc in table_cfg.get("computed_columns") or []:
            if isinstance(cc, dict) and cc.get("name"):
                known.add(cc["name"])
        for lc in table_cfg.get("lookup_columns") or []:
            if isinstance(lc, dict) and lc.get("name"):
                known.add(lc["name"])
        for rc in table_cfg.get("rollup_columns") or []:
            if isinstance(rc, dict) and rc.get("name"):
                known.add(rc["name"])
        for f in ((screen.get("form") or {}).get("fields") or []):
            if isinstance(f, dict) and f.get("computed_from_dataset") and f.get("column"):
                known.add(f["column"])
        # Form fields
        for f in (((screen.get("form") or {}).get("fields")) or []):
            col = f.get("column")
            if col and col not in known:
                report.missing_columns.append({
                    "screen": screen.get("id"),
                    "where": "form.fields",
                    "column": col,
                })
        # Table columns
        for col in (((screen.get("table") or {}).get("columns")) or []):
            if col and col not in known:
                report.missing_columns.append({
                    "screen": screen.get("id"),
                    "where": "table.columns",
                    "column": col,
                })


def import_workboard(
    db: Session,
    bundle: Dict[str, Any],
    *,
    target_dataset_id: Optional[int],
    target_name: Optional[str] = None,
    table_mapping: Optional[Dict[Any, Any]] = None,
    column_mapping: Optional[Dict[Any, Any]] = None,
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

    # Build the table-id map. Explicit user mapping wins; exact source-table
    # matching remains as a fallback for older imports.
    target_tables = _target_dataset_tables(db, target_dataset_id)
    target_table_ids = {t.id for t in target_tables}
    explicit_table_map = _coerce_table_mapping(table_mapping, target_table_ids)
    explicit_column_map = _coerce_column_mapping(column_mapping)
    exact_match_index, normalized_match_index = _build_table_match_indexes(target_tables)
    id_map: Dict[int, Optional[int]] = {}
    for old_id_str, meta in bundle_tables_meta.items():
        try:
            old_id = int(old_id_str)
        except ValueError:
            continue
        src = meta.get("source_table_name")
        if old_id in explicit_table_map:
            new_id = explicit_table_map[old_id]
            mapping_source = "manual" if new_id else "unmapped"
        else:
            new_id = _infer_target_table_id(meta, exact_match_index, normalized_match_index)
            mapping_source = "auto" if new_id else "missing"
        id_map[old_id] = new_id
        record = {
            "old_table_id": old_id,
            "source_table_name": src,
            "display_name": meta.get("display_name"),
            "dataset_name": meta.get("dataset_name"),
            "new_table_id": new_id,
            "mapping_source": mapping_source,
        }
        (report.matched_tables if new_id else report.missing_tables).append(record)

    # Rewrite layout.
    raw_layout = bundle.get("layout_json") or {}
    # Drop feature-configs this engine's schema can't accept (e.g. a map
    # display-mode / geocode block built by a newer or divergent build) so the
    # import degrades gracefully with a warning instead of a hard 400.
    raw_layout, report.stripped_features = _sanitize_layout_for_import(raw_layout)
    old_pk_table = bundle.get("primary_table_id")
    old_pk_table_id = old_pk_table if isinstance(old_pk_table, int) else None
    layout_with_columns = _rewrite_column_references(
        raw_layout,
        primary_old_table_id=old_pk_table_id,
        column_map=explicit_column_map,
    )
    layout = _rewrite_table_ids(
        layout_with_columns, id_map, unmapped_out=report.unmapped_table_refs
    )
    # Heal the layout through the SAME normalizer the create/update path uses,
    # so an imported workboard is canonical at rest — in particular a bundle
    # exported from a pre-Phase-13 workboard (legacy ``kind='grid'/'list'`` +
    # ``grid``/``list`` blocks) is rewritten to ``kind='table'`` before insert,
    # rather than relying on the read-side shim + a later save to clean it up.
    layout = _normalize_layout(layout)
    _check_missing_columns(db, layout, bundle_tables_meta, id_map, report)

    # Resolve primary_table_id — bundle's old id -> new id, or first
    # physical table of the target dataset, or None.
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
    # Always give the imported workboard a slug — it is REQUIRED to publish the
    # app to a public Cổng (the workspace menu is keyed by workboard_slug). Use
    # the bundle's slug when present, else derive one from the name; then make
    # it unique against existing workboards.
    base_slug = (wb_meta.get("slug") or "").strip() or _slugify_workboard(raw_name)
    candidate = base_slug
    suffix = 2
    while db.query(Workboard.id).filter(Workboard.slug == candidate).first():
        candidate = f"{base_slug}-{suffix}"
        suffix += 1
        if suffix > 500:
            candidate = f"{base_slug}-{new_pk_table or 'x'}-{suffix}"
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

    _import_app_users(db, workboard, bundle, report)

    db.commit()
    db.refresh(workboard)
    return workboard, report


def _import_app_users(
    db: Session,
    workboard: Workboard,
    bundle: Dict[str, Any],
    report: ImportReport,
) -> None:
    """Recreate app users on the freshly-imported workboard.

    Each ``bundle["app_users"]`` entry becomes a ``WorkboardAppUser``
    bound to the new workboard id. Rows without ``pin_hash`` (bundle
    exported with ``include_credentials=false``) get a placeholder hash
    that won't verify — admins must reset the PIN via the Builder before
    those users can log in. The placeholder approach keeps the row
    visible (admin can see who needs a PIN) instead of dropping the row.
    """
    raw_users = bundle.get("app_users") or []
    if not isinstance(raw_users, list) or not raw_users:
        return

    from app.modules.workboards.services import app_user_service

    # Sentinel hash that no PIN can verify against — bcrypt of a long
    # random string. Hashed once per import so we don't churn cycles.
    placeholder_hash = app_user_service.hash_pin(
        "__appbi_placeholder__set_via_admin__"
    )

    inserted = 0
    needs_pin: List[str] = []
    for raw in raw_users:
        if not isinstance(raw, dict):
            continue
        username = str(raw.get("username") or "").strip()
        if not username:
            continue
        pin_hash = raw.get("pin_hash") if isinstance(raw.get("pin_hash"), str) else None
        if not pin_hash:
            pin_hash = placeholder_hash
            needs_pin.append(username)
        try:
            db.add(
                WorkboardAppUser(
                    workboard_id=workboard.id,
                    username=username,
                    pin_hash=pin_hash,
                    full_name=raw.get("full_name") or None,
                    role=raw.get("role") or None,
                    active=bool(raw.get("active", True)),
                    context=raw.get("context") or {},
                )
            )
            inserted += 1
        except Exception as exc:
            logger.warning(
                "import: failed to insert app user '%s' for workboard %s: %s",
                username,
                workboard.id,
                exc,
            )
    if inserted:
        db.flush()
    # Surface the user-import outcome on the import report so the FE can
    # show "Imported 12 users (3 need PIN reset)".
    setattr(report, "app_users_imported", inserted)
    setattr(report, "app_users_needing_pin", needs_pin)


# ── v2: auto-create dataset on a chosen Source, then import ────────────────


def _normalised_source_name_set(rows: List[Dict[str, Any]]) -> Dict[str, str]:
    """From ``list_tables`` rows build {normalised_name: actual_name} so a
    bundle's ``source_table_name`` can be matched even if schema-qualified or
    cased differently. Also indexes the bare table name (after the last dot)."""
    out: Dict[str, str] = {}
    for r in rows or []:
        name = str(r.get("name") or "").strip()
        if not name:
            continue
        schema = str(r.get("schema") or "").strip()
        qualified = f"{schema}.{name}" if schema and "." not in name else name
        for cand in {name, qualified}:
            out.setdefault(_normalise_name(cand), cand)
    return out


def inspect_source_match(
    db: Session,
    bundle: Dict[str, Any],
    datasource_map: Dict[str, int],
) -> Dict[str, Any]:
    """Dry-run: given a chosen target Source per bundle datasource ``ref``,
    report which of the bundle's physical tables EXIST on that Source (matched
    by name), without creating anything. Drives the import preview so the user
    can manually map mismatches before committing.

    Only checks table EXISTENCE (one ``list_tables`` call per source) — column
    diffs are surfaced later by ``import_workboard``'s missing_columns report,
    keeping quota-limited sources (Sheets) cheap here.
    """
    from app.models.models import DataSource
    from app.services.datasource_service import DataSourceConnectionService

    dataset_tables = bundle.get("dataset_tables") or []
    # Cache list_tables per resolved datasource so we hit each source once.
    name_index_cache: Dict[int, Dict[str, str]] = {}

    def _index_for(ds_id: int) -> Dict[str, str]:
        if ds_id in name_index_cache:
            return name_index_cache[ds_id]
        ds = db.query(DataSource).filter(DataSource.id == ds_id).first()
        if not ds:
            name_index_cache[ds_id] = {}
            return {}
        ds_type = ds.type.value if hasattr(ds.type, "value") else str(ds.type)
        try:
            rows = DataSourceConnectionService.list_tables(ds_type, ds.config)
        except Exception as exc:  # source unreachable / bad creds
            logger.warning("inspect: list_tables failed for ds %s: %s", ds_id, exc)
            rows = []
        idx = _normalised_source_name_set(rows)
        name_index_cache[ds_id] = idx
        return idx

    tables_report: List[Dict[str, Any]] = []
    physical_total = 0
    physical_found = 0
    for dt in dataset_tables:
        kind = dt.get("source_kind")
        ref = dt.get("datasource_ref")
        entry: Dict[str, Any] = {
            "old_table_id": dt.get("old_table_id"),
            "display_name": dt.get("display_name"),
            "source_kind": kind,
            "source_table_name": dt.get("source_table_name"),
            "datasource_ref": ref,
            "datasource_name": dt.get("datasource_name"),
        }
        if kind == "physical_table":
            physical_total += 1
            target_ds_id = datasource_map.get(str(ref)) if ref is not None else None
            if not target_ds_id:
                entry["status"] = "no_source_selected"
            else:
                idx = _index_for(int(target_ds_id))
                matched = idx.get(_normalise_name(dt.get("source_table_name")))
                if matched:
                    entry["status"] = "found"
                    entry["matched_source_table"] = matched
                    physical_found += 1
                else:
                    entry["status"] = "missing"
                    entry["available_sample"] = list(idx.values())[:50]
        else:
            # sql_query / derived_table / generated_calendar — recreated from the
            # bundle's own definition; nothing to match against the source.
            entry["status"] = "recreate"
        tables_report.append(entry)

    return {
        "tables": tables_report,
        "physical_total": physical_total,
        "physical_found": physical_found,
        "all_found": physical_found == physical_total,
    }


def rebuild_dataset_from_bundle(
    db: Session,
    bundle: Dict[str, Any],
    datasource_map: Dict[str, int],
    *,
    owner_id: Any = None,
    table_source_overrides: Optional[Dict[int, str]] = None,
) -> Tuple[Dataset, Dict[str, Any]]:
    """Create a fresh Dataset on the chosen Source(s) and rebuild every table
    from the bundle (live column introspection), then replay the semantic model
    (views' dims/measures/pk + explores' joins) so relationships match the
    export. Returns ``(dataset, rebuild_report)``.

    Resilient: a bundle table whose source table isn't found on the chosen
    Source is recorded in ``skipped`` and left out — the workboard screens that
    referenced it land in a "needs config" state (same as a partial v1 import)
    instead of failing the whole import.
    """
    # Lazy imports avoid an app.api ↔ service import cycle at module load.
    from app.api.datasets import (
        _build_columns_cache_payload,
        _infer_dataset_table_columns,
        _infer_dataset_table_source_columns,
    )
    from app.models.models import DataSource
    from app.schemas.dataset import DatasetCreate, TableCreate
    from app.services.dataset_crud import DatasetCRUDService
    from app.services.dataset_model_service import generate_dataset_model

    overrides = table_source_overrides or {}
    ds_bundle = bundle.get("dataset") or {}
    base_name = (ds_bundle.get("name") or "Imported dataset").strip()

    # Create the dataset shell (name auto-suffixed on collision by the service),
    # then stamp settings/dictionary straight onto the row (raw JSONB — already
    # normalised by the source export, so we skip strict schema coercion).
    dataset = DatasetCRUDService.create_dataset(
        db,
        DatasetCreate(name=f"{base_name} (import)", description=ds_bundle.get("description")),
        owner_id=owner_id,
    )
    if ds_bundle.get("settings") is not None:
        dataset.settings = ds_bundle["settings"]
    if ds_bundle.get("dictionary") is not None:
        dataset.dictionary = ds_bundle["dictionary"]
    db.commit()
    db.refresh(dataset)

    report: Dict[str, Any] = {
        "dataset_id": dataset.id,
        "dataset_name": dataset.name,
        "created_tables": [],
        "skipped_tables": [],
    }
    id_map: Dict[int, int] = {}
    ds_obj_cache: Dict[int, Optional[DataSource]] = {}

    def _ds(ds_id: Optional[int]) -> Optional[DataSource]:
        if not ds_id:
            return None
        if ds_id not in ds_obj_cache:
            ds_obj_cache[ds_id] = db.query(DataSource).filter(DataSource.id == ds_id).first()
        return ds_obj_cache[ds_id]

    for dt in bundle.get("dataset_tables") or []:
        old_id = dt.get("old_table_id")
        kind = dt.get("source_kind") or "physical_table"
        ref = dt.get("datasource_ref")
        target_ds_id = datasource_map.get(str(ref)) if ref is not None else None

        # Generated-calendar tables are recreated implicitly by the dataset's
        # calendar settings (ensure_calendar_table) — skip explicit creation.
        if kind == "generated_calendar":
            report["skipped_tables"].append({"old_table_id": old_id, "reason": "calendar_auto"})
            continue

        if kind in ("physical_table", "sql_query") and not target_ds_id:
            report["skipped_tables"].append({"old_table_id": old_id, "reason": "no_source_selected"})
            continue

        source_table_name = overrides.get(old_id) or dt.get("source_table_name")

        try:
            create_kwargs: Dict[str, Any] = {
                "display_name": dt.get("display_name") or None,
                "datasource_id": target_ds_id if kind != "derived_table" else None,
                "source_kind": kind,
                "enabled": bool(dt.get("enabled", True)),
                "transformations": dt.get("transformations") or None,
            }
            if kind == "physical_table":
                create_kwargs["source_table_name"] = source_table_name
            elif kind in ("sql_query", "derived_table"):
                create_kwargs["source_query"] = dt.get("source_query")

            new_table = DatasetCRUDService.add_table_to_dataset(
                db, dataset.id, TableCreate(**create_kwargs)
            )
            if new_table is None:
                report["skipped_tables"].append({"old_table_id": old_id, "reason": "add_failed"})
                continue

            # Live column inference + cache (mirrors the /tables POST endpoint).
            datasource = _ds(target_ds_id)
            inferred = _infer_dataset_table_columns(db, dataset, datasource, new_table)
            if inferred:
                source_cols = _infer_dataset_table_source_columns(
                    db, dataset, datasource, new_table, fallback_columns=inferred
                )
                DatasetCRUDService.update_table_cache(
                    db,
                    new_table.id,
                    columns_cache=_build_columns_cache_payload(
                        new_table, inferred, source_columns=source_cols
                    ),
                )

            # Carry type overrides + column formats verbatim (raw JSONB columns).
            changed = False
            if dt.get("type_overrides"):
                new_table.type_overrides = dt["type_overrides"]
                changed = True
            if dt.get("column_formats"):
                new_table.column_formats = dt["column_formats"]
                changed = True
            if dt.get("miniapp_share"):
                new_table.miniapp_share = True
                changed = True
            if changed:
                db.commit()
                db.refresh(new_table)

            if old_id is not None:
                id_map[int(old_id)] = new_table.id
            report["created_tables"].append({
                "old_table_id": old_id,
                "new_table_id": new_table.id,
                "source_table_name": source_table_name,
                "columns": len(inferred or []),
            })
        except Exception as exc:
            logger.warning("rebuild: failed to create table %s (%s): %s", old_id, source_table_name, exc)
            db.rollback()
            report["skipped_tables"].append({"old_table_id": old_id, "reason": "error", "detail": str(exc)[:200]})

    # Recreate the dataset's semantic model 1:1 from the bundle (views +
    # relationships exactly as exported) so the imported dataset matches the
    # source and the mini-app runs the same. Falls back to the standard
    # auto-generate ("Generate model") if the bundle has no model snapshot
    # (older v1 bundle) or if the faithful rebuild errors — so the dataset
    # ALWAYS ends up with a working model. Only ever creates rows for THIS new
    # dataset; never touches existing datasets/dashboards.
    semantic = bundle.get("semantic")
    built = False
    try:
        if semantic and semantic.get("views"):
            built = _rebuild_semantic_from_bundle(db, dataset.id, id_map, semantic)
    except Exception as exc:
        logger.warning("rebuild: faithful model rebuild failed for ds %s: %s", dataset.id, exc)
        try:
            db.rollback()
        except Exception:
            pass
        built = False
    if not built:
        try:
            generate_dataset_model(db, dataset.id, force=True)
        except Exception as exc:
            logger.warning("rebuild: model generation failed for ds %s: %s", dataset.id, exc)

    report["id_map"] = {str(k): v for k, v in id_map.items()}
    report["model_source"] = "bundle" if built else "generated"
    return dataset, report


_DT_TOKEN_RE = re.compile(r"dataset_table_(\d+)")


def _remap_dt_tokens(value: Any, id_map: Dict[int, int]) -> Any:
    """Rewrite every ``dataset_table_<OLD_id>`` token to ``dataset_table_<NEW_id>``
    (via id_map) anywhere inside a string / list / dict.

    Auto-generated semantic models NAME their views ``dataset_table_<id>`` and
    reference them that way in joins (``view``, ``from_view``, ``${dataset_table_x}``
    in ``sql_on``) and in dimension/measure SQL. The id is the OLD source table
    id; on import it must point at the NEWLY created table, else the engine/model
    canvas resolves it to whatever table currently owns that id — a DIFFERENT
    dataset's table (the cross-dataset contamination bug). Unmapped ids are left
    as-is."""
    if isinstance(value, str):
        return _DT_TOKEN_RE.sub(
            lambda m: f"dataset_table_{id_map.get(int(m.group(1)), m.group(1))}",
            value,
        )
    if isinstance(value, list):
        return [_remap_dt_tokens(v, id_map) for v in value]
    if isinstance(value, dict):
        return {k: _remap_dt_tokens(v, id_map) for k, v in value.items()}
    return value


def _rebuild_semantic_from_bundle(
    db: Session,
    dataset_id: int,
    id_map: Dict[int, int],
    semantic: Dict[str, Any],
) -> bool:
    """Recreate the semantic model 1:1 from the export bundle for the freshly
    created dataset: one SemanticView per exported view (with the exact
    dimensions / measures / primary_key) + the SemanticExplores with their
    joins/default_filters. Every ``dataset_table_<id>`` token (view names, join
    refs, sql_on placeholders, dim/measure SQL) is remapped OLD→NEW via id_map so
    the model points only at THIS dataset's new tables — never a foreign dataset's
    table that happens to share the old id. Returns True if a model was built
    (>= 1 view), False if there was nothing to build (caller then falls back to
    auto-generate). Scoped entirely to ``dataset_id`` — no other dataset's model
    is read or mutated."""
    from app.models.semantic import SemanticModel, SemanticView, SemanticExplore

    views_b = semantic.get("views") or []
    explores_b = semantic.get("explores") or []

    # Map each bundle view to a NEW table id; skip views whose table wasn't
    # recreated (e.g. a generated-calendar table we don't replay).
    pending_views = []
    for bv in views_b:
        old_tid = bv.get("old_table_id")
        new_tid = id_map.get(int(old_tid)) if old_tid is not None else None
        if new_tid:
            pending_views.append((int(old_tid), new_tid, bv))
    if not pending_views:
        return False

    model = SemanticModel(
        dataset_id=dataset_id,
        name=semantic.get("model_name") or f"model_{dataset_id}",
        settings=semantic.get("model_settings"),
    )
    db.add(model)
    db.flush()

    view_by_old_table: Dict[int, Any] = {}
    for old_tid, new_tid, bv in pending_views:
        view = SemanticView(
            name=_remap_dt_tokens(bv.get("name") or f"view_{new_tid}", id_map),
            sql_table_name=_remap_dt_tokens(bv.get("sql_table_name"), id_map),
            dataset_table_id=new_tid,
            dimensions=_remap_dt_tokens(bv.get("dimensions") or [], id_map),
            measures=_remap_dt_tokens(bv.get("measures") or [], id_map),
            primary_key=_remap_dt_tokens(bv.get("primary_key"), id_map),
            description=bv.get("description"),
        )
        db.add(view)
        db.flush()
        view_by_old_table[old_tid] = view

    for be in explores_b:
        old_base = be.get("base_view_old_table_id")
        base_view = view_by_old_table.get(int(old_base)) if old_base is not None else None
        if not base_view:
            continue
        db.add(
            SemanticExplore(
                model_id=model.id,
                base_view_id=base_view.id,
                base_view_name=_remap_dt_tokens(be.get("base_view_name"), id_map) or base_view.name,
                joins=_remap_dt_tokens(be.get("joins") or [], id_map),
                default_filters=_remap_dt_tokens(be.get("default_filters") or {}, id_map),
                name=_remap_dt_tokens(be.get("name"), id_map) or base_view.name,
            )
        )

    db.commit()
    return True


def import_from_source(
    db: Session,
    bundle: Dict[str, Any],
    *,
    datasource_map: Dict[str, int],
    owner_id: Any = None,
    target_name: Optional[str] = None,
    reuse_dataset_id: Optional[int] = None,
    table_mapping: Optional[Dict[Any, Any]] = None,
    column_mapping: Optional[Dict[Any, Any]] = None,
    table_source_overrides: Optional[Dict[int, str]] = None,
) -> Tuple[Workboard, ImportReport]:
    """Top-level v2 import: (optionally) auto-create a Dataset on the chosen
    Source(s) from the bundle, then run the existing ``import_workboard`` against
    it (which remaps layout table-ids by source_table_name + recreates app
    users). When ``reuse_dataset_id`` is given, skip the rebuild and import
    straight onto that existing dataset (the legacy path)."""
    if bundle.get("kind") != "workboard_template":
        raise ValueError("Not a workboard template bundle.")

    rebuild_report: Optional[Dict[str, Any]] = None
    if reuse_dataset_id:
        target_dataset_id = int(reuse_dataset_id)
    else:
        if bundle.get("bundle_version", 1) < 2 or not bundle.get("dataset_tables"):
            raise ValueError(
                "Bundle này (v1) không kèm cấu trúc dataset nên không thể tự tạo dataset. "
                "Hãy chọn 'dùng dataset có sẵn' hoặc export lại từ bản mới."
            )
        dataset, rebuild_report = rebuild_dataset_from_bundle(
            db,
            bundle,
            datasource_map,
            owner_id=owner_id,
            table_source_overrides=table_source_overrides,
        )
        target_dataset_id = dataset.id

    try:
        workboard, report = import_workboard(
            db,
            bundle,
            target_dataset_id=target_dataset_id,
            target_name=target_name,
            table_mapping=table_mapping,
            column_mapping=column_mapping,
            owner_id=owner_id,
        )
    except Exception:
        # Atomic import: if we auto-created the dataset for this run and the
        # workboard build then failed, roll the dataset back so a failed import
        # never leaves an orphan dataset behind. A reused dataset is left as-is.
        if not reuse_dataset_id and rebuild_report:
            orphan_id = rebuild_report.get("dataset_id")
            if orphan_id:
                try:
                    db.rollback()
                    from app.services.dataset_crud import DatasetCRUDService
                    DatasetCRUDService.delete_dataset(db, int(orphan_id))
                except Exception:
                    logger.exception(
                        "import rollback: could not delete auto-created dataset %s",
                        orphan_id,
                    )
        raise
    # Surface the dataset-rebuild outcome on the report for the FE.
    setattr(report, "dataset_rebuild", rebuild_report)
    return workboard, report


# ── Helpers ───────────────────────────────────────────────────────────────


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
