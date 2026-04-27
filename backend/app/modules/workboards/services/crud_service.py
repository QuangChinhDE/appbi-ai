"""CRUD service for Workboard mini-apps."""
from __future__ import annotations

import copy
import re
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.core.logging import get_logger
from app.models import DataSource
from app.models.dataset import DatasetTable
from app.modules.workboards.models import Workboard, WorkboardSubmission
from app.modules.workboards.schemas import (
    LayoutJson,
    WorkboardCreate,
    WorkboardUpdate,
)
from app.services.dataset_model_service import get_dataset_model
from app.services.datasource_service import DataSourceConnectionService

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# v1 → v2 layout upgrade
# ---------------------------------------------------------------------------

def upgrade_layout_to_v2(
    raw: Optional[Dict[str, Any]],
    *,
    primary_table_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Return a layout dict that is guaranteed to contain v2 sections.

    v1 documents (or empty/missing) are wrapped: 1 entry in `tables[]`, a
    `table` view from the legacy list, a `form` view from the legacy form,
    and `nav.primary_view` pointing at the table view. The v1 fields
    (form/list/doc_views) are preserved intact for back-compat.
    """
    base: Dict[str, Any] = copy.deepcopy(raw) if isinstance(raw, dict) else {}
    base.setdefault("version", 1)
    base.setdefault("form", {})
    base.setdefault("list", {})
    base.setdefault("doc_views", [])
    base.setdefault("rls", {})
    base.setdefault("audit", {})

    has_v2_tables = bool(base.get("tables"))
    has_v2_views = bool(base.get("views"))

    # Always ensure the v2 keys exist (idempotent).
    base.setdefault("branding", {})
    base.setdefault("tables", [])
    base.setdefault("refs", [])
    base.setdefault("slices", [])
    base.setdefault("actions", [])
    base.setdefault("views", [])
    base.setdefault("nav", {})
    base.setdefault("security", {})

    if has_v2_tables and has_v2_views:
        # already v2 — just stamp the version
        base["version"] = max(int(base.get("version") or 1), 2)
        return base

    # Auto-upgrade. Need at least primary_table_id to seed a table.
    table_uuid = "primary"
    if primary_table_id and not base["tables"]:
        list_cfg = base.get("list") or {}
        form_cfg = base.get("form") or {}
        visible_cols = list(list_cfg.get("columns") or []) or [
            (f.get("column") if isinstance(f, dict) else None)
            for f in (form_cfg.get("fields") or [])
        ]
        visible_cols = [c for c in visible_cols if c]
        column_config: Dict[str, Dict[str, Any]] = {}
        for f in form_cfg.get("fields") or []:
            if not isinstance(f, dict):
                continue
            col = f.get("column")
            if not col:
                continue
            column_config[col] = {
                "label": f.get("label"),
                "required": bool(f.get("required") or False),
                "editable": not bool(f.get("readonly") or False),
                "show": True,
                "show_in": ["table", "detail", "form"],
                "enum_values": (
                    [
                        {"label": v.get("label") if isinstance(v, dict) else str(v),
                         "value": v.get("value") if isinstance(v, dict) else v}
                        for v in (f.get("lookup", {}).get("values") or [])
                    ]
                    if isinstance(f.get("lookup"), dict) and (f.get("lookup") or {}).get("kind") == "static"
                    else None
                ),
            }
        base["tables"] = [{
            "id": table_uuid,
            "table_id": primary_table_id,
            "label": (base.get("branding") or {}).get("app_name") or "Primary",
            "icon": "Table",
            "pk": [],
            "column_config": column_config,
        }]

    if not base["views"] and base["tables"]:
        first_tbl = base["tables"][0]["id"]
        list_cfg = base.get("list") or {}
        form_cfg = base.get("form") or {}
        base["views"] = [
            {
                "id": "view_table",
                "label": "All rows",
                "kind": "table",
                "source": {"kind": "table", "id": first_tbl},
                "position": "primary",
                "icon": "Table",
                "visible_columns": list(list_cfg.get("columns") or []) or None,
                "sort": (
                    [{"column": list_cfg.get("default_sort_column"),
                      "direction": list_cfg.get("default_sort_direction") or "desc"}]
                    if list_cfg.get("default_sort_column") else None
                ),
                "action_ids": [],
                "config": {
                    "page_size": int(list_cfg.get("page_size") or 50),
                    "row_actions": list(list_cfg.get("row_actions") or []),
                    "filters": list(list_cfg.get("filters") or []),
                },
            },
            {
                "id": "view_detail",
                "label": "Detail",
                "kind": "detail",
                "source": {"kind": "table", "id": first_tbl},
                "position": "system",
                "icon": "FileText",
                "action_ids": [],
                "config": {},
            },
            {
                "id": "view_form",
                "label": "Add / Edit",
                "kind": "form",
                "source": {"kind": "table", "id": first_tbl},
                "position": "menu",
                "icon": "Edit",
                "action_ids": [],
                "config": {
                    "title": form_cfg.get("title"),
                    "submit_label": form_cfg.get("submit_label"),
                    "fields": list(form_cfg.get("fields") or []),
                },
            },
        ]

    # nav defaults
    nav = base.get("nav") or {}
    if not nav.get("primary_view") and base["views"]:
        primary = next(
            (v for v in base["views"] if v.get("position") == "primary"),
            base["views"][0],
        )
        nav["primary_view"] = primary["id"]
    if not nav.get("menu_view_ids") and base["views"]:
        nav["menu_view_ids"] = [
            v["id"] for v in base["views"] if v.get("position") in ("primary", "menu")
        ]
    base["nav"] = nav

    base["version"] = 2
    return base


def _normalize_layout(payload, *, primary_table_id: Optional[int] = None) -> dict:
    """Coerce the layout payload into a canonical v2 dict for storage."""
    if payload is None:
        raw: Dict[str, Any] = {}
    elif isinstance(payload, LayoutJson):
        raw = payload.model_dump(mode="json")
    elif isinstance(payload, dict):
        # validate then dump so unknown fields are stripped sensibly
        raw = LayoutJson.model_validate(payload).model_dump(mode="json")
    else:
        raw = LayoutJson.model_validate(payload).model_dump(mode="json")
    return upgrade_layout_to_v2(raw, primary_table_id=primary_table_id)


def load_layout_v2(workboard: Workboard) -> Dict[str, Any]:
    """Read-side helper: return a guaranteed-v2 layout dict."""
    return upgrade_layout_to_v2(
        workboard.layout_json or {},
        primary_table_id=workboard.primary_table_id,
    )


def _columns_cache_list(table: DatasetTable) -> List[Dict[str, Any]]:
    cache = table.columns_cache
    if isinstance(cache, dict):
        raw = cache.get("columns")
        if isinstance(raw, list):
            return [item for item in raw if isinstance(item, dict)]
    if isinstance(cache, list):
        return [item for item in cache if isinstance(item, dict)]
    return []


def _parse_source_table_name(source_table_name: Optional[str], datasource: Optional[DataSource]) -> Tuple[str, str]:
    raw = str(source_table_name or "").strip().strip('"').strip("`")
    if "." in raw:
        schema_name, table_name = raw.split(".", 1)
        return schema_name.strip('"').strip("`"), table_name.strip('"').strip("`")
    config = datasource.config or {} if datasource else {}
    default_schema = (
        config.get("schema_name")
        or config.get("schema")
        or config.get("database")
        or "public"
    )
    return str(default_schema), raw


def _introspect_columns(db: Session, table: DatasetTable) -> List[Dict[str, Any]]:
    cached = _columns_cache_list(table)
    datasource = (
        db.query(DataSource)
        .filter(DataSource.id == table.datasource_id)
        .first()
    ) if table.datasource_id else None
    if table.source_kind != "physical_table" or datasource is None:
        return cached
    try:
        schema_name, table_name = _parse_source_table_name(table.source_table_name, datasource)
        ds_type = datasource.type.value if hasattr(datasource.type, "value") else str(datasource.type)
        detail = DataSourceConnectionService.get_table_detail(
            ds_type,
            datasource.config or {},
            schema_name,
            table_name,
            preview_rows=1,
        )
        raw = detail.get("columns")
        if isinstance(raw, list) and raw:
            return [item for item in raw if isinstance(item, dict)]
    except Exception:
        logger.warning("Workboard schema introspection fallback to cache for table %s", table.id, exc_info=True)
    return cached


def _humanize(name: str) -> str:
    text = re.sub(r"[_\s]+", " ", str(name or "")).strip()
    return text[:1].upper() + text[1:] if text else ""


def _infer_primary_key_columns(
    columns: List[Dict[str, Any]],
    requested: Optional[List[str]] = None,
) -> List[str]:
    names = [str(item.get("name") or "").strip() for item in columns if item.get("name")]
    name_set = {name for name in names if name}
    requested = [str(item).strip() for item in (requested or []) if str(item).strip()]
    if requested:
        valid = [item for item in requested if item in name_set]
        if valid:
            return valid
    flagged = [
        str(item.get("name"))
        for item in columns
        if item.get("name") and bool(item.get("is_primary_key"))
    ]
    if flagged:
        return flagged
    if "id" in name_set:
        return ["id"]
    singulars = set()
    for name in names:
        base = name.split(".")[-1]
        singulars.add(base)
        if base.endswith("s") and not base.endswith("ss"):
            singulars.add(base[:-1])
    for candidate in names:
        if candidate.endswith("_id"):
            stem = candidate[:-3]
            if stem in singulars:
                return [candidate]
    for candidate in names:
        if candidate.endswith("_id"):
            return [candidate]
    return [names[0]] if names else []


def _pick_label_column(columns: List[Dict[str, Any]], pk_columns: List[str]) -> Optional[str]:
    preferred_types = {"string", "text", "character varying", "varchar"}
    for item in columns:
        name = str(item.get("name") or "")
        if not name or name in pk_columns:
            continue
        low_type = str(item.get("type") or "").lower()
        if any(token in low_type for token in preferred_types):
            return name
    for item in columns:
        name = str(item.get("name") or "")
        if name and name not in pk_columns:
            return name
    return pk_columns[0] if pk_columns else None


def _field_widget(column: Dict[str, Any], *, is_lookup: bool) -> str:
    if is_lookup:
        return "lookup"
    low_type = str(column.get("type") or "").lower()
    name = str(column.get("name") or "").lower()
    if "bool" in low_type:
        return "checkbox"
    if "timestamp" in low_type or "datetime" in low_type:
        return "datetime"
    if low_type == "date":
        return "date"
    if any(token in low_type for token in ("int", "numeric", "decimal", "float", "double", "real", "number")):
        return "number"
    if "text" in low_type and len(name) > 0:
        return "textarea"
    return "text"


def _pick_view_label_column(view: Dict[str, Any], to_column: str) -> str:
    dimensions = [item for item in (view.get("dimensions") or []) if isinstance(item, dict)]
    for item in dimensions:
        field_name = str(item.get("name") or "")
        field_type = str(item.get("type") or "").lower()
        if field_name and field_name != to_column and field_type in {"string", "date", "datetime"}:
            return field_name
    return to_column


def _resolve_related_tables(
    db: Session,
    *,
    dataset_id: int,
    primary_table_id: int,
    primary_columns: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    model = get_dataset_model(db, dataset_id)
    if not isinstance(model, dict):
        return [], [], {}

    view_by_name = {
        str(view.get("name")): view
        for view in (model.get("views") or [])
        if isinstance(view, dict) and view.get("name")
    }
    primary_view_names = {
        str(view.get("name"))
        for view in (model.get("views") or [])
        if isinstance(view, dict) and view.get("dataset_table_id") == primary_table_id
    }
    if not primary_view_names:
        return [], [], {}

    refs: List[Dict[str, Any]] = []
    lookup_tables: List[Dict[str, Any]] = []
    related_tables: Dict[str, Dict[str, Any]] = {}
    seen_ref_ids: set[str] = set()
    primary_col_names = {str(item.get("name")) for item in primary_columns if item.get("name")}

    for explore in (model.get("explores") or []):
        if not isinstance(explore, dict):
            continue
        if str(explore.get("base_view_name") or "") not in primary_view_names:
            continue
        for join in (explore.get("joins") or []):
            if not isinstance(join, dict):
                continue
            from_column = str(join.get("from_column") or "").strip()
            if not from_column or from_column not in primary_col_names:
                continue
            target_view = view_by_name.get(str(join.get("view") or ""))
            target_table_id = target_view.get("dataset_table_id") if isinstance(target_view, dict) else None
            to_column = str(join.get("to_column") or "").strip()
            if not target_table_id or not to_column:
                continue
            table_key = f"lookup_{target_table_id}"
            if table_key not in related_tables:
                related_tables[table_key] = {
                    "id": table_key,
                    "table_id": int(target_table_id),
                    "label": target_view.get("table_display_name") or target_view.get("name") or f"Table {target_table_id}",
                    "icon": "Table",
                    "pk": [to_column],
                    "label_column": _pick_view_label_column(target_view, to_column),
                    "column_config": {},
                }
            ref_id = f"ref_{from_column}_{target_table_id}_{to_column}"
            if ref_id in seen_ref_ids:
                continue
            seen_ref_ids.add(ref_id)
            refs.append(
                {
                    "id": ref_id,
                    "from_table": "primary",
                    "from_column": from_column,
                    "to_table": table_key,
                    "to_column": to_column,
                    "cardinality": "many_to_one",
                }
            )
            lookup_tables.append(
                {
                    "column": from_column,
                    "table_id": int(target_table_id),
                    "value_column": to_column,
                    "label_column": related_tables[table_key]["label_column"],
                    "label": related_tables[table_key]["label"],
                }
            )
    return refs, lookup_tables, related_tables


def _apply_default_layout(
    raw_layout: Dict[str, Any],
    *,
    primary_table_id: int,
    columns: List[Dict[str, Any]],
    primary_key_columns: List[str],
    refs: List[Dict[str, Any]],
    lookup_tables: List[Dict[str, Any]],
    related_tables: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    layout = _normalize_layout(raw_layout, primary_table_id=primary_table_id)
    column_names = [str(item.get("name") or "") for item in columns if item.get("name")]
    label_column = _pick_label_column(columns, primary_key_columns)
    lookup_by_column = {str(item.get("column")): item for item in lookup_tables if item.get("column")}

    form_cfg = layout.setdefault("form", {})
    if not form_cfg.get("fields"):
        form_fields: List[Dict[str, Any]] = []
        for column in columns:
            name = str(column.get("name") or "").strip()
            if not name:
                continue
            lookup = lookup_by_column.get(name)
            is_pk = name in primary_key_columns
            widget = _field_widget(column, is_lookup=lookup is not None)
            field: Dict[str, Any] = {
                "column": name,
                "widget": widget,
                "label": _humanize(name),
                "required": bool(not column.get("nullable") and not is_pk),
                "readonly": bool(is_pk),
            }
            if lookup:
                field["lookup"] = {
                    "kind": "dataset_table",
                    "table_id": lookup["table_id"],
                    "value_column": lookup["value_column"],
                    "label_column": lookup["label_column"],
                }
            form_fields.append(field)
        form_cfg["fields"] = form_fields
    form_cfg.setdefault("submit_label", "Save")

    list_cfg = layout.setdefault("list", {})
    if not list_cfg.get("columns"):
        list_cfg["columns"] = column_names[: min(8, len(column_names))]
    list_cfg.setdefault("page_size", 50)
    if not list_cfg.get("row_actions"):
        list_cfg["row_actions"] = ["edit", "delete"]

    tables = list(layout.get("tables") or [])
    if not tables:
        tables = [{"id": "primary", "table_id": primary_table_id}]
    primary_app_table = tables[0]
    primary_app_table["id"] = primary_app_table.get("id") or "primary"
    primary_app_table["table_id"] = primary_table_id
    primary_app_table["pk"] = list(primary_key_columns)
    primary_app_table["label_column"] = label_column
    column_config = dict(primary_app_table.get("column_config") or {})
    for column in columns:
        name = str(column.get("name") or "").strip()
        if not name:
            continue
        existing = dict(column_config.get(name) or {})
        existing.setdefault("label", _humanize(name))
        existing.setdefault("required", bool(not column.get("nullable") and name not in primary_key_columns))
        existing.setdefault("editable", name not in primary_key_columns)
        existing.setdefault("show", True)
        existing.setdefault("show_in", ["table", "detail", "form"])
        lookup = lookup_by_column.get(name)
        if lookup:
            target_table = next(
                (item for item in refs if item.get("from_column") == name),
                None,
            )
            if target_table:
                existing.setdefault("ref_table_id", target_table.get("to_table"))
                existing.setdefault("ref_action", "navigate")
        column_config[name] = existing
    primary_app_table["column_config"] = column_config

    existing_table_ids = {str(item.get("id")) for item in tables if item.get("id")}
    for item in related_tables.values():
        if item["id"] not in existing_table_ids:
            tables.append(item)
    layout["tables"] = tables
    layout["refs"] = refs

    views = list(layout.get("views") or [])
    if views:
        for view in views:
            if not isinstance(view, dict):
                continue
            if view.get("kind") == "table":
                view["visible_columns"] = view.get("visible_columns") or list_cfg.get("columns")
                cfg = dict(view.get("config") or {})
                cfg.setdefault("page_size", int(list_cfg.get("page_size") or 50))
                cfg.setdefault("row_actions", list(list_cfg.get("row_actions") or []))
                view["config"] = cfg
            if view.get("kind") == "form":
                cfg = dict(view.get("config") or {})
                cfg["fields"] = list(form_cfg.get("fields") or [])
                cfg.setdefault("submit_label", form_cfg.get("submit_label"))
                view["config"] = cfg
            if view.get("kind") == "detail":
                view["visible_columns"] = view.get("visible_columns") or list_cfg.get("columns")
    layout["views"] = views
    return layout


def _prepare_schema_defaults(
    db: Session,
    *,
    dataset_id: int,
    primary_table_id: int,
    requested_pk_columns: Optional[List[str]],
    raw_layout: Any,
) -> Tuple[List[str], List[Dict[str, Any]], Dict[str, Any]]:
    table = (
        db.query(DatasetTable)
        .filter(DatasetTable.id == primary_table_id)
        .first()
    )
    if not table:
        raise ValueError("Primary table not found")
    if table.dataset_id != dataset_id:
        raise ValueError("Primary table does not belong to the selected dataset")
    columns = _introspect_columns(db, table)
    primary_key_columns = _infer_primary_key_columns(columns, requested=requested_pk_columns)
    refs, lookup_tables, related_tables = _resolve_related_tables(
        db,
        dataset_id=dataset_id,
        primary_table_id=primary_table_id,
        primary_columns=columns,
    )
    layout_json = _apply_default_layout(
        raw_layout,
        primary_table_id=primary_table_id,
        columns=columns,
        primary_key_columns=primary_key_columns,
        refs=refs,
        lookup_tables=lookup_tables,
        related_tables=related_tables,
    )
    return primary_key_columns, lookup_tables, layout_json


def _pick_first_physical_table(db: Session, dataset_id: int) -> int:
    first_physical = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == dataset_id,
            DatasetTable.source_kind == "physical_table",
        )
        .order_by(DatasetTable.id.asc())
        .first()
    )
    if not first_physical:
        raise ValueError(
            "Dataset has no physical tables - workboards need at least one "
            "physical table to anchor the layout. Add a table to the dataset first."
        )
    return int(first_physical.id)


def _dataset_table_ids(db: Session, dataset_id: int) -> set[int]:
    rows = db.query(DatasetTable.id).filter(DatasetTable.dataset_id == dataset_id).all()
    return {int(row[0]) for row in rows}


def _clear_layout_table_refs_not_in_dataset(
    raw_layout: Any,
    valid_table_ids: set[int],
) -> Dict[str, Any]:
    """Clear stale table ids after rebinding a workboard to another dataset."""
    if raw_layout is None:
        layout: Dict[str, Any] = {}
    elif isinstance(raw_layout, LayoutJson):
        layout = raw_layout.model_dump(mode="json")
    elif isinstance(raw_layout, dict):
        layout = copy.deepcopy(raw_layout)
    else:
        layout = LayoutJson.model_validate(raw_layout).model_dump(mode="json")

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            for key in list(node.keys()):
                value = node[key]
                if key == "table_id" and isinstance(value, int):
                    if value not in valid_table_ids:
                        node[key] = None
                elif key == "source" and isinstance(value, str) and value.startswith("lookup:"):
                    try:
                        ref_table_id = int(value.split(":", 1)[1])
                    except ValueError:
                        continue
                    if ref_table_id not in valid_table_ids:
                        node[key] = "primary"
                else:
                    _walk(value)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(layout)
    return layout


class WorkboardService:
    """Service layer for Workboard CRUD. All methods are static."""

    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[Workboard]:
        return (
            db.query(Workboard)
            .order_by(Workboard.updated_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    @staticmethod
    def get_by_id(db: Session, workboard_id: int) -> Optional[Workboard]:
        return (
            db.query(Workboard)
            .filter(Workboard.id == workboard_id)
            .first()
        )

    @staticmethod
    def get_by_slug(db: Session, slug: str) -> Optional[Workboard]:
        if not slug:
            return None
        return db.query(Workboard).filter(Workboard.slug == slug).first()

    @staticmethod
    def slug_exists(
        db: Session, slug: str, *, exclude_id: Optional[int] = None
    ) -> bool:
        if not slug:
            return False
        query = db.query(Workboard.id).filter(Workboard.slug == slug)
        if exclude_id is not None:
            query = query.filter(Workboard.id != exclude_id)
        return db.query(query.exists()).scalar() is True

    @staticmethod
    def create(
        db: Session,
        payload: WorkboardCreate,
        owner_id=None,
    ) -> Workboard:
        if payload.slug and WorkboardService.slug_exists(db, payload.slug):
            raise ValueError(f"Workboard slug '{payload.slug}' already exists")

        # Auto-resolve primary_table_id when the caller didn't specify one.
        # The mini-app contract assigns table_id per screen, so the workboard
        # itself only needs *any* physical table from the chosen dataset to
        # satisfy the FK + legacy v1 form code paths.
        primary_table_id = payload.primary_table_id
        if primary_table_id is None:
            primary_table_id = _pick_first_physical_table(db, payload.dataset_id)

        (
            primary_key_columns,
            lookup_tables,
            layout_json,
        ) = _prepare_schema_defaults(
            db,
            dataset_id=payload.dataset_id,
            primary_table_id=primary_table_id,
            requested_pk_columns=payload.primary_key_columns,
            raw_layout=payload.layout_json,
        )

        db_obj = Workboard(
            name=payload.name,
            slug=payload.slug,
            description=payload.description,
            icon=payload.icon,
            dataset_id=payload.dataset_id,
            primary_table_id=primary_table_id,
            primary_key_columns=primary_key_columns,
            lookup_tables=lookup_tables,
            layout_json=layout_json,
            optimistic_lock_column=payload.optimistic_lock_column,
            is_published=False,
            version=1,
            owner_id=owner_id,
        )
        db.add(db_obj)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise ValueError(f"Workboard could not be created: {exc.orig}") from exc
        db.refresh(db_obj)
        logger.info(
            "Created workboard id=%s name=%s dataset=%s table=%s",
            db_obj.id,
            db_obj.name,
            db_obj.dataset_id,
            db_obj.primary_table_id,
        )
        return db_obj

    @staticmethod
    def update(
        db: Session,
        workboard_id: int,
        payload: WorkboardUpdate,
    ) -> Optional[Workboard]:
        db_obj = WorkboardService.get_by_id(db, workboard_id)
        if not db_obj:
            return None

        update_data = payload.model_dump(exclude_unset=True)

        if "slug" in update_data:
            new_slug = update_data["slug"]
            if new_slug and WorkboardService.slug_exists(
                db, new_slug, exclude_id=workboard_id
            ):
                raise ValueError(f"Workboard slug '{new_slug}' already exists")

        schema_binding_changed = (
            "dataset_id" in update_data or "primary_table_id" in update_data
        )
        target_dataset_id = int(update_data.get("dataset_id") or db_obj.dataset_id)
        target_primary_table_id = update_data.get("primary_table_id")
        if schema_binding_changed and target_primary_table_id is None:
            target_primary_table_id = _pick_first_physical_table(db, target_dataset_id)
        if target_primary_table_id is None:
            target_primary_table_id = db_obj.primary_table_id
        target_primary_table_id = int(target_primary_table_id)

        should_refresh_schema = (
            ("layout_json" in update_data and update_data["layout_json"] is not None)
            or schema_binding_changed
        )
        if should_refresh_schema:
            raw_layout = update_data.get("layout_json")
            if raw_layout is None:
                raw_layout = db_obj.layout_json or {}
            if schema_binding_changed:
                raw_layout = _clear_layout_table_refs_not_in_dataset(
                    raw_layout,
                    _dataset_table_ids(db, target_dataset_id),
                )
            (
                refreshed_pk,
                refreshed_lookups,
                refreshed_layout,
            ) = _prepare_schema_defaults(
                db,
                dataset_id=target_dataset_id,
                primary_table_id=target_primary_table_id,
                requested_pk_columns=list(db_obj.primary_key_columns or []),
                raw_layout=raw_layout,
            )
            update_data["dataset_id"] = target_dataset_id
            update_data["primary_table_id"] = target_primary_table_id
            update_data["layout_json"] = refreshed_layout
            update_data["primary_key_columns"] = refreshed_pk
            update_data["lookup_tables"] = refreshed_lookups

        for key, value in update_data.items():
            setattr(db_obj, key, value)

        # Bump structural version when the layout actually changes.
        if "layout_json" in update_data:
            db_obj.version = (db_obj.version or 1) + 1

        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise ValueError(f"Workboard could not be updated: {exc.orig}") from exc
        db.refresh(db_obj)
        logger.info("Updated workboard id=%s", workboard_id)
        return db_obj

    @staticmethod
    def refresh_schema_defaults(db: Session, workboard: Workboard) -> Workboard:
        primary_key_columns, lookup_tables, layout_json = _prepare_schema_defaults(
            db,
            dataset_id=workboard.dataset_id,
            primary_table_id=workboard.primary_table_id,
            requested_pk_columns=list(workboard.primary_key_columns or []),
            raw_layout=workboard.layout_json or {},
        )
        workboard.primary_key_columns = list(primary_key_columns)
        workboard.lookup_tables = list(lookup_tables)
        workboard.layout_json = layout_json
        db.commit()
        db.refresh(workboard)
        return workboard

    @staticmethod
    def delete(db: Session, workboard_id: int) -> bool:
        db_obj = WorkboardService.get_by_id(db, workboard_id)
        if not db_obj:
            return False
        db.delete(db_obj)
        db.commit()
        logger.info("Deleted workboard id=%s", workboard_id)
        return True

    @staticmethod
    def update_introspection_cache(
        db: Session,
        workboard: Workboard,
        *,
        primary_key_columns: Optional[List[str]] = None,
        lookup_tables: Optional[List[dict]] = None,
    ) -> Workboard:
        """Refresh the cached schema metadata after introspection."""
        if primary_key_columns is not None:
            workboard.primary_key_columns = list(primary_key_columns)
        if lookup_tables is not None:
            workboard.lookup_tables = list(lookup_tables)
        db.commit()
        db.refresh(workboard)
        return workboard

    @staticmethod
    def record_submission(
        db: Session,
        *,
        workboard: Workboard,
        action: str,
        table_name: str,
        row_pk: Optional[dict],
        payload: Optional[dict],
        validation_warnings: Optional[List[dict]] = None,
        user_id=None,
    ) -> WorkboardSubmission:
        submission = WorkboardSubmission(
            workboard_id=workboard.id,
            action=action,
            table_name=table_name,
            row_pk=row_pk,
            payload=payload,
            validation_warnings=validation_warnings or [],
            user_id=user_id,
        )
        db.add(submission)
        db.commit()
        db.refresh(submission)
        return submission

    @staticmethod
    def list_submissions(
        db: Session,
        workboard_id: int,
        *,
        skip: int = 0,
        limit: int = 100,
    ) -> List[WorkboardSubmission]:
        return (
            db.query(WorkboardSubmission)
            .filter(WorkboardSubmission.workboard_id == workboard_id)
            .order_by(WorkboardSubmission.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
