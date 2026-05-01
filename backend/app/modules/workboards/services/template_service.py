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
from app.modules.workboards.models import Workboard, WorkboardAppUser

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

    def to_dict(self) -> Dict[str, Any]:
        return {
            "matched_tables": self.matched_tables,
            "missing_tables": self.missing_tables,
            "missing_columns": self.missing_columns,
            "app_users_imported": self.app_users_imported,
            "app_users_needing_pin": self.app_users_needing_pin,
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
        if isinstance(block.get("column_groups"), list):
            for group in block["column_groups"]:
                if isinstance(group, dict) and "columns" in group:
                    group["columns"] = _rename_col_list(
                        group.get("columns"), old_table_id, column_map
                    )


def _rename_lookup_columns(
    lookup: Any,
    column_map: Dict[int, Dict[str, str]],
) -> None:
    if not isinstance(lookup, dict):
        return
    lookup_table_id = lookup.get("table_id")
    if isinstance(lookup_table_id, int):
        if "value_column" in lookup:
            lookup["value_column"] = _rename_col(lookup.get("value_column"), lookup_table_id, column_map)
        if "label_column" in lookup:
            lookup["label_column"] = _rename_col(lookup.get("label_column"), lookup_table_id, column_map)
    for hop in lookup.get("relationship_path") or []:
        if not isinstance(hop, dict):
            continue
        hop_table_id = hop.get("table_id")
        if not isinstance(hop_table_id, int):
            continue
        if "value_column" in hop:
            hop["value_column"] = _rename_col(hop.get("value_column"), hop_table_id, column_map)
        if "label_column" in hop:
            hop["label_column"] = _rename_col(hop.get("label_column"), hop_table_id, column_map)


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

    # Legacy v1 top-level layout.
    form = out.get("form") if isinstance(out.get("form"), dict) else None
    if form:
        for field in form.get("fields") or []:
            if not isinstance(field, dict):
                continue
            if "column" in field:
                field["column"] = _rename_col(field.get("column"), primary_old_table_id, column_map)
            _rename_lookup_columns(field.get("lookup"), column_map)
    list_cfg = out.get("list") if isinstance(out.get("list"), dict) else None
    if list_cfg:
        if "columns" in list_cfg:
            list_cfg["columns"] = _rename_col_list(list_cfg.get("columns"), primary_old_table_id, column_map)
        if "default_sort_column" in list_cfg:
            list_cfg["default_sort_column"] = _rename_col(
                list_cfg.get("default_sort_column"), primary_old_table_id, column_map
            )
        for item in list_cfg.get("filters") or []:
            if isinstance(item, dict) and "column" in item:
                item["column"] = _rename_col(item.get("column"), primary_old_table_id, column_map)
    for doc in out.get("doc_views") or []:
        _rename_doc_columns(doc, primary_old_table_id=primary_old_table_id, column_map=column_map)
    rls = out.get("rls") if isinstance(out.get("rls"), dict) else None
    if rls and "owner_column" in rls:
        rls["owner_column"] = _rename_col(rls.get("owner_column"), primary_old_table_id, column_map)

    # Modern mini-app screens.
    for screen in out.get("screens") or []:
        if not isinstance(screen, dict):
            continue
        old_table_id = screen.get("table_id") if isinstance(screen.get("table_id"), int) else primary_old_table_id
        if "primary_key_columns" in screen:
            screen["primary_key_columns"] = _rename_col_list(
                screen.get("primary_key_columns"), old_table_id, column_map
            )
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
                _rename_lookup_columns(field.get("lookup"), column_map)
            if "initial_values" in form_cfg:
                form_cfg["initial_values"] = _rename_col_dict_keys(
                    form_cfg.get("initial_values"), old_table_id, column_map
                )
        list_screen = screen.get("list") if isinstance(screen.get("list"), dict) else None
        if list_screen:
            if "columns" in list_screen:
                list_screen["columns"] = _rename_col_list(list_screen.get("columns"), old_table_id, column_map)
            if "default_sort_column" in list_screen:
                list_screen["default_sort_column"] = _rename_col(
                    list_screen.get("default_sort_column"), old_table_id, column_map
                )
            for item in list_screen.get("filters") or []:
                if isinstance(item, dict) and "column" in item:
                    item["column"] = _rename_col(item.get("column"), old_table_id, column_map)
        _rename_doc_columns(screen.get("doc"), primary_old_table_id=old_table_id, column_map=column_map)
        for rule in screen.get("rls") or []:
            _rename_rls_rule_columns(rule, old_table_id, column_map)
        _rename_rls_rule_columns(screen.get("rls_default"), old_table_id, column_map)

    # AppSheet-style v2 sections.
    app_table_old_by_id: Dict[str, int] = {}
    for app_table in out.get("tables") or []:
        if not isinstance(app_table, dict):
            continue
        app_table_id = app_table.get("id")
        old_table_id = app_table.get("table_id")
        if isinstance(app_table_id, str) and isinstance(old_table_id, int):
            app_table_old_by_id[app_table_id] = old_table_id
        if isinstance(old_table_id, int):
            if "pk" in app_table:
                app_table["pk"] = _rename_col_list(app_table.get("pk"), old_table_id, column_map)
            if "label_column" in app_table:
                app_table["label_column"] = _rename_col(app_table.get("label_column"), old_table_id, column_map)
            if isinstance(app_table.get("column_config"), dict):
                app_table["column_config"] = _rename_col_dict_keys(
                    app_table.get("column_config"), old_table_id, column_map
                )
    for ref in out.get("refs") or []:
        if not isinstance(ref, dict):
            continue
        from_old = app_table_old_by_id.get(str(ref.get("from_table") or ""))
        to_old = app_table_old_by_id.get(str(ref.get("to_table") or ""))
        if "from_column" in ref:
            ref["from_column"] = _rename_col(ref.get("from_column"), from_old, column_map)
        if "to_column" in ref:
            ref["to_column"] = _rename_col(ref.get("to_column"), to_old, column_map)
    for view in out.get("views") or []:
        if not isinstance(view, dict):
            continue
        source = view.get("source") if isinstance(view.get("source"), dict) else {}
        source_old = app_table_old_by_id.get(str(source.get("id") or ""))
        if "visible_columns" in view:
            view["visible_columns"] = _rename_col_list(view.get("visible_columns"), source_old, column_map)
        if "group_by" in view:
            view["group_by"] = _rename_col(view.get("group_by"), source_old, column_map)
        if "sort" in view:
            view["sort"] = _rename_sort_columns(view.get("sort"), source_old, column_map)
        cfg = view.get("config") if isinstance(view.get("config"), dict) else None
        if cfg:
            if "fields" in cfg:
                for field in cfg.get("fields") or []:
                    if isinstance(field, dict) and "column" in field:
                        field["column"] = _rename_col(field.get("column"), source_old, column_map)
            if "filters" in cfg:
                for item in cfg.get("filters") or []:
                    if isinstance(item, dict) and "column" in item:
                        item["column"] = _rename_col(item.get("column"), source_old, column_map)
    for action in out.get("actions") or []:
        if not isinstance(action, dict):
            continue
        source_old = app_table_old_by_id.get(str(action.get("source_table") or ""))
        if "set_columns" in action:
            for item in action.get("set_columns") or []:
                if isinstance(item, dict) and "column" in item:
                    item["column"] = _rename_col(item.get("column"), source_old, column_map)
        if "add_with_values" in action:
            add_old = app_table_old_by_id.get(str(action.get("add_to_table") or "")) or source_old
            action["add_with_values"] = _rename_col_dict_keys(action.get("add_with_values"), add_old, column_map)

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
    old_pk_table = bundle.get("primary_table_id")
    old_pk_table_id = old_pk_table if isinstance(old_pk_table, int) else None
    layout_with_columns = _rewrite_column_references(
        raw_layout,
        primary_old_table_id=old_pk_table_id,
        column_map=explicit_column_map,
    )
    layout = _rewrite_table_ids(layout_with_columns, id_map)
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


# ── Helpers ───────────────────────────────────────────────────────────────


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
